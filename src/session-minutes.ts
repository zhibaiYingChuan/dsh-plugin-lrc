/**
 * 会话纪要（session minutes）。
 *
 * ## 为什么需要它（2026-11-17 真实数据）
 *
 * 现有实现只在库里留下**句子级碎片**：实测 session-95eaf7e3 写入 1515 条，
 * 长度中位 **33 字**，19.3% ≤ 20 字。这些碎片能召回，但回答不了
 * 「这段对话到底做成了什么」。
 *
 * 同时另一条路也已经排除：把**压缩摘要**整条归档不可行 ——
 * 实测同会话 247 次 compaction 产出 966,414 字符纪要，其中
 * **92% 是工具调用回显**；剩下的「助手结论」段 1161 条、p50 仅 27 字，
 * 含因果理由的比例（11.5%）反而低于正文直抽（15.4%）。
 *
 * ## 所以纪要要重新生成，不复用压缩摘要
 *
 * 一份对话**一份**纪要，形态是「诉求演进 + 关键结论 + 时序」：
 * ```
 * 【会话纪要】<sessionId>
 * 时间：<起> → <止>（N 小时 / M 轮）
 * ## 诉求演进
 * - 11-14 14:26 所有图标要用 SVG 绘制…
 * ## 关键结论
 * - 兽的入场用 CSS 缩放淡入是错的，像素画必须逐帧切换
 * ```
 *
 * ## 时序是硬要求
 *
 * 实测 LRC 两个写入端点对时间的态度不同：
 * ```
 * /v1/memories/remember  + source_timestamp_ms → 尊重真实时间（偏差 0.0 秒）
 * /v1/context/migrate    （无该字段）           → 恒为摄入时刻（偏差 319.9 天）
 * ```
 * 因此纪要**必须**走 `remember` 并带上会话真实起始时间。
 * 否则 65.8 小时的会话在库里只表现为一个瞬间，「什么时候定的」永久丢失。
 *
 * ## 写入语义：合并，不是覆盖
 *
 * LRC **不**按 `event_id` 覆盖。它比较内容相似度（Jaccard ≥ 0.5 才合并），
 * 不够相似就**新建一条**。所以同一个 `session-minutes:<sessionId>`
 * 在库里可能有多条 —— 这是**两段真实历史**，不是重复（见 `probeExistingMinutes`）。
 *
 * 但合并路径本身是危险的单向门：`apply_merge` 会整体替换 content，
 * 残缺稿能覆盖完整稿。因此写入前必须拦「**会被合并且轮数更少**」的稿
 * （`writeMinutes` 的 `minTurns` + `existingContent` 双判据），
 * 否则同一会话每轮追加都会把已积累的结论洗掉。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LrcClient } from './lrc-client.ts';

/** 一轮对话的记账。 */
export interface TurnRecord {
  /** 轮次序号（宿主给的 turn 编号） */
  idx: number;
  /** 本轮真实开始时间（Unix 毫秒） */
  startedAt: number;
  /** 本轮真实结束时间 */
  endedAt: number;
  /** 结束原因：completed / aborted / error */
  reason: string;
  /** 用户在本轮说的话（已清洗，多句拼成一段） */
  userText: string;
  /** 本轮抽出的结论（已通过 schema 校验） */
  conclusions: string[];
}

/**
 * 纪要生成配置。
 *
 * 上限取自实测：22 轮 / 65.8 小时的会话，诉求演进整段约 1.4K 字符、
 * 关键结论取 20 条约 1.2K，合计约 2.6K 字符 —— 与 LRC 单条记忆的
 * 常见体量一致，也远低于检索/注入的截断阈值。
 */
export interface MinutesConfig {
  /** 诉求演进最多列多少轮 */
  maxTurnLines: number;
  /** 关键结论最多列多少条 */
  maxConclusions: number;
  /** 每条诉求/结论的字符上限（超出截断加省略号） */
  lineChars: number;
}

export const DEFAULT_MINUTES_CONFIG: MinutesConfig = {
  maxTurnLines: 40,
  maxConclusions: 24,
  lineChars: 120,
};

/** 「可回答为什么」的判据：出现因果/理由词。**只用于排序，不做准入**。 */
const WHY_SIGNAL =
  /因为|由于|所以|否则|原因是|根因|问题出在|导致|为了避免|这样才能|不然|其实|实际上是/;

/**
 * 机器输出 / 英文自述的识别（**只用于形态过滤**）。
 *
 * ## 为什么不在这里判「这是不是结论」（2026-11-17 独立审查 M1）
 *
 * 首版用 `WHY_SIGNAL || DECISION_SIGNAL` 做**准入门槛**，实测误杀：
 * ```
 * 丢 | 数据库连接池上限是 20，当前峰值 18
 * 丢 | 端口 3099 被旧进程占用，新实例起不来
 * 丢 | 把 LRC 的 baseUrl 从 3099 改为 3111 后连接恢复正常
 * ```
 * 这些都是真结论，只是不含「因为/决定」这类字面词。而上游 `validateFact`
 * 与 `extractFacts` 已经裁决过「这是不是值得记的结论」——
 * 本层再判一次就是**双裁判**（项目反复警告的缺陷族）。
 *
 * 因此本层只做**形态**过滤：英文自述、机器输出、超长/超短。
 * 语义权重交给排序（`WHY_SIGNAL` 只影响先后，不影响去留）。
 */
