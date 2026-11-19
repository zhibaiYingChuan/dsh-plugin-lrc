/**
 * **唯一的记忆提取器**。
 *
 * ## 为什么把 6 条路径合成 1 个函数
 *
 * 改动前有 6 条并行写入口，每条自带门槛：
 *
 * | # | 入口 | 自己的门槛 |
 * |---|---|---|
 * | 1 | `<lrc_memory>` 标签 | 标签存在性（实测命中 1.8%） |
 * | 2 | 助手正文正则 | 8 字 / 4 字分层 |
 * | 3 | 用户纠正句式 | ≥6 字 + 行为闸门 |
 * | 4 | 用户资源位置 | 媒体扩展名 / 行首盘符 |
 * | 5 | 服务端 distill 透传 | 无（已停用） |
 * | 6 | LLM 兜底 | 类型缺口 / 密度 / 配额 |
 *
 * 任何一次修复只能覆盖其中一条，其余五条继续漏或继续脏 —— 这是
 * 「改了十一轮还在反复」的机械原因。
 *
 * ## 现在的结构
 *
 * ```
 * 任意文本块 ──► extractFacts() ──► MemoryFact[] ──► validateFact() ──► 写库
 * ```
 *
 * 六条路径退化为**同一个函数的六种调用方式**（差别只在 `origin` 与
 * `sourceLabel`），没有任何一条能绕过 `validateFact`。
 *
 * ## 提取 ≠ 过滤
 *
 * 旧实现的核心动作是「这个句子像不像约束」（二分类，假设空间无限）。
 * 新实现的核心动作是「这句能不能拆出 (subject, predicate, value)」
 * （结构化，假设空间 = 谓词词表 + 位置词表，**有界**）。
 *
 * 拆不出来就不是记忆 —— 不需要长度门槛，也不需要黑名单。
 */
import {
  deriveLocation,
  deriveRebuttal,
  extractTopic,
  isProcessNarration,
  isSelfContained,
  makeFact,
  validateFact,
  validateJudgedFact,
  type FactKind,
  type MemoryFact,
} from './memory-schema.ts';
import {
  extractMemoryTag,
  isNoUpdate,
  isOptionLabel,
  isSmallTalk,
  looksLikeMachineOutput,
  looksLikeNormalLog,
  maskPaths,
  stripCodeFences,
  stripMemoryTag,
} from './memory-filter.ts';

/** 提取输入。 */
export interface ExtractInput {
  text: string;
  origin: 'user' | 'assistant';
  sessionId: string;
  turn?: number;
}

/** 提取产物 + 被拒原因（审计用）。 */
export interface ExtractResult {
  facts: MemoryFact[];
  rejected: Array<{ text: string; reason: string }>;
  /**
   * 语义待裁决的句子（★2026-11-14）。
   *
   * 这些句子通过了全部**结构**判据（自足 / 非过程叙述 / 非疑问 /
   * 非机器输出），但没命中谓词表。结构判据对「是垃圾」与「是真判断句」
   * 零区分力（实测 82/82 全通过），所以它们的去留必须由 LLM 裁决，
   * 不能由 95 词白名单否决，也不能无条件放行。
   */
  pending: string[];
}

/** 单句最大长度：超过的多半是整段推理 / 报告，不是可复用陈述。 */
const MAX_CLAUSE = 200;

/** 绝对路径 token（盘符或 UNC）。 */
const ABS_PATH = /(?:^|[^A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\)[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*)/;

/** 媒体 / 素材类文件名。 */
const MEDIA_TOKEN =
  /[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp)\b/i;

/** 资源名词：用来给路径补 subject。 */
const RESOURCE_NOUN = /(?:音频|视频|文案|脚本|素材|图片|封面|成片|录音|音乐|文件|目录)/;

/** 标签行首的类别声明。 */
const TAG_KIND = /^(决策|约束|结论|决定|事实)\s*[：:]\s*/;

/** 类别声明 → schema 类别。 */
function hintOf(head: string): FactKind {
  switch (head) {
    case '决策':
      return 'decision';
    case '约束':
      return 'constraint';
    case '结论':
      return 'conclusion';
    case '事实':
      return 'statement';
    default:
      return 'fact';
  }
}

/**
 * 把一个文本块切成候选句。
 *
 * 只做切分，不做判定 —— 判定全部交给 schema。
 */
function splitClauses(text: string): string[] {
  const source = text
    // 表格行 / 标题行永远是片段，不是陈述
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s.*$/gm, ' ');
  return source
    .split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/)
    .map((raw) => raw.trim().replace(/^[-*+\d.)\s]+/, '').trim())
    .filter((line) => line.length > 0 && line.length <= MAX_CLAUSE);
}

