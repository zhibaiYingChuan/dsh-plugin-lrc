/**
 * 路径 1 + 路径 2：确定性上下文裁剪（零 LLM）。
 *
 * ## 两条路径的分工
 *
 * - **路径 2（`pruneToolResults`）**：调用官方 `toolResultPruner` 服务，
 *   把超长工具输出（默认 >8192 字符）截成「头 4096 + 标记 + 尾 1024」。
 *   同步、幂等、不丢对话结构，每步都能跑，是廉价的持续过滤。
 * - **路径 1（`trimContext`）**：把旧历史整段替换成一条规则式摘要。
 *   更重、更激进，按 token 阈值 + 步数节流触发。
 *
 * 先剪枝再裁剪：剪枝后 token 往往已经降下来，路径 1 就不必触发。
 *
 * ## 为什么走这条路
 *
 * 宿主层的 `ctx.get('compaction')` 在桌面装配下拿不到 —— 压缩服务被关在
 * 每个 agent preset 的 `isolate: { compaction: true }` 里。但
 * `ctx.get('agentPresets').serviceFor(agent, 'compaction')` 能穿透隔离，
 * 拿到该会话自己的 `BasicCompactionEngine`（探针已实测可用）。
 *
 * ## 为什么不用 compactIfNeeded
 *
 * `compactIfNeeded(agent, 'pressure')` 依赖 `engine.config.thresholdRatio`，
 * 而 `resolveConfig()` 返回的是 `deepFreeze()` 过的对象 —— 临时改阈值会静默失败。
 * `'context-overflow'` 分支虽然绕过阈值，但保留尾部为 0，会把整段历史压成一条，
 * 过于激进。所以这里直接调 `compactRegion(start, end, agent, signal)`，
 * 自己选范围、自己保留最近 N 个节点。
 *
 * ## 为什么能零 LLM
 *
 * `compactRegion` 内部经 `regionDependencies().summarize` **动态调用**
 * `this.summarize(...)`，所以临时替换实例上的 `summarize` 即可接管摘要生成。
 * 替换是同步的、不 yield，`assertWholeSurfaceUnchanged` 不会失败。
 *
 * ## 边界
 *
 * - 只裁「旧」历史，最近 `keepRecentNodes` 个 surface 节点原样保留
 * - 裁剪边界必须工具配对平衡（不能把 tool-call 和 tool-result 切开）
 * - 摘要必须比被藏内容短，否则引擎抛错 —— 这里按被藏字符数的 1/4 硬性封顶
 * - 任何异常都吞掉并返回原因，绝不影响对话
 */
import { randomUUID } from 'node:crypto';
import { isConversationNode } from './event-classify.ts';
import { isProcessNarration as schemaIsProcessNarration } from './memory-schema.ts';

/** 保留尾部节点数的默认值（配置非法时用它）。 */
export const DEFAULT_KEEP_RECENT = 8;

/**
 * 单次裁剪节点数的默认上限（`maxNodes` 传了非法值时用它）。
 *
 * **必须取「安全侧」**：非法值退化成「不限制」会让一次裁掉 92%，
 * 那正是本次事故的形态；退化成「40」最坏只是少裁一点。
 */
export const DEFAULT_MAX_NODES_PER_RUN = 40;

/** 裁剪参数。 */
export interface TrimOptions {
  /** 上下文低于这个 token 数就不裁（避免无意义抖动） */
  minTokens: number;
  /** 保留最近多少个 surface 节点原文 */
  keepRecentNodes: number;
  /** 摘要字符上限 */
  maxSummaryChars: number;
  /**
   * 强制裁剪：跳过 token 阈值判断。
   *
   * 用于「节点数超过硬上限」的兜底 —— token 计量一旦失真（宿主换版本、
   * meter 返回 0、阈值配错），纯 token 触发会让上下文无限增长。
   * 节点数是**不依赖任何服务**的硬指标，用它兜底最可靠。
   */
  force?: boolean;
  /**
   * 本次最多裁掉多少个节点。
   *
   * ## 为什么必须有上限
   *
   * 原实现把 `[startIdx, endIdx]` 整段一次替换掉。实测
   * （session-e1419190）：
   *
   * ```
   * 23:53  节点=141 → 裁掉 131 个（92%）
   * 08:27  节点=137 → 裁掉 127 个（92%）
   * ```
   *
   * 每次都是「一次性重写整段前缀」—— KV 缓存按前缀复用，这等于把
   * 缓存全部作废。而且裁完只剩 8 个保留节点，模型立刻丢失最近的工作脉络。
   *
   * 改为每次只裁一部分，代价分摊到多次。
   *
   * ## 两条触发路径都生效（不只是 force）
   *
   * 早期版本写「`force` 时生效」，理由是「token 超阈值说明真的太大」。
   * 实测反驳：窗口 800K 时 trimMin 降到 8 万，节点数 114 就走 token 路径，
   * 一次裁 104（91%），事故原样复发。所以现在无条件生效。
   *
   * 缺省（`undefined`）时由 `trimContext` 补 `DEFAULT_MAX_NODES_PER_RUN`，
   * **不会退化成「不限制」** —— 那是事故形态本身。
   */
  maxNodesPerRun?: number;
  /**
   * 会话 Fact 账本：摘要「助手结论」段的**唯一真理源**（★2026-11-14）。
   *
   * 不传时退回旧行为（按 role 判定），那会把过程叙述当结论。
   * 由 `index.ts` 在每次 `trimContext` 调用时传入本会话账本。
   */
  facts?: readonly { kind: string; statement: string; status?: string }[];
}

/** 一次裁剪的结果。 */
export interface TrimOutcome {
  ok: boolean;
  /** 机器可读原因：ok / below-threshold / no-range / engine-unavailable / error:… */
  reason: string;
  /** 诊断细节：失败时带上节点数 / token 数 / 事件源，避免静默 */
  detail?: string;
  /** 被藏起来的 token 数（成功时） */
  shadowedTokens?: number;
  /** 摘要字符数（成功时） */
  summaryChars?: number;
  /** 摘要各区块条目数（成功时，诊断用） */
  summaryStats?: string;
}

/** 裁剪范围（surface 位置上的闭区间）。 */
export interface TrimRange {
  start: number;
  end: number;
  startIdx: number;
  endIdx: number;
}

function safeGet(ctx: unknown, name: string): unknown {
  try {
    return (ctx as { get?: (n: string) => unknown })?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * 取会话的事件数组。
 *
 * **不能只读 `session.events`**：不同 DSH 版本的公开成员不一样 ——
 * 有的版本是 `events` getter，有的只有 `log`，有的提供 `snapshotEvents()`。
 * 只认一个字段会让 `trimContext` 恒返回 `no-range` 且被静默吞掉
 * （实测生产里 120 步超过阈值、一次都没裁）。
 *
 * @param session - 宿主会话对象
 * @returns 事件数组；三种形状都不匹配时返回 undefined
 */
export function resolveSessionEvents(session: unknown): unknown[] | undefined {
  const s = session as {
    snapshotEvents?: () => unknown;
    events?: unknown;
    log?: unknown;
  };
  try {
    const snapshot = s?.snapshotEvents?.();
    if (Array.isArray(snapshot)) return snapshot;
  } catch {
    // 继续尝试下一种形状
  }
  if (Array.isArray(s?.events)) return s.events;
  if (Array.isArray(s?.log)) return s.log;
  return undefined;
}

/**
 * 是否是裁剪摘要节点（宿主 `compactRegion` 产出的 checkpoint）。
 *
 * ## 为什么必须单独识别
 *
 * 宿主把摘要写成 `user/message` + `source.kind = 'compact-checkpoint'`。
 * `classifyEvent` 对 `user/message` 的判定是「kind 不是 user 就归 injected」，
 * 于是摘要被归为 `injected`，`isTrimBoundaryEligible` 直接跳过它。
 *
 * 后果（实测 3.5 小时）：每轮 trim 把旧区间换成一条约 2,310 字符的摘要，
 * 摘要落在被替换区间的起点；下一轮 trim 从摘要**之后**的第一个可裁剪节点开始，
 * 于是**任何一条摘要都不会被后续裁剪覆盖**。真实内容被压到 36%，
 * 摘要层线性累积到 64%，成为上下文最大单项（实测 97 节点里 85 条是摘要）。
 *
 * 摘要必须可再次被裁剪：它是「旧历史的压缩表示」，不是运行时事实。
 *
 * ## 为什么还要按内容前缀兜底
 *
 * 只认 `source.kind` 的话，宿主一旦改字段名，85 条堆叠会立刻复现。
 * 实测宿主 checkpoint 正文以 `This is an automatically generated checkpoint` 开头，
 * LRC 自己的摘要以 `## 已裁剪的历史` 开头，两者都可作为稳定判据。
 */
const SUMMARY_TEXT_PREFIXES = [
  '## 已裁剪的历史',
  'This is an automatically generated checkpoint',
  '<compacted-summary>',
];

export function isSummaryNode(event: unknown): boolean {
  const e = event as {
    type?: string;
    data?: { source?: { kind?: string }; content?: unknown };
  };
  if (e?.type !== 'user/message') return false;
  const kind = e.data?.source?.kind;
  if (
    kind === 'compact-checkpoint' ||
    kind === 'compaction' ||
    kind === 'summary' ||
    // LRC 自己产出的「已剪枝」节点（prune-reasoning 的替换体）：
    // 它是旧对话的改写版，必须可再次被 trim 覆盖，否则会像摘要一样累积。
    kind === 'lrc-prune'
  ) {
    return true;
  }
  // 兜底：按内容前缀识别，避免宿主改 source.kind 后堆叠复现
  const content = e.data?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== 'string') continue;
    const head = text.trimStart();
    if (SUMMARY_TEXT_PREFIXES.some((prefix) => head.startsWith(prefix))) return true;
  }
  return false;
}

/**
 * 是否可以作为裁剪区间的边界节点。
 *
 * 判定统一走 `event-classify.ts`：真实对话节点（user / assistant / tool-result）
 * 可以替换；`system/message`、注入上下文、未知类型一律跳过。
 *
 * **摘要节点是例外**：它虽然被 `classifyEvent` 归为 `injected`，但必须可再次裁剪，
 * 否则摘要层只增不减（见 `isSummaryNode`）。
 *
 * 之前这里是黑名单，漏掉 `system/message` 导致起点恒为 0，
 * `compactRegion` 必报 `node 0 holds the system prompt`。
 */