const ENGLISH_HEAD =
  /^(?:Let me|Let's|I |I'll|I've|The |This |That |Now |So |But |Actually|Wait|Hmm|OK|Okay|First|Next)/;

/** 机器输出形态：工具回显、错误堆栈、JSON/路径行，不该进纪要正文。 */
const MACHINE_OUTPUT =
  /^(?:pwsh|edit|read|read_image|grep|skill|lrc_recall|write|glob|bash|shell|exec)\(\{|^结果[:：]|^执行结果[:：]|^已读取文件[:：]|^已修改文件[:：]|^共(?:修改|读取|扫描|命中) ?\d+|^Error:|^\[stderr\]|^\{.*\}$|^<path>|^<skill_content/;

/** 中文占比（用于识别「以英文为主」的行）。 */
const CJK_MATCH = /[\u4e00-\u9fa5]/g;

function cjkRatio(text: string): number {
  if (text.length === 0) return 0;
  const hits = text.match(CJK_MATCH);
  return (hits === null ? 0 : hits.length) / text.length;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * 是否是一句可进纪要的结论（**只做形态过滤**）。
 *
 * @param raw - 原始陈述（**未经截断**，长度上限在这里判）
 * @param minChars - 最短字符数。默认 12：实测「端口 3099 被占用」这类
 *   关键根因只有 12~15 字，15 字的门槛会误杀。
 */
export function isUsableConclusion(raw: string, minChars = 12): boolean {
  const flat = raw.trim();
  if (flat.length < minChars) return false;
  // 单条上限：超过 300 字的多半是整段报告/日志粘贴，不是「一句结论」
  if (flat.length > 300) return false;
  if (MACHINE_OUTPUT.test(flat)) return false;
  if (ENGLISH_HEAD.test(flat)) return false;
  // 中文占比 < 25% ⇒ 以英文为主（技术句里的路径/标识符会拉低占比，
  // 实测 0.4 会把「构建产物写入 dist/index.js，体积 1.2MB」(0.28) 误杀）
  if (cjkRatio(flat) < 0.25) return false;
  return true;
}

/**
 * 时间渲染：**统一本地时区，带年份**。
 *
 * ## 为什么不能混用 UTC 与本地（2026-11-17 独立审查 M7）
 *
 * 首版用 `isoLocal`（本地）渲染时间线、`isoFull`（UTC）渲染头部：
 * ```
 * 时间：2026-11-14T03:27:35Z → …        ← UTC
 * - 11-14 11:27 所有图标要用 SVG…        ← 本地（UTC+8）
 * ```
 * 差 8 小时，读者会以为诉求行的时间晚于结束时间。
 * 且 `isoLocal` 无年份，跨年会话（12-31 → 01-01）会显示成时间倒序。
 *
 * 纪要是给人读的，因此统一用**本地时间 + 年份**；`source_timestamp_ms`
 * 本身是 epoch，不受渲染影响。
 */
function formatWhen(ms: number): string {
  if (ms <= 0) return '?';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 纪要生成结果。 */
export interface MinutesDraft {
  /** 纪要正文（可直接作为一条记忆的 content） */
  content: string;
  /** 会话真实开始时间（Unix 毫秒）—— 写入时作为 `source_timestamp_ms` */
  startedAt: number;
  /** 会话真实结束时间 */
  endedAt: number;
  /** 纳入的轮数 */
  turns: number;
  /** 纳入的结论条数 */
  conclusions: number;
}

/**
 * 从纪要正文里读回「这段的起点时间」（Unix 毫秒）。
 *
 * ⚠ 必须带 `m` 标志（十二轮审查 major 1）：正文首行是 `【会话纪要】…`，
 * 时间行在**第二行**。不带 `m` 时 `^` 只锚定字符串开头 ⇒ 恒返回 null
 * ⇒ 基线起点合并、`unchanged` 分支、`Math.min(override, baselineStart)`
 * 全部失效，且 `source_timestamp_ms` 会写成「现在」（时序偏差数天）。
 */
export function parseMinutesStartedAt(content: string): number | null {
  const m = /^时间[:：]\s*(.+?)\s*→/m.exec(content);
  if (m === null) return null;
  const t = Date.parse(`${m[1]}:00`);
  return Number.isFinite(t) ? t : null;
}

/** 从纪要正文里读回「这段的结束时间」（Unix 毫秒）。 */
export function parseMinutesEndedAt(content: string): number | null {
  const m = /^时间[:：].*?→\s*(.+?)（/m.exec(content);
  if (m === null) return null;
  const t = Date.parse(`${m[1]}:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * 取出纪要正文的「诉求演进」行（`- <时间> <文本>`）。
 *
 * 返回**原始行**（不含 `## ` 标题），供 `mergeBaseline` 按时间轴拼接去重。
 */
export function parseTurnLines(content: string): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === '## 诉求演进';
      continue;
    }
    if (inSection && line.startsWith('- ')) out.push(line);
  }
  return out;
}

/** 从纪要正文里读回「关键结论」段的行（已渲染好的 `- xxx`）。 */
export function parseConclusionLines(content: string): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === '## 关键结论';
      continue;
    }
    if (inSection && line.startsWith('- ')) out.push(line);
  }
  return out;
}

/** 从诉求行里取时间戳（毫秒）与正文，用于按时间排序与去重。 */
function splitTurnLine(line: string): { at: number; text: string } | null {
  const m = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) (.*)$/.exec(line);
  if (m === null) return null;
  const at = Date.parse(`${m[1]}:00`);
  if (!Number.isFinite(at)) return null;
  return { at, text: m[2] ?? '' };
}

/**
 * 已知的「轮次状态标记」。
 *
 * ## 为什么必须白名单而不是 `/（[^）]*）$/`（十轮审查 major 3）
 *
 * 用户正文里本来就可能以括号结尾：
 * ```
 * - 13:00 把端口改成 3111（原 3099）
 * ```
 * 用「任意括号」判标记会把它当成阶段稿 ⇒ 重放时被判 `replaced`，
 * 行内时间被换成「现在」⇒ 正文与基线不等 ⇒ `unchanged` 永不成立。
 */
const TURN_MARK = /（(?:in-progress|aborted|error|no-end|switched)）$/;

/** 剥掉尾部状态标记（只认白名单里的值）。 */
function stripTurnMark(text: string): string {
  return text.replace(TURN_MARK, '').trim();
}

/**
 * 把「库内已有那段」的诉求行并入本稿（**grow-only 语义**）。
 *
 * ## 为什么必须合并而不是二选一（六钥匙裁决）
 *
 * LRC 的合并是 `update_content`（**整体替换**），所以发给它的 content
 * 必须自己保证单调性 —— 否则「回到旧主题」与「账本丢失后重放」这两件
 * 事在内容上无法区分，只能二选一：
 * ```
 * 拦下 ⇒ 本轮真实对话永远进不了库（违背「持续性」）
 * 放行 ⇒ 库里那段更完整的历史被替换掉（不可逆）
 * ```
 * 拼接让两者同时成立：
 * ```
 * 库内 22 轮 + 本轮 3 轮新内容 ⇒ 写 25 轮（22 行原样保留 + 3 行新增）
 * 账本丢失后重放旧内容        ⇒ 拼完与库内相同 ⇒ 判定「无变化」不发 HTTP
 * ```
 *
 * ## 匹配规则（顺序不能反）
 *
 * 1. **纯文本精确匹配**（基线行不带标记）⇒ 整行沿用基线
 *    重放时本稿的行带着「现在」的时间戳，若用它，拼出来的正文与库里
 *    那段不等 ⇒ `unchanged` 判定失效 ⇒ 每次重放都白写一次。
 * 2. **同一轮（分钟级时间相同）且基线行带标记** ⇒ 用本稿的文本 + 基线时间
 *    阶段稿 `（in-progress）` 收尾成正式稿，必须覆盖而不是并存。
 *    用户中途补充诉求时 `userText` 会增长（`做重构` → `做重构 顺便补测试`），
 *    但 `startedAt` 是**轮开始时刻**、不会变 ⇒ 时间仍然相同 ⇒ 这条也覆盖它。
 * 3. 都不匹配 ⇒ 新增行
 *
 * ## 为什么**不能**加「文本前缀匹配」兜底（十一轮审查 major 1）
 *
 * 曾加过一条「基线行带标记且本稿文本以它为前缀 ⇒ 覆盖」。反例：
 * ```
 * 基线：- 11-14 13:00 做重构（aborted）
 * 本稿：- 11-19 15:00 做重构 顺便补测试   ← 完全不同的新轮
 * ```
 * 前缀匹配会命中 ⇒ 新轮的真实时间 15:00 被换成 11-14 13:00，
 * `aborted` 信号也被抹掉。而「同一轮 userText 增长」的时间戳本来就
 * 相同（规则 2 已覆盖），前缀匹配只会带来误配。
 *
 * ## 基线内部同文本行不能互相覆盖（十轮审查 minor 7）
 *
 * 基线用**数组**而不是 Map：旧版库里若两轮说了同一句话，两行都要保留，
 * 否则拼接结果不是超集。
 */
