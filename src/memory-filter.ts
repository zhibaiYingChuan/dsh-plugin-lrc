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
  // markdown 表格行：`| 0–8s | 一次对话，光点起势… |`
  //
  // 实测这条会以 `[决策] | 0–8s | 一次对话…` 的形式进库并**真的被注入**
  // —— 因为它含「决策」二字命中了词表。表格行永远是片段，不是结论。
  if (/^\|.*\|/.test(t)) return true;
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
    // **短行豁免要包含「资源位置」形态**。
    //
    // 用户交代文件位置时往往极短：「音频在桌面」（5 字）、
    // 「文件放在下载目录了」（9 字）。它们既没有命令式关键词，
    // 也过不了 20 字门槛，于是被整条吞掉 —— 事故里模型缺的正是这条信息。
    //
    // 判据必须用**收窄**的 `isKeyResourceLocation(…, true)`（只认媒体文件 +
    // 紧邻位置词），不能用宽松的 `carriesResourceLocation`：
    // 后者会把 `materials/架构图.png`、`打开 G:\proj\端口.md` 这类纯指针行
    // 当资源位置放行（实测 3/3 误收）。
    const isResourceLine = isKeyResourceLocation(line, true);
    if (line.length < MIN_CHARS && !hasKeyword && !isResourceLine) continue;
    // 路径/URL 之外几乎没剩正文 —— 纯指针行，不是结论。
    // 但资源位置行本身就以路径为主，不能按「剩余正文长度」判死。
    if (!hasKeyword && !isResourceLine && masked.replace(/\s+/g, '').length < MIN_BODY_CHARS) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 决策类词：从正文里识别「已经定下来的做法」。
 *
 * ## 为什么不能是裸 `includes`
 *
 * 裸词会把**名词化 / 计数句**全捞进来，实测污染注入：
 * ```
 * 决策：这次有 3 条关键决策          ← 计数句
 * 决策：| 0–8s | 一次对话，光点起势…  ← 表格行碎片
 * ```
 *
 * ## 但也不能用白名单后接字
 *
 * 上一版写成 `(?:决定|决策)(?:用|采用|走|把|先|是|为|定|改)`，
 * 实测**漏掉 9 条真决策**（比噪声重要得多）：
 * `决定不再使用 IDM`、`决定放弃 IDM`、`决定取消 --json 方案`、
 * `决定停止使用临时目录`、`决定去掉 BOM`、`决定保留 8 个节点`、
 * `决定重写整个场景`、`决定使用 --stdin`。
 * 「决定 + 任意动词」本身就是最标准的决策句式。
 *
 * ## 采用**排除式**
 *
 * 只排除「决策/决定」后面**没有动作**的名词化/计数用法：
 * - `3 条关键决策` / `关键决策是` → 前面是数量词或后面接「的/是/有」
 * - `需要决定` / `要决定` → 前面是情态词（未定）
 *
 * @see `NOMINAL_DECISION` 为对应的排除正则
 */
const DECISION_MARKERS =
  /决定|决策|采用|改用|换成|改成|改到|换到|换为|换了|切成|设为|设成|调成|调为|定为|选型|就用/;

/**
 * 「决策」的**名词化 / 未定 / 被引用**用法（不是已定结论）。
 *
 * - `N 条/个 关键决策`：计数
 * - `需要/要/待 决定`：还没定
 * - `…的决策`：名词短语
 * - `"…决策…"`：**引号里被引用的名词**（实测画面描述里出现
 *   `Deleted item: a block "决策 · 端口纪律 3099/3111" with strike`）
 */
const NOMINAL_DECISION =
  /(?:\d+\s*[条个项]\s*(?:关键)?决策)|(?:(?:需要|要|待|待定|未)\s*决定)|(?:的决策)|(?:决策[到的])|(?:["'「"][^"'」"]*决策[^"'」"]*["'」"])/;

/**
 * 是否是「像样的中文正文」——决策判定的额外闸门。
 *
 * 两个必要条件：
 * 1. 中文字符占比 ≥ 50%（英文推理流里引用中文词不算）
 * 2. **不以代码/参数形态开头**（`hop=5 "…"`、`x = 1` 这类是配置/参数行）
 *
 * 实测被这个闸门挡掉的噪声：
 * ```
 * hop=5 "吃完洗碗，洗碗布该换了"        ← 画面参数行
 * Deleted item: a block "决策 · 端口纪律"  ← 英文描述
 * ```
 */