/** 噪声行（与 schema 无关的结构性问题）。 */
function isStructuralNoise(line: string): boolean {
  if (isSmallTalk(line)) return true;
  if (isOptionLabel(line)) return true;
  if (looksLikeNormalLog(line)) return true;
  if (looksLikeMachineOutput(line)) return true;
  // 兜底：仍是代码形态的行
  if (/^\s{4,}|^(?:const|let|var|function|class|import|export|def|fn)\s/.test(line)) return true;
  return false;
}

/**
 * 资源位置：`D:\Desktop，score.wav，这是你要打音频` → `(音频, 位于, D:\Desktop)`。
 *
 * ## 为什么必须单独一支
 *
 * 位置句里没有 schema 谓词词表能命中的词（`在 / 位于` 是中文最高频
 * 虚词，靠它做二分类四轮全失败），但作为**三元组拆分**它完全可靠：
 * 路径 token 是 subject 的锚，资源名词是 subject 的名字。
 *
 * ## 只对用户消息生效
 *
 * 助手正文里 `G:\loong 是仓库`、`assets/score.wav 的 MD5 一致` 与
 * 「用户交代文件在哪」在文本形态上无法区分 —— 靠加词表三代全部失败
 * （见 memory-filter.ts 的历史注释）。来源维度是唯一可靠的区分。
 */
function pathLocations(text: string): Array<{ subject: string; value: string }> {
  const out: Array<{ subject: string; value: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(ABS_PATH.source, 'g'))) {
    const token = (m[1] ?? '').trim().replace(/[，。；：、]+$/, '');
    if (token.length < 3) continue;
    if (seen.has(token)) continue;
    // ## 必须有**就近的资源名词**才成立（★2026-11-14 真实缺陷）
    //
    // 旧实现无论有没有名词都产出一条，subject 兜底成文件名本身。
    // 用户粘贴长文档时这会大量误触发：
    // ```
    // 底部："入戒门"按钮（草鞋图标`straw_sandal.png`）
    // → (straw_sandal.png, 位于, straw_sandal.png)   ← 主语=取值，零信息
    // ```
    // 「用户交代资源在哪」这件事的语义核心是**资源名词**（音频/文案/
    // 素材/图片…）。没有就近名词就说明这句话不是在交代资源位置 ——
    // 它只是在谈论某个文件，那属于文档内容，该由 LLM 判定，不该在这里
    // 无条件产出一条自指的空洞 Fact。
    const after = text.slice((m.index ?? 0) + token.length, (m.index ?? 0) + token.length + 24);
    const noun = RESOURCE_NOUN.exec(after);
    if (noun === null) continue;
    seen.add(token);
    // subject 取**路径之后的**资源名词（`<路径> 的音频` → `音频`）：
    // 位置交代的语义是「这个目录里装的是音频」，名词在路径后面。
    // 取路径之前的窗口会抓到「使用产品截图与」里的无关名词。
    out.push({ subject: noun[0], value: token });
  }
  const media = MEDIA_TOKEN.exec(text);
  if (media !== null && out.length === 0 && !seen.has(media[0])) {
    // ## 资源名词只能在**媒体 token 附近**找（★2026-11-14 真实缺陷）
    //
    // 旧实现是 `RESOURCE_NOUN.exec(text)` —— 在整段文本里找第一个资源名词。
    // 用户粘贴长文档时这必然错位：实测 session-95eaf7e3 里有一句
    // ```
    // 底部："入戒门"按钮（草鞋图标`straw_sandal.png`）
    // ```
    // 而整篇文档第一次出现「视频」是在产品定位里的「刷短视频」，
    // 于是抽出 `视频位于 straw_sandal.png` —— 张冠李戴。
    //
    // 判据应该是**就近**：名词必须在 token 前后 24 字符内。
    // 找不到就近名词就说明这句不是在交代资源位置（只是在谈论某个文件），
    // 与上面 ABS_PATH 分支同理 —— 不产出自指的空洞 Fact。
    const at = media.index ?? 0;
    const window = text.slice(Math.max(0, at - 24), at + media[0].length + 24);
    const noun = RESOURCE_NOUN.exec(window);
    if (noun === null) return out;
    out.push({ subject: noun[0], value: media[0] });
  }
  return out;
}