function isTrimBoundaryEligible(event: unknown): boolean {
  return isConversationNode(event) || isSummaryNode(event);
}

/** 一个 surface 事件对「未闭合工具调用数」的增量，与 DSH 的 tool-pairing 口径一致。 */
function toolDelta(event: unknown): number {
  const e = event as {
    type?: string;
    data?: { message?: { content?: unknown } };
  };
  if (e?.type === 'assistant/message') {
    const content = e.data?.message?.content;
    if (!Array.isArray(content)) return 0;
    let calls = 0;
    for (const block of content) {
      if ((block as { type?: string })?.type === 'tool-call') calls += 1;
    }
    return calls;
  }
  if (e?.type === 'tool/result') return -1;
  return 0;
}

/**
 * 归一化「节点数 / 保留数」这类配置。
 *
 * ## 为什么必须在函数入口做，而不是在调用方
 *
 * 这些值来自宿主 `cordis.patch.yml`，**不会**随插件升级自动补齐新字段，
 * 且可能被写成字符串 / 小数 / `NaN`。两种失效形态已在真实事故里各出现过一次：
 *
 * ```
 * '40'   → 隐式转数参与算术，限制完全失效
 * NaN    → 比较恒 false，`n <= NaN+1` 漏过守卫，区间算出 seq=undefined
 * 0.3    → 先 floor 成 0，再被判为非法 ⇒ 退化成「不限制」，一次裁光
 * ```
 *
 * 上一版只在 `index.ts` 的调用方做收口，漏掉了同函数里的 `keepRecentNodes`
 * —— 而 `trimContext` / `selectTrimRange` 都是导出函数，任何调用方都会继承这个洞。
 * 收口放在入口才不会再漏。
 *
 * @param value - 原始值
 * @param fallback - 非法时用的默认值
 * @param min - 允许的最小值（含）
 */
export function normalizeCount(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  const floored = Math.floor(value);
  // (0,1) 区间：配置写错（如 `0.3`）。**取 fallback，不要升到 1**。
  //
  // 上一版 `Math.max(min, floored)` 在 `min=0` 时给出 0，于是
  // `keepRecentNodes=0.3` ⇒ 保留 0 个节点 ⇒ 192 节点裁 188（97.9%），
  // 比事故的 92% 更激进。改成 `max(1, min)` 也只是「保留 1 个」，
  // 仍是近乎全裁。
  //
  // 小数几乎只可能来自「单位换算写错」，正确处置是**当作没配**，
  // 用默认值（keepRecent 默认 8），而不是猜一个极限值。
  if (floored === 0 && value !== 0) return fallback;
  return Math.max(min, floored);
}

/**
 * 归一化「单次最多裁多少节点」。
 *
 * ## 与 `normalizeCount` 的区别：非法值必须退化到**安全侧**
 *
 * `maxNodes` 是**防事故的限流阀**（事故：一次裁 92%）。所以：
 *
 * | 输入 | 结果 | 理由 |
 * |---|---|---|
 * | `undefined` | `undefined`（不限制） | 正常缺省，token 触发路径就该整段裁 |
 * | `40` / `'40'` | `40` | 字符串是宿主 patch 的真实形态，转数后接受 |
 * | `0.3` / `0.5` | `1` | 不能 `floor` 成 0 后被当成「不限制」 |
 * | `3.7` | `3` | 向下取整 |
 * | `0` / `-5` / `NaN` / `Infinity` / `true` / `{}` | **40** | 非法 ⇒ 用默认上限 |
 *
 * **非法值绝不能退化成「不限制」** —— 那正是事故形态本身。
 * 上一版在 `selectTrimRange` 里写 `normalizeCount(...) || undefined`，
 * 于是 `'40'` 走 fallback=0、再被 `||` 变成 `undefined` ⇒ 真实 145 节点
 * surface 上裁 135（等于不限制）。而 e2e 还把「视为不限制」写成了期望值，
 * 等于把事故根因固化成回归锁。
 *
 * @param value - 宿主传来的原始值
 * @returns 归一化后的上限；`undefined` 表示不限制
 */
export function normalizeMaxNodes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const asNumber =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return DEFAULT_MAX_NODES_PER_RUN;
  // **(0,1) 退化为默认上限，不能退化为 1**。
  //
  // 上一版写 `Math.max(1, Math.floor(v))`，于是 `0.3 → 1`。
  // 而真实增长节奏是「每步 append 均值 2.25 个节点、每 10 步裁一次」：
  //   limit=40：141 → 122 → … → 11（收敛）
  //   limit=1 ：141 → 161 → 181 → … → 341（**单调膨胀**）
  // 即「配置误写」会被放大成事故 A 的观感（上下文一路涨）。
  // 小数几乎只可能来自「单位写错」，正确处置是当作没配、用默认上限。
  if (asNumber < 1) return DEFAULT_MAX_NODES_PER_RUN;
  // 上界：超过 1000 等价于「不限制」，同样按非法值处理
  if (asNumber > 1000) return DEFAULT_MAX_NODES_PER_RUN;
  return Math.max(1, Math.floor(asNumber));
}

/**
 * 选一段可安全裁剪的旧历史。
 *
 * `cut[i]` 表示「第 i 个节点之前的切点是否平衡」，`cut[n]` 是尾部切点。
 * 起点取第一个平衡切点（`cut[0]` 恒为 true），终点从「保留尾部」往前退到平衡切点。
 *
 * @param nodes - `session.surface.nodes`（当前 surface 的事件 seq 列表）
 * @param events - `session.events`（按 seq 索引的事件数组）
 * @param keepRecentNodes - 尾部原样保留的节点数
 * @param maxNodes - 本次最多裁多少个节点（`undefined` = 不限制，裁到 keepRecent 边界）
 * @returns 可裁剪范围；没有安全范围时返回 null
 */
export function selectTrimRange(
  nodes: readonly number[],
  events: readonly unknown[],
  keepRecentNodes: number,
  maxNodes?: number,
): TrimRange | null {
  // 两个入参都在这里收口（理由见 `normalizeCount` / `normalizeMaxNodes`）。
  //
  // `keepRecentNodes` 的**合法值是 ≥1**：保留 0 个等于「不留任何近期上下文」，
  // 实测 141 节点裁 139（98.6%），比事故的 92% 更激进。
  // 但 1 是合法配置（只留最后一条），不能因为防 0 就把它抬到 2 ——
  // 那会悄悄改变用户显式配置的行为。
  const rawKeep = normalizeCount(keepRecentNodes, DEFAULT_KEEP_RECENT, 0);
  const keep = rawKeep < 1 ? DEFAULT_KEEP_RECENT : rawKeep;
  const limit = normalizeMaxNodes(maxNodes);

  const n = nodes.length;
  if (n <= keep + 1) return null;

  const cut: boolean[] = new Array(n + 1).fill(false);
  let running = 0;
  cut[0] = true;
  for (let i = 0; i < n; i += 1) {
    running += toolDelta(events[nodes[i] as number]);
    cut[i + 1] = running === 0;
  }

  // ── 先定终点（从保留边界往回收）──
  //
  // 顺序与原来一致：先确定一个**可用的**尾部边界，再据此限定起点。
  // 不能先定起点：若边界处节点不可替换（大量 injected 消息），
  // 先算起点会一路加到边界之外直接返回 null，而实际上往回收一步就能裁。
  const hardEnd = n - keep - 1;
  let endIdx = hardEnd;
  while (
    endIdx >= 0 &&
    (cut[endIdx + 1] !== true || !isTrimBoundaryEligible(events[nodes[endIdx] as number]))
  ) {
    endIdx -= 1;
  }
  if (endIdx < 0) return null;

  // ── 再定起点（上限是已确定的 endIdx）──
  let startIdx = 0;
  while (
    startIdx <= endIdx &&
    (cut[startIdx] !== true || !isTrimBoundaryEligible(events[nodes[startIdx] as number]))
  ) {
    startIdx += 1;
  }
  if (startIdx > endIdx) return null;

  // ── 最后按 maxNodes 收缩终点 ──
  //
  // 裁掉的节点数 = endIdx - startIdx + 1。渐进裁剪把单次规模压到
  // maxNodes 以内，避免「一次重写整段前缀」把 KV 缓存全部作废。
  if (limit !== undefined && endIdx - startIdx + 1 > limit) {
    // ## 单位是「节点数」，不是「可替换节点数」
    //
    // `compactRegion(start, end)` 替换的是**整个连续区间**，
    // 区间里夹着的 tool/call、step/start、job 等节点都会被一并折进摘要。
    // 所以预算就是区间长度 `endIdx - startIdx + 1`。
    //
    // 我上一版把它误解成「数够 limit 个可替换节点」，在真实 surface 上
    // （session-e1419190，145 节点里约 127~135 个可替换）导致数不到 limit，
    // 直接退化成整段裁剪（裁 126 个）—— 等于 40 的限制完全失效。
    //
    // 也不能要求「连续可替换」（再上一版）：节点 [0] 是 compact-checkpoint，
    // [1] 是 compaction/end（不可替换），首轮 break ⇒ 只裁 1 个，
    // `force` 每 10 步减 1 而每步新增 2.8，上下文持续膨胀。
    //
    // 正确做法：**直接按区间长度切**，再回退到最近的平衡切点。
    let want = Math.min(endIdx, startIdx + limit - 1);

    // 回退到最近的「切点平衡 + 端点可替换」位置
    let e = want;
    while (
      e >= startIdx &&
      (cut[e + 1] !== true || !isTrimBoundaryEligible(events[nodes[e] as number]))
    ) {
      e -= 1;
    }

    if (e >= startIdx) {
      endIdx = e;
    } else {
      // 回退失败：向前找最近的可用切点（宁可多裁一点，
      // 也不要退化为整段裁剪 —— 那会复现 92% 的老问题）。
      //
      // ## 但必须有硬上界
      //
      // 起点自身是**并行 tool-call**（一条 assistant 消息带 N 个 tool-call）时，
      // `cut[startIdx+1..startIdx+N]` 全为 false，`[startIdx, want]` 内一个
      // 合法位置都没有 —— 只能跳到并行段结束后。而「并行度 ≤ limit-2」是个
      // **未经任何断言的隐式前提**：实测 40 并行时 limit=40 会裁 41，
      // 100 并行时裁 101（2.5 倍）。
      //
      // 真实日志里最大并行度是 2（两份会话 tool-call 分布 {1:224,2:9}/{1:171,2:8}），
      // 所以线上不可达；但 DSH 支持并行调用，模型行为一变就会引爆。
      //
      // 因此把越界限制在 2 倍预算内：超过就**不裁**（返回 null）。
      // 让 `trimContext` 记 `no-range` 而不是静默多裁 —— 可观测优先于勉强完成任务。
      const hardCap = Math.min(endIdx, startIdx + limit * 2 - 1);
      let up = Math.max(want, startIdx);
      while (
        up <= hardCap &&
        (cut[up + 1] !== true || !isTrimBoundaryEligible(events[nodes[up] as number]))
      ) {
        up += 1;
      }
      if (up > hardCap) return null;
      endIdx = up;
    }
  }

  return {
    start: nodes[startIdx] as number,
    end: nodes[endIdx] as number,
    startIdx,
    endIdx,
  };
}

