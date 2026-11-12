/**
 * 沉淀前的三层过滤（**全部在插件端完成，LRC 只负责存**）。
 *
 * ## 为什么不在 LRC 端做
 *
 * LRC 的定位是极速存储基建（写入 ~29ms）。一旦在里面塞 LLM 做语义过滤，
 * 每次写入都要等模型生成，耗时从毫秒级变成秒级，且安装包与本地算力开销
 * 都会失控。筛选、提炼、决定"什么该存"是网关（插件）的职责。
 *
 * ## 三层
 *
 * 1. **硬规则**（`hardFilter`）：寒暄、代码围栏、正常日志、过短且无关键词的行。
 * 2. **宿主 LLM 提炼**（`extractMemoryTag`）：系统提示要求模型在回答末尾输出
 *    `<lrc_memory>决策/约束/结论</lrc_memory>`，这里用正则抠出来。
 * 3. **本地查重**（`isDuplicate`）：Jaccard 相似度，重复复述连 HTTP 都不发。
 *
 * 本模块是纯函数，不依赖 `@deepseek-ai/*`，可直接单测。
 */

/** 模型按系统提示输出的记忆标签。 */
export const MEMORY_TAG_OPEN = '<lrc_memory>';
export const MEMORY_TAG_CLOSE = '</lrc_memory>';

/**
 * 找出所有**行首**标签块。
 *
 * 为什么要求行首：模型会在正文里行内提及标签，例如
 * 「残留漏网依赖 `<lrc_memory>` 层兜底」。用 `indexOf` 找第一个标签会命中
 * 这个行内提及，把整段报告正文当成标签内容切碎入库（实测产出
 * `[结论] <lrc_memory>`、`[结论] ## 验证` 这类碎片）。
 * 真正的标签按系统提示写在回答末尾、独占一行。
 */
function findTagBlocks(text: string): Array<{ start: number; end: number; body: string }> {
  const blocks: Array<{ start: number; end: number; body: string }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith(MEMORY_TAG_OPEN)) {
      const openAt = offset + line.indexOf(MEMORY_TAG_OPEN);
      const closeAt = text.indexOf(MEMORY_TAG_CLOSE, openAt + MEMORY_TAG_OPEN.length);
      if (closeAt >= 0) {
        blocks.push({
          start: openAt,
          end: closeAt + MEMORY_TAG_CLOSE.length,
          body: text.slice(openAt + MEMORY_TAG_OPEN.length, closeAt).trim(),
        });
      }
    }
    offset += line.length + 1;
  }
  return blocks;
}

/**
 * 抠出 `<lrc_memory>…</lrc_memory>` 里的内容。
 *
 * 取**最后一个**行首标签块（真正的标签在回答末尾）。
 * 没有标签、标签为空、标签未闭合都返回 `null` —— 调用方据此退回硬规则。
 */
export function extractMemoryTag(text: string): string | null {
  const blocks = findTagBlocks(text);
  if (blocks.length === 0) return null;
  const body = blocks[blocks.length - 1].body;
  return body.length > 0 ? body : null;
}

/** 去掉所有行首标签块，保留其余正文。 */
export function stripMemoryTag(text: string): string {
  const blocks = findTagBlocks(text);
  if (blocks.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.start);
    cursor = block.end;
  }
  return out + text.slice(cursor);
}

/**
 * 标签内容是否表示"本轮无新增"。
 *
 * 系统提示要求模型**每次都输出标签**，没有可记的就写 `无新增`。
 * 这样触发率可观测，也不会因为模型偶尔省略标签而退回噪声很大的硬规则。
 */
export function isNoUpdate(body: string): boolean {
  const t = body.trim().replace(/[。.!！\s]/g, '').toLowerCase();
  return t === '无新增' || t === '无' || t === 'none' || t === 'noupdate' || t === 'nothing';
}

/** 寒暄词表（去掉标点后整句匹配，避免误伤正文）。 */
const SMALL_TALK = [
  '你好',
  '您好',
  '谢谢',
  '多谢',
  '好的',
  '收到',
  '明白',
  '了解',
  'ok',
  'okay',
  'thanks',
  'thankyou',
  'hello',
  'hi',
];