/**
 * 从**任意文本块**提取记忆。
 *
 * 所有写入路径都调这一个函数：标签、正文、用户纠正、资源位置、
 * 推理兜底。差别只在 `origin` 与置信度。
 */
export function extractFacts(input: ExtractInput): ExtractResult {
  const facts: MemoryFact[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];
  const pending: string[] = [];
  const body0 = input.text.trim();
  if (body0.length === 0) return { facts, rejected, pending };

  const base = {
    origin: input.origin,
    sessionId: input.sessionId,
    turn: input.turn,
  };

  // ── 第一支：模型显式标签（最高置信度，但实测命中率仅 1.8%）──
  const tag = extractMemoryTag(body0);
  if (tag !== null && !isNoUpdate(tag)) {
    for (const raw of stripCodeFences(tag).split('\n')) {
      const line = raw.trim().replace(/^[-*+]\s*/, '').trim();
      if (line.length === 0) continue;
      const head = TAG_KIND.exec(line);
      const hint = head !== null ? hintOf(head[1] as string) : undefined;
      const statement = head !== null ? line.slice(head[0].length).trim() : line;
      const fact = makeFact({ statement, ...base, hint, confidence: 0.95 });
      if (fact === null) {
        rejected.push({ text: line, reason: 'no_claim' });
        continue;
      }
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        rejected.push({ text: line, reason: verdict.reason });
        continue;
      }
      facts.push(fact);
    }
  }

  // ── 第二支：正文（剥掉标签与代码围栏后逐句判定）──
  const body = stripMemoryTag(stripCodeFences(body0));

  // 用户消息先走「资源位置」：路径 token 是可靠的锚，且这类句子
  // 往往不含任何谓词（`D:\Desktop，score.wav，这是你要打音频`）
  if (input.origin === 'user') {
    for (const loc of pathLocations(body)) {
      const statement = `${loc.subject}位于 ${loc.value}`;
      const fact = makeFact({ statement, ...base, asLocation: true, confidence: 0.9 });
      if (fact === null) {
        rejected.push({ text: statement, reason: 'no_claim' });
        continue;
      }
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        rejected.push({ text: statement, reason: verdict.reason });
        continue;
      }
      // ## 陈述必须**归一化**，不能直接用原句
      //
      // 用户一句话交代多个目录时（`A 的音频加 B 的文案`），若两条位置都用
      // 原句做 statement，它们在去重阶段会被判为同一条 ⇒ 只留一个目录，
      // 另一个永久丢失。实测 session-c8762e44 正是这种形态。
      facts.push(fact);
    }
  }

  for (const line of splitClauses(body)) {
    if (isStructuralNoise(line)) {
      rejected.push({ text: line, reason: 'structural_noise' });
      continue;
    }
    // 过程叙述：讲「我接下来要做什么」，不是给后人的规矩
    //
    // 必须传 origin：`接下来要保证用户能持续用下去` 在用户消息里是**要求**，
    // 在助手正文里才是过程叙述（见 `isProcessNarration` 注释）。
    if (isProcessNarration(line, input.origin)) {
      rejected.push({ text: line, reason: 'process_narration' });
      continue;
    }
    if (!isSelfContained(line)) {
      rejected.push({ text: line, reason: 'not_self_contained' });
      continue;
    }

    let fact: MemoryFact | null = null;

    // ## 用户消息先试两条专用支路（★2026-11-14 顺序调整）
    //
    // `makeFact` 现在拆不出三元组时也返回 Fact（未富集），不再返回 null。
    // 所以「`fact === null` 时再试位置/纠正」的旧写法永远不会命中 ——
    // 必须先试专用支路，让它们有机会**富集**成 location / constraint。
    if (input.origin === 'user') {
      // `音频在桌面` 这类用户口语没有 schema 谓词，却正是最关键的事实。
      const loc = deriveLocation(line);
      if (loc !== null) {
        fact = makeFact({ statement: line, ...base, asLocation: true, confidence: 0.85 });
      }
      // 用户纠正 / 重申句式：语义上等价于一条约束，但没有 schema 谓词。
      // 例如「不是告诉你音频在的位置了吗？」—— 靠正则二分类三轮都漏过它。
      if (fact === null) {
        const rebuttal = deriveRebuttal(line);
        if (rebuttal !== null) {
          fact = {
            kind: 'constraint',
            subject: rebuttal.subject,
            predicate: '已明确要求',
            value: rebuttal.value,
            statement: rebuttal.value,
            scope: 'project',
            origin: 'user',
            confidence: 0.9,
            source: { sessionId: input.sessionId, turn: input.turn },
            status: 'active',
            enriched: true,
          };
        }
      }
    }

    if (fact === null) {
      fact = makeFact({ statement: line, ...base, confidence: input.origin === 'user' ? 0.9 : 0.85 });
    }
    if (fact === null) {
      rejected.push({ text: line, reason: 'no_claim' });
      continue;
    }
    const verdict = validateFact(fact);
    if (!verdict.ok) {
      // ## 未富集 ⇒ 待裁决，不是拒绝（★2026-11-14）
      //
      // `no_predicate` / `no_value` 意味着「没命中谓词表」，不代表这句
      // 没有价值。实测真判断句（`分层极其干净，改造成本低`）与垃圾
      // （`是的，我明白了`）在这里无法区分 —— 只有语义能区分。
      // 所以送进 `pending`，由 LLM 整条消息一次调用裁决。
      if (verdict.reason === 'no_predicate' || verdict.reason === 'no_value') {
        pending.push(line);
        continue;
      }
      rejected.push({ text: line, reason: verdict.reason });
      continue;
    }
    facts.push(fact);
  }

  // ── 统一附加消息主题（★2026-11-17，contextual enrichment）──
  //
  // ## 为什么放在**出口**而不是每条 makeFact 调用处
  //
  // 本函数有四条抽取分支（标签 / 资源位置 / 正文逐句 / 用户纠正），
  // 逐处传参必然漏 —— 而漏掉的那一支产出的 Fact 就会缺 topic，
  // 表现为「同一个函数产出的记忆质量不一致」，极难排查。
  //
  // ## 为什么不改 statement
  //
  // statement 参与去重（`areNearDuplicate`）、冲突判定（`factKey`）、
  // 自足性校验与快照渲染。往里塞 topic 会让这四条全部失真：
  // 两条不同主题的同义 Fact 会被判成重复。topic 必须是**旁路字段**。
  //
  // ## topic 只对**多句正文**有意义
  //
  // 用户消息通常一两句话，topic 就等于全文，附加无意义；标签支路
  // 本身就是模型显式给的结论，也不缺上下文。因此只给 assistant 正文附加。
  //
  // ## 必须用**已清洗**的 `body`，不能用 `body0`（2026-11-17 审查修出的 major）
  //
  // `body0` 含 `<lrc_memory>…</lrc_memory>` 标签与代码围栏。实测：
  // ```
  // extractTopic('<lrc_memory>\n[约束] 必须是 12 的倍数') → '<lrc_memory>'
  // ```
  // 于是标签支路产出的 Fact 会被标成 `topic:<lrc_memory>`，折叠头也变成
  // `【<lrc_memory>】` —— 一条纯噪声进库。`body` 已剥掉标签与围栏。
  // 统一走 `attachTopic`：让「附加 topic」只有一处实现，
  // 其它产生 Fact 的路径（LLM 兜底）也能复用同一判据。
  if (input.origin === 'assistant') attachTopic(facts, body);

  return { facts, rejected, pending };
}