/**
 * 起点回退：从 `startIdx + 1` 起找第一个「切点平衡 + 可替换」的节点。
 *
 * ## 为什么需要
 *
 * 某些 DSH 版本把系统提示写成**没有 source 的 `user/message`**，
 * `classifyEvent` 按兼容旧格式的规则把它判成 `user`，于是
 * `selectTrimRange` 认为 node 0 可替换，`compactRegion` 必报
 * `node 0 holds the system prompt`。实测该区间没有兜底时会一路涨到 81k tokens。
 *
 * 回退不能简单 `startIdx + 1`：如果被跳过的节点是 `tool/result`，
 * 直接后移会破坏 tool-pairing 平衡，宿主仍会拒绝。所以这里同时校验
 * 「被跳过的前缀增量之和为 0」。
 *
 * @param nodes - `session.surface.nodes`
 * @param events - 按 seq 索引的事件数组
 * @param startIdx - 原起点
 * @param endIdx - 原终点
 * @returns 可用的新起点下标；找不到时返回 null
 */
export function findRetryStart(
  nodes: readonly number[],
  events: readonly unknown[],
  startIdx: number,
  endIdx: number,
): number | null {
  let running = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    running += toolDelta(events[nodes[i] as number]);
    const candidate = i + 1;
    if (running === 0 && isTrimBoundaryEligible(events[nodes[candidate] as number])) {
      return candidate;
    }
  }
  return null;
}

/** 从内容块里取纯文本（只认 text，推理不进摘要）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) out.push(b.text);
  }
  return out.join('\n');
}

/** 压成一行并截断。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 把一段正文切成句子（用于**逐句**判过程叙述，★2026-11-15 独立审查 P1）。
 *
 * ## 为什么需要它
 *
 * lrc-prune 的正文是一整段 text block，可能包含几十句。对整段做
 * `isProcessNarration` 是**粒度层双裁判**：`memory-extract` 按单句判，
 * 摘要按整块判，同一判据两种结论 —— 首句是过程叙述就让整段消失。
 *
 * ## 切分规则
 *
 * 与 `memory-extract.splitClauses` 保持同源：换行 + 句末标点。
 * 只做切分不改写，空句丢弃。长度上限交给调用方的 `oneLine`。
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[\n。！？；]+/)
    .map((line) => line.trim().replace(/^[-*+\d.)\s|#]+/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * 去重后按上限收集。
 *
 * @param options.keepNewest - 达到上限后**淘汰最旧、保留最新**（★2026-11-15）
 *
 * ## 为什么需要 `keepNewest`
 *
 * 默认语义是「先到先得，满了就丢后来者」，适合调用/错误这类**日志**。
 * 但 lrc-prune 桶要的是「本轮最新的任务产出」：实测 20 条素材、
 * 上限 10 时只留下素材 1–10，第 20 条（最新）永远进不来 ——
 * 即使投影端倒序遍历也救不回来，因为**收集端就已经丢了**。
 *
 * 这是独立审查 P0-3 复查时发现的：上一轮只改了投影端的方向，
 * 没注意收集端是另一种截断。
 */
function collect(
  target: string[],
  seen: Set<string>,
  line: string,
  limit: number,
  options: { keepNewest?: boolean } = {},
): void {
  if (line.length === 0 || seen.has(line)) return;
  if (target.length >= limit) {
    if (options.keepNewest !== true) return;
    // 淘汰最旧（队首），腾出位置给这一条最新
    const evicted = target.shift();
    if (evicted !== undefined) seen.delete(evicted);
  }
  seen.add(line);
  target.push(line);
}

/**
 * 宿主每轮注入的系统噪音前缀。
 *
 * ## 为什么必须过滤
 *
 * 推理侧回放里，这些内容全部是 `role:'user'` 的纯文本块，和用户真正说的话
 * 在结构上**无法区分**。实测 145 条「用户请求」里 137 条是噪音（94%）：
 * 运行时上下文快照、技能目录更新通知、审批策略变更、checkpoint 外壳。
 *
 * 后果是摘要的「用户请求」区被噪音占满，真正的任务描述被挤掉 ——
 * 摘要看起来 2000 字符写满，实际信息量为零。
 */
const NOISE_PREFIXES = [
  'Current runtime context.',
  'Current working directory:',
  'Current DSH file policy:',
  'Current DeepSeek Harness',
  'This is an automatically generated checkpoint',
  '<compacted-summary>',
  '</compacted-summary>',
  '<system-reminder>',
  // 系统提示首句（`systemPromptUpdate: in-history` 时它作为 role:'system'
  // 消息进入重放历史；即使 role 字段丢失，也不能把它当结论收进摘要）
  'You are an AI agent powered by DeepSeek Harness',
  'The available skill catalog changed',
  'The user changed the approval policy',
  'Approval prompts are disabled',
  // 每轮 prepare 时宿主采样时间并注入，同样伪装成 role:'user'
  'Time sampled while preparing',
  'Browser time zone for this request:',
  // ## 后台任务通知（`source.kind === 'tool-jobs'`）不是用户发言（★2026-11-15）
  //
  // 实测最新摘要的「用户请求」首条是：
  // ```
  // - background job pwsh-2b002cc2420941a9 (pwsh: cd H:\xjz; node server/src/index.js) finished …
  // ```
  // 这是宿主报告后台命令结束的注入，与用户意图无关，却占了仅有的
  // 12 个请求槽位之一。`source.kind` 已能识别，但摘要采集只看内容，
  // 所以这里补前缀兜底（两条通道都要拦，不能只靠 kind）。
  'background job ',
  '## 已裁剪的历史',
  '### 用户请求',
  '### 工具调用与结果',
  '### 工具错误',
  '### 助手结论',
  '### 早期结论',
  '[LRC 状态]',
] as const;

/** 是否是宿主注入的系统噪音（非用户真实发言）。 */
function isNoiseText(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true;
  // 只比前缀：噪音标记总在开头，避免正文里偶然提到这些词被误杀
  const head = t.length > 160 ? t.slice(0, 160) : t;
  return NOISE_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * 是否是「过程叙述」：描述「接下来要做什么」，不是已完成的结论。
 *
 * ## 为什么复用 `memory-schema` 的判据（★2026-11-15）
 *
 * 这个文件原本有一份**自己写的**过程叙述判断：
 * ```
 * /接下来|下一步|我要|待确认|待验证|还需要|准备|打算|将要/
 * ```
 * 它比 `memory-schema.ts` 的 `isProcessNarration` 弱得多 —— 后者已经
 * 迭代出三层判据（显式第一人称 / 时间副词 / 执行叙述），覆盖
 * `我把 X 改成 Y`、`全部换成了…`、`现在换成…` 等 9 类形态。
 *
 * 实测后果（`session-95eaf7e3`）：
 * ```
 * 提取器：`我先看一下文件` → 拒绝（process_narration）
 * 摘要：  `我先看一下文件` → 收进「助手结论」
 * ```
 * **同一句话被两个模块判成相反结论** —— 这是「双裁判」问题的第三处实例
 * （前两处：写入路径 6 条合并、摘要 isConclusionRole）。
 *
 * 现在统一走 `memory-schema` 的判据，注解为 `assistant`（摘要里的正文
 * 全部来自助手消息）。
 */
function isProcessNarration(text: string): boolean {
  return schemaIsProcessNarration(text, 'assistant');
}

/**
 * 「用户请求」段里**实际上是助手正文**的形态特征（★2026-11-15 存量清理）。
 *
 * ## 为什么需要它
 *
 * 旧版插件把 `lrc-prune` 的助手正文错记进摘要的「用户请求」段：
 * ```
 * - 十六枚都已经画好，全在下面这张图里…  ![十六枚候选](H:\xjz\.shots\95-…png)
 * - 提交了（`c1cf3be`）。这是画押屏的样板…  ![未蘸](H:\xjz\.shots\70-…png)
 * ```
 * 该摘要被宿主包成 `compact-checkpoint`，本函数每次裁剪都原样吸收，
 * 于是污染在 69 个 checkpoint 里层层复制（实测会话至今 2 条残留）。
 *
 * 新代码已阻止**新增**（`prunedByLrc` 重分类 + `tool-jobs` 过滤），
 * 但已写进历史摘要的内容无法自动消失 —— 只能在此处**逐条清掉**。
 *
 * ## 判据为什么选 Markdown 图片语法
 *
 * 它是纯**形态**标记（`![alt](path)`），不涉及任何语义判断 ——
 * 符合「代码层只判形态、价值判断交 LLM」的分工。
 *
 * 实测该会话 11 条真实用户消息**全部不含** `![`，两条污染条目**全部含**。
 * 用户粘贴图片时给的是路径或截图，不会写成 Markdown 图片标签。
 */
const ASSISTANT_PROSE_MARKER = /!\[[^\]]*\]\([^)]*\)/;

/**
 * 把一条旧摘要的内容吸收进当前桶，而不是原样再嵌一层。
 *
 * 摘要自身会被再次裁剪（`isSummaryNode`）。若把旧摘要当成「用户请求」整段塞回，
 * 每轮就多套一层「已裁剪的历史」，深度线性增长且全是重复文本（实测 67 层嵌套）。
 * 这里按区块把旧摘要**摊平**，只取其中的真实条目。
 */
