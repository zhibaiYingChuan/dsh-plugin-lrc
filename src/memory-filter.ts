/**
 * 沉淀前的**结构过滤**与查重。
 *
 * ## 本模块的职责边界（2026-11 重构后）
 *
 * 这里只做两类事：
 * 1. **结构过滤**：寒暄、代码围栏、正常日志、选项标签、机器输出 ——
 *    判断依据是「这行是不是人写的句子」，与「它值不值得记」无关。
 * 2. **查重**：字符级 Jaccard + 取值 token + 中文对立词三层判据。
 *
 * ## 语义判定**不在这里**
 *
 * 此前本文件有 1700 行，其中 1200 行是「这句像不像约束 / 结论 / 目标 /
 * 范围」的正则二分类。那套判据的假设空间是无限的（措辞无穷），
 * 十一轮修补后仍在反复：每修好一批误报，就漏掉另一批真信息。
 *
 * 判定的职责已迁到：
 * - `memory-schema.ts` —— 「一条记忆是什么」（三元组契约，有界）
 * - `memory-extract.ts` —— 唯一的提取器
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
 * 没有标签、标签为空、标签未闭合都返回 `null`。
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
 * 选项标签：`- **A**：…` / `- 1) …` / markdown 表格行。
 *
 * 这类行是报告里的"选项罗列 / 待办清单"，不是可复用陈述。
 * 实测一次沉淀 11 条里 2 条是 `- **A**：…` 这种片段。
 */
export function isOptionLabel(line: string): boolean {
  const t = line.trim();
  if (/^[-*+]\s*\*\*[A-Za-z0-9]{1,3}\*\*\s*[：:]/.test(t)) return true;
  if (/^[-*+]\s*[A-Za-z0-9]{1,3}[.、)]\s/.test(t)) return true;
  // 表格行：`| 0–8s | 一次对话，光点起势… |`
  if (/^\|.*\|/.test(t)) return true;
  return false;
}

/**
 * 是否是**机器输出形态**的行（JSON / 键值对），不是人写的句子。
 *
 * ## 判据只看「结构特征」，不看「中文多少 / 有无标点」
 *
 * 两版都栽在「用中文特征判」。第一版看行首字符，误杀 8/8 真约束：
 * ```
 * D:\Desktop，score-xxx.wav，这是你要打音频。继续任务   ← 盘符被当键名
 * https://example.com 是唯一可信来源，必须按它来。      ← 协议被当键名
 * [2026-11-14] 必须重新构建 dist 后再提交。            ← 时间戳被当数组
 * ```
 * 第二版改看「中文句子骨架 + 标点」，又踩了另一个坑：调用方切句后
 * `目标是降到 10 元` 已无句号 ⇒ 被判成机器输出（实测 3/3 误杀）。
 */
export function looksLikeMachineOutput(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;

  // 1) JSON 容器：`{...}` / `[...]` 且含引号或纯标量列表
  if (/^[{\[]/.test(t)) {
    if (t.includes('"')) return true;
    if (/^\[[\w\s,.-]*\]$/.test(t)) return true;
  }

  // 2) 行内 JSON 片段：引号键紧跟冒号（`"定位到":1`）
  if (/"[^"]{1,40}"\s*:/.test(t)) return true;

  // 3) 键值行：纯 ASCII 键 + 分隔符，且值部分是「短中文 / 无句读」
  const kv = /^[A-Za-z_$][\w$.-]*\s*[:=]\s*([\s\S]*)$/.exec(t);
  if (kv !== null) {
    const value = (kv[1] ?? '').trim();
    const maskedValue = maskPaths(value);
    const cjk = (maskedValue.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    // 值部分带中文句读 → 人话（`pnpm: 只用 pnpm，不要用 npm。`）
    if (cjk >= 3 && /[，。；！？]/.test(maskedValue)) return false;
    // 值含强制性语义 → 注释型约束（`TODO: 不要用 IDM 下载`）
    if (
      /(?:必须|务必|一定要|禁止|严禁|切勿|不得|不允许|不准|不许|杜绝|只能|只允许|一律|不要|别用|别再|改用|换成|改成|定为|决定)/.test(
        maskedValue,
      )
    ) {
      return false;
    }
    // 量化约束：`上限 1000`、`不超过 200ms`
    if (/(?:上限|下限|不超过|不低于|不少于|不大于|不小于|压到|降到|控制在|限制在)\s*[0-9]/.test(maskedValue)) {
      return false;
    }
    if (cjk < 6) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────
// 路径挖空
//
// 词表与格式判定都需要区分「正文里的词」和「路径里的词」：
// `见 docs/规范.md`、`materials/架构图.png` 这类纯指针行会因为路径里带
// 「规范 / 架构 / 端口」被当成结论留库。
//
// 因此判定前先过 `maskPaths()`：把 URL / 绝对路径 / 相对路径 /
// 带扩展名的文件名整段挖成空格。挖成等长空格而不是删除，
// 是为了让调用方仍能按位置对齐原文。
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
    out.push(m[0].toLowerCase());
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

/** 两条文本是否在某个对立词对上取了**相反**的值。 */
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
 * ```
 * 后果不只是快照去重，而是 `isDuplicate` 在**入库前**就丢掉：
 * 用户说「改用 npm」，被判为复述直接不发 HTTP ⇒ LRC 里永远是旧值。
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
    if (!same) return false;
  }
  if (antonymConflict(a, b) !== null) return false;
  return jaccard(a, b) >= threshold;
}

/** 默认查重阈值：与 LRC 的相似合并阈值一致。 */
export const DEFAULT_DEDUP_THRESHOLD = 0.85;

/**
 * 本地查重：与"最近已发送的内容"比对，高度重合说明是换措辞复述，
 * 直接丢弃 —— 连 HTTP 请求都不发。
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