/**
 * 从推理流提取（工具密集型轮次没有正文时的兜底）。
 *
 * 走**同一个** `extractFacts`；置信度略低，因为推理是模型的内部思考，
 * 措辞更不规整。
 */
export function extractFactsFromReasoning(input: ExtractInput): ExtractResult {
  const result = extractFacts(input);
  return {
    facts: result.facts.map((fact) => ({ ...fact, confidence: Math.min(fact.confidence, 0.8) })),
    rejected: result.rejected,
    pending: result.pending,
  };
}

/**
 * 把 LLM 返回的 `约束：…` 行转成事实。
 *
 * ## 用 `validateJudgedFact` 而不是 `validateFact`（★2026-11-14）
 *
 * 语义**已经由模型裁决**（它明确说「这句是关键信息」），若再用
 * `validateFact` 要求三元组，等于让 95 词白名单获得二次否决权 ——
 * 那正是「开启兜底却补不上定义句」的根因。
 *
 * 模型偶尔把表格行 / JSON 片段 / 半句话当成结论返回，这些是**形态**
 * 问题，由 `validateJudgedFact` 里的结构底线拦（代码判得比模型准）。
 */
export function factsFromLlmLines(
  lines: readonly string[],
  base: { origin: 'user' | 'assistant'; sessionId: string; turn?: number },
): ExtractResult {
  const facts: MemoryFact[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const head = TAG_KIND.exec(line);
    const hint = head !== null ? hintOf(head[1] as string) : undefined;
    const statement = head !== null ? line.slice(head[0].length).trim() : line;
    const fact = makeFact({ statement, ...base, hint, confidence: 0.7 });
    if (fact === null) {
      rejected.push({ text: line, reason: 'no_claim' });
      continue;
    }
    const verdict = validateJudgedFact(fact);
    if (!verdict.ok) {
      rejected.push({ text: line, reason: verdict.reason });
      continue;
    }
    facts.push(fact);
  }
  return { facts, rejected, pending: [] };
}