function absorbPriorSummary(
  text: string,
  buckets: { requests: string[]; calls: string[]; errors: string[]; conclusions: string[] },
  seen: Set<string>,
): void {
  const limits = { requests: 8, calls: 20, errors: 10, conclusions: 10 };
  let section: keyof typeof buckets | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('## ')) continue;

    if (line.startsWith('### ')) {
      const title = line.slice(4).trim();
      if (title.startsWith('用户请求')) section = 'requests';
      else if (title.startsWith('工具调用')) section = 'calls';
      else if (title.startsWith('工具错误')) section = 'errors';
      else if (title.startsWith('助手结论') || title.startsWith('早期结论')) section = 'conclusions';
      else section = undefined;
      continue;
    }

    if (section === undefined) continue;
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    if (isNoiseText(body)) continue;
    // 存量污染清理：助手正文不该留在「用户请求」段（见上方判据注释）
    if (section === 'requests' && ASSISTANT_PROSE_MARKER.test(body)) continue;
    collect(buckets[section], seen, `- ${body}`, limits[section]);
  }
}

/**
 * 摘要收录的消息角色**白名单**。
 *
 * ## 为什么必须白名单，而不是「非 user 即 assistant」
 *
 * 原实现是：`role === 'tool'` 走工具分支、`role === 'user'` 进「用户请求」、
 * **其余一切** 都进「助手结论」。而 DSH 的模型配置是
 * `systemPromptUpdate: in-history` —— 系统提示会作为 `role: 'system'`
 * 的消息出现在重放历史里，于是它落进 else 分支。
 *
 * 后果（实测 2026-11-12，session-644bba1d，5 份摘要全部中招）：
 *
 * ```
 * ### 助手结论
 * - You are an AI agent powered by DeepSeek Harness. You are a coding agent
 *   powered by the deepseek/deepseek-v4.1-flash model. Tokens prefixed with @ ...
 * ```
 *
 * 三重危害：
 * 1. **挤占**：结论区上限 15 条，系统提示通常是全历史最长的一条，
 *    `oneLine(300)` 之后仍占满首条；实测所有摘要的结论区只有这 1 条。
 * 2. **污染**：被裁剪后，系统提示的残片变成了「历史对话里的一段助手结论」，
 *    模型会把对自己的指令当成过往讨论内容。
 * 3. **静默**：不报错，摘要长度看起来正常（2.3KB 写满），信息量却是零。
 *
 * 这与 `event-classify.ts` 采用白名单是同一个理由：新角色出现时最坏是
 * 「不收录」，而不是「被误当成结论」。
 *
 * ## 为什么 `undefined` 单独放行到「按内容判定」
 *
 * 白名单一旦漏掉某个宿主版本（重放消息不带 `role`），代价是**所有 assistant
 * 正文被静默丢光**，摘要只剩「用户请求」区 —— 比原来的污染更糟（那时至少有字）。
 * 而系统提示的文字有稳定首句，`NOISE_PREFIXES` 已能拦下。
 * 所以 `role === undefined` 不在这一层拒绝，交给内容判定。
 */
function isConversationRole(role: unknown): boolean {
  return role === 'user' || role === 'assistant' || role === undefined;
}

/** 结论段的总槽位数（账本 + prune 补位共用）。 */
const CONCLUSION_SLOTS = 15;

/**
 * lrc-prune 补位条数上限。
 *
 * 低于总槽位，确保**任何情况下都至少留 5 个槽给账本** ——
 * 账本是已过双闸门的判断，不该被未经裁决的原始素材挤掉。
 */
const PRUNE_CONCLUSION_LIMIT = 10;

/** 是否该把该角色的文本收进「助手结论」区。 */
function isConclusionRole(role: unknown): boolean {
  // 缺 role 时按 assistant 处理：真实重放里 user 消息一定带 role
  // （否则连「用户请求」区都收不到，那是另一种可观测的异常）。
  return role === 'assistant' || role === undefined;
}

/**
 * 生成确定性摘要（零 LLM）。
 *
 * 只保留四类信息：用户请求、工具调用、工具错误、助手结论。
 * 工具成功输出只留首行 —— 那才是上下文膨胀的主因。
 *
 * ## ★2026-11-14：助手结论改为**消费 Fact 账本**
 *
 * ## 为什么要改
 *
 * 真实测试（session-a7f16f92）暴露：这次 compaction 的摘要里
 * `### 助手结论` 有 4 条，全是过程叙述：
 * ```
 * 我先去仓库看看它到底是什么。
 * 两个联网工具都报错了，我换一种方式直接访问。
 * 仓库本身可以访问，于是直接把它克隆到本地来读。
 * 克隆成功，仓库比预期大，开始读它的结构。
 * ```
 * **真结论 0 条**，而 `### 工具调用与结果` 有 17 条，占了摘要主体。
 * 同一批 4 句喂给 `extractFacts` 全部被拒 —— 也就是说：
 * **同一个系统里有两个裁判，判同一件事，结论相反。**
 *
 * 这与上一轮修的「6 条写入路径」是同类问题，只是发生在另一个维度：
 * 写入侧收口到 `validateFact` 了，读侧（压缩摘要）却还留着一套独立实现。
 *
 * ## 现在的结构
 *
 * ```
 * 有 facts  → 助手结论 = facts 里 kind ∈ {constraint, decision, conclusion, statement} 的陈述
 * 无 facts  → 退回旧行为（只按 role 判定）+ 记住这是降级
 * ```
 *
 * 降级路径必须保留：`trimContext` 可能在 Fact 账本尚未建立时被调用
 * （会话开始、插件刚加载），此时若要求必须有 facts，摘要会变成空的。
 *
 * @param messages - 被裁剪区间的重放消息（`SummarizationInput.messages`）
 * @param maxChars - 摘要字符上限
 * @param realCounts - 可选出参：回填真实条数（见下）
 * @param facts - 可选的会话 Fact 账本；提供时「助手结论」从它投影
 */