/** 寒暄判定：去标点后不超过 12 字，且以寒暄词开头。 */
export function isSmallTalk(line: string): boolean {
  const t = line
    .trim()
    .toLowerCase()
    .replace(/[。！!，,、；;：:\s]/g, '');
  if (t.length === 0) return true;
  if (t.length > 12) return false;
  return SMALL_TALK.some((word) => t.startsWith(word));
}

/** 报错标记：命中即视为"值得留"的日志。 */
const ERROR_MARKERS = [
  'error',
  'exception',
  'panic',
  'failed',
  'failure',
  'traceback',
  '错误',
  '异常',
  '失败',
  '报错',
  '崩溃',
  '堆栈',
  '调用栈',
];

export function hasErrorMarker(line: string): boolean {
  // 先挖路径：`[info] 轮转 error.log 完成` 里的 error 是文件名，不是报错。
  const lower = maskPaths(line).toLowerCase();
  return ERROR_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * 是否是"正常日志"行。
 *
 * 终端打印 100 行正常日志对长期记忆毫无价值；只有报错才值得留。
 * 判定只看行首形态（时间戳 / 日志级别），不猜内容。
 */
export function looksLikeNormalLog(line: string): boolean {
  const t = line.trim();
  if (hasErrorMarker(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return true;
  if (/^\[?(INFO|DEBUG|TRACE|VERBOSE)\]?[\s:]/i.test(t)) return true;
  return false;
}

/** 去掉 ``` 围栏代码块，只保留围栏外的说明文字。 */
export function stripCodeFences(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

/**
 * 选项标签：`- **A**：…` / `- 1) …`。
 *
 * 这类行是报告里的"选项罗列 / 待办清单"，不是可复用结论。
 * 实测一次沉淀 11 条里 2 条是 `- **A**：…` 这种片段。
 */
export function isOptionLabel(line: string): boolean {
  const t = line.trim();
  if (/^[-*+]\s*\*\*[A-Za-z0-9]{1,3}\*\*\s*[：:]/.test(t)) return true;
  if (/^[-*+]\s*[A-Za-z0-9]{1,3}[.、)]\s/.test(t)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────
// 词表命中路径
//
// 词表判定全部是 `includes`，天然分不清「正文里的词」和「路径里的词」：
// `见 docs/规范.md`、`materials/架构图.png` 这类纯指针行会因为路径里带
// 「规范 / 架构 / 端口」被当成结论留库；用户消息门槛也会被
// `帮我排版 docs/禁止事项.md` 里的「禁止」骗过。
//
// 因此所有词表判定都先过 `maskPaths()`：把 URL / 绝对路径 / 相对路径 /
// 带扩展名的文件名整段挖成空格，再在剩下的正文上匹配。
// 挖成等长空格而不是删除，是为了让 `explainKeywordHit()` 能报告
// 「命中词来自正文还是路径」。
// ────────────────────────────────────────────────────────────

const PATH_BOUNDARY = '[^\\s，。；：、！？"\'`（）()【】\\[\\]{}<>《》「」]';

/** 路径类 token 的正则（顺序有意义：先 URL，再绝对路径，最后文件名）。 */
const PATH_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+/gi,
  /[A-Za-z]:[\\/][^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*/g,
  /\\\\[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]*/g,
  // 相对路径：**只认 ASCII 路径段**。
  //
  // 不能用 `${PATH_BOUNDARY}*[\\/]${PATH_BOUNDARY}*` —— PATH_BOUNDARY 含 CJK，
  // 会把 `禁止使用3099/3111` 整段挖成空格，真实约束直接丢失（实测回归）。
  // CJK 文件名由下面的扩展名规则兜住（`docs/规范.md` 仍会被完整挖掉）。
  /(?:[A-Za-z0-9_.~-]+[\\/])+[A-Za-z0-9_.~-]*/g,
  new RegExp(
    `${PATH_BOUNDARY}+\\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|ini|cfg|conf|` +
      'png|jpe?g|gif|svg|webp|bmp|pdf|docx?|xlsx?|pptx?|csv|log|exe|dll|so|dylib|lock|' +
      'html?|css|scss|less|py|rs|go|java|kt|sh|ps1|bat|cmd|zip|tar|gz|7z|mp4|mp3|wav)\\b',
    'gi',
  ),
];

/** 把路径类 token 挖成等长空格；返回同长度字符串。 */
export function maskPaths(text: string): string {
  let out = text;
  for (const pattern of PATH_PATTERNS) {
    out = out.replace(pattern, (token) => ' '.repeat(token.length));
  }
  return out;
}

/**
 * 约束词表：**用户消息门槛**与**短行豁免**共用这一份。
 *
 * 以前 `session-text.ts` 里另有一份 `USER_CONSTRAINT_WORDS`，两边只覆盖
 * 「必须/禁止/不要…」这一小撮，结果 `统一用 3111`、`只允许 3111`、
 * `never use 3099` 这类真实约束全被门槛丢掉。词表只留一份，避免再漂移。
 */
export const CONSTRAINT_WORDS = [
  '必须',
  '禁止',
  '严禁',
  '切勿',
  '不得',
  '不能',
  '不要',
  '不会',
  '不用',
  '无需',
  '不需要',
  '不允许',
  '不许',
  '不准',
  '禁用',
  '杜绝',
  '一律',
  '统一',
  '统一为',
  '默认',
  '只允许',
  '只能',
  '务必',
  '一定要',
  '请用',
  '记得',
  '别忘',
  '下次',
  '别用',
  '别再',
  '别动',
  '别改',
  '别删',
  '别碰',
  '别连',
  '别把',
  '别写',
  '别存',
  '别加',
  '改用',
  '换成',
  '改成',
  '以后都',
  '今后都',
];

/** 英文约束标记（用词边界，避免 `notation` 之类误中 `not`）。 */
const ENGLISH_CONSTRAINT =
  /\b(?:never|always|must(?:\s+not)?|should\s+not|do\s+not|don'?t|dont|avoid|forbidden|prohibited|not\s+allowed|only\s+use|required\s+to)\b/i;

/** 短行豁免词表 = 约束词 + 决策/名词类结论标记。 */
const SHORT_LINE_KEYWORDS: readonly string[] = [
  ...new Set([
    ...CONSTRAINT_WORDS,
    '严禁',
    '决定',
    '决策',
    '结论',
    '约束',
    '规范',
    '约定',
    '原则',
    '端口',
    '架构',
  ]),
];

/** 单行最短长度（低于此值且无关键词则丢弃）。 */
const MIN_CHARS = 20;

/** 去掉路径后，正文至少要剩这么多字符，否则视为纯指针行。 */
const MIN_BODY_CHARS = 8;

/** 关键词是否命中**正文**（路径部分已被挖掉）。 */
function hitsKeyword(body: string): boolean {
  if (ENGLISH_CONSTRAINT.test(body)) return true;
  return SHORT_LINE_KEYWORDS.some((k) => body.includes(k));
}

/**
 * 用户消息是否带约束（门槛判定用）。
 *
 * 先挖路径再匹配，所以 `帮我排版 docs/禁止事项.md` 不再因为路径里的
 * 「禁止」通过门槛。
 */
export function hasConstraintMarker(text: string): boolean {
  return hitsKeyword(maskPaths(text));
}

/** 词表命中来源：用来诊断"路径里的词"到底有没有被当成正文关键词。 */
export type KeywordSource = 'body' | 'path';

export interface KeywordHit {
  word: string;
  source: KeywordSource;
}

/**
 * 解释一条文本为什么命中词表（诊断用）。
 *
 * `source === 'path'` 表示只有路径里含该词 —— 这类命中**不参与**
 * 短行豁免与用户门槛判定，仅用于观察。
 */
export function explainKeywordHit(
  text: string,
  words: readonly string[] = SHORT_LINE_KEYWORDS,
): KeywordHit | null {
  const masked = maskPaths(text);
  const bodyWord = words.find((w) => masked.includes(w));
  if (bodyWord !== undefined) return { word: bodyWord, source: 'body' };
  const english = ENGLISH_CONSTRAINT.exec(masked);
  if (english !== null) return { word: english[0].toLowerCase(), source: 'body' };
  const pathWord = words.find((w) => text.includes(w));
  if (pathWord !== undefined) return { word: pathWord, source: 'path' };
  return null;
}

/**
 * 第一层：硬规则过滤。
 *
 * 优先级：`<lrc_memory>` 标签 > 硬规则。有标签时直接用标签内容，
 * 因为那是宿主 LLM 已经提炼过的精粮；标签写 `无新增` 时返回空串
 * （尊重模型的判断，不再退回噪声很大的硬规则）。
 *
 * **必须整段调用**：`stripCodeFences` 要跨行维护围栏状态，
 * 逐行调用会让围栏内的代码直接透传。
 */
export function hardFilter(text: string): string {
  const tag = extractMemoryTag(text);
  if (tag !== null) {
    if (isNoUpdate(tag)) return '';
    // 防御：模型可能在标签里写代码块，同样剥掉
    return stripCodeFences(tag).trim();
  }

  const body = stripCodeFences(stripMemoryTag(text));
  const kept: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (isSmallTalk(line)) continue;
    if (isOptionLabel(line)) continue;
    if (looksLikeNormalLog(line)) continue;
    // 路径先挖掉：`见 docs/规范.md` 不该因为路径里的「规范」被留下。
    const masked = maskPaths(line);
    const hasKeyword = hitsKeyword(masked);
    if (line.length < MIN_CHARS && !hasKeyword) continue;
    // 路径/URL 之外几乎没剩正文 —— 纯指针行，不是结论。
    if (!hasKeyword && masked.replace(/\s+/g, '').length < MIN_BODY_CHARS) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** 决策类词：从正文里识别「已经定下来的做法」。 */
const DECISION_MARKERS = /决定|决策|采用|改用|换成|改成|定为|选型|就用/;

/**
 * 正文里的**过程叙述**：第一人称正在做事，不是结论也不是约束。
 *
 * 与 `conclusionsFromReasoning` 里的 `PROCESS_NARRATION` 不同：那个针对
 * 推理流（英文居多），这个针对**正文答复**（中文居多）。
 */
const PROSE_NARRATION =
  /^(?:我(?:先|来|去|再|正在|会先)|让我|接下来我|下面我|现在(?:我)?(?:来|去)|先(?:看|查|读|试|跑))|(?:检查|查看|读取|尝试|运行)(?:一下|下)/;

/**
 * 「已经在做/刚刚发生」的句式 —— 不是约束。
 *
 * 实测抽到的噪声（session-e1419190）：
 * ```
 * 约束：开工前先定几件事，其余我按默认来          ← 过程安排
 * 约束：你上一轮的意图是「用 mh 创建…」，所以我先确认…  ← 回顾
 * 约束：这个 CLI 现在能启动了，但它默认把缓存写到…      ← 状态陈述
 * ```
 *
 * 这类句子的共同点：描述**已发生**或**即将做**，而不是**必须遵守**。
 *
 * ## ⚠️ 不能用裸字 `过`
 *
 * 首版写成 `/(?:过|正在|...)/`，结果把「必须**通过** --stdin 传入」
 * 「禁止**通过** IDM 下载」「不要**跳过**校验」「必须**经过** 3111」
 * 全部当成过去时误杀 —— 6/6 真实约束被丢弃。这些都是最常见的
 * 执行方式约束，恰好是最高价值的一类。
 *
 * 所以「过去时」只能用**动词后置的时态标记**表达：`试过`、`用过`、
 * `已经…过`，而不是「过」这个字出现在任何位置。
 */
const PAST_OR_PLANNING =
  // 过去时：动词 + 过（且后面是句读/空白，不是「滤/程/度」等构词）
  /(?:试|用|碰|去|做|改|见|跑|查|看|读|写|装|删|加|调|测|验)过(?:[，。；\s]|$)|(?:正在|刚刚|刚才|已经|接着|然后)/;

/**
 * 真正的「约束」形态：情态/祈使/禁止。
 *
 * 比 `CONSTRAINT_WORDS` 更严：词表里的「改用/改成/换成」属于**决策**，
 * 「不会/不用」在过程叙述里也常见（"这个 CLI 不会启动"是状态，不是约束）。
 * 这里只认**强制性**表述，用来区分「约束」与「状态」。
 */
const STRONG_CONSTRAINT =
  /(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律)|(?:不要|不会|不用|别|不能|禁止)(?:用|走|把|在|连|写|加|改|删|碰|跳|绕|省|忽)/;

/**
 * 从**正文**里抽取「约束 / 决策」（不依赖 `<lrc_memory>` 标签）。
 *
 * ## 为什么必须有这一层
 *
 * 系统提示要求「每次回答最后一行必须输出 <lrc_memory>」。实测
 * （session-e1419190，56 条有正文的 assistant 消息）：
 *
 * | 指标 | 数值 |
 * |---|---|
 * | 带标签的轮次 | **1 条（1.8%）** |
 * | 正文长度 P50 | **46 字符** |
 *
 * 98.2% 的轮次没有标签，于是沉淀只能退回硬规则 —— 而硬规则从推理流
 * 抽的是「CLI 已安装」「binary truncated」这类**过程记录**。
 * 这些过程记录被当作「状态」反复注入，与当前任务无关。
 *
 * 这与「模型从未想起调 lrc_recall」是同一个病：**要求模型做一个额外的、
 * 与它当前任务无关的动作，它就不会做**。两次都是如此。
 *
 * ## 做法
 *
 * 模型其实**一直在说**约束和决策，只是混在正常答复里：
 * 「不要用 IDM 下载」、「已改用 --stdin 传入」。这里直接从正文抓这些句子，
 * 不要求它换一种格式重写一遍。
 *
 * @param text - assistant 正文
 * @param maxLines - 最多返回几条
 * @returns 形如 `约束：…` / `决策：…` 的行（可直接喂 `itemsFromTag`）
 */
export function constraintsFromProse(text: string, maxLines = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  // **必须先整段剥掉代码围栏**。
  //
  // 逐句判定时 `stripCodeFences(line) !== line` 是无效的：那时围栏标记
  // 已经被切句切走了，单行内看不到 ```，于是代码行被当成正文抽出来。
  // 实测会把 `const x = 1; // 必须用 const` 抽成「约束」。
  //
  // 同时剥掉 `<lrc_memory>` 标签：标签内容由 `itemsFromTag` 走另一条
  // 高价值路径（绕过 distill）。若不剥，标签里的 `- 决策：…` 会被这里
  // 再抽一次，两条路径内容重复 ⇒ 本地查重拦下另一条，
  // 实测 jaccard=0.98，deduped 计数虚高且白占 recent 窗口。
  const body = stripMemoryTag(stripCodeFences(text));

  // 按句切（含中英文句读），逐句判定
  for (const raw of body.split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/)) {
    const line = raw.trim().replace(/^[-*+\d.)\s]+/, '').trim();
    if (line.length < 8 || line.length > 200) continue;
    if (isSmallTalk(line) || isOptionLabel(line) || looksLikeNormalLog(line)) continue;
    // 兜底：整段剥完围栏后仍以代码特征开头的行（如缩进 4 空格以上的代码）
    if (/^\s{4,}|^(?:const|let|var|function|class|import|export|def|fn)\s/.test(line)) continue;
    // 过程叙述不是约束（"我先看一下文件"）
    if (PROSE_NARRATION.test(line)) continue;

    // 路径先挖掉再匹配，避免 `docs/禁止.md` 骗过判定
    const masked = maskPaths(line);

    // 判定顺序有讲究：先认「决策」（改用/换成），再认「强约束」（必须/禁止）。
    //
    // 不用宽泛的 `CONSTRAINT_WORDS`：实测那样会把「现在改用无 BOM 方式」
    // 「缓存必须放在工作区外」之外的大量**状态陈述**也捞进来
    // （"这个 CLI 现在能启动了"、"刚刚安装完成"），
    // 覆盖率 25% 看似变好，实际一半是噪声。
    const isDecision = DECISION_MARKERS.test(masked);
    const isConstraint = STRONG_CONSTRAINT.test(masked);
    if (!isDecision && !isConstraint) continue;

    // 决策句即使带「了/现在」也要留（"已改用 --stdin" 是有价值的决策）；
    // 约束句若含过去/计划语气，多半是状态描述，丢掉。
    if (!isDecision && PAST_OR_PLANNING.test(masked)) continue;

    const kind = isDecision ? '决策' : '约束';
    const body = line.replace(/^(决策|约束|结论|决定)\s*[：:]\s*/, '').trim();
    if (body.length < 6) continue;

    const key = body.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${kind}：${body}`);
    if (out.length >= maxLines) break;
  }
  return out;
}

/**
 * 结论句标记：推理流里只有带这些词的句子才可能是"结论"。
 *
 * 为什么需要：工具密集型轮次里 assistant 没有正文，`<lrc_memory>` 标签
 * 根本没地方出现（实测 74 步会话正文占比 0%）。整段推理入库会写进大量
 * 内部思考（实测 92 条垃圾），所以只抽带结论标记的句子。
 */
const CONCLUSION_MARKERS = [
  '结论',
  '因此',
  '所以',
  '决定',
  '必须',
  '不能',
  '应该',
  '最终',
  '综上',
  '关键是',
  '根因',
  '原因',
  '方案',
  '改用',
  '采用',
  '确认',
  '发现',
  '注意',
];

/**
 * 英文**强**结论标记：出现即视为结论句。
 *
 * 推理流经常是英文，只认中文标记会把整轮内容漏掉。
 */
const ENGLISH_STRONG =
  /\b(?:therefore|thus|hence|conclusion|concluded|decided|decision|root\s+cause)\b/i;

/**
 * 英文**弱**结论标记：`must` / `should` / `because` 在过程叙述里也常见
 * （"I should check the file"），必须配合长度与句式过滤，否则会灌噪声。
 */
const ENGLISH_WEAK = /\b(?:must|should|need\s+to|because)\b/i;

/**
 * 过程叙述：第一人称 + 动作动词（"I should check the file"），
 * 或明显的步骤引导词。这类句子即使带弱标记也不是结论。
 *
 * 注意不能一刀切掉所有 `I` / `We`：`We should use ctx.get` 是建议，属于结论。
 */
const PROCESS_NARRATION =
  /^(?:(?:I|We)\s+(?:should|need\s+to|will|am|are|'ll|'re)\s+(?:check|look|read|see|try|start|begin|open|run|search|find|verify|inspect|edit|update|fix|add|remove|change)\b|Let\s+me\b|Now\b|First\b|Next\b|Then\b|Okay\b|OK\b|Hmm\b|Wait\b|Looking\b|Checking\b|Reading\b|Let's\b)/i;

/**
 * 从推理流里抽结论句（兜底路径）。
 *
 * 只保留：长度 8~300、带结论标记、不含代码围栏、不是寒暄/选项/正常日志的句子。
 * 去重后最多 `maxLines` 条。
 *
 * @param text - 本轮累计的推理文本
 * @param maxLines - 最多返回几条
 * @param maxChars - 单句字符上限（过长的多半是整段推理，不是结论）
 * @returns 结论句数组（不含前缀，交给 `itemsFromTag` 分类）
 */
export function conclusionsFromReasoning(
  text: string,
  maxLines = 5,
  maxChars = 300,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // 中文按标点切；英文按「句号 + 空白」切（避免把 v0.10.0 这类版本号切开）。
  for (const raw of text.split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/)) {
    const line = raw.trim();
    if (line.length < 8 || line.length > maxChars) continue;
    if (isSmallTalk(line) || isOptionLabel(line) || looksLikeNormalLog(line)) continue;
    if (stripCodeFences(line) !== line) continue;
    const masked = maskPaths(line);
    const chineseHit = CONCLUSION_MARKERS.some((marker) => masked.includes(marker));
    const englishStrong = ENGLISH_STRONG.test(masked);
    const englishWeak = ENGLISH_WEAK.test(masked);
    if (!chineseHit && !englishStrong && !englishWeak) continue;
    // 英文弱标记单独命中时，排除过程叙述与过短句
    if (!chineseHit && !englishStrong && englishWeak) {
      if (line.length < 20 || PROCESS_NARRATION.test(line)) continue;
    }
    const key = line.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

/** 字符级 Jaccard 相似度（与 LRC 的合并判据同口径）。 */
export function jaccard(a: string, b: string): number {
  const setA = new Set(a.replace(/\s+/g, ''));
  const setB = new Set(b.replace(/\s+/g, ''));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 默认查重阈值：与 LRC 的相似合并阈值一致。 */
export const DEFAULT_DEDUP_THRESHOLD = 0.85;

/**
 * 第三层：本地查重。
 *
 * 与"最近已发送的块"比对，高度重合说明是换措辞复述，直接丢弃 ——
 * 连 HTTP 请求都不发。
 */
export function isDuplicate(
  text: string,
  recent: readonly string[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  return recent.some((r) => jaccard(r, t) >= threshold);
}