/**
 * 给一批 Fact 补上**所在消息的主题**（上下文附加）。
 *
 * ## 为什么单独抽成函数（2026-11-17 实测发现）
 *
 * 改造时只在 `extractFacts` 的出口附加了 topic，于是**所有绕过它的路径**
 * 都没有 topic —— 实测新会话里 LLM 兜底写出的 5 条：
 * ```
 * [事实] 现在的兽只有一个静止的点阵，外加一层 CSS 缩放淡入   ← 无 topic
 * [结论] 像素画的动感只能靠逐帧切换                          ← 无 topic
 * ```
 * 这些正是「脱离原文就不知在说谁」的碎片。topic 缺失即上下文锚点缺失。
 *
 * 收成一个入口，让每条产生 Fact 的路径都调用它，不存在「补丁落在路径之外」。
 *
 * @param facts  - 待补 topic 的 Fact（原地修改）
 * @param source - 这批 Fact 的来源正文（用**已清洗**的正文，不要传原始消息）
 */
export function attachTopic(facts: MemoryFact[], source: string | undefined): void {
  if (source === undefined || source.length === 0) return;
  const topic = extractTopic(source);
  if (topic === undefined) return;
  for (const fact of facts) {
    if (fact.topic === undefined) fact.topic = topic;
  }
}

/** 完整同句片段（含路径）用于查重键：避免路径被 mask 掉后相似度虚高。 */
function dedupeKey(fact: MemoryFact): string {
  return maskPaths(fact.statement).replace(/\s+/g, '');
}

/**
 * 批内去重：三元组相同，或陈述高度相似。
 *
 * 六条路径合并后同一条约束可能被两条路径同时抽到，必须在入库前收敛。
 */
export function dedupeFacts(
  incoming: readonly MemoryFact[],
  existing: readonly MemoryFact[],
  isNear: (a: string, b: string) => boolean,
): { fresh: MemoryFact[]; dropped: number } {
  const fresh: MemoryFact[] = [];
  let dropped = 0;
  for (const fact of incoming) {
    const key = dedupeKey(fact);
    const dup =
      fresh.some((f) => dedupeKey(f) === key || isNear(f.statement, fact.statement)) ||
      existing.some((f) => dedupeKey(f) === key || isNear(f.statement, fact.statement));
    if (dup) {
      dropped += 1;
      continue;
    }
    fresh.push(fact);
  }
  return { fresh, dropped };
}