export function buildDeterministicSummary(
  messages: readonly unknown[],
  maxChars: number,
  /**
   * 可选出参：回填**第一遍（真实对话）**收集到的条数。
   *
   * 为什么需要：第二遍会把旧摘要补位进各桶，导致 `summaryStats` 里的
   * 「请求 8」恒等于 absorb 上限（8），而不是真实请求数（真实上限是 12）。
   * 把真实条数单独回填，诊断时才能区分「真实负载」与「补位填充」。
   *
   * ★注意：它在**字符预算截断之前**快照，所以 `real` 可能**大于**最终条数
   * （`调用` 段 weight 最低、最先被砍）。`summaryStats` 必须能表达
   * `real > total` 这个关系，否则相减会得到负数。
   */
  realCounts?: { requests: number; conclusions: number; errors: number; calls: number },
  /**
   * 会话 Fact 账本：**摘要结论的唯一真理源**。
   *
   * 类型用结构化的最小契约而非 `MemoryFact`，避免 `context-trim.ts`
   * 依赖 `memory-schema.ts`（它原本是零依赖的纯文本模块，单测不需要
   * 构造完整 Fact）。
   */
  facts?: readonly { kind: string; statement: string; status?: string }[],
): string {
  // ## `maxChars` 必须是有限数（★2026-11-16 发布前审查 P1-2）
  //
  // 该函数是导出的纯函数，任何调用方（含测试、未来的新调用点）都可能传
  // `undefined` / `NaN`。而本函数内部的截断判据全是 `text.length > maxChars`：
  // `Infinity` ⇒ 永不截断（可接受）；**`NaN` ⇒ 恒 false ⇒ 直接掉到末尾的
  // `slice(0, maxChars - 1)`，产出单个 `"…"`**，整段摘要被毁（测试已复现）。
  //
  // 在入口兜底而不是只在调用点兜底：调用点有多个，函数只有一个。
  const max = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 4000;

  const requests: string[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  const conclusions: string[] = [];
  /**
   * lrc-prune 正文（助手任务产出）单独成桶（★2026-11-15 代码审查）。
   *
   * 直接和账本共用 `conclusions` 会挤占：实测 15 条 prune 能让账本
   * **全灭**。账本是已过双闸门的判断，优先级高于未经裁决的原始素材，
   * 所以先收这里，等账本投影完再用剩余槽位补位。
   */
  const pruneConclusions: string[] = [];
  /**
   * prune 桶自己的去重集合。
   *
   * 不能与全局 `seen` 共用：`collect` 会先 `seen.add(line)` 再入桶，
   * 共用会让补位阶段认为「已收过」而整条丢弃。
   */
  const pruneSeen = new Set<string>();
  const seen = new Set<string>();
  /** 「用户请求」段的独立去重集合（见下方 `collect(requests, …)` 注释）。 */
  const requestSeen = new Set<string>();
  /** 旧摘要文本，留到第二遍再吸收（见下方「两遍扫描」说明） */
  const priorSummaries: string[] = [];

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown; isError?: unknown; source?: { kind?: string } };
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    // ## LRC 的「已剪枝」节点是**助手正文**，不是用户发言（★2026-11-15 修正）
    //
    // ## 上一版错在哪
    //
    // 曾写成 `if (source.kind === 'lrc-prune') continue` —— 直接丢弃。
    // 核实后这是**有损的错误**：`appendReplace` 用 `surfaceOp: replace`
    // 遮蔽了原始 `assistant/message` 节点，所以 lrc-prune 是该内容在
    // 重放里的**唯一载体**。它承载的是助手刚写的正文，例如：
    // ```
    // 十六枚都已经画好…一眼能认出 1A 锁、2A 窗、4B 镜…失败的案例 4 个
    // ```
    // 这是用户任务最核心的产出。丢弃它等于把「本轮做了什么」整段抹掉。
    //
    // ## 正确的区分：**身份错位** ≠ **内容无主**
    //
    // ```
    // lrc-prune → role='user' 但内容属于助手 ⇒ 重新归类到「助手结论」
    // tool-jobs → 内容不属于任何参与者       ⇒ 丢弃
    // ```
    // 前者是**有损重分类**，后者才是**有损过滤**。混为一谈就会误删。
    const prunedByLrc = message.source?.kind === 'lrc-prune';
    // 后台任务结束通知是宿主插管，不属于任何参与者（见 `NOISE_PREFIXES`）
    if (message.source?.kind === 'tool-jobs') continue;

    // 真实重放里工具结果是独立消息 `role:'tool'`，正文直接是 `[{type:'text'}]`，
    // **没有** `type:'tool-result'` 块。以前只认块类型，于是几百 KB 的工具输出
    // 全被当成「助手结论」塞进摘要（10 条 × 200 字符上限，还挤掉了真正的结论）。
    if (message.role === 'tool') {
      const text = textOf(content);
      if (text.length > 0) {
        const isError = message.isError === true ||
          (Array.isArray(content) && (content as { isError?: unknown }[]).some((b) => b?.isError === true));
        if (isError) collect(errors, seen, `- ${oneLine(text, 300)}`, 15);
        else collect(calls, seen, `- 结果：${oneLine(text.split('\n')[0] ?? '', 150)}`, 30);
      }
      continue;
    }

    for (const block of content) {
      const b = block as {
        type?: string;
        text?: unknown;
        name?: unknown;
        arguments?: unknown;
        isError?: unknown;
        content?: unknown;
      };
      if (b?.type === 'text' && typeof b.text === 'string') {
        // 旧摘要：先记下来，第二遍再吸收（不整段嵌套，否则每轮多一层「已裁剪的历史」）
        if (isNoiseText(b.text) && b.text.trimStart().startsWith('## 已裁剪的历史')) {
          priorSummaries.push(b.text);
          continue;
        }
        // 宿主每轮注入的运行时事实 / 技能目录 / 审批策略：不是用户说的话
        //
        // ## lrc-prune 豁免这一层（★2026-11-15 代码审查）
        //
        // `NOISE_PREFIXES` 是按**用户消息**归纳的（`Current runtime context.`
        // / `### 用户请求` / `[LRC 状态]` …）。而 lrc-prune 是助手正文，
        // 正文里出现「### 助手结论」这种小标题完全正常 —— 若按噪音拦掉，
        // 恰好把最结构化的任务产出整段丢掉。
        //
        // 它自己的身份已由 `prunedByLrc` 确认，不需要内容前缀再判一次。
        if (!prunedByLrc && isNoiseText(b.text)) continue;
        // 系统提示：既不是用户请求也不是助手结论。
        // `systemPromptUpdate: in-history` 时它会出现在重放历史里，
        // 必须在这里显式拦掉（见 `isConclusionRole` 注释）。
        if (!isConversationRole(message.role)) continue;
        const line = oneLine(b.text, 300);
        // ## lrc-prune 按 **assistant 身份**走（不是按 role）
        //
        // 它的 `role` 被宿主强制成 `'user'`（`appendReplace` 的限制），
        // 但内容是助手正文。若按 role 分流，它的产出会全落进「用户请求」，
        // 把真实用户发言挤出去 —— 实测 12 槽被占满导致「请求 真实 0」。
        if (message.role === 'user' && !prunedByLrc) {
          // ## 「用户请求」用**独立**去重集合（★2026-11-15 独立审查 P1）
          //
          // 共用 `seen` 时有个隐蔽后果：用户说「以后都不要碰 3099」，
          // 这句话既进 requests、又被抽成 constraint 进账本。requests 先
          // `seen.add`，账本投影时就被去重丢掉 —— 实测结论段退化成
          // 「（本段无可用结论：已裁 1 条消息）」，信息被降级成语义更弱的
          // 「用户请求」。
          //
          // 两个段落回答的是不同问题（用户要什么 / 已定了什么），
          // 不该互相去重。
          //
          // ## 必须 `keepNewest`（★2026-11-16 发布前审查 P1-1）
          //
          // 首版用默认的「满额即丢」——那保留的是**最旧的 12 条**。
          // 探针实测：20 条用户请求只留第 1–12 条，**最新 8 条被丢弃**，
          // 用户刚说的话进不了摘要。
          //
          // 这与本项目已修的三处是同一个缺陷族（账本投影 / prune 补位 /
          // handoff 投影都是「取最旧」），方向必须统一为「留最新」。
          collect(requests, requestSeen, `- ${line}`, 12, { keepNewest: true });
        }
        // ## 助手结论：有 Fact 账本时**不再从这里收**
        //
        // 旧实现是 `isConclusionRole(role) && !isProcessNarration(text)` ——
        // `isConclusionRole` 只看 role 是不是 assistant，**一条语义判据都没有**，
        // 于是「我先去仓库看看它到底是什么」这种过程叙述全部进了结论区
        // （实测 session-a7f16f92：4 条结论、0 条真结论）。
        //
        // 现在结论统一在下面从 `facts` 投影。只有 `facts` 缺失（账本尚未建立）
        // 时才退回旧路径 —— 那时代码里没有任何语义判据可用，宁可保留
        // 旧行为，也不要让摘要变空。
        //
        // ## 为什么 `prunedByLrc` 时**即使有 facts 也要收**
        //
        // 账本投影的是**已通过的 Fact**，而 lrc-prune 的正文正是尚未入库的
        // 原始素材（提取器从中只抽到 1 条，另有 7 条待 LLM 裁决）。
        // 若因为有 facts 就跳过它，这段「本轮做了什么」在摘要里会**完全消失**。
        //
        // ## 但**不能直接占结论槽**（★2026-11-15 代码审查）
        //
        // 首版直接 `collect(conclusions, …, 15)`，实测被挤占：
        // ```
        //  2 条 prune → 结论 15 条（prune 2 / 账本 13）
        // 10 条 prune → 结论 15 条（prune 10 / 账本 5）
        // 15 条 prune → 结论 15 条（prune 15 / 账本 0）  ← 账本全灭
        // ```
        // 账本是**已通过的判断**（`validateFact` / `validateJudgedFact` 双闸门），
        // 价值高于未经裁决的原始素材。所以先收进独立桶，等账本投影完
        // 再用剩余槽位补位 —— 账本永远优先。
        else if (
          (isConclusionRole(message.role) || prunedByLrc) &&
          (facts === undefined || prunedByLrc)
        ) {
          // ## 过程叙述必须**按句**判，不能按整块（★2026-11-15 独立审查 P1）
          //
          // prune 的正文是一整段 text block。首版 `isProcessNarration(b.text)`
          // 对整块判定：首句「我先看一下现有结构。」命中 ⇒ 整块被丢，
          // 后面「十六枚都已经画好，一眼能认出 1A 锁…」一并消失。
          //
          // 这是**粒度层双裁判**：`memory-extract` 按单句判，这里按整块判，
          // 同一判据两种结论。摘要没有 LLM 可仲裁（见 `isProcessNarration`
          // 复用注释），必须与提取层同粒度。
          //
          // ## 为什么用换行 + 句末标点切分
          //
          // 与 `memory-extract.splitClauses` 同源。prune 正文结构是
          // 「一段一句一行」，所以换行是最可靠的边界；再补句末标点兜底。
          const bucket = prunedByLrc ? pruneConclusions : conclusions;
          const limit = prunedByLrc ? PRUNE_CONCLUSION_LIMIT : CONCLUSION_SLOTS;
          const seenForBucket = prunedByLrc ? pruneSeen : seen;
          if (!prunedByLrc) {
            if (isProcessNarration(b.text)) continue;
            collect(bucket, seenForBucket, `- ${line}`, limit);
          } else {
            // 逐句判：过程句不占槽，真实产出逐句进桶
            //
            // `keepNewest`：prune 要的是**本轮最新**的产出，满了应淘汰最旧
            // 而不是拒绝后来的（见 `collect` 注释）。
            for (const clause of splitSentences(b.text)) {
              if (isProcessNarration(clause)) continue;
              collect(bucket, seenForBucket, `- ${oneLine(clause, 300)}`, limit, { keepNewest: true });
            }
          }
        }
      } else if (b?.type === 'tool-call') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const args = typeof b.arguments === 'string' ? oneLine(b.arguments, 150) : '';
        collect(calls, seen, `- ${name}(${args})`, 30);
      } else if (b?.type === 'tool-result') {
        const text = textOf(b.content);
        if (text.length === 0) continue;
        if (b.isError === true) collect(errors, seen, `- ${oneLine(text, 300)}`, 15);
        else collect(calls, seen, `- 结果：${oneLine(text.split('\n')[0] ?? '', 150)}`, 30);
      }
    }
  }

  // ── 从 Fact 账本投影「助手结论」（★2026-11-14）──
  //
  // 这是本次修复的核心：结论的**唯一真理源**是 `validateFact` 产出的 Fact，
  // 不是「role 是不是 assistant」。
  //
  // 顺序有讲究：必须先投影再快照 `realCounts`，否则统计里结论数是 0。
  // 之所以放在两遍扫描之前：现有 Fact 是本会话的**最新真相**，
  // 优先级高于旧摘要里吸收来的条目（`collect` 会按 `seen` 去重）。
  if (facts !== undefined) {
    // ## 必须**从新到旧**遍历（★2026-11-15 独立审查 P0）
    //
    // `sessionFacts` 是「越新越靠后」的数组（见 `recordSessionFacts`）。
    // 首版 `for (const fact of facts)` 从头遍历 + `collect(..., 15)` 上限，
    // 取到的是**最旧**的 15 条：实测 30 条账本只留第 0..14 条。
    //
    // 后果：账本超过 15 条后，新写入的 Fact **永远进不了摘要**。
    // 真实日志证据 —— seq 6557/6686/6883/6888/7016 五次连续裁剪，
    // 结论段首条完全相同（`file:// 形式的图片会被拦截…`）。
    //
    // 倒序遍历 + 走共享 `seen`：新值优先占槽，旧值只在有空位时补进来。
    for (let i = facts.length - 1; i >= 0; i -= 1) {
      const fact = facts[i] as { kind: string; statement: string; status?: string };
      if (fact.status !== undefined && fact.status !== 'active') continue;
      // 只收「会答用户问题」的四类：
      //   约束/决策/结论 = 已定的事；statement = 这是什么
      // 位置与工件已在「用户请求」与工具行里体现，不重复占结论槽。
      if (
        fact.kind !== 'constraint' &&
        fact.kind !== 'decision' &&
        fact.kind !== 'conclusion' &&
        fact.kind !== 'statement'
      ) {
        continue;
      }
      collect(conclusions, seen, `- ${oneLine(fact.statement, 300)}`, CONCLUSION_SLOTS);
    }
  }

  // ── lrc-prune 正文**补位**（★2026-11-15 代码审查）──
  //
  // 账本先占，prune 只用剩余槽位。见 `pruneConclusions` 注释：
  // 共用同一个桶会让 15 条 prune 把账本全挤掉。
  //
  // ## 同样必须从新到旧（同一次审查的第二处）
  //
  // `pruneConclusions` 也是按重放顺序收的（旧→新）。若从头遍历，
  // 15 条 prune 只会留下最早的 10 条，**本轮最新的任务产出反而丢失** ——
  // 与账本那处是同一个缺陷的两个实例。
  // 注意 `collect` 会用 `seen` 去重，而 prune 的条目可能和账本同文
  // （同一条被替换的助手正文既入了账本、又还在重放里）。复用 `seen`
  // 正是要的效果：账本已收过就不再重复补位。
  for (let i = pruneConclusions.length - 1; i >= 0; i -= 1) {
    if (conclusions.length >= CONCLUSION_SLOTS) break;
    collect(conclusions, seen, pruneConclusions[i] as string, CONCLUSION_SLOTS);
  }

  // ── 两遍扫描：真实内容优先，旧摘要只补空位 ──
  //
  // 实测一次 trim 会同时覆盖 85 条堆叠的 checkpoint（摘要自增殖的遗留）。
  // 若按时间顺序边扫边吸收，**最老的摘要会先占满 12 个请求槽**，
  // 之后所有真实用户请求和较新的摘要条目全被 `collect` 丢弃 ——
  // 摘要看起来写满了，实际留下的是最不相关的旧内容。
  //
  // 所以：第一遍只收真实对话；第二遍按**从新到旧**吸收旧摘要，只填空位。
  //
  // 在吸收之前快照真实条数：吸收会把旧摘要补进各桶，之后桶大小就不再等于真实负载。
  if (realCounts !== undefined) {
    realCounts.requests = requests.length;
    realCounts.conclusions = conclusions.length;
    realCounts.errors = errors.length;
    realCounts.calls = calls.length;
  }
  for (let i = priorSummaries.length - 1; i >= 0; i -= 1) {
    absorbPriorSummary(priorSummaries[i] as string, { requests, calls, errors, conclusions }, seen);
  }

  // ## 结论为空时必须**显式标注**（★2026-11-15 六钥匙裁决）
  //
  // ## 为什么不能就这样留空
  //
  // 摘要会替换历史进入上下文。结论段为空时，接手方看到的是
  // 「用户问了什么 + 调了哪些工具」—— 它**无从知道是没有结论，
  // 还是结论被裁掉了**。「信息为 0」与「无法判断有没有信息」是两回事，
  // 后者才是真正的损失。
  //
  // 实测（15 次裁剪）：结论真实值为 0 的占 20%。比例不高但确实发生，
  // 且发生时分不清是哪种情况。
  //
  // ## 为什么用 LLM 补生成（否决）
  //
  // 那会引入**第三套语义判断**（提取层已有 `validateFact` /
  // `validateJudgedFact` 的仲裁）。而摘要会替换历史，判错后的污染是
  // 持续的、不可撤回的。为 20% 的场景付这个代价不划算。
  //
  // ## 为什么用「（…）」而不是「- …」
  //
  // `summaryStats` 只统计以 `- ` 开头的行。用圆括号前缀让它**不计入
  // 结论条数** —— 否则日志里「结论 1」会掩盖真相（真实 0）。
  //
  // ## 措辞只写可核对的事实
  //
  // 不写「未沉淀为 Fact 的正文 N 条」这类无法核验的推断 —— 摘要里
  // 每一句都应该是可追溯到具体数据的。只报「裁了多少条消息」。
  if (conclusions.length === 0) {
    const cutCount = Array.isArray(messages) ? messages.length : 0;
    conclusions.push(`（本段无可用结论：已裁 ${cutCount} 条消息）`);
  }

  // 区块顺序 = 信息价值顺序，截断从最低价值端砍。
  //
  // 旧顺序是 请求→工具调用→错误→结论，2000 字符一到就直接 `slice(0, maxChars)`
  // 砍尾，于是**助手结论整块消失**，只留下最廉价的工具调用列表。
  // 实测 68 条摘要全部以「-…」结尾，没有一条含「### 助手结论」。
  interface Section {
    title: string;
    lines: string[];
    /** 越低越先被牺牲 */
    weight: number;
  }
  const all: Section[] = [
    { title: '### 用户请求', lines: requests, weight: 3 },
    { title: '### 助手结论', lines: conclusions, weight: 2 },
    { title: '### 工具错误', lines: errors, weight: 1 },
    { title: '### 工具调用与结果', lines: calls, weight: 0 },
  ].filter((s) => s.lines.length > 0);

  const render = (sections: Section[]): string => {
    const out: string[] = ['## 已裁剪的历史（确定性摘要，无 LLM）'];
    for (const s of sections) out.push(s.title, ...s.lines);
    return out.join('\n');
  };

  let text = render(all);
  if (text.length <= max) return text;

  // 超限：按 weight 升序逐条丢弃最低价值段落，直到装得下
  const working = all.map((s) => ({ ...s, lines: [...s.lines] }));
  while (text.length > max) {
    // 先删权重最低的段落的最后一条；该段空了就整段移除
    const target = working
      .filter((s) => s.lines.length > 0)
      .sort((a, b) => a.weight - b.weight)[0];
    if (!target) break;
    target.lines.pop();
    text = render(working.filter((s) => s.lines.length > 0));
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * 统计摘要各区块的条目数（诊断用）。
 *
 * 摘要质量不能只看字符数：4000 字符全被「工具调用」占满、结论 0 条，
 * 和「请求 4 / 结论 3 / 调用 12」是完全不同的信息密度。
 * 把条目数打进 trim 日志，才能判断某次裁剪是不是把关键信息挤掉了。
 */
export function summaryStats(
  text: string,
  /**
   * 可选：第一遍真实条数（由 `buildDeterministicSummary` 回填）。
   *
   * 传入后，若某桶的末尾条数 ≠ 真实条数，会标注构成
   * （`N新+M继承` 或 `截断自 N`）—— 避免把补位上限误读成真实负载，
   * 也避免把「本段没有真实用户发言」误读成「统计坏了」。
   */
  realCounts?: { requests: number; conclusions: number; errors: number; calls: number },
): string {
  const counts = { requests: 0, conclusions: 0, errors: 0, calls: 0 };
  let section: keyof typeof counts | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('### ')) {
      const title = line.slice(4).trim();
      if (title.startsWith('用户请求')) section = 'requests';
      else if (title.startsWith('助手结论') || title.startsWith('早期结论')) section = 'conclusions';
      else if (title.startsWith('工具错误')) section = 'errors';
      else if (title.startsWith('工具调用')) section = 'calls';
      else section = undefined;
      continue;
    }
    if (section !== undefined && line.startsWith('- ')) counts[section] += 1;
  }
  /**
   * 输出该桶的**来源构成**，形如：
   * - `3`                                   —— 全是本段真实内容
   * - `8(0新+8继承)`                         —— 本段没有真实内容，全部继承自上游摘要
   * - `26(截断自 30)`                        —— 真实有 30 条，被字符预算截到 26
   *
   * ## 为什么不能只写「真实 N」
   *
   * 旧写法 `请求 8（真实 0）` 在真实日志里连续出现 18 次，读起来像
   * 「8 条请求里 0 条是真的」—— 即「统计坏了」或「用户发言全丢了」。
   * 实测核对（用 `shadowedSeqs` 回查被遮蔽区间）后确认：那 8 条**全部**来自
   * 旧摘要继承，被裁区间里确实一条真实用户消息都没有，**统计是对的**。
   *
   * ## 为什么必须分三支而不是 `total - real`
   *
   * ★独立审查 P0：首版写成 `${total}(=${real}新+${total - real}旧)`，
   * 隐含假设 `real ≤ total`。但 `realCounts` 在**截断之前**快照
   * （见 `buildDeterministicSummary` 里 `realCounts` 赋值处），而
   * `maxChars` 超限时会按 weight 升序丢弃整段末尾条目 —— `调用` 段
   * weight=0，最先被砍。于是 `real` 可以是 30 而 `total` 只有 26，
   * `total - real` 得到 **负数**：
   * ```
   * 调用 26(=30新+-4旧)   ← 旧措辞至少只是模糊，这是数学上不可能的数
   * ```
   * 实测生产日志确实存在 `调用 26（真实 30）` / `调用 22（真实 30）`。
   *
   * 所以三种关系必须分别表达：`<`（继承）、`>`（截断）、`=`（不标注）。
   *
   * 用「继承」而不是「旧」：`8旧` 会被读成「这 8 条记忆很老」，
   * 而实际含义是「继承自上游摘要」。
   */
  const part = (label: string, total: number, real: number | undefined): string => {
    if (real === undefined || real === total) return `${label} ${total}`;
    // 真实多于末尾条数 ⇒ 被字符预算截断
    if (real > total) return `${label} ${total}(截断自 ${real})`;
    // 真实少于末尾条数 ⇒ 差额来自由旧摘要补位
    return `${label} ${total}(${real}新+${total - real}继承)`;
  };
  return (
    `${part('请求', counts.requests, realCounts?.requests)} / ` +
    `${part('结论', counts.conclusions, realCounts?.conclusions)} / ` +
    `${part('错误', counts.errors, realCounts?.errors)} / ` +
    `${part('调用', counts.calls, realCounts?.calls)}`
  );
}