function looksLikeChineseProse(text: string): boolean {
  // 参数/赋值行：`hop=5 …`、`foo: bar`、`x = 1`
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*/.test(text)) return false;
  // **只有当英文单词占主导时才算英文句**。
  //
  // 不能简单用「中文字符占比 < 50%」：`目前改用 --stdin 传入` 这类
  // 短决策句里 `--stdin` 是 8 个 ASCII 字符，会把占比压到 50% 以下，
  // 实测误杀了「决定使用 --stdin」「决策是改用 --file」等真决策。
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const englishWords = (text.match(/\b[A-Za-z]{3,}\b/g) ?? []).length;
  // 中文一个字都没有 ⇒ 不是中文正文
  if (cjk === 0) return false;
  // 英文单词 ≥ 4 个且明显多于中文字数 ⇒ 是英文叙述
  return !(englishWords >= 4 && englishWords > cjk);
}

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
 * ## 不能用裸字，也不能用常见连接词
 *
 * 两轮都栽在这里：
 *
 * 1. **裸字 `过`**：把「必须**通过** --stdin」「禁止**通过** IDM」
 *    「不要**跳过**校验」全部当过去时误杀（6/6）。
 * 2. **裸词 `然后/接着/已经`**：把「必须先把音频放到 assets，**然后**用
 *    --file 传入」「必须用 --stdin，**然后**再验证」「不要走 IDM，**已经**
 *    说过两次」全部误杀（6/6）。而「先做 A 再做 B」正是执行方式约束的
 *    最常见形态。
 *
 * 判定原则：**有情态词的句子就是约束**，时态词不应覆盖情态词。
 * 所以这里只保留真正表示「过去时/进行中」的标记，且必须紧跟在动词后
 * 或作为句首状语。
 */
const PAST_OR_PLANNING =
  // 仅「动词 + 过」且后接句读（排除 过滤/过程/过度 等构词）
  /(?:试|用|碰|去|做|改|见|跑|查|看|读|写|装|删|加|调|测|验)过(?:[，。；\s]|$)|(?:刚刚|刚才)(?:试|装|跑|执行|验证|看了?)|(?:正在)|(?:目前|已经)(?:完成|安装|验证|确认|试过)/;

/**
 * 真正的「约束」形态：情态/祈使/禁止。
 *
 * 比 `CONSTRAINT_WORDS` 更严：词表里的「改用/改成/换成」属于**决策**，
 * 「不会/不用」在过程叙述里也常见（"这个 CLI 不会启动"是状态，不是约束）。
 * 这里只认**强制性**表述，用来区分「约束」与「状态」。
 */
