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
   * 本次最多裁掉多少个节点（`force` 时生效）。
   *
   * ## 为什么必须有上限
   *
   * 原实现 force 时把 `[startIdx, endIdx]` 整段一次替换掉。实测
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
   * 改为每次只裁一部分（默认保留约 1/4 的待裁区间），代价分摊到多次：
   * 单次缓存损失更小，且上下文始终保有较近的历史。
   */
  maxNodesPerRun?: number;
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
  // **规范化 maxNodes**：这是本轮新增、且宿主 patch 里通常没有的字段。
  //
  // 实测三种失效形态（与本项目历史 `baseMs * 2**n` 得 NaN 同类）：
  // ```
  // maxNodes='40'    → 裁 139（限制完全失效，隐式转数后越界）
  // maxNodes=40.5    → null（完全裁不动）
  // maxNodes=NaN     → 裁 191（限制完全失效）
  // ```
  // 故在入口收口，任何非正整数一律视为「不限制」，绝不参与算术。
  const limit =
    typeof maxNodes === 'number' && Number.isFinite(maxNodes) && maxNodes > 0
      ? Math.floor(maxNodes)
      : undefined;

  const n = nodes.length;
  if (n <= keepRecentNodes + 1) return null;

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
  const hardEnd = n - keepRecentNodes - 1;
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
    // 收缩终点：从 startIdx 起，取**连续**的第 limit 个可替换节点。
    //
    // ## 为什么必须连续
    //
    // `compactRegion(start, end)` 会把 [start, end] 整个区间换掉。
    // 区间里若夹着 injected / system 节点，宿主的 surface 校验会拒绝
    // （那些节点不允许被替换）。所以收缩后的终点不能跨过不可替换节点。
    //
    // ## 为什么不能简单 `startIdx + limit - 1`
    //
    // 实测（182 节点，中间夹 60 个 injected）：那样会退到只剩 2 个节点，
    // 把 40 的预算浪费成 2，渐进裁剪形同停摆。
    // 这里改为「数到 limit 个可替换就停」，遇到不可替换则就地结束。
    let taken = 0;
    let lastEligible = -1;
    for (let cursor = startIdx; cursor <= endIdx; cursor += 1) {
      if (cut[cursor + 1] !== true || !isTrimBoundaryEligible(events[nodes[cursor] as number])) {
        break; // 遇到不可替换/不平衡：区间到此为止，不能跨过
      }
      lastEligible = cursor;
      taken += 1;
      if (taken >= limit) break;
    }
    // 收缩窗口内一个可用边界都没有 ⇒ 保持原 endIdx（退化为整段裁剪）。
    //
    // **不要 return null**：那会让 `trimContext` 返回 no-range，
    // 而 `trimReasonsLogged` 每种原因只记一次 ⇒ 整场会话静默不再裁剪、
    // 上下文无限增长且日志看着正常。这是本项目最典型的静默失效形态。
    if (lastEligible >= startIdx) endIdx = lastEligible;
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

/** 去重后按上限收集。 */
function collect(target: string[], seen: Set<string>, line: string, limit: number): void {
  if (target.length >= limit) return;
  if (line.length === 0 || seen.has(line)) return;
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
 * 实测 AI 会把「接下来我要确认工具参数存放在哪里」当成结论写进摘要，
 * 导致 `### 助手结论` 约 10% 是待办意图。含完成时态词时不判为过程叙述。
 */
function isProcessNarration(text: string): boolean {
  if (!/接下来|下一步|我要|待确认|待验证|还需要|准备|打算|将要/.test(text)) return false;
  return !/已完成|已确认|已验证|已修复|结论是|因此|所以|说明|表明/.test(text);
}

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
 * @param messages - 被裁剪区间的重放消息（`SummarizationInput.messages`）
 * @param maxChars - 摘要字符上限
 * @returns 摘要文本
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
   */
  realCounts?: { requests: number; conclusions: number; errors: number; calls: number },
): string {
  const requests: string[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  const conclusions: string[] = [];
  const seen = new Set<string>();
  /** 旧摘要文本，留到第二遍再吸收（见下方「两遍扫描」说明） */
  const priorSummaries: string[] = [];

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown; isError?: unknown };
    const content = message?.content;
    if (!Array.isArray(content)) continue;

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
        if (isNoiseText(b.text)) continue;
        // 系统提示：既不是用户请求也不是助手结论。
        // `systemPromptUpdate: in-history` 时它会出现在重放历史里，
        // 必须在这里显式拦掉（见 `isConclusionRole` 注释）。
        if (!isConversationRole(message.role)) continue;
        const line = oneLine(b.text, 300);
        if (message.role === 'user') collect(requests, seen, `- ${line}`, 12);
        // 过程叙述（「接下来我要…」）不是结论，不进 `### 助手结论`
        else if (isConclusionRole(message.role) && !isProcessNarration(b.text)) {
          collect(conclusions, seen, `- ${line}`, 15);
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
  if (text.length <= maxChars) return text;

  // 超限：按 weight 升序逐条丢弃最低价值段落，直到装得下
  const working = all.map((s) => ({ ...s, lines: [...s.lines] }));
  while (text.length > maxChars) {
    // 先删权重最低的段落的最后一条；该段空了就整段移除
    const target = working
      .filter((s) => s.lines.length > 0)
      .sort((a, b) => a.weight - b.weight)[0];
    if (!target) break;
    target.lines.pop();
    text = render(working.filter((s) => s.lines.length > 0));
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
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
   * 传入后，若某桶的最终条数 ≠ 真实条数（差额来自旧摘要补位），
   * 会标注「（真实 N）」，避免把补位上限误读成真实负载。
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
  const part = (label: string, total: number, real: number | undefined): string =>
    real !== undefined && real !== total ? `${label} ${total}（真实 ${real}）` : `${label} ${total}`;
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
  const { agent, log } = deps;
  const thresholdChars = deps.options?.thresholdChars ?? 4000;
  const headChars = deps.options?.headChars ?? 2000;
  const keepRecentNodes = deps.options?.keepRecentNodes ?? 8;

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
  const keepRecentNodes = deps.options?.keepRecentNodes ?? 8;

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
    // 只在 force（节点数超限）时限制单次规模：token 超阈值是「真的太大了」，
    // 该一次裁够；而节点数超限是常态兜底，必须摊开裁，否则每次重写整段前缀。
    options.force ? options.maxNodesPerRun : undefined,
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
    const cap = Math.max(200, Math.min(options.maxSummaryChars, Math.floor(sourceChars / 4)));
    const text = buildDeterministicSummary(list, cap, summaryRealCounts);
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