/**
 * 从引擎上取 token 计量服务（引擎自己的 ctx 一定在 preset 隔离组内）。
 *
 * **必须用 `ctx.get('tokenMeter')`，不能直接读 `ctx.tokenMeter`**：
 * cordis 的服务属性访问要求当前 fiber 声明了 `inject`，否则抛
 * `cannot get property "tokenMeter" without inject`（实测连续两次崩溃）。
 * `get()` 是无需 inject 的安全访问器。
 */
function meterOf(engine: unknown, ctx: unknown): { measure?: (s: unknown) => unknown } | undefined {
  const engineCtx = (engine as { ctx?: unknown })?.ctx;
  const own = safeGet(engineCtx, 'tokenMeter');
  if (own !== undefined) return own as { measure?: (s: unknown) => unknown };
  return safeGet(ctx, 'tokenMeter') as { measure?: (s: unknown) => unknown } | undefined;
}

/** 一次工具输出剪枝的结果。 */
export interface PruneOutcome {
  ok: boolean;
  /** ok / no-session / pruner-unavailable / error:… */
  reason: string;
  /** 本次被剪枝的工具结果条数 */
  pruned?: number;
  /** 省下的字符数 */
  charsRemoved?: number;
}

/**
 * 找到 `toolResultPruner` 服务。
 *
 * 它和 `compaction` 一样挂在 preset 的隔离组里，宿主层 `ctx.get()` 可能拿不到。
 * 依次尝试三条路：宿主层 → `agentPresets.serviceFor` → 压缩引擎自己的 ctx。
 */