const STRONG_CONSTRAINT =
  /(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律)|(?:请勿|勿)(?:使用|用|走|通过|点击|下载)|(?:不要|不会|不用|别|不能|禁止)(?:再|再次|再一次|重复|继续)?(?:直接)?(?:使用|使|去|用|走|通过|把|在|连|写|加|改|删|碰|跳|绕|省|忽|下载|调用|点)/;

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

  // 硬排除 markdown 表格行 / 标题行：它们永远是片段，不是可复用结论。
  //   `| 0–8s | 一次对话，光点起势… |` 因为含「决策」二字被抽成
  //   `[决策] | 0–8s | …` 并**真的进了注入内容**（实测）。
  const source = text.replace(/^\s*\|.*\|\s*$/gm, ' ').replace(/^\s*#{1,6}\s.*$/gm, ' ');

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
  const body = stripMemoryTag(stripCodeFences(source));

  // 按句切（含中英文句读），逐句判定
  for (const raw of body.split(/[。！？；\n]+|(?<=[A-Za-z0-9])\.\s+/)) {
    const line = raw.trim().replace(/^[-*+\d.)\s]+/, '').trim();
    if (line.length > 200) continue;
    if (isSmallTalk(line) || isOptionLabel(line) || looksLikeNormalLog(line)) continue;
    // 兜底：整段剥完围栏后仍以代码特征开头的行（如缩进 4 空格以上的代码）
    if (/^\s{4,}|^(?:const|let|var|function|class|import|export|def|fn)\s/.test(line)) continue;
    // 过程叙述不是约束（"我先看一下文件"）
    if (PROSE_NARRATION.test(line)) continue;

    // 路径先挖掉再匹配，避免 `docs/禁止.md` 骗过判定
    const masked = maskPaths(line);

    // ## 长度门槛分层：短约束不能被一刀切掉
    //
    // 原来统一要求 `length >= 8`，于是「不要跳过校验」（6 字）、
    // 「不要走 IDM」（7 字）这类**最典型的短约束**整条被丢 ——
    // 而它们正是用户最常说的形态（越短越像命令，越长越像叙述）。
    //
    // 现在：普通句子仍需 8 字；**命中强情态词的放宽到 4 字**
    // （「别用 IDM」= 5 字也要能进）。
    const strongHit = STRONG_CONSTRAINT.test(masked);
    if (line.length < (strongHit ? 4 : 8)) continue;

    // 判定顺序有讲究：先认「决策」（改用/换成），再认「强约束」（必须/禁止）。
    //
    // 不用宽泛的 `CONSTRAINT_WORDS`：实测那样会把大量**状态陈述**也捞进来
    // （"这个 CLI 现在能启动了"、"刚刚安装完成"），
    // 覆盖率看似变好，实际一半是噪声。
    const isDecision = DECISION_MARKERS.test(masked) && !NOMINAL_DECISION.test(masked);
    const isConstraint = STRONG_CONSTRAINT.test(masked);
    if (!isDecision && !isConstraint) continue;

    // 决策类判定额外要求「这是中文正文」：英文推理流里引用中文词
    // （`a block "决策 · 端口纪律" with strike`）会被裸词「决策」骗过，
    // 实测这类 4 条以 decision 入池并进入注入。
    if (isDecision && !isConstraint && !looksLikeChineseProse(line)) continue;

    // **情态词优先于时态词**：带「必须/禁止/不要」的句子就是约束，
    // 即使句中有「然后/已经/现在」。
    //
    // 实测误杀（两轮各一批）：
    // 「必须先把音频放到 assets，然后用 --file 传入」← 被「然后」杀掉
    // 「不要走 IDM 下载，已经说过两次了」        ← 被「已经」杀掉
    // 「必须用 --stdin 传入，然后再验证一次」      ← 被「然后」杀掉
    // 而「先做 A 再做 B」正是执行方式约束最常见的形态。
    //
    // 时态排除只对**纯状态陈述**生效：不含强情态词、只靠 DECISION_MARKERS
    // 里的弱词（如「就用」）命中的句子。
    if (!isConstraint && PAST_OR_PLANNING.test(masked)) continue;

    const kind = isDecision && !isConstraint ? '决策' : '约束';
    const body = line.replace(/^(决策|约束|结论|决定)\s*[：:]\s*/, '').trim();
    // 同样的分层：「不要走 IDM」去掉标点后只有 9 字符，强约束不该被再砍一刀
    if (body.length < (strongHit ? 4 : 6)) continue;

    const key = body.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${kind}：${body}`);
    if (out.length >= maxLines) break;
  }
  return out;
}

/**
 * 文本是否携带**具体资源位置**（路径 / 媒体文件名 / 桌面这类位置词）。
 *
 * ## 为什么单列这一条
 *
 * 真实事故里最关键的一条用户消息是：
 * ```
 * D:\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务
 * ```
 * 它既没有约束词，也不是纠正句式 —— `hasConstraintMarker` 与
 * `constraintsFromUser` 双双漏过，于是「音频在桌面」从未入库。
 * 而模型缺的正是这个事实，只能去点下载链接，最终引出用户的第二次纠正。
 *
 * ## 两处使用
 *
 * 1. `session-text.ts` 的用户消息门槛（让它进沉淀源）
 * 2. `offloader.ts` 的快照取词（让它**排到注入内容里**）
 *
 * 第 2 处是事故真正没被修完的地方：事实进了库，但 `rank()` 把它归到
 * `code_context`（最低优先级），在 `snapshotItems=3` 且高价值条目充足时
 * **永远不会被注入** —— 「进了库但注入不到」等于没进。
 *
 * 判据只看**结构特征**，不猜语义。这类消息在真实会话里极少（5 条里 1 条），
 * 误收代价低，而漏收的代价是整个任务方向跑偏。
 */
export function carriesResourceLocation(text: string): boolean {
  // 盘符绝对路径（D:\Desktop、C:/Users/xxx）。
  //
  // 必须先在**去掉 URL** 的文本上判断：`https://` 里的 `s:/` 会被
  // `[A-Za-z]:[\\/]` 命中，于是「https://github.com/… 做个视频」这类
  // 纯任务描述会被误判成资源位置（实测真实 seq=620 就中招）。
  const withoutUrls = text.replace(/\bhttps?:\/\/\S+/gi, ' ');
  if (/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(withoutUrls)) return true;
  // 带**媒体/素材**类扩展名的文件名（score-Dtle1HAU.wav）。
  //
  // 刻意**不收**代码/文档扩展名（.ts/.md/.json…）：用户说
  // 「帮我排版 docs/禁止事项.md」是在交代任务对象，不是「资源在哪」；
  // 放进来会把大量普通任务描述灌进沉淀源（实测该门槛被 `docs/禁止事项.md`
  // 直接骗过，把整条普通指令当成约束入库）。
  if (
    /[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // 用户口语里常见的「在桌面 / 在下载目录」+ 资源名词
  if (/(?:桌面|downloads?|下载目录|文档目录|视频目录)/i.test(text) && /(?:音频|视频|文件|素材|图片|脚本)/.test(text)) {
    return true;
  }
  return false;
}

/**
 * 是否是**用户交代的关键资源位置**（用于快照提权）。
 *
 * ## 为什么不能用黑名单
 *
 * 前两版都栽在这里：
 * 1. 用宽松的 `carriesResourceLocation` ⇒ 助手正文里 `G:\loong 是仓库`
 *    也被提权，rank0 从 5 条膨胀到 13 条，IDM 约束注入 4 → **0** 次。
 * 2. 改成「媒体扩展名 + 过程词黑名单」⇒ 英文推理句
 *    `…fails with "unsupported format"… score.wav is 10MB` 既含 `.wav`
 *    又没命中黑名单词，仍被判为关键资源，**抢走预留槽位**：
 *    真实重放里真资源位置注入 **1/17** 次（剔除它后升到 7/17）。
 *
 * 黑名单永远补不全（`验证通过`/`已导入`/`too large`/`unsupported`…）。
 *
 * ## 改成「位置指示词」白名单
 *
 * 事故里真正缺的信息是「文件**在哪**」。所以要求同时满足：
 * 1. 含媒体类文件 token（`.wav/.mp3/.mp4/...`）
 * 2. 含**位置指示词**：`在/位于/放到/放在/存在/桌面/路径/目录/来自`，
 *    或行首直接就是路径（`D:\Desktop，score.wav`）
 *
 * 这样：
 * - `D:\Desktop，score-Dtle1HAU.wav，这是你要打音频` ✓（行首路径）
 * - `音频文件是 assets/bgm.wav` ✓（有 `是`…但需位置词，见下）
 * - `score.wav is 10MB` ✗（只是描述大小，没有位置）
 * - `assets/score.wav 的 MD5 一致` ✗
 * - `G:\loong 是仓库` ✗（没有媒体扩展名）
 *
 * 英文句也一并排除：`fail/error/unsupported/too large/Hmm/Let me` 这类
 * 是推理过程，不是交代位置。
 */
/**
 * 位置词：**只用于「紧邻」形态判断，不再单独作为闸门**。
 *
 * 早期版本用它做独立闸门（`LOCATION_HINT.test(body)`），但裸「在」是中文
 * 最高频虚词，于是任何日常句都命中：
 * ```
 * 现在把 assets/bgm.mp3 处理一下   ← 有「在」（现在）
 * 正在生成封面.png                ← 有「在」（正在）
 * 你在吗，assets/bgm.mp3 卡住了     ← 有「在」（你在吗）
 * ```
 * 实测这 3 条会被判成资源位置并 pin 进池，**把真资源位置挤掉**。
 *
 * 现在只认「紧邻」形态（见下方 `ADJACENT_LOCATION`）。
 */
const LOCATION_HINT = /(?:位于|放在|放到|存在|路径|目录|桌面|来自|下载目录|素材库)/;
const ENGLISH_PROCESS = /\b(?:fail|error|unsupported|unrecognized|too\s+large|hmm|let\s+me|maybe|tries?\s+to)\b/i;
/**
 * 中文**过程结论**词：说明「对文件做了什么/校验结果」，不是「文件在哪」。
 *
 * 实测误报（第十二轮）：
 * ```
 * 桌面上的文件与 assets/score.wav 的 MD5 一致   ← 有「桌面」也命中 LOCATION_HINT
 * 音频已经验证通过，位于 assets/bgm.mp3         ← 有「位于」
 * ```
 * 它们讲的是校验结果/状态，模型拿到它对「源文件在哪」毫无帮助。
 */
const PROCESS_CONCLUSION_CN = /(?:MD5|哈希|一致|已确认|已验证|验证通过|已生成|已删除|已复制|已上传|已导入|处理完毕|测试通过|校验)/;
const MEDIA_FILE = /[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp)\b/i;
/** 行首就是盘符路径（`D:\Desktop，score.wav`）—— 用户直接贴位置的最常见形态。 */
const LEADING_PATH = /^\s*(?:\[[^\]]+\]\s*)?(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * 是否是**用户交代的关键资源位置**（用于快照提权）。
 *
 * ## 必须传 `fromUser`，判据必须看「谁在说」
 *
 * 这是三轮反复踩的同一个坑：
 *
 * | 版本 | 判据 | 结果 |
 * |---|---|---|
 * | v1 | 宽松 `carriesResourceLocation` | 助手正文 `G:\loong 是仓库` 也提权，IDM 注入 4→**0** |
 * | v2 | 媒体扩展名 + 过程词黑名单 | 英文推理句 `score.wav is 10MB` 冒充，真位置 **1/17** |
 * | v3 | 位置词白名单 | 英文假货消失，但**中文助手结论**顶上来：`桌面上的文件与 assets/score.wav 的 MD5 一致` 抢走预留槽，真位置 **1/16** |
 *
 * 大病根不在词表，在**没有来源维度**：助手在正文里陈述「某文件和某文件一致」
 * 与用户交代「文件在桌面」在文本形态上无法区分，靠加词永远追不上。
 *
 * 所以：**只有用户说的话才提权**。助手正文里的一切（哪怕是「音频在桌面」）
 * 都交由 `rank` 的常规优先级处理。
 *
 * @param text - 条目内容
 * @param fromUser - 是否来自用户消息（`index.ts` 的 `user/message` 分支）
 */
export function isKeyResourceLocation(text: string, fromUser: boolean): boolean {
  if (!fromUser) return false;
  // 先剥 URL：`https://example.com/shot.png` 不该被当成资源位置
  const body = text.replace(/\bhttps?:\/\/\S+/gi, ' ');
  // 英文推理过程句排除
  if (ENGLISH_PROCESS.test(body)) return false;

  const hasMediaFile = MEDIA_FILE.test(body);
  // ## 位置信号必须严格，不能用宽泛的位置词
  //
  // 早期用 `LOCATION_HINT`（含「桌面/目录/在」）做闸门，实测三条误报：
  // ```
  // 桌面上的文件与 assets/score.wav 的 MD5 一致     ← 命中「桌面」
  // 音频已经验证通过，位于 assets/bgm.mp3          ← 命中「位于」
  // 正在生成封面.png                              ← 命中弱判据的「封面在」
  // ```
  // 它们讲的都是**过程/状态**，不是「文件在哪」。
  //
  // 所以位置信号只认两种**不可伪造**的形态：
  // 1. 行首盘符路径（`D:\Desktop，score.wav`）
  // 2. 「资源名词 紧邻 位置词」（`音频在`、`文件放在`），中间最多 2 字
  const RES = '(?:音频|视频|文件|素材|图片|脚本|封面|成片|录音|音乐)';
  /**
   * 「在」后面必须接的**真正位置**（白名单）。
   *
   * ## 为什么不判断「在」本身
   *
   * 这是四轮反复踩坑的根因：「在」是中文最高频虚词，任何基于它的
   * 形状匹配都会漂移。逐次失败记录：
   *
   * | 版本 | 判据 | 后果 |
   * |---|---|---|
   * | v1 | `LOCATION_HINT` 含裸「在」 | `现在把 x 处理一下` 命中「现在」→ 抢槽 |
   * | v2 | 加 `ACTION_VERB` 整句否决 | 误杀「音频在桌面，你处理一下」10/11 |
   * | v3 | 加 `正在/现在` 整句否决 | 误杀「音频现在在桌面」11/11 |
   * | v4 | `FORWARD` 放宽到 4 字 | `音频处理好了在后台排队` 等 6 条新误报 |
   *
   * 根因不在「用哪个词排除」，而在**「在」的宾语没被验证**：
   * 「在桌面」是位置，「在后台/在 3 秒后/在队列里」是处所或时间。
   *
   * ## 改成：`在` 后必须紧跟位置性词
   *
   * 白名单是**收敛的**（位置词是有限集合），黑名单是**发散的**
   * （处所/时间副词补不完）。所以只认白名单。
   */
  // ## 白名单必须覆盖中文真实口语位置
  //
  // 只收「英文构建目录名 + 少量中文目录词」时实测 25/29 条真实位置被判 false，
  // 其中 `音频在 C 盘`、`音频在网盘里`、`音频在当前目录`、`音频在这里`
  // 都是主干说法，且漏报会让两条路同时死（`isKey=false` + `hardFilter` 空）
  // ⇒ 位置事实**彻底丢失**，正是事故 B 的原始形态。
  //
  // 漏报代价 > 误报代价：误报只占一个槽（可恢复），漏报丢一条事实（不可恢复）。
  const PLACE = [
    // 目录 / 介质
    '桌面', '下载目录', '目录', '文件夹', '盘', '硬盘', '网盘', '云盘', 'U\\s*盘', '移动硬盘',
    '本地', '本机', '电脑', '服务器', '共享', 'onedrive', '素材库',
    // 工程目录
    'assets', 'build', 'dist', 'public', 'tmp', 'temp', '项目', '工程', '工作区',
    // 指示位置
    '当前', '上级', '这里', '这儿', '那儿', '路径', '根目录', '子目录', '同目录', '子文件夹',
    // 盘符（C 盘 / D盘 / D:\\ / C:/）
    '[A-Za-z]\\s*盘', '[A-Za-z]:[\\\\/]',
  ].join('|');
  // `在` 后（允许空格与「我的/这个/那个」这类修饰语）跟位置白名单，或直接跟媒体文件
  const LOC = `(?:(?:位于|放在|放到|存在|来自|存到|拷到|复制到)|在[\\s]*(?:我的|这个|那个|本地|本机)?[\\s]*(?:${PLACE})|在[\\s]*[^\\s，。；：]{0,40}\\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp))`;
  // 正向形态放宽到 4 字：中文里常插时间副词（`音频**目前还**在桌面`）。
  // 反向形态保持 2 字：`位于`/`放在` 这类双字词后不会插副词。
  const FORWARD = new RegExp(`${RES}.{0,4}${LOC}`);
  const REVERSE = new RegExp(
    `(?:位于|放在|放到|存在|来自|存到|拷到|复制到).{0,2}${RES}`,
  );
  // ## 判定范围：**位置短语所在的那一小句**，不是整句
  //
  // 这是六轮反复踩坑的同一个错误：每次都用「整句 return false」修误报，
  // 每次都会连带清掉同一句里的真位置。失败记录：
  // ```
  // 音频在桌面，被覆盖了              ← 位置有效，被 PASSIVE_VOICE 整句否掉
  // 音频在桌面，你看下多少个文件        ← 位置有效，被 QUESTION_WORD 整句否掉
  // 音频在 C 盘，有多少个版本你数一下    ← 同上
  // 音频在桌面，什么格式都行            ← 同上
  // ```
  // 正确做法：先把句子按逗号/句读切成小句，只在**含位置短语的那一小句**里
  // 检查疑问/被动。`音频在桌面 | 被覆盖了` 第二句不含位置，不影响判定。
  const QUESTION_WORD = /(?:什么|多少|怎么|哪些|几个|几次|哪一个|有没有|是否|吗|还是|哪里|哪儿)/;
  const PASSIVE_VOICE = /(?:被|遭到|受到)(?:压缩|清掉|清空|删除|删了|打包|覆盖|处理|替换|修改|重写|移除)/;

  /**
   * 取「位置短语所在的小句」：按逗号/句读切，返回第一个含位置词的小句。
   *
   * 若切不出（整句没有标点），退回整句。
   */
  const clauseWithLocation = (): string => {
    const clauses = body.split(/[，。；、！？,;!?]+/);
    for (const c of clauses) {
      if (FORWARD.test(c) || REVERSE.test(c)) return c;
    }
    return body;
  };

  const target = clauseWithLocation();
  const strongLocation =
    (FORWARD.test(target) || REVERSE.test(target)) &&
    !/(?:在|位于|放在|放到|存在|来自)的/.test(target) &&
    !QUESTION_WORD.test(target) &&
    !PASSIVE_VOICE.test(target);
  const hasLocationSignal = LEADING_PATH.test(body) || strongLocation;

  // ## 过程词只在**没有位置信号**时否决
  //
  // 上一版把过程词检查放在最前面，于是「真位置 + 顺带提到校验」被整句判死：
  // ```
  // 音频在桌面，校验一下 MD5                 ← 位置是真的，被判 false
  // 素材位于 assets/score.wav，和之前的一致     ← 同上
  // ```
  if (!hasLocationSignal && PROCESS_CONCLUSION_CN.test(body)) return false;

  // ── 强判据：媒体文件扩展名 / 行首盘符路径 ──
  //
  // ## 必须排除两种「只有路径、没有交代」的形态
  //
  // 1. **整行就是一个带目录的裸路径**：`materials/架构图.png`、`G:\proj\端口.md`
  //    —— 这是「见这个文件」，不是「资源在哪」。
  // 2. **整行就是一个裸文件名**：`score-Dtle1HAU.wav`
  //    —— 同理。上一版 `isBarePath` 只认含 `[\\/]` 的形态，裸文件名漏过，
  //    实测它会被标成 `origin=user` 并独占预留槽位：
  //    `maxItems=2 → [LRC 状态] score-Dtle1HAU.wav；不要走 IDM 下载音频`
  //
  // 判据统一为：**整行除了这个文件 token 之外没有别的实质内容** ⇒ 是纯指针行。
  // 真实的资源位置交代一定带说明或位置词：
  // `D:\Desktop，score-Dtle1HAU.wav，这是你要打音频`。
  const withoutFileToken = body.replace(
    /[^\s，。；：、！？"'`（）()【】\[\]{}<>《》「」]+\.(?:wav|mp3|mp4|mov|avi|mkv|flac|m4a|aac|png|jpe?g|gif|webp|bmp)/gi,
    '',
  );
  // 去掉文件 token 后剩下的「实质字符」（排除标点与空白）
  const residue = withoutFileToken.replace(/[\s，。；：、！？,.;:!?"'`（）()【】\[\]{}<>《》「」\\/-]/g, '');
  const isPointerOnly = hasMediaFile && residue.length <= 2;
  if (!isPointerOnly) {
    // ## 有媒体文件还不够，必须**同时**有「交代位置」的信号
    //
    // 上一版这里只判 `hasMediaFile` ⇒ 任何「随口提到媒体文件」的句子都被
    // 提升为资源位置并 pin 进池（最多 2 条），挤掉真正的约束。实测误报：
    // ```
    // 帮我检查一下 assets/bgm.mp3 的音质        ← 让我做事，不是交代位置
    // assets/bgm.mp3 的时长是 55 秒吗           ← 在问问题
    // 我把 score.wav 换成了新的版本             ← 说动作
    // 封面.png 换成暗金色试试                   ← 说改动
    // 现在把 assets/bgm.mp3 处理一下            ← 只有「在」（现在）
    // 正在生成封面.png                          ← 只有「在」（正在）
    // ```
    // 所以位置信号必须用**紧邻形态**（`hasLocationSignal`），
    // 不能用裸「在」——那是中文里最高频的虚词，任何句子都会命中。
    if (hasMediaFile && hasLocationSignal) return true;
    if (LEADING_PATH.test(body) && /(?:音频|视频|文件|素材|图片|脚本|封面|成片)/.test(body)) return true;
  }

  // ── 弱判据：口语形态「音频在桌面」──
  //
  // **必须要求位置词紧邻资源名词**，不能各自独立出现。
  //
  // 实测教训：宽松版（位置词 + 资源名词，各自出现即可）会把用户的
  // **纠正句**也判成位置交代：
  // ```
  // 不是告诉你音频在的位置了吗？你一点击下载，就会调取桌面的IDM…
  //                          ↑ 有「在」+ 有「音频」⇒ 误判 isKey=true
  // ```
  // 后果：它抢走预留槽位，真正的 `D:\Desktop，score-Dtle1HAU.wav` 落选。
  // 真实回放实测：音频命中 **1/16**、资格窗口 **0/3**；
  // 收紧成「紧邻」后升到 **3/15**、资格窗口 **2/2**。
  //
  // 要求形态：`<资源名词><位置词>` 或 `<位置词><资源名词>`，中间最多 2 个字。
  //
  // ## 必须排除「…的位置」形态
  //
  // 「不是告诉你**音频在的位置**了吗」里 `音频在` 是紧邻的，但它说的是
  // 「音频所在的位置」这个概念，不是「音频在桌面」。所以位置词后面
  // 若紧跟 `的`（`在的` / `放到的`），说明是在**指代**而非陈述位置。
  if (!strongLocation) return false;
  return true;
}

/**
 * 用户**纠正 / 重申**的句式标记。
 *
 * ## 为什么单列这一类
 *
 * `hasConstraintMarker` 只认「必须/禁止/不要」这类命令式词。而真实会话里，
 * 用户最关键的约束往往是用**反问句**表达的纠正 —— 实测（session-e1419190）：
 *
 * ```
 * seq=1682 「不是告诉你音频在的位置了吗？你一点击下载，就会调取桌面的
 *            IDM 的下载软件…」
 * ```
 *
 * 这一条三重落空：`hasConstraintMarker=false`（没有命令式词）、
 * `linesFromSession` 收不到、模型也从未在正文复述 ⇒ 约束从未入库，
 * 下一轮模型照旧去点下载链接。
 *
 * 反问句是**最强的纠正信号**：它在指出「我已经说过了」。这类句子必须入库。
 */
const USER_CORRECTION =
  // 必须**有第二人称指向 + 完成态**（你）或「说过 N 次」的明确重申。
  //
  // ## 收得多紧，为什么
  //
  // `index.ts` 里这条路径直接 migrate 进长期记忆，**无法撤回**，
  // 且 `recall` 会把它当「用户约束」反复召回。而用户消息量远大于
  // assistant 正文，误收代价不对称。
  //
  // 两次收紧的实测依据：
  // 1. 裸 `不是说` → 「不是 X，是 Y」解释句 4/4 误收（见 `NEGATION_EXPLANATION`）。
  // 2. 裸 `我跟你说` → 寒暄/开场白 4/4 误收：
  //    「我跟你说一下，这个视频还要改」「我跟你说，这个音频就在桌面」
  //    「你再说一次刚才那个命令」「我说过两次了，你怎么还这样」
  //    因此 `我跟你说` 必须带**完成/指向**后缀（说过 / 的是），
  //    `再说一次` 必须后接否定或更正，不能是「请再说一遍」。
  /(?:不是(?:已经)?(?:告诉|跟|给|对)(?:过)?你)|(?:我(?:已经|早就)?(?:跟你说过|告诉过你|讲过|强调过|说的是|要的是))|(?:说(?:过|了)(?:两|三|好几|\d+)次)|(?:强调|重申)(?:过|一?次)/;

/**
 * 用户消息是否在「质疑模型的具体行为」。
 *
 * ## 为什么需要这道闸门
 *
 * 纠正句的共性不是句式，而是**指向模型的错误动作**：
 * 「你一点击下载，就会调取 IDM」—— 有第二人称 + 动作动词 + 否定/危害。
 * 单纯「我跟你说…」只是开场白。
 *
 * 判据：同句含 `你`，且含「动作动词 + 否定/危害」或明确禁令。
 * 这一条把「你再说一次刚才那个命令」这类也挡掉（提问，不是纠正）。
 */
function isBehaviorCorrection(text: string): boolean {
  if (!/你/.test(text)) return false;
  // 否定/危害信号：会调起、就会、会下载、不知道…哪、别再、不要、不能
  const hasHarm =
    /(?:就会|会(?:调起|调取|触发|下载|覆盖|删)|不知(?:道|会)|别再|不要|不能|禁止|必须|改用)/.test(text);
  return hasHarm;
}

/**
 * 「否定 + 转折解释」句式：`不是 X，是 Y` / `不是 X 而是 Y`。
 *
 * ## 为什么要排除
 *
 * `不是说` 这类片段在中文里**大量出现在解释句**中，与「纠正」无关：
 * ```
 * 这个不是说明书的写法，你去看一下第三章
 * 这两个文件不是说明关系，是引用关系
 * 不是说这个方案不行，是成本太高
 * 我不是说我不同意，是说要先确认
 * ```
 * 实测 4/4 全部被误收成 `约束：…` 并 migrate 进长期记忆。
 * 用户消息量远大于 assistant 正文，这条新通路一旦误收就无法撤回
 * （`recall` 会把它当用户约束反复召回）。
 *
 * 判据：`不是` 之后出现 `，是` / `而是` / `是` 引导的转折，且**同句不含**
 * 强情态词 —— 那是在解释，不是在立规矩。
 */
const NEGATION_EXPLANATION = /不是[^。！？；\n]{0,30}(?:，|,)?\s*(?:而是|是)[^。！？；\n]*/;

/**
 * 从**用户消息**里抽取约束（不依赖命令式词表）。
 *
 * ## 为什么不能复用 `constraintsFromProse`
 *
 * 那个函数是给 assistant 正文用的，它的判定核心是「强情态词」
 * （必须/禁止/不要）。用户消息里最关键的约束常常没有这些词，
 * 而是「不是告诉你…了吗」这种纠正句式 —— 实测唯一提到 IDM 的那条
 * 用户消息因此完全没进沉淀源。
 *
 * ## 判定
 *
 * 按句切分，命中「纠正/重申」句式即入选；纠正句的**下一句**一并带上 ——
 * 用户纠正后通常紧接着说正确做法（「你一点击下载就会调起 IDM」），
 * 那才是可执行的信息。
 *
 * @param text - 用户消息正文
 * @param maxLines - 最多返回几条
 * @returns 形如 `约束：…` 的行（可直接喂 `itemsFromTag`）
 */
export function constraintsFromUser(text: string, maxLines = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const sentences = stripCodeFences(text)
    .split(/[。！？；\n]+/)
    .map((s) => s.trim().replace(/^[-*+\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 6 && s.length <= 200);

  for (let i = 0; i < sentences.length; i += 1) {
    const line = sentences[i] as string;
    if (isSmallTalk(line) || looksLikeNormalLog(line)) continue;
    const masked = maskPaths(line);
    // 命令式约束已在 `hasConstraintMarker` 那条路上处理；这里只补纠正句式
    if (!USER_CORRECTION.test(masked)) continue;

    // 纠正句后面那句通常是「正确做法」（「你一点击下载就会调起 IDM」），
    // 判定与入库都必须把它算进来：真实那条 IDM 消息被 `？` 切成两句，
    // 纠正句式在前句、危害描述在后句，只看单句会把行为闸门判错。
    const next = sentences[i + 1];
    const nextUsable = next !== undefined && next.length >= 6 && next.length <= 120 && !isSmallTalk(next);
    const window = nextUsable ? `${line}；${next}` : line;
    const maskedWindow = maskPaths(window);

    // 「不是 X，是 Y」是解释句，不是纠正 —— 除非同句另有强情态词
    if (NEGATION_EXPLANATION.test(maskedWindow) && !STRONG_CONSTRAINT.test(maskedWindow)) continue;
    // 必须指向模型的**具体行为**，否则只是开场白/提问（见 `isBehaviorCorrection`）
    if (!isBehaviorCorrection(maskedWindow)) continue;

    const body = line.replace(/^(决策|约束|结论|决定)\s*[：:]\s*/, '').trim();
    const merged = nextUsable ? `${body}；${next}` : body;
    // 句尾问号对入库无意义，去掉
    const cleaned = merged.replace(/[？?]+$/, '').trim();
    if (cleaned.length < 6) continue;
    const key = cleaned.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`约束：${cleaned}`);
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

/**
 * 提取「取值型 token」：包名、端口、路径、文件名、参数等。
 *
 * 这些才是约束之间**真正的差异所在**：
 * `必须用 pnpm` 与 `必须用 npm`、`必须用 3111` 与 `必须用 3113`。
 */
function valueTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.\-/\\]*|\d+/g)) {
    const t = m[0].toLowerCase();
    if (t.length >= 1) out.push(t);
  }
  return out;
}

/**
 * 中文里「一个字的差别就翻转语义」的对立词对。
 *
 * ## 为什么需要单独一张表
 *
 * `valueTokens` 只抓 ASCII（包名/端口/路径），对**纯中文的取值差异**完全无感。
 * 实测误判：
 * ```
 * j=0.917  「必须放在工作区之外…」 vs 「必须放在工作区之内…」   ← 语义相反
 * j=0.875  「必须用中文回答」      vs 「必须用英文回答」        ← 语义相反
 * ```
 * 后果与 pnpm/npm 完全相同：`isDuplicate` 在**入库前**判重，
 * 用户的更正直接不发 HTTP ⇒ LRC 里永远留着旧的那条，recall 反复召回错值。
 *
 * ## 判据
 *
 * 两条文本**各自包含对立词对中的不同一端** ⇒ 一定是不同约束。
 * 只做二元对立，不做通用中文分词（那会显著抬高误判面）。
 */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['之外', '之内'],
  ['以外', '以内'],
  ['中文', '英文'],
  ['启用', '禁用'],
  ['保留', '删除'],
  ['删除', '保留'],
  ['开头', '结尾'],
  ['前面', '后面'],
  ['之前', '之后'],
  ['同步', '异步'],
  ['包含', '排除'],
];

/**
 * 两条文本是否在某个对立词对上取了**相反**的值。
 *
 * @returns 存在对立差异时返回该词对；否则 null
 */
function antonymConflict(a: string, b: string): [string, string] | null {
  for (const [x, y] of ANTONYM_PAIRS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) return [x, y];
  }
  return null;
}

/**
 * 判断两条内容是否「近似重复」。
 *
 * ## 为什么不能只用字符集 Jaccard
 *
 * 字符集对「同句式、差一两个取值」完全不敏感 —— 而这恰是约束最关键的
 * 差异。实测误判（9/13）：
 * ```
 * 1.000  「必须用 pnpm」 vs 「必须用 npm」       ← 字符集合完全相同
 * 1.000  「必须用 3111」 vs 「必须用 3113」
 * 0.875  「缓存放 mh 目录」 vs 「缓存放 mh2 目录」
 * ```
 * 后果不只是快照去重，而是 `isDuplicate` 在**入库前**就丢掉：
 * 用户说「改用 npm」，被判为复述直接不发 HTTP ⇒ LRC 里永远是旧值，
 * 后续 recall 一直召回过期约束。
 *
 * ## 三层判据
 *
 * 1. **ASCII 取值 token 不同** ⇒ 不同（pnpm/npm、3111/3113）
 * 2. **中文对立词取了相反端** ⇒ 不同（之外/之内、中文/英文）
 * 3. 否则才用字符集 Jaccard 判近似（处理「工作区外」/「工作区之外」这类改写）
 */
export function areNearDuplicate(a: string, b: string, threshold: number): boolean {
  const va = valueTokens(a);
  const vb = valueTokens(b);
  if (va.length > 0 && vb.length > 0) {
    const sa = new Set(va);
    const sb = new Set(vb);
    const same = va.every((x) => sb.has(x)) && vb.every((x) => sa.has(x));
    // 取值不同就是不同约束（pnpm vs npm、3111 vs 3113）
    if (!same) return false;
  }
  // 中文对立词：语义翻转，绝不是「换措辞复述」
  if (antonymConflict(a, b) !== null) return false;
  return jaccard(a, b) >= threshold;
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
  return recent.some((r) => areNearDuplicate(r, t, threshold));
}