function mergeTurnLines(
  baseline: readonly string[],
  current: readonly string[],
  maxLines: number,
): { lines: string[]; added: number; replaced: number; truncated: boolean } {
  interface BaseRow {
    at: number;
    text: string;
    line: string;
    marked: boolean;
  }
  const baseRows: BaseRow[] = [];
  for (const line of baseline) {
    const parsed = splitTurnLine(line);
    if (parsed === null) continue;
    baseRows.push({
      at: parsed.at,
      text: stripTurnMark(parsed.text),
      line,
      marked: TURN_MARK.test(parsed.text),
    });
  }
  const used = new Set<number>();
  const out: Array<{ at: number; line: string }> = [];
  let added = 0;
  let replaced = 0;
  for (const line of current) {
    const parsed = splitTurnLine(line);
    if (parsed === null) continue;
    const text = stripTurnMark(parsed.text);
    // ① 纯文本精确匹配（优先未标记的基线行）
    let idx = baseRows.findIndex((r, i) => !used.has(i) && !r.marked && r.text === text);
    // ② 同一轮（分钟级时间相同）且基线行带标记，且本稿文本以它为前缀
    //
    // ## 为什么必须加前缀约束（十二轮审查 minor 3）
    //
    // 只按分钟匹配会碰撞：同一分钟内的两轮（A 轮 15:00:10、B 轮 15:00:50）
    // 时间字符串相同 ⇒ B 会覆盖 A，A 的诉求与 `aborted` 信号丢失。
    // 加「本稿文本以基线文本为前缀」后：
    // ```
    // 基线：- 15:00 做重构（in-progress）
    // 本稿：- 15:00 做重构 顺便补测试   ← 前缀匹配 ✓（同一轮 userText 增长）
    // 本稿：- 15:00 补测试              ← 不匹配 ⇒ 新增行 ✓（另一轮）
    // ```
    if (idx < 0) {
      idx = baseRows.findIndex(
        (r, i) => !used.has(i) && r.marked && r.at === parsed.at && text.startsWith(r.text),
      );
    }
    if (idx < 0) {
      added += 1;
      out.push({ at: parsed.at, line });
      continue;
    }
    const row = baseRows[idx] as BaseRow;
    used.add(idx);
    if (row.marked) {
      // 阶段稿 → 正式稿：用本稿文本，但时间沿用基线（同一轮）
      replaced += 1;
      out.push({ at: row.at, line: `- ${formatWhen(row.at)} ${parsed.text}` });
    } else {
      // 重放：整行沿用基线，保住真实时刻
      out.push({ at: row.at, line: row.line });
    }
  }
  // 未被本稿匹配到的基线行原样保留
  for (let i = 0; i < baseRows.length; i += 1) {
    if (used.has(i)) continue;
    const row = baseRows[i] as BaseRow;
    out.push({ at: row.at, line: row.line });
  }
  out.sort((a, b) => a.at - b.at);
  // ## 截断保留**最近**的（六钥匙：保留最早会让正文永久冻结）
  //
  // 反例（保留最早）：账本滑窗是「最近 40 轮」⇒ 第 41 轮起本稿的行集合
  // 变成第 2..41 轮，取「最早 40 行」仍是第 1..40 ⇒ 正文永不变化
  // ⇒ LRC 合并后内容不变 ⇒ 纪要永久冻结在第 40 轮。
  const kept = out.length > maxLines ? out.slice(-maxLines) : out;
  return {
    lines: kept.map((r) => r.line),
    added,
    replaced,
    truncated: out.length > maxLines,
  };
}

/**
 * 把一轮对话累积成纪要草稿。
 *
 * @param sessionId - 会话 ID（只用于标题与 event_id）
 * @param turns     - 轮次记录（按时间升序）
 * @param config    - 上限配置
 * @param startedAtOverride - 会话**首次观测**时间（Unix 毫秒）。缺省取最早一轮。
 *   必须能覆盖：账本有上限，早期轮次被淘汰后 `turns[0]` 不再是会话起点，
 *   而纪要的 `source_timestamp_ms` 必须恒为会话真正开始的那一刻。
 * @param baselineContent - 库里已有那段的正文（相似度最高的一段）。
 *   提供时会把它的「诉求演进」行并入本稿（grow-only），见 `mergeTurnLines`。
 *   缺省表示「库里没有可比对的段」⇒ 只写本稿。
 * @returns 纪要草稿；没有任何有效内容时返回 `null`（调用方据此跳过写入）
 */