function resolvePruner(ctx: unknown, agent: unknown): unknown {
  const direct = safeGet(ctx, 'toolResultPruner');
  if (typeof (direct as { pruneSession?: unknown } | undefined)?.pruneSession === 'function') {
    return direct;
  }

  const presets = safeGet(ctx, 'agentPresets') as
    | { serviceFor?: (a: unknown, n: string) => unknown }
    | undefined;
  try {
    const viaPreset = presets?.serviceFor?.(agent, 'toolResultPruner');
    if (typeof (viaPreset as { pruneSession?: unknown } | undefined)?.pruneSession === 'function') {
      return viaPreset;
    }
  } catch {
    // 继续尝试下一条路
  }

  try {
    const engine = presets?.serviceFor?.(agent, 'compaction');
    const viaEngine = (engine as { ctx?: { get?: (n: string) => unknown } } | undefined)?.ctx?.get?.(
      'toolResultPruner',
    );
    if (typeof (viaEngine as { pruneSession?: unknown } | undefined)?.pruneSession === 'function') {
      return viaEngine;
    }
  } catch {
    // 三条路都不通就放弃
  }
  return undefined;
}

/**
 * 路径 2：确定性工具输出剪枝（零 LLM，同步）。
 *
 * 只截断超长工具结果的中间段，保留头尾与完整事件结构，因此可以每步都跑。
 * 幂等：剪过的结果已低于阈值，下次调用是空操作。
 *
 * 永不抛错：任何失败都转成 `{ ok: false, reason }`。
 *
 * @param deps - 宿主 ctx、agent 与日志函数
 * @returns 剪枝结果
 */
export function pruneToolResults(deps: {
  ctx: unknown;
  agent: unknown;
  log: (message: string) => void;
  /**
   * 临时覆盖官方 pruner 的阈值（字符）。
   *
   * 官方默认 8192，实测对本类会话只命中 3/128 —— 大量 4K~8K 的工具输出
   * 卡在阈值边缘。这里临时把 `pruner.config` 换成更低的阈值，
   * 复用官方那套经过验证的头/中/尾截断算法，剪完立刻恢复。
   */
  thresholdChars?: number;
}): PruneOutcome {
  const { ctx, agent, log } = deps;
  const session = (agent as { session?: unknown })?.session;
  if (session === undefined) return { ok: false, reason: 'no-session' };

  const pruner = resolvePruner(ctx, agent) as
    | { pruneSession?: (s: unknown) => unknown; config?: unknown }
    | undefined;
  if (typeof pruner?.pruneSession !== 'function') {
    return { ok: false, reason: 'pruner-unavailable' };
  }

  // 临时降阈值：config 是普通属性（值被 deepFreeze，属性本身可写）。
  // 不可写就跳过覆盖，退回官方默认阈值。
  const originalConfig = pruner.config;
  let patched = false;
  if (deps.thresholdChars !== undefined && originalConfig !== undefined) {
    const threshold = deps.thresholdChars;
    const head = Math.min(2048, Math.max(0, threshold - 600));
    const tail = Math.min(512, Math.max(0, threshold - head - 100));
    try {
      pruner.config = { ...(originalConfig as object), thresholdChars: threshold, headChars: head, tailChars: tail };
      patched = true;
    } catch {
      // 属性不可写：保持官方配置
    }
  }

  try {
    const result = pruner.pruneSession(session) as
      | { pruned?: unknown[]; charsRemoved?: number }
      | undefined;
    const count = Array.isArray(result?.pruned) ? result.pruned.length : 0;
    const charsRemoved = result?.charsRemoved ?? 0;
    if (count > 0) {
      log(`[lrc][prune] 裁剪 ${count} 条工具输出（省 ${charsRemoved} 字符）`);
    }
    return { ok: true, reason: 'ok', pruned: count, charsRemoved };
  } catch (error) {
    return {
      ok: false,
      reason: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (patched) pruner.config = originalConfig;
  }
}

/** 工具参数被截断后插入的标记。 */
export const ARGS_TRUNCATED_MARKER = '\n[... tool arguments truncated ...]';

/**
 * 追加一条「单节点替换」事件。
 *
 * ## 为什么替换体一律用 `user/message`
 *
 * 宿主的两条硬规则把 `assistant/message` 当替换体的路封死了：
 *   1. `assistant/message` 不能携带 `sourceEventSeqs`（"embeds its source stream"）；
 *   2. 任何 replace 都要求 `sourceEventSeqs` 覆盖全部 shadowed 节点。
 * 二者合起来 ⇒ 用 assistant 替换 assistant 必然被拒。
 *
 * 宿主自己的 `compactRegion` 也是用 `user/message` 当替换体
 * （见 dsh-compaction-basic 的 `commitCompactionBody`）。这里沿用同一做法。
 *
 * ## 为什么含 tool-call 的节点不能替换
 *
 * 宿主的 tool-pairing 平衡按 `eventDelta` 计算：`assistant/message` 里的
 * `tool-call` 计 +1，`tool/result` 计 -1，`user/message` 计 0。
 * 把含 tool-call 的 assistant 换成 user 会让平衡永久偏移，
 * 下一次 `compactRegion` 会报 "tool/result has no matching tool-call"。
 * 所以含 tool-call 的节点一律跳过（返回 false），只替换纯文本/推理节点。
 *
 * @returns 是否真的替换了
 */
function appendReplace(session: unknown, content: unknown[], seq: number): boolean {
  const append = (session as { append?: unknown })?.append;
  if (typeof append !== 'function') throw new Error('session.append unavailable');
  // 含 tool-call 的节点不能替换（会破坏 tool-pairing 平衡）
  if (content.some((block) => (block as { type?: string })?.type === 'tool-call')) {
    return false;
  }
  (append as (t: string, d: unknown, o: unknown) => unknown).call(
    session,
    'user/message',
    // 必须带 `role: 'user'` 与 `id`：宿主 `createUserMessage` 会补这两个字段，
    // 而 `deriveEventMessage` 对 user/message 是**原样返回 data**，
    // 缺 role 会让 LLM 适配器拿不到消息角色。
    { role: 'user', id: randomUUID(), content, source: { kind: 'lrc-prune' } },
    {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    },
  );
  return true;
}

/** 工具参数截断参数。 */
export interface PruneArgsOptions {
  /** 超过多少字符才截断 */
  thresholdChars: number;
  /** 保留开头多少字符 */
  headChars: number;
  /**
   * 保留最近多少个节点不丢弃参数。
   *
   * 比这更旧的工具调用，参数直接替换成 `{}` —— 工具早已执行完毕，
   * 参数只用于展示；只截断到 2000 字符的话，40 步下来仍有 8 万字符。
   */
  keepRecentNodes: number;
}

/**
 * 路径 2b：截断 `tool-call.arguments`（官方 pruner 不覆盖的部分）。
 *
 * 官方 `toolResultPruner` 只处理 `tool/result`，而 `tool-call.arguments`
 * 是只增不减的 —— 实测一个会话里 toolArgs 占上下文 16%（12.3 万字符）。
 *
 * 替换的是 assistant 消息本身，但保留全部 tool-call id，所以工具配对不受影响；
 * 参数只用于展示与重放，工具早已执行完毕。
 *
 * 永不抛错：任何失败都转成 `{ ok: false, reason }`。
 */
export function pruneToolCallArguments(deps: {
  ctx: unknown;
  agent: unknown;
  log: (message: string) => void;
  options?: Partial<PruneArgsOptions>;
}): PruneOutcome {
  const { agent } = deps;
  const session = (agent as { session?: unknown })?.session;
  if (session === undefined) return { ok: false, reason: 'no-session' };

  const nodes = (session as { surface?: { nodes?: unknown } })?.surface?.nodes;
  const events = resolveSessionEvents(session);
  const append = (session as { append?: unknown })?.append;
  if (!Array.isArray(nodes) || events === undefined || typeof append !== 'function') {
    return { ok: false, reason: 'no-range' };
  }

  // ★2026-11-07：宿主 surface 校验不允许替换含 tool-call 的 assistant 节点
  // （会破坏 tool-pairing 平衡，下一次 compactRegion 必报
  // "tool/result has no matching tool-call"），故本路径在当前宿主版本下不可用。
  // 保留函数与配置项，等宿主提供「原地改参数」能力后再启用。
  return { ok: false, reason: 'incompatible-with-host-surface' };
}

/** 推理块裁剪参数。 */
export interface PruneReasoningOptions {
  /** 保留最近多少个 surface 节点不处理 */
  keepRecentNodes: number;
}

/**
 * 路径 2c：丢弃旧消息里的 reasoning 块。
 *
 * 实测 reasoning 占可见上下文 29.5%，是增速最快的一项，而 prune 只裁工具输出、
 * trim 的摘要也明确排除推理 —— 这块完全没人管。
 *
 * 只处理**同时含其他块**的 assistant 消息：纯推理消息丢掉推理会变成空消息。
 * 保留最近 N 个节点，避免影响当前正在进行的推理链。
 *
 * 永不抛错。
 */
export function pruneReasoning(deps: {
  ctx: unknown;
  agent: unknown;
  log: (message: string) => void;
  options?: Partial<PruneReasoningOptions>;
}): PruneOutcome {
  const { agent, log } = deps;
  const keepRecentNodes = normalizeCount(deps.options?.keepRecentNodes, DEFAULT_KEEP_RECENT, 0);

  const session = (agent as { session?: unknown })?.session;
  if (session === undefined) return { ok: false, reason: 'no-session' };

  const nodes = (session as { surface?: { nodes?: unknown } })?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === undefined) {
    return { ok: false, reason: 'no-range' };
  }

  const cutoff = nodes.length - keepRecentNodes;
  let pruned = 0;
  let charsRemoved = 0;
  try {
    for (let index = 0; index < cutoff; index += 1) {
      const seq = nodes[index] as number;
      const event = events[seq] as
        | { type?: string; data?: { message?: { content?: unknown } } }
        | undefined;
      if (event?.type !== 'assistant/message') continue;
      const message = event.data?.message;
      const content = message?.content;
      if (!Array.isArray(content)) continue;

      const reasoningBlocks = content.filter(
        (block) => (block as { type?: string })?.type === 'reasoning',
      );
      if (reasoningBlocks.length === 0) continue;
      // 纯推理消息不能丢：丢了就变成空消息
      if (reasoningBlocks.length === content.length) continue;

      const nextContent = content.filter(
        (block) => (block as { type?: string })?.type !== 'reasoning',
      );
      // 含 tool-call 的消息会被 appendReplace 跳过（保护 tool-pairing 平衡）；
      // 只有真正替换成功才计入 charsRemoved，避免日志虚报。
      if (appendReplace(session, nextContent, seq)) {
        for (const block of reasoningBlocks) {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') charsRemoved += text.length;
        }
        pruned += 1;
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: `error:${error instanceof Error ? error.message : String(error)}`,
      pruned,
      charsRemoved,
    };
  }

  if (pruned > 0) {
    log(`[lrc][prune-reasoning] 丢弃 ${pruned} 条旧推理（省 ${charsRemoved} 字符）`);
  }
  return { ok: true, reason: 'ok', pruned, charsRemoved };
}

/**
 * 执行一次确定性裁剪。
 *
 * 永不抛错：任何失败都转成 `{ ok: false, reason }`，调用方只记日志。
 *
 * @param deps - 宿主 ctx、agent、取消信号、参数与日志函数
 * @returns 裁剪结果
 */
export async function trimContext(deps: {
  ctx: unknown;
  agent: unknown;
  signal?: AbortSignal;
  options: TrimOptions;
  log: (message: string) => void;
}): Promise<TrimOutcome> {
  const { ctx, agent, signal, options, log } = deps;

  const presets = safeGet(ctx, 'agentPresets') as
    | { serviceFor?: (a: unknown, n: string) => unknown }
    | undefined;
  let engine: unknown;
  try {
    engine = presets?.serviceFor?.(agent, 'compaction');
  } catch (error) {
    return { ok: false, reason: `error:serviceFor ${String(error)}` };
  }
  const compactRegion = (engine as { compactRegion?: unknown } | undefined)?.compactRegion;
  if (typeof compactRegion !== 'function') {
    return {
      ok: false,
      reason: 'engine-unavailable',
      detail: `serviceFor=${typeof presets?.serviceFor} engine=${engine === undefined ? 'undefined' : 'present'}`,
    };
  }

  const session = (agent as { session?: unknown })?.session;
  const nodes = (session as { surface?: { nodes?: unknown } })?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === undefined) {
    return {
      ok: false,
      reason: 'no-range',
      detail: `nodes=${Array.isArray(nodes) ? nodes.length : 'missing'} events=${events === undefined ? 'missing' : events.length}`,
    };
  }

  const range = selectTrimRange(
    nodes,
    events,
    options.keepRecentNodes,
    // **两条触发路径都必须限流**。
    //
    // 上一版写 `force ? maxNodesPerRun : undefined`，理由是「token 超阈值
    // 说明真的太大了，该一次裁够」。这个判断是错的：
    //
    // - 事故的伤害不来自「裁得不够」，而来自「一次重写整段前缀」——
    //   KV 缓存按前缀复用，整段作废的代价与裁多少成正比。
    // - 真实日志里同一个窗口（contextWindow=1M ⇒ trimMin≈10.5 万）下，
    //   141 节点时刻 force 先触发；但窗口降到 800K 时 trimMin=8 万，
    //   节点数 114 就触发 token 路径 ⇒ 一次裁 104（91%），事故原样复发。
    // - 「一次裁够」并不会更快收敛：每步都有新节点进来，摊开裁同样能
    //   把规模压下去，且缓存损失小得多。
    //
    // ## 默认值必须下沉到函数内部
    //
    // 可以写成 `options.maxNodesPerRun`，也可以让 `selectTrimRange` 的
    // `undefined` 表示不限制 —— 但后者意味着**任何漏传的调用方都会精确
    // 复现事故**（实测 141 节点 → 裁 129，91.5%）。限流阀的默认值不能
    // 依赖「唯一装配点恰好传了」，所以这里自己补默认。
    options.maxNodesPerRun ?? DEFAULT_MAX_NODES_PER_RUN,
  );
  if (range === null) {
    return {
      ok: false,
      reason: 'no-range',
      detail: `nodes=${nodes.length} keepRecent=${options.keepRecentNodes}（节点太少或找不到平衡切点）`,
    };
  }

  const meter = meterOf(engine, ctx);
  let totalTokens = 0;
  let shadowedTokens = 0;
  try {
    const measurement = meter?.measure?.(session) as
      | { totalTokens?: number; nodes?: Array<{ tokens?: number }> }
      | undefined;
    totalTokens = measurement?.totalTokens ?? 0;
    const priced = measurement?.nodes;
    if (Array.isArray(priced)) {
      for (let i = range.startIdx; i <= range.endIdx; i += 1) {
        shadowedTokens += priced[i]?.tokens ?? 0;
      }
    }
  } catch {
    // 计量失败就按 0 处理：宁可少裁，不可误裁
  }
  if (!options.force && totalTokens < options.minTokens) {
    return {
      ok: false,
      reason: 'below-threshold',
      detail: `totalTokens=${totalTokens} min=${options.minTokens} meter=${meter === undefined ? 'missing' : 'present'}`,
    };
  }

  const target = engine as {
    summarize?: (...args: unknown[]) => Promise<unknown>;
    compactRegion: (s: number, e: number, a: unknown, sig?: AbortSignal) => Promise<unknown>;
  };
  if (typeof target.summarize !== 'function') {
    return {
      ok: false,
      reason: 'engine-unavailable',
      detail: `summarize=${typeof target.summarize}`,
    };
  }

  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'summarize');
  const original = target.summarize;
  let summaryChars = 0;
  let summaryText = '';
  // 第一遍真实条数（不含旧摘要补位），供 summaryStats 区分真实负载与补位填充。
  let summaryRealCounts: { requests: number; conclusions: number; errors: number; calls: number } = {
    requests: 0,
    conclusions: 0,
    errors: 0,
    calls: 0,
  };

  target.summarize = async (input: unknown) => {
    const messages = (input as { messages?: unknown })?.messages;
    const list = Array.isArray(messages) ? messages : [];
    // 被藏内容的字符总量：摘要必须明显更短，否则引擎会抛「summary is not smaller」
    let sourceChars = 0;
    for (const message of list) {
      const content = (message as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { text?: unknown; arguments?: unknown };
          if (typeof b?.text === 'string') sourceChars += b.text.length;
          if (typeof b?.arguments === 'string') sourceChars += b.arguments.length;
        }
      }
    }
    // `buildDeterministicSummary` 内部已对 NaN / 缺字段兜底（见该函数入口注释），
    // 这里只负责把「源字符数 / 4」与配置上限取小。
    const cap = Math.max(200, Math.min(options.maxSummaryChars, Math.floor(sourceChars / 4)));
    const text = buildDeterministicSummary(list, cap, summaryRealCounts, options.facts);
    summaryChars = text.length;
    summaryText = text;
    return {
      summary: [{ type: 'text', text }],
      provider: 'lrc',
      model: 'deterministic',
    };
  };

  try {
    await target.compactRegion(range.start, range.end, agent, signal);
    log(
      `[lrc][trim] 已裁剪 ${range.endIdx - range.startIdx + 1} 个节点` +
        `（总 ${totalTokens} tokens，${options.force ? '节点数强制' : '超阈值'}；` +
        `约 ${shadowedTokens} tokens → 摘要 ${summaryChars} 字符：${summaryStats(summaryText, summaryRealCounts)}）`,
    );
    return { ok: true, reason: 'ok', shadowedTokens, summaryChars, summaryStats: summaryStats(summaryText, summaryRealCounts) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // ★2026-11-07：兜底——起点落在 system prompt 上时，向后找第一个平衡切点重试一次。
    // 宿主对 node 0 有硬保护（只允许 system/message 重写它），而某些版本把系统提示
    // 写成无 source 的 user/message，会被判成可替换节点；没有兜底时该区间会一路涨到模型收尾。
    if (message.includes('holds the system prompt')) {
      const retryIdx = findRetryStart(nodes, events, range.startIdx, range.endIdx);
      if (retryIdx !== null) {
        try {
          await target.compactRegion(nodes[retryIdx] as number, range.end, agent, signal);
          log(
            `[lrc][trim] 起点回退后成功（${retryIdx}..${range.endIdx}）` +
              `（总 ${totalTokens} tokens，${options.force ? '节点数强制' : '超阈值'}；` +
              `约 ${shadowedTokens} tokens → 摘要 ${summaryChars} 字符：${summaryStats(summaryText, summaryRealCounts)}）`,
          );
          return { ok: true, reason: 'ok', shadowedTokens, summaryChars, summaryStats: summaryStats(summaryText, summaryRealCounts) };
        } catch (retryError) {
          return {
            ok: false,
            reason: `error:${retryError instanceof Error ? retryError.message : String(retryError)}`,
            detail: `retry range=${retryIdx}..${range.endIdx}`,
          };
        }
      }
    }
    return {
      ok: false,
      reason: `error:${message}`,
      detail: `range=${range.startIdx}..${range.endIdx} shadowedTokens=${shadowedTokens}`,
    };
  } finally {
    if (hadOwn) target.summarize = original;
    else delete (target as { summarize?: unknown }).summarize;
  }
}