export function buildMinutes(
  sessionId: string,
  turns: readonly TurnRecord[],
  config: MinutesConfig = DEFAULT_MINUTES_CONFIG,
  startedAtOverride?: number,
  baselineContent?: string,
): MinutesDraft | null {
  if (turns.length === 0) return null;

  const ordered = [...turns].sort((a, b) => a.startedAt - b.startedAt);
  // ## 起点必须取「基线那段」的更早者（否则拼接后时间窗倒退）
  //
  // 拼接后正文里包含基线那段的行（可能早于本稿首轮），若头部起点只取
  // 本稿首轮 ⇒ 头部写「11-19 起」而行里出现「11-14」的时刻 ⇒ 自相矛盾。
  const baselineStart = baselineContent === undefined ? null : parseMinutesStartedAt(baselineContent);
  const earliest = ordered[0]?.startedAt ?? 0;
  let earliestStart =
    startedAtOverride !== undefined && startedAtOverride > 0 && startedAtOverride < earliest
      ? startedAtOverride
      : earliest;
  if (baselineStart !== null && baselineStart > 0 && baselineStart < earliestStart) {
    earliestStart = baselineStart;
  }
  // ## 结束时间也要取基线的更晚者
  //
  // 基线那段可能比本次观测到的更晚结束（本稿只是补写早期轮次）。
  const baselineEnd = baselineContent === undefined ? null : parseMinutesEndedAt(baselineContent);
  const lastEndRaw = ordered[ordered.length - 1]?.endedAt ?? 0;
  const lastEnd =
    baselineEnd !== null && baselineEnd > lastEndRaw ? baselineEnd : lastEndRaw;

  // ── 诉求演进 ──
  //
  // 每轮一行。中止的轮次要标出来 —— 实测 99 轮里 19 轮非正常结束（19.2%），
  // 用户看到「（aborted）」才知道那一轮没做完。
  const curLines: string[] = [];
  for (const t of ordered) {
    const text = oneLine(t.userText, config.lineChars);
    if (text.length === 0) continue;
    const mark =
      t.reason === 'completed' || t.reason === '' ? '' : `（${t.reason}）`;
    curLines.push(`- ${formatWhen(t.startedAt)} ${text}${mark}`);
  }
  const baseLines = baselineContent === undefined ? [] : parseTurnLines(baselineContent);
  const merged = mergeTurnLines(baseLines, curLines, config.maxTurnLines);
  const turnLines = merged.lines;

  // ── 关键结论 ──
  //
  // 排序规则与「接手方最需要什么」一致：先要能回答「为什么」的，
  // 再要已定的事。同一句只出现一次（跨轮去重）。
  interface Cand { text: string; why: boolean; when: number }
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const t of ordered) {
    for (const raw of t.conclusions) {
      // 过滤在**截断之前**做：`isUsableConclusion` 的 >300 字上限
      // 判的是原始陈述（整段报告粘贴），截断后永远不成立。
      if (!isUsableConclusion(raw)) continue;
      // ## 去重键必须取**原文**（2026-11-17 独立审查 M1，已复算确认）
      //
      // 首版把去重键算在 `oneLine(raw, 120)` 的结果上，然后写
      // `norm.length > 120 ? 头60+尾60 : norm` —— 但 `oneLine` 已保证
      // `text.length <= 120`（超长会被截断并加省略号），所以
      // `norm.length > 120` **永不成立**，头尾分支是死代码，
      // 「图标固定为 16px / 24px / 32px」这类同前缀不同尾值的结论仍被判成同一条。
      //
      // 现在键在 `raw` 上算：`raw` 最长 300 字（`isUsableConclusion` 的上限），
      // 超过 120 字时取头尾各 60 字，差异落在尾部也能区分。
      const norm = raw.replace(/[\s，。；：、！？"'`（）()]/g, '');
      const key =
        norm.length <= 120 ? norm : `${norm.slice(0, 60)}\u0000${norm.slice(-60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = oneLine(raw, config.lineChars);
      cands.push({ text, why: WHY_SIGNAL.test(text), when: t.startedAt });
    }
  }
  // 稳定排序：含因果的优先，其次按时间新→旧
  cands.sort((a, b) => {
    if (a.why !== b.why) return a.why ? -1 : 1;
    return b.when - a.when;
  });
  // ## 结论同样要与基线合并（grow-only）
  //
  // 只写本稿自身的结论 ⇒ 回到旧主题时库内那段的结论会被整体替换掉。
  // 基线结论原样保留，本稿结论只过滤「与基线那行等价」的。
  //
  // ## 去重键必须**归一化**（十一轮审查 major 2）
  //
  // 逐字比较会把「标点差异」当成新结论：
  // ```
  // 基线：- 迁移前必须全量备份，因为回滚会丢数据
  // 本稿：- 迁移前必须全量备份, 因为回滚会丢数据   ← 半角逗号
  // ```
  // 抽取层不保证幂等（集成测试已实测），逐字比较会让 24 个槽位被
  // 标点变体占满，把真正不同的旧结论挤出去。
  //
  // ⚠ **不能**在本稿内部再按渲染文本去重：`cands` 已用**原文头尾**做过
  // 去重（见上方 M1 注释），两条超 120 字、差异只在尾部的结论渲染后会
  // 变成同样的 120 字，在这里再去重会把它们并成一条（已实测复现）。
  const baseConclusions =
    baselineContent === undefined ? [] : parseConclusionLines(baselineContent);
  const normConclusion = (line: string): string =>
    line
      .replace(/^-\s*/, '')
      // ## 必须同时覆盖全角与半角标点（十二轮审查 major 2）
      //
      // 只列全角时，`备份, 因为` 与 `备份，因为` 归一化后仍不等
      // ⇒ 标点变体照样占满 24 个槽位。
      // ⚠ 不能加 `.`：`1.5` 与 `15` 会被误并。
      .replace(/[\s，。；：、！？"'`（）(),;:!?]/g, '');
  const baseSet = new Set(baseConclusions.map(normConclusion));
  const newConclusions = cands
    .slice(0, config.maxConclusions)
    .map((c) => `- ${c.text}`)
    .filter((line) => !baseSet.has(normConclusion(line)));
  // ## 结论段是「最近 N 条」，不是严格超集（十一轮审查 major 2）
  //
  // 与诉求行同口径：超限时挤掉**最旧**的。若强行保留基线全部，
  // 结论段会无界增长（每轮都可能新增），最终撑爆单条记忆的体量。
  // 被挤掉的旧结论在 LRC 的其他记忆里仍在（`offloadFacts` 是 append 语义）。
  const conclusionLines = [...baseConclusions, ...newConclusions].slice(-config.maxConclusions);

  // 两段全空 ⇒ 不产生纪要（避免写入一条只有标题的空壳）
  if (turnLines.length === 0 && conclusionLines.length === 0) return null;

  // ## 纯重放（诉求行与结论行**都没有变化**）⇒ 直接沿用基线原文
  //
  // 逐字比对比「重新渲染后 hope 它一样」可靠得多：
  // ```
  // 账本丢失后重放：插件观测到的 startedAt 是「现在」
  // 重新渲染 ⇒ 头部时间窗不同 ⇒ 与库里那段不等 ⇒ unchanged 判定失效
  //           ⇒ 每次重放都白写一次
  // ```
  // 用原文还能顺带保住库里那份的精确毫秒（行内时间只到分钟）。
  //
  // ⚠ **必须同时判结论**（十轮审查 critical 1）：只判诉求行的话，
  // 「诉求没变但助手给了新结论」会被误判成无变化 ⇒ 新结论永远进不了库。
  if (
    merged.added === 0 &&
    merged.replaced === 0 &&
    newConclusions.length === 0 &&
    baselineContent !== undefined
  ) {
    const baseDraftTurns = parseMinutesTurns(baselineContent);
    return {
      content: baselineContent,
      startedAt: baselineStart ?? earliestStart,
      endedAt: baselineEnd ?? lastEnd,
      turns: baseDraftTurns ?? turnLines.length,
      conclusions: parseConclusionLines(baselineContent).length,
    };
  }

  // ## 轮数：有基线时 = 基线轮数 + 新增行数（十轮审查 major 5）
  //
  // 不能用 `Math.max(ordered.length, turnLines.length)`：账本滑窗只有
  // 1 轮、而正文有 2 行（基线 1 行 + 新增 1 行）时会算出 2，但
  // `minutesWrittenTurns` 仍是 1 ⇒ 探查时 `localTurns < primaryTurns`
  // ⇒ 误标 `memoryIdFromProbe=true` ⇒ 该 id 永不 forget。
  //
  // 再与**实际行数**取小（十一轮审查 minor 4）：截断后正文只有 40 行，
  // 头部却写「41 轮」会与正文自相矛盾。
  //
  // ⚠ 只在**真的发生截断**时才钳制（十二轮审查 minor 4）：无基线时
  // `turnLines.length` 可能小于 `ordered.length`（空 userText 的轮次
  // 不产行），无条件取小会把「5 轮」低报成「3 轮」。
  const rawTurns =
    baselineContent === undefined
      ? ordered.length
      : (parseMinutesTurns(baselineContent) ?? 0) + merged.added;
  const totalTurns = merged.truncated ? Math.min(rawTurns, turnLines.length) : rawTurns;
  // ## 截断后头部起点必须与首行一致（十轮审查 minor 6）
  //
  // 反例：基线 22 行（11-14 起）+ 本稿 40 行（11-20）⇒ 截断后全是
  // 11-20 的行，但头部仍写「11-14 起」⇒ 自相矛盾。
  //
  // ⚠ 但 `startedAtOverride`（会话**真实**起点）优先：它是账本记录的
  // 首次观测时间，不受账本滑窗/截断影响，`source_timestamp_ms` 必须用它。
  // 再与基线起点取更早者（十一轮审查 minor 3）：异常数据下 override
  // 可能晚于基线起点，取 min 才不会写出「起点晚于首行」的头部。
  const firstKeptAt = turnLines.length > 0 ? splitTurnLine(turnLines[0] as string)?.at : null;
  const hasOverride = startedAtOverride !== undefined && startedAtOverride > 0;
  const baseStart = hasOverride
    ? Math.min(startedAtOverride as number, baselineStart ?? Number.POSITIVE_INFINITY)
    : firstKeptAt !== null && firstKeptAt !== undefined && firstKeptAt > earliestStart
      ? firstKeptAt
      : earliestStart;
  const startedAt = Number.isFinite(baseStart) ? baseStart : earliestStart;
  const endedAt = lastEnd;

  const hours = ((endedAt - startedAt) / 3600_000).toFixed(1);
  const lines: string[] = [];
  lines.push(`【会话纪要】${sessionId}`);
  lines.push(
    `时间：${formatWhen(startedAt)} → ${formatWhen(endedAt)}（${hours} 小时 / ${totalTurns} 轮，本地时间）`,
  );
  if (turnLines.length > 0) {
    lines.push('');
    lines.push('## 诉求演进');
    lines.push(...turnLines);
  }
  if (conclusionLines.length > 0) {
    lines.push('');
    lines.push('## 关键结论');
    lines.push(...conclusionLines);
  }

  return {
    content: lines.join('\n'),
    startedAt,
    endedAt,
    // ## 返回**拼接后**的轮数（不是本次观测到的轮数）
    //
    // 调用方（`persistLedgerInner`）用它刷新 `probedMinutes.turns`，
    // 那是下一次写入的完整性基准。若这里返回 `ordered.length`（如 1），
    // 基准会被错误地降到 1 ⇒ 下一份更残缺的稿也能通过。
    turns: totalTurns,
    // ## 用**实际写入**的结论条数（十一轮审查 minor 5）
    //
    // `picked.length` 只是本稿自身的结论数；拼接后正文里可能有
    // 「基线 5 条 + 新增 3 条 = 8 条」，报 3 会让日志与正文对不上。
    conclusions: conclusionLines.length,
  };
}

/** 纪要的记忆标签（便于检索与后续更新定位）。 */
export function minutesTags(sessionId: string): string[] {
  return ['session-minutes', 'minutes', `session:${sessionId}`, 'timeline'];
}

/**
 * 纪要的 `event_id`：同一会话恒定。
 *
 * 注意：它**不是**去重键。LRC 合并只看内容相似度，不看 `event_id`。
 * 这个值的作用是让检索侧能把同一会话的多段纪要归到一起。
 */
export function minutesEventId(sessionId: string): string {
  return `session-minutes:${sessionId}`;
}

/** 纪要写入结果。 */
export interface MinutesWriteResult {
  written: boolean;
  memoryId: string;
  /** 纪要字符数 */
  chars: number;
  /** 纪要正文（调用方用它刷新「库内那一份」的相似度基准） */
  content: string;
  turns: number;
  conclusions: number;
  /**
   * 拼完基线后与库里那段**完全相同**（六钥匙裁决后新增）。
   *
   * 语义与 `written: false` 一致（不写入），但原因不同：
   * 这不是「没内容」，而是「库里已经是这个样子」。
   * 调用方据此**可以**推进进度计数（避免反复重试同一份稿）。
   */
  unchanged?: boolean;
}

/**
 * 纪要账本的**落盘形态**。
 *
 * ## 为什么必须落盘（2026-11-17 独立审查 C2）
 *
 * 账本只在内存里时，DSH 一重启就归零，于是：
 * ```
 * 重启前：已写 22 轮 / 2.7K 字的完整纪要
 * 重启后：只观测到 1 轮 ⇒ 生成一份 1 轮的纪要
 * ```
 * 而 LRC 的写入**不是 event_id 覆盖**，是**内容 Jaccard ≥ 0.5 才合并**
 * （`memory_store.rs` 的 `find_similar_in_snapshot`）：
 * ```
 * 20 轮 vs 3 轮   = 0.61 → 合并，旧内容被 update_content 覆盖
 * 40 轮 vs 1 轮   = 0.31 → 不合并，**同一个 event_id 在库里出现两条**
 * ```
 * 两种结局都是错的：前者丢内容，后者产生重复纪要。历史版本只留 5 代，
 * 所以反复重启 5 次后连可回溯的旧版都消失。
 *
 * 落盘后：重启命中同一 sessionId 就**恢复**账本，而不是从零重来。
 */
export interface MinutesLedgerState {
  sessionId: string;
  /** 轮次记录（append 语义，按时间升序） */
  turns: TurnRecord[];
  /** 累计归档轮数（单调递增，账本淘汰不回退） */
  archivedTurns: number;
  /** 上次成功写入纪要时的 `archivedTurns`；-1 表示从未写成功 */
  writtenAtArchived: number;
  /**
   * 上次**轮内阶段写入**时那一轮的 `idx`（0 = 从未写过）。
   *
   * ## 为什么需要与 `writtenAtArchived` 分开
   *
   * 「每 N 轮写一次」的节流口径必须是「**已完成**轮次」，否则阶段写入会把它打乱：
   * ```
   * 第 6 轮归档后正式写一次（writtenAtArchived=6）
   * 第 7 轮跑了 30 分钟 → 阶段写入 3 次（内容已含第 7 轮）
   * 第 7 轮 turn/end ⇒ archivedTurns=7，7-6=1 < 5 ⇒ 正式写入被节流拦下
   * ⇒ 库里永远停在「进行中」的阶段稿，「已完成」版本永不落库
   * ```
   * 所以阶段写入不触碰 `writtenAtArchived`，只记「覆盖到了哪一轮」；
   * `maybeWriteMinutes` 据此发现「阶段稿已抢跑」时强制放行正式稿。
   *
   * 标为可选：旧版账本没有这个键，省略等价于「从未阶段写入」。
   */
  stageWrittenTurnIdx?: number;
  /** 会话**首次观测**时间（Unix 毫秒）—— 恒取第一次看到该会话的时刻 */
  startedAt: number;
  /**
   * 已成功写入库的**最大轮数**（`lrc_status` 展示用）。
   *
   * 「纪要内容只增不减」的执行点：新草稿的轮数少于它时直接跳过写入，
   * 否则会用不完整的快照覆盖完整纪要。
   */
  writtenTurns: number;
  /**
   * 上次成功写入的**记忆 ID**（六轮审查 M-A 的修复依据）。
   *
   * ## 为什么必须记
   *
   * LRC 的写入不是 event_id 覆盖，而是「内容 Jaccard ≥ 0.5 才合并」。
   * 首轮纪要（约 1 行诉求）与第 3 轮纪要（多行）相似度可能只有 0.35 ——
   * **不合并**，于是同一个 `session-minutes:<sid>` 在库里出现两条：
   * 一条停在 1 轮的过时版本（importance=9，会被召回），一条是新的。
   *
   * 有了这个 ID，`persistLedger` 在发现「本次返回的 id ≠ 上次的 id」时
   * 可以 `forget(oldId)`，保证库里恒为 1 条。缺省（旧版文件 / 从未写过）
   * 为空串。
   */
  memoryId: string;
  /**
   * `memoryId` 是不是**从库里探查捡来的**（七轮审查 critical 1）。
   *
   * ## 三态，不能是布尔（八/九轮审查 M-1）
   *
   * ```
   * true      —— 探查捡来的，代表库里另一段真实历史 ⇒ 永不 forget
   * false     —— 本插件自己写入得到的 ⇒ 被新版本取代时可以 forget
   * undefined —— **来源未知**（旧版账本没有这个键）⇒ 保守：不删
   * ```
   *
   * 「未知」必须与「自己写的」区分开。折成 `false` 的反例：
   * ```
   * 旧版账本 memoryId=P（探查来的，但没这个键）
   * enrich 返回 503 ⇒ 探查 3 次全败（无法补标记）
   * LRC 的 remember 却正常 ⇒ 本稿与 P 相似度 < 0.5 ⇒ 新建 N
   * ⇒ 按 false 处理 ⇒ forget(P) ❌ 22 轮真实历史被删，不可逆
   * ```
   * 折成 `true` 则相反：自己写的副本永不清理，每轮多一条过时纪要。
   * 所以只能保留 `undefined`，让判据走「宁可多一条，也不误删」。
   */
  memoryIdFromProbe?: boolean;
  /**
   * **待删除的过时记忆 ID**（七轮审查 M-2）。
   *
   * `forget` 失败时把 id 留在这里并落盘，下次任何写入前先重试。
   * 否则旧 id 会在 `memoryId` 被更新后再无记录点 —— 那条
   * importance=9 的过时纪要将永久滞留库里，持续污染召回。
   *
   * 标为可选：它是**辅助清理状态**，与「纪要内容」正交。
   * 构造账本时若无需清理，省略即等价于空数组 —— 这让所有
   * 已有的构造点不必为一个可选能力付出样板代码。
   */
  pendingForget?: string[];
  updatedAt: number;
}

/** 落盘文件名里的安全字符集（sessionId 可能含 `:`、`/` 等）。 */
function safeFileName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 纪要账本的按会话持久化（复用 `CursorStore` 的「落盘失败即降级」策略）。
 *
 * 一个会话一个文件：`<dir>/minutes-<safeSessionId>.json`。
 * 独立文件而非单一大 JSON，是因为账本随会话增长（40 轮 × 每轮数条结论），
 * 单文件会退化成「每次写入都重写全部会话」。
 */
export class MinutesLedgerStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathOf(sessionId: string): string {
    return join(this.dir, `minutes-${safeFileName(sessionId)}.json`);
  }

  /** 读取账本；文件不存在/损坏返回 `null`（调用方当作新会话）。 */
  load(sessionId: string): MinutesLedgerState | null {
    try {
      const path = this.pathOf(sessionId);
      if (!existsSync(path)) return null;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object') return null;
      const raw = parsed as Partial<MinutesLedgerState>;
      // 归属校验：文件名已隔离，但仍校验一次 —— 手工改文件/复制粘贴时
      // 不能让 A 的账本被当成 B 的（与 `snapshotOwner` 同源的防御）
      if (raw.sessionId !== sessionId || !Array.isArray(raw.turns)) return null;
      const turns = raw.turns.filter((t): t is TurnRecord => {
        if (t === null || typeof t !== 'object') return false;
        const r = t as Partial<TurnRecord>;
        return (
          typeof r.idx === 'number' &&
          typeof r.startedAt === 'number' &&
          typeof r.endedAt === 'number' &&
          typeof r.reason === 'string' &&
          typeof r.userText === 'string' &&
          Array.isArray(r.conclusions)
        );
      });
      return {
        sessionId,
        turns,
        archivedTurns: typeof raw.archivedTurns === 'number' ? raw.archivedTurns : turns.length,
        writtenAtArchived:
          typeof raw.writtenAtArchived === 'number' ? raw.writtenAtArchived : -1,
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
        writtenTurns: typeof raw.writtenTurns === 'number' ? raw.writtenTurns : 0,
        // 旧版账本没有这个字段：空串表示「不知道之前写的是哪一条」，
        // 清理逻辑会因此跳过（宁可多一条，也不误删别人的记忆）
        memoryId: typeof raw.memoryId === 'string' ? raw.memoryId : '',
        // ## 三态：键缺失 ⇒ undefined（来源未知，保守不删）
        //
        // 不能折成 `false` —— 旧版账本的 id 可能是探查来的，折成
        // 「自己写的」会让它被误删（九轮审查 M-1 的反例）。
        memoryIdFromProbe:
          raw.memoryIdFromProbe === true
            ? true
            : raw.memoryIdFromProbe === false
              ? false
              : undefined,
        pendingForget: Array.isArray(raw.pendingForget)
          ? raw.pendingForget.filter((id): id is string => typeof id === 'string')
          : [],
        // ## 漏掉这个字段会让整个阶段稿机制在重启后失效（十轮审查 C1）
        //
        // `save()` 是 `{...state}` 全量写入，磁盘上一直有这个键；
        // 但若 `load()` 不读回来，`applyLedgerState` 拿到 undefined ⇒
        // `minutesStageWrittenTurnIdx = 0` ⇒ `stageNeedsFinalize` 恒假 ⇒
        // 库里那份 in-progress 阶段稿再也等不到正式稿收尾。
        // 更糟的是所有 `{...onDisk}` 重写点会顺手把它从磁盘抹掉。
        stageWrittenTurnIdx:
          typeof raw.stageWrittenTurnIdx === 'number' ? raw.stageWrittenTurnIdx : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      };
    } catch {
      // 损坏不阻断：当作没有账本（退化为从本次会话开始记）
      return null;
    }
  }

  save(state: MinutesLedgerState): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const payload: MinutesLedgerState = { ...state, updatedAt: Date.now() };
      writeFileSync(this.pathOf(state.sessionId), JSON.stringify(payload), 'utf8');
    } catch {
      // 落盘失败只影响「重启后能否恢复」，不影响本次会话的纪要生成
    }
  }

  /** 删除某会话的账本（纪要已完整写入后不再需要）。 */
  clear(sessionId: string): void {
    try {
      const path = this.pathOf(sessionId);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // 清理失败无害：下次 load 仍可恢复
    }
  }

  /**
   * 只保留最近 `maxFiles` 个账本文件（按 mtime）。
   *
   * 不清理会无界增长：每个会话一个文件，长期使用会积累上百个小 JSON。
   *
   * ## 有未补写增量的文件**优先保留**（五轮审查 M2）
   *
   * 反例：用户有 41 个会话，最老那个还有 2 轮没写进 LRC。
   * 只按 mtime 淘汰会删掉它 ⇒ 用户回到该会话时 `load` 返回 null
   * ⇒ `resetMinutesState`（`writtenAtArchived = -1`）⇒ 闸门放行首轮稿
   * ⇒ 同一 `event_id` 因 Jaccard 低而**新增第二条**，库里原多轮纪要
   * 从此失去更新入口（内容永久停在旧的短版本）。
   *
   * ## 边界：待补写文件数 > `maxFiles` 时仍会淘汰（六轮审查 m-b）
   *
   * 「优先保留」不等于「永不淘汰」：若 LRC 长期不可用、50 个会话都攒着
   * 待补写，`maxFiles = 40` 时仍会删掉一部分。这是有意的 ——
   * 无界增长会让磁盘占用失控。超出时打 warn 留痕，便于判断
   * 「是不是 LRC 长期不可用」。
   */
  prune(maxFiles: number): void {
    if (maxFiles <= 0) return;
    try {
      if (!existsSync(this.dir)) return;
      const files = readdirSync(this.dir)
        .filter((f) => f.startsWith('minutes-') && f.endsWith('.json'))
        .map((f) => {
          const path = join(this.dir, f);
          const at = statSync(path).mtimeMs;
          return { name: f, at, pendingToWrite: this.hasPendingWrite(path) };
        })
        // 待补写的排在最前（最不该删），其余按 mtime 新→旧
        .sort((a, b) => {
          if (a.pendingToWrite !== b.pendingToWrite) return a.pendingToWrite ? -1 : 1;
          return b.at - a.at;
        });
      // 待补写数超过保留上限属异常状态（LRC 长期不可用），必须留痕
      const pendingCount = files.filter((f) => f.pendingToWrite).length;
      if (pendingCount > maxFiles) {
        // 该模块不依赖宿主 logger，用 console 兜底（与 CursorStore 同策略）
        console.warn(
          `[lrc] 纪要账本待补写文件 ${pendingCount} 个 > 保留上限 ${maxFiles}，` +
            `将淘汰其中 ${pendingCount - maxFiles} 个（LRC 是否长期不可用？）`,
        );
      }
      for (const file of files.slice(maxFiles)) {
        try {
          unlinkSync(join(this.dir, file.name));
        } catch {
          // 单个删除失败不影响其余
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  /** 该账本文件是否还有「已归档但没写进 LRC」的轮次。 */
  private hasPendingWrite(path: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MinutesLedgerState>;
      // ## 带删除待办的账本同样要保留（九轮审查 minor）
      //
      // `pendingForget` 是「库里还有过时重复纪要没删掉」的唯一记录。
      // 若按 mtime 淘汰掉这个文件，那些 id 就永久失联（重复纪要留在库里）。
      // 清理待办与补写轮次一样，都属于「未完成的工作」。
      if (Array.isArray(parsed.pendingForget) && parsed.pendingForget.length > 0) return true;
      // ## 带阶段标记的账本也要保留（十一轮审查 M-3）
      //
      // `stageWrittenTurnIdx > 0` 表示「库里有一份 in-progress 阶段稿还没收尾」。
      // 若按 mtime 淘汰掉这个账本，收尾入口就没了 —— 库里那条 importance=9
      // 的 `in-progress` 纪要将永久滞留，且下次写入会按「从未写过」放行。
      // 注意：只含阶段标记、`turns` 为空的第一轮长任务账本最容易被误删。
      if (typeof parsed.stageWrittenTurnIdx === 'number' && parsed.stageWrittenTurnIdx > 0) {
        return true;
      }
      // ## 旧版账本缺 `archivedTurns` 时按轮次兜底（七轮审查 m-2）
      //
      // 取 0 会让「有 8 轮但字段缺失」的旧文件被判成「无待补写」，
      // 升级后首次 prune 就可能删掉它。用 `turns.length` 兜底更保守。
      const turnsLen = Array.isArray(parsed.turns) ? parsed.turns.length : 0;
      const archived =
        typeof parsed.archivedTurns === 'number' ? parsed.archivedTurns : turnsLen;
      const written = typeof parsed.writtenAtArchived === 'number' ? parsed.writtenAtArchived : -1;
      // ## 必须排除「空账本」（六轮审查 m-a）
      //
      // 从未归档过任何轮次时 `archived=0, written=-1` ⇒ `-1 < 0` 成立，
      // 会被判成「有待补写」而永久占一个保留名额。加 `archived > 0`
      // 让空账本走正常淘汰。
      return archived > 0 && written < archived;
    } catch {
      // ## 读不出来时**保留**（六轮审查 m-a）
      //
      // 反例：文件正在被并发写（半写入的 JSON）—— 那正是最该保住的状态，
      // 判成 false 会把它排到最末位优先删掉。宁可多留一个坏文件。
      return true;
    }
  }
}

/**
 * 写入闸门：新纪要不得用「更少的轮次」覆盖库里已有的。
 *
 * ## 为什么需要（C2 的运行时兜底）
 *
 * LRC 的写入**不是按 `event_id` 覆盖**，而是**内容 Jaccard ≥ 0.5 才合并**
 * （`memory_store.rs` 的 `find_similar_in_snapshot`）。实测矩阵：
 * ```
 * 20 轮 vs 3 轮  = 0.61 → 合并（旧内容被 update_content 覆盖，丢内容）
 * 40 轮 vs 1 轮  = 0.31 → 不合并（同一 event_id 在库里出现两条）
 * ```
 * 两种结局都错。闸门让「更短的稿」根本发不出去。
 *
 * ## 参数语义：**都用单调的归档轮数**（三段审查 M1）
 *
 * 曾经用 `(writtenTurns, turns.length)` —— 两者都会被 40 轮上限钳住，
 * 恢复出短账本时还会变小，在饱和与恢复两种情形下双双失真。
 * 现在两个参数都传 `archivedTurns` 口径（只增不减），失真面消失。
 *
 * ## `maxTurns` 必填（五轮审查 m3）
 *
 * 早先给了默认值 40，而调用方另有 `TURN_LEDGER_MAX` —— 两处硬编码会
 * 静默漂移。改成必填后由类型系统保证只有一个真相来源。
 *
 * @param writtenArchived - 上次成功写入时的累计归档轮数（-1 = 从未写过）
 * @param nextArchived    - 本次要写的累计归档轮数
 * @param maxTurns        - 账本上限。达到即视为饱和，轮数不可比 ⇒ 放行
 */
export function canOverwriteMinutes(
  writtenArchived: number,
  nextArchived: number,
  maxTurns: number,
): boolean {
  // 从未写过：任何有内容的稿都可以写
  if (writtenArchived < 0) return true;
  // 饱和：轮数失去「进度」含义（每轮都会挤掉最旧一轮），必须放行
  if (nextArchived >= maxTurns) return true;
  return nextArchived >= writtenArchived;
}

/**
 * 是否还有「没进纪要的轮次」（**单调判据**）。
 *
 * ## 为什么不能用 `turns.length`
 *
 * `archivedTurns` 只增不减，`writtenAtArchived` 记录上次写入时的值，
 * 两者之差就是真实增量。账本饱和（`turns.length` 恒为 40）后，
 * 任何基于长度的判据都会失真 —— C6 与 X1 踩的是同一个坑。
 *
 * @param archivedTurns     - 累计归档轮数（单调）
 * @param writtenAtArchived - 上次成功写入时的累计归档轮数（-1 = 从未写过）
 */
export function shouldRewriteMinutes(
  archivedTurns: number,
  writtenAtArchived: number,
): boolean {
  if (writtenAtArchived < 0) return archivedTurns > 0;
  return archivedTurns > writtenAtArchived;
}

/**
 * 从纪要正文里读回「这份纪要覆盖了几轮」。
 *
 * 头部固定形如 `时间：… → …（65.7 小时 / 22 轮，本地时间）`，
 * 由 `buildMinutes` 生成，是本模块自己的格式，可安全反解。
 *
 * @returns 轮数；**解析不出来时返回 `null`**（旧版本格式 / 正文被改动）
 *
 * ## 为什么必须区分 `null` 与 `0`（六轮审查 major 4）
 *
 * 调用方用这个值当「保护基准」。若把「解析不出来」也返回 0，
 * 调用方会以为「库里那份是 0 轮」⇒ 保护整个失效，冷启动的残稿
 * 会照常写入并把库里那份 22 轮纪要覆盖掉（`apply_merge` 整体替换）。
 * 返回 `null` 后调用方可以明确「规格未知 ⇒ 宁可不覆盖」。
 *
 * ## 为什么保护判据用轮数而不是字符数（十五轮审查 C2 修正）
 *
 * 「轮数」才是「完整性」的语义口径，字符数只是它的代理指标 ——
 * 而且代理会失效：
 * ```
 * 阶段稿：… - 13:00 第九轮 做重构（in-progress）
 * 正式稿：… - 13:00 第九轮 做重构          ← 同样 9 轮，但少 14 字符
 * ```
 * 用字符数判「更短」会把这唯一正确的收尾写入拦下，于是库里
 * 永久停在 `in-progress`。轮数不受标记长度影响。
 */
export function parseMinutesTurns(content: string): number | null {
  const m = /\/\s*(\d+)\s*轮/.exec(content);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 与 LRC **同源**的相似度（七轮审查 major 4）。
 *
 * 逐条对齐 `core/lrc-algo/src/engine/synthesis_engine.rs`：
 * ```
 * JaccardTerms::new(text):                     // :463-484
 *   lower = text.to_lowercase()                // 仅小写化，**不删标点/空格**
 *   has_cjk = 任一字符落在 0x4E00..=0x9FFF
 *   bigrams = lower 的**全部相邻字符**二元组    // 含空格、换行、标点
 *   words   = has_cjk ? None : lower.split_whitespace()
 *
 * jaccard_with_terms(a, b):                    // :495-521
 *   任一含 CJK ⇒ bigram 的 |交|/|并|
 *   否则       ⇒ 词集的 |交|/|并|
 * ```
 *
 * ## 为什么必须同源（不能「去噪后比较」）
 *
 * 插件侧算这个值是为了**预测 LRC 会不会合并**。算法不同就会错配：
 * ```
 * 插件算 0.45 < 0.5 ⇒ 以为 LRC 会新建 ⇒ 放行
 * LRC  算 0.72 ≥ 0.5 ⇒ 实际合并并整体替换 ⇒ 完整稿被残缺稿覆盖 ❌
 * ```
 * 早期版本删掉了所有非字母数字字符、且 ASCII 也走字符 bigram ——
 * 与 LRC 的「词集模式」完全不同，在英文纪要上会严重低估。
 */
export function minutesSimilarity(a: string, b: string): number {
  const toTerms = (text: string): { hasCjk: boolean; bigrams: Set<string>; words: Set<string> } => {
    const lower = text.toLowerCase();
    const chars = [...lower];
    const hasCjk = chars.some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code >= 0x4e00 && code <= 0x9fff;
    });
    const bigrams = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i += 1) bigrams.add(`${chars[i]}${chars[i + 1]}`);
    const words = hasCjk
      ? new Set<string>()
      : new Set(lower.split(/\s+/).filter((w) => w.length > 0));
    return { hasCjk, bigrams, words };
  };
  const ta = toTerms(a);
  const tb = toTerms(b);
  const useBigram = ta.hasCjk || tb.hasCjk;
  const sa = useBigram ? ta.bigrams : ta.words;
  const sb = useBigram ? tb.bigrams : tb.words;
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** LRC 判「合并（覆盖）」的阈值，与 `memory_store.rs` 对齐。 */
export const MINUTES_MERGE_THRESHOLD = 0.5;

/**
 * 生成并写入纪要到 LRC。
 *
 * @param client    - 已连接的 LRC 客户端（未连接时调用方应跳过）
 * @param sessionId - 会话 ID
 * @param turns     - 轮次记录
 * @param config    - 上限配置
 * @param existingSegments - 库里**全部**同 `event_id` 段的 `{turns, content}`。
 *   与其中一段相似度 ≥ 0.5 时，LRC 会**合并并整体替换**那段
 *   （`apply_merge` → `update_content`，不做长度保护）。
 *   所以本函数选相似度最高的那段当**基线**，把它的诉求行与结论并入本稿
 *   （grow-only），保证发出的 content 是那段内容的**超集**。
 *
 *   ## 为什么不再「拦下」（六钥匙裁决）
 *   拦下的副作用是「本轮真实对话永远进不了库」，而放行的副作用是
 *   「库里那段被替换」。拼接让两者同时成立，所以拦截分支整个删掉了。
 *   唯一保留的跳过条件是「拼完与基线完全相同」⇒ 无变化，不必发 HTTP。
 * @returns 写入结果；无有效内容或与基线无差异时 `written: false`
 */
export async function writeMinutes(
  client: Pick<LrcClient, 'remember'>,
  sessionId: string,
  turns: readonly TurnRecord[],
  options: {
    project?: string;
    config?: MinutesConfig;
    startedAt?: number;
    existingSegments?: ReadonlyArray<{ turns: number | null; content: string }>;
  } = {},
): Promise<MinutesWriteResult> {
  const config = options.config ?? DEFAULT_MINUTES_CONFIG;
  // ## 先算「本稿不带基线」的形态，用它挑基线
  //
  // 只有与库里某段相似度 ≥ 0.5 时 LRC 才会合并进那段 —— 那才是需要
  // 拼基线的情形。相似度低时 LRC 会新建一条，拼进来反而污染新段。
  const bare = buildMinutes(sessionId, turns, config, options.startedAt);
  if (bare === null) {
    return {
      written: false,
      memoryId: '',
      chars: 0,
      content: '',
      turns: 0,
      conclusions: 0,
    };
  }
  const segments = options.existingSegments ?? [];
  const baseline = segments
    .map((seg) => ({ seg, sim: minutesSimilarity(seg.content, bare.content) }))
    .filter((x) => x.sim >= MINUTES_MERGE_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)[0];
  const draft =
    baseline === undefined
      ? bare
      : buildMinutes(sessionId, turns, config, options.startedAt, baseline.seg.content);
  if (draft === null) {
    return {
      written: false,
      memoryId: '',
      chars: 0,
      content: '',
      turns: 0,
      conclusions: 0,
    };
  }
  // ## 拼完与基线完全相同 ⇒ 无变化，不发 HTTP
  //
  // 这正是「账本丢失后重放全部旧内容」的场景：拼去重后与库里那段一字不差。
  // 不跳过的话每次重放都会白写一次（还会推进 `writtenAtArchived`）。
  if (baseline !== undefined && draft.content === baseline.seg.content) {
    return {
      written: false,
      memoryId: '',
      chars: draft.content.length,
      content: draft.content,
      turns: draft.turns,
      conclusions: draft.conclusions,
      unchanged: true,
    };
  }
  const { memoryId } = await client.remember({
    content: draft.content,
    memoryType: 'conversation',
    ...(options.project === undefined ? {} : { project: options.project }),
    tags: minutesTags(sessionId),
    // 纪要是整段对话的最高价值产物，给最高重要性
    importance: 9,
    eventId: minutesEventId(sessionId),
    // ★ 真实发生时间，不是写入时刻
    sourceTimestampMs: draft.startedAt,
  });
  return {
    written: memoryId.length > 0,
    memoryId,
    chars: draft.content.length,
    content: draft.content,
    turns: draft.turns,
    conclusions: draft.conclusions,
  };
}
