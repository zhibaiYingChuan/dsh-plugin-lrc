/**
 * DSH 插件入口：内置 LRC + 持续记忆沉淀。
 *
 * ## 职责
 *
 * 1. 启动/复用 LRC 运行时（`runtime.ts`）
 * 2. 注册系统提示段落，让宿主 LLM 顺手输出 `<lrc_memory>` 提炼结果
 * 3. 订阅会话事件，累计新增对话
 * 4. 达到阈值（N 步 / 8 轮 / 6000 字符）或 turn 结束时沉淀进 LRC（`offloader.ts`）
 * 5. 注册 `lrc_remember_now` 工具，允许模型手动触发
 *
 * ## 架构边界
 *
 * **LRC 只存不筛**。硬规则过滤、宿主 LLM 提炼、本地查重全部在本插件完成，
 * 送进 LRC 的已经是高密度结论。LRC 端不加任何 LLM，保持毫秒级写入。
 *
 * ## 关于事件名
 *
 * `session/event` 与 `agent/pre-step` 来自 DSH 官方压缩后端的用法。
 * 本插件对事件载荷做**防御式解析**：字段对不上就跳过并记一次 warn，
 * 不会因为 DSH 版本差异而崩溃。
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LrcRuntime } from './runtime.ts';
import { LrcClient, type DistilledItem } from './lrc-client.ts';
import { Recoverable, isConnectionError } from './recoverable.ts';
import { normalizeRecallOptions, formatRecallInjection, topicFingerprint } from './recall-injection.ts';
import { CursorStore, RecentStore, snapshotChanged } from './cursor.ts';
import { Offloader, itemsFromTag } from './offloader.ts';
import {
  hasMalformedTextBlock,
  isRealUserMessage,
  linesFromSession,
  messageContent,
  reasoningBlocksOnly,
  textBlocksOnly,
  userMessageText,
} from './session-text.ts';
import { conclusionsFromReasoning, constraintsFromProse, extractMemoryTag, isNoUpdate } from './memory-filter.ts';
import {
  pruneReasoning,
  pruneToolCallArguments,
  pruneToolResults,
  trimContext,
} from './context-trim.ts';
import { buildHandoffText, createHandoffSession, extractHandoffSource } from './handoff.ts';
import { formatCapabilities, probeCapabilities } from './capabilities.ts';
import { formatBudget, resolveBudget, type ResolvedBudget } from './budget.ts';
import { formatProfile, profileSurface } from './context-profile.ts';
import {
  createGovernorState,
  formatGovernorState,
  runGovernor,
  type GovernorAction,
} from './governor.ts';

export const name = 'dsh-plugin-lrc';

/** 等工具注册表就绪后再执行 apply。 */
export const inject = ['tools'];

export interface Config {
  /** 指向已有 LRC；留空则自动探测/启动 */
  baseUrl: string;
  token: string;
  project: string;
  /** 累计多少轮沉淀一次 */
  offloadTurns: number;
  /** 累计多少字符沉淀一次 */
  offloadChars: number;
  /** 累计多少步沉淀一次（长任务兜底） */
  offloadSteps: number;
  /** 单次最多提炼条数 */
  maxItems: number;
  /** 是否启用工具输出剪枝（路径 2，零 LLM，每步执行） */
  pruneEnabled: boolean;
  /** 工具输出剪枝阈值（字符）；官方默认 8192，实测命中率太低 */
  pruneResultThreshold: number;
  /** 是否截断超长工具参数（路径 2b，官方 pruner 不覆盖） */
  pruneArgsEnabled: boolean;
  /** 工具参数超过多少字符才截断 */
  pruneArgsThreshold: number;
  /** 工具参数保留开头多少字符 */
  pruneArgsHead: number;
  /** 是否丢弃旧消息里的 reasoning 块（路径 2c） */
  pruneReasoningEnabled: boolean;
  /** 统一保留策略：最近多少个 surface 节点不裁剪、不丢推理 */
  keepRecentNodes: number;
  /** 是否启用确定性上下文裁剪（路径 1，零 LLM） */
  trimEnabled: boolean;
  /** 显式指定模型窗口；0 = 自动探测 */
  contextWindowTokens: number;
  /** 裁剪阈值占窗口比例 */
  trimRatio: number;
  /** 工具输出剪枝阈值占窗口比例 */
  pruneRatio: number;
  /** 窗口未知时的裁剪阈值（绝对值） */
  trimMinTokens: number;

  /** 两次裁剪之间至少间隔多少步 */
  trimMinSteps: number;
  /** surface 节点数硬上限：超过就跳过 token 阈值强制裁剪 */
  trimMaxNodes: number;
  /**
   * 节点数超限时，**单次最多裁掉多少节点**。
   *
   * 实测（session-e1419190）：141 个节点一次裁掉 131 个（92%），
   * 这是「一次性重写整段前缀」，KV 前缀缓存全部作废。
   * 渐进裁剪把代价分摊到多次，且始终保留较近的历史脉络。
   */
  trimMaxNodesPerRun: number;
  /** 确定性摘要的字符上限 */
  trimMaxSummaryChars: number;
  /** 首次重连等待（毫秒）；0 = 不重试 */
  reconnectBaseMs: number;
  /** 重连退避上限（毫秒） */
  reconnectMaxMs: number;
  /** 能力矩阵复查间隔（步）：判定为不可用后每 N 步重探一次，0 = 不复查 */
  capabilityRecheckSteps: number;
  /** 预算复查间隔（步）：窗口未知时每 N 步重探一次，0 = 不复查 */
  budgetRecheckSteps: number;
  /** 是否主动把相关记忆注入上下文 */
  recallInjectEnabled: boolean;
  /** 最多注入几条 */
  recallInjectMaxItems: number;
  /** 低于该相关度不注入（0–1） */
  recallInjectMinScore: number;
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: number;
}

export const Config: Schema = Schema.object({
  baseUrl: Schema.string().default(''),
  token: Schema.string().default(''),
  project: Schema.string().default('dsh'),
  offloadTurns: Schema.number().default(8),
  offloadChars: Schema.number().default(6000),
  // 20 步对工具密集型轮次太晚：实测 16 步的会话一次都没触发，
  // 快照始终为空。降到 8 步，让中途也能沉淀出 `[LRC 状态]`。
  offloadSteps: Schema.number().default(8),
  maxItems: Schema.number().default(40),
  pruneEnabled: Schema.boolean().default(true),
  pruneResultThreshold: Schema.number().default(4096),
  // ★2026-11-07：默认关闭。宿主 surface 校验不允许替换含 tool-call 的
  // assistant 节点（会破坏 tool-pairing 平衡），本路径在当前宿主版本下不可用。
  // 保留配置项，等宿主提供「原地改参数」能力后再启用。
  pruneArgsEnabled: Schema.boolean().default(false),
  pruneArgsThreshold: Schema.number().default(4000),
  pruneArgsHead: Schema.number().default(2000),
  pruneReasoningEnabled: Schema.boolean().default(true),
  // 统一保留策略：trim 与 prune-reasoning 共用，避免两套 keep-recent 漂移
  keepRecentNodes: Schema.number().default(8),
  trimEnabled: Schema.boolean().default(true),
  // 阈值按模型窗口比例推导：1M 窗口 → trim 100000 / prune 4000；
  // 128K 窗口 → trim 12800 / prune 2048。
  //
  // ★2026-11-12：0.03 → 0.10。原比例实测代价极高：trim 会重写早期历史，
  // 而 KV 缓存是前缀缓存 ⇒ 每次 trim 后整段缓存失效（实测 2 次 cacheRead=0
  // 全价重发，另 2 次丢 14K tokens 前缀）。而 trim 当次只降 3~7K tokens，
  // 上下文几步后又涨回原水位 —— **净亏**。
  // 0.10 让压缩在「真有必要」时才发生，而不是刚过 3% 就反复重写。
  contextWindowTokens: Schema.number().default(0),
  trimRatio: Schema.number().default(0.1),
  pruneRatio: Schema.number().default(0.004),
  // 窗口探测失败时的绝对值兜底
  trimMinTokens: Schema.number().default(30000),

  trimMinSteps: Schema.number().default(10),
  // ★2026-11-08：节点数硬上限兜底。token 计量一旦失真（宿主换版本 / meter 返回 0 /
  // 阈值配错），纯 token 触发会让上下文无限增长；节点数不依赖任何服务，用它兜底。
  // 实测正常稳态 31–72 节点，120 只在异常时触发。
  trimMaxNodes: Schema.number().default(120),
  // 单次最多裁 40 个（约 1/3）。宁可多裁几轮，也别一次重写整段前缀 ——
  // 每裁一次就打断一次 KV 前缀缓存，粗粒度裁剪的代价是细粒度的数倍。
  trimMaxNodesPerRun: Schema.number().default(40),
  // ★2026-11-07：2000 → 4000。实测 2000 字符的摘要会把关键结论截掉，
  // 用户反馈「关键信息基本都丢了」；4000 仍远小于被裁剪区间（约 9k tokens）。
  trimMaxSummaryChars: Schema.number().default(4000),

  // ── 连接恢复 ──
  // LRC 可能比 DSH 晚启动（实测桌面端晚 20 分钟）。此前插件只在加载时连一次，
  // 失败即永久降级 —— 召回整场会话都用不了。这两项控制重连退避节奏。
  /** 首次重连等待（毫秒）；0 = 不重试（仅排障用） */
  reconnectBaseMs: Schema.number().default(2000),
  /** 重连退避上限（毫秒）：封顶保证最终能自愈 */
  reconnectMaxMs: Schema.number().default(60000),

  // ── 一次性判定的复查 ──
  // 宿主服务可能后起（compaction 在 preset 初始化 / tokenMeter 随模型切换就绪）。
  // 一次性探测会把「启动瞬间没准备好」固化成「整场会话不可用」。
  capabilityRecheckSteps: Schema.number().default(20),
  budgetRecheckSteps: Schema.number().default(20),

  // ── 主动召回注入 ──
  // 实测（2026-11-12，379 步真实会话）：模型从未想起调用 lrc_recall，
  // 系统提示写了也没用。改为由插件主动把相关记忆推进上下文。
  // 默认关闭：先让用户按需开启并观察缓存命中率，确认无副作用再改默认值。
  /** 是否主动注入相关记忆 */
  recallInjectEnabled: Schema.boolean().default(false),
  /** 最多注入几条 */
  recallInjectMaxItems: Schema.number().default(2),
  /** 低于该相关度不注入（0–1） */
  recallInjectMinScore: Schema.number().default(0.5),
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: Schema.number().default(80),
});

/** 系统提示段落名（全局唯一，避免与宿主段落冲突）。 */
const PROMPT_SECTION = 'lrc:memory-capture';

/**
 * 构建系统提示段落。
 *
 * 让宿主 LLM 顺手做提炼：为什么放在系统提示而不是再起一次 LLM 调用 ——
 * 宿主本来就要生成回答，顺手多写 1~3 句结论是零额外成本；单独调用一次
 * 模型既慢又费钱。为什么要求"每次都输出"：实测把标签写成可选项时，
 * 模型十来轮一次都没照做，这一层等于不存在。改成强制契约后，触发率可观测，
 * 也能用 `无新增` 明确表达空。
 *
 * # 为什么按配置分两版
 *
 * 开启主动注入后，`[LRC 相关记忆]` 已经出现在上下文里。此时若仍写
 * 「先调 `lrc_recall` 工具」，模型会面对**两套相互竞争的指令**：
 * 一边已经拿到记忆，一边被要求再去调工具查一遍。实测这类矛盾提示会
 * 让模型两头都不做（既不调工具，也不信任注入内容）。
 *
 * 所以注入开启时，提示改成「记忆已给你，不足才查」，让两条路径互补而非冲突。
 */
function buildPromptText(recallInjected: boolean): string {
  const recallRule = recallInjected
    ? [
        '上下文里可能已出现 `[LRC 相关记忆]` 段落，那是插件按当前话题**自动检索**的结果，',
        '直接当事实使用，不需要再调 `lrc_recall` 确认。',
        '只有当该段落缺失、或明显不足以回答（例如需要更早的细节）时，才调 `lrc_recall` 补充检索；',
        '检索为空时回退内置搜索，并在回复中说明「LRC 未命中，已回退内置搜索」。',
      ]
    : [
        '涉及项目历史、用户偏好、之前做过的决定、上次怎么改的，**先调 `lrc_recall` 工具**，',
        '不要直接 Grep 或翻文件。检索为空时才回退内置搜索，并在回复中说明「LRC 未命中，已回退内置搜索」。',
      ];

  return [
    '## 长期记忆（LRC）',
    '',
    ...recallRule,
    '',
    '发现某条记忆与事实不符时，用 `lrc_forget` 撤回（id 从 `lrc_recall` 输出里取），',
    '不要让它继续污染后续对话。',
    '',
    '## 长期记忆沉淀',
    '',
    '插件会自动从你的回答里提取**约束**（"不要用 X"、"必须 Y"）和**决策**（"改用 X"），',
    '所以不需要额外格式化输出。只要在回答里把结论说清楚即可。',
    '',
    '如果你愿意显式标注，可用下面的块（可选，不是必须）：',
    '',
    '<lrc_memory>',
    '- 决策：…',
    '- 约束：…',
    '- 结论：…',
    '</lrc_memory>',
    '',
    '规则：',
    '- 只写本轮产生的决策、约束、最终结论；没有的条目直接省略。',
    '- 只写结论，不写过程、待办清单、选项罗列或代码。',
  ].join('\n');
}

export function apply(ctx: Context, config: Config): void {
  const cacheDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'lrc-plugin');
  const snapshotPath = join(cacheDir, 'snapshot.json');

  /**
   * 复查间隔规范化。
   *
   * 为什么必须兜底：宿主通过 `cordis.patch.yml` 传入的配置**不一定**包含新字段
   * （老 patch 不会自动补齐）。缺失时 `steps % undefined` 得到 `NaN`，
   * 而 `NaN === 0` 恒为 false ⇒ 复查永远不触发，且**不报错、日志正常**。
   *
   * 0 或负数表示「不复查」，显式短路，避免落入取模的 NaN 陷阱。
   */
  function recheckInterval(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  }
  const capabilityRecheckSteps = recheckInterval(config.capabilityRecheckSteps);
  const budgetRecheckSteps = recheckInterval(config.budgetRecheckSteps);

  /**
   * 正整数配置归一化（带兜底默认值）。
   *
   * 与 `recheckInterval` 同一类防护：宿主 patch 里**不会**包含新字段，
   * 传进来就是 `undefined`。而 `undefined` 参与算术会静默变形 ——
   * 实测 `trimMaxNodesPerRun` 缺失时单次裁 132 个（旧行为），
   * 传 `'40'` 时限制完全失效（裁 139），传 `40.5` 时完全裁不动（null）。
   */
  function positiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
  }
  const trimMaxNodesPerRun = positiveInt(config.trimMaxNodesPerRun, 40);

  /**
   * 从磁盘恢复上次的快照。
   *
   * 不持久化的话，插件进程一重启 `latestSnapshot` 就变空串，
   * 读路径（`[LRC 状态]` 注入）直接断掉 —— 而 LRC 里的记忆还在。
   *
   * 返回快照文本与其归属的会话 ID。**归属必须一起读出来**：
   * 快照是「本会话的沉淀状态」，不是全局事实。没有归属时，新会话
   * 会继承上一个会话的结论（实测：新开会话注入
   * 「[LRC 状态] 方向已定，不再问你」，而模型完全不知道「方向」指什么）。
   */
  function loadSnapshot(): { text: string; sessionId: string } {
    const empty = { text: '', sessionId: '' };
    try {
      if (!existsSync(snapshotPath)) return empty;
      const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
        text?: unknown;
        sessionId?: unknown;
      };
      return {
        text: typeof raw.text === 'string' ? raw.text : '',
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      };
    } catch (error) {
      // 不能静默：快照损坏会让 `[LRC 状态]` 凭空消失，而用户只会觉得"插件不工作了"。
      // 只告警一次，随后照常以降级方式继续（快照本身可以重建）。
      ctx.logger.warn(
        `[lrc] 快照文件读取失败，本次从空快照开始（${error instanceof Error ? error.message : String(error)}）：${snapshotPath}`,
      );
      return empty;
    }
  }

  let warnedSaveSnapshot = false;

  /**
   * 快照落盘 + 内存态更新（**唯一入口**）。
   *
   * ## 为什么 sessionId 必须显式传入
   *
   * 曾把 `currentSessionId` 藏在函数内部读，理由是「收口到一处就不可能写错」。
   * 那是错的：`currentSessionId` 是「最近一次收到事件的会话」，而 `flush()`
   * 是异步的（要等 distill + migrate 两次 HTTP）。真实时序：
   *
   * ```
   * A 的 turn/end → flush(A) 进入 await
   *   → B 的 turn/start 到达，bindSnapshotToSession('B') 改写 currentSessionId
   *   → A 的 HTTP 返回，saveSnapshot(A 的内容) 落盘时标成 B
   * ```
   *
   * 落盘归属看起来「有值且合理」，实际是错的 —— 比空值更难排查。
   * 所以由调用方传入它**当时那个 session 的真实 ID**。
   *
   * ## 为什么还要比较 currentSessionId
   *
   * 上面那段时序里，A 的内容不只落盘错，还会被 A 的调用点写进
   * `latestSnapshot`（全局单值），立刻出现在 B 的 `text()` 里被注入 ——
   * 此时 `bindSnapshotToSession` 已不会再触发（B 已是 current），
   * **归属判定被完全绕过**。故这里直接拒绝：不是当前会话的内容不进内存。
   *
   * @returns 是否接受本次写入（false = 内容属于已离开的会话，已丢弃）
   */
  function saveSnapshot(text: string, sessionId: string): boolean {
    // 已切走：写盘也不该覆盖当前会话的归属，内存更不能污染
    if (sessionId.length > 0 && currentSessionId.length > 0 && sessionId !== currentSessionId) {
      ctx.logger.info(
        `[lrc] 丢弃属于已离开会话（${sessionId}）的快照，当前为 ${currentSessionId}`,
      );
      return false;
    }

    // 空 sessionId 表示「取不到会话标识」（异常宿主形状）。此时**不更新归属**：
    // 否则会把 `snapshotOwner` 写成 ''，下次正常会话启动时判定
    // `'' !== sessionId` ⇒ 把自己刚写的内容当别人的丢掉，且无从排查。
    if (text.length > 0 && sessionId.length > 0) {
      latestSnapshot = text;
      snapshotOwner = sessionId;
    } else if (text.length > 0 && snapshotOwner === currentSessionId) {
      // 同一会话但取不到 ID：内容仍是自己的，可以进内存（归属不变）
      latestSnapshot = text;
    }

    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        snapshotPath,
        JSON.stringify({ text, sessionId, updatedAt: Date.now() }),
        'utf8',
      );
    } catch (error) {
      // 落盘失败不影响本次对话，但**会让下次启动丢掉读路径**，必须让人知道。
      // 只告警一次，避免每轮沉淀都刷屏。
      if (!warnedSaveSnapshot) {
        warnedSaveSnapshot = true;
        ctx.logger.warn(
          `[lrc] 快照落盘失败，重启后 [LRC 状态] 会缺失（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
    return true;
  }

  const runtime = new LrcRuntime({
    // 配置里的 baseUrl 必须传下去，否则 patch 里写 3111 也会打到 3099
    baseUrl: config.baseUrl,
    cacheDir,
    log: (message) => ctx.logger.info(message),
  });

  /**
   * 沉淀器**恒存在**（只是可能未连接）。
   *
   * 用确定类型而非 `| null`：一旦允许 null，调用点就会各自写
   * `if (offloader === null) return`，LRC 恢复后那批内容便永久丢弃。
   * 「未连接」由 `offloader.connected` 表达，语义更准确。
   */
  let offloader: Offloader;
  /**
   * LRC 连接：**可恢复**，不是启动时决定一次就永久定死。
   *
   * 真实事故：LRC 桌面端比 DSH 晚 20 分钟启动，插件在那一刻探测失败后
   * `client` 永久为 null，整个会话 5 次 `lrc_recall` 全部返回「未就绪」，
   * 即使 LRC 早已健康也没有任何重试。
   *
   * 现在改成懒加载 + 指数退避 + 热路径失效重连（见 `recoverable.ts`）。
   */
  const connection = new Recoverable<LrcClient>(
    async () => {
      // force：重试节奏由外层 Recoverable 统一控制，避免两层退避叠加
      const result = await runtime.ensure({ force: true });
      if (result.mode === 'degraded') {
        throw new Error(result.reason ?? 'LRC 不可用');
      }
      const created = new LrcClient({ baseUrl: result.baseUrl, token: config.token || undefined });
      attachOffloader(created);
      return created;
    },
    { backoff: { baseMs: config.reconnectBaseMs, maxMs: config.reconnectMaxMs } },
  );
  let warnedShape = false;
  let warnedEmpty = false;
  /** 推理兜底抽不到结论句时只提示一次。 */
  let warnedNoConclusion = false;
  let flushing = false;
  /** 能力矩阵是否已探测（首次 pre-step 探测一次）。 */
  let probed = false;
  /**
   * 主动召回注入的当前状态。
   *
   * 为什么要"按话题指纹"而不是每轮查：
   * 宿主按前缀复用 KV 缓存（实测基线命中率 92.2% / P50 96.6%）。
   * 每轮注入不同文本会把命中率打下来，所以同一话题内**保持文本完全不变**，
   * 只在该话题首次进入时更新一次。
   */
  let recallText = '';
  let recallFingerprint = '';
  /**
   * 召回注入的并发代次。
   *
   * 每发起一次召回就递增；结果回来时若代次已变，说明有更新的一次在飞，
   * 本次结果直接丢弃。没有这道闸门时，用户连发两条不同话题的消息，
   * 先发的慢查询会覆盖后发的结果 —— 注入内容与当前问题无关，
   * 且会一直错到下次换话题。
   */
  let recallGeneration = 0;
  /** 注入文本累计改写次数（缓存代价的唯一实测口径，`lrc_status` 展示）。 */
  let recallRewrites = 0;
  /**
   * 规范化后的注入参数（**只算一次**）。
   *
   * 不能直接用 `config.recallInjectMaxItems` 等字段：宿主传的裸配置可能缺字段，
   * `undefined` 会让「最多 N 条」变成「全部」、让相关度过滤恒为 false。
   * 详见 `normalizeRecallOptions` 注释。
   */
  const recallOptions = normalizeRecallOptions({
    maxItems: config.recallInjectMaxItems,
    maxCharsPerItem: config.recallInjectMaxCharsPerItem,
    maxTotalChars: 240,
    minScore: config.recallInjectMinScore,
  });
  /**
   * `<lrc_memory>` 命中统计：**按轮计，不按消息计**。
   *
   * 按消息计时，工具密集型轮次里的中间说明（"我先看下文件"）会被算成失败，
   * 分母被灌水，实测显示 2.5% 命中率，而真实带标签的轮次比例是 2/5、1/5、1/2。
   */
  let turnHits = 0;
  let turnMisses = 0;
  /**
   * 通过**正文抽取**拿到约束的轮次数（2026-11-12 新增）。
   *
   * 与 `turnHits`（显式标签）并列展示：模型几乎不写标签，所以只看
   * 「标签命中率」会长期 0%，被误读成插件失效。这个计数才是真实来源。
   */
  let proseTurns = 0;
  /**
   * 未连接时暂存的正文档约束（上限 30）。
   *
   * 为什么需要：`assistant/message` 事件**不会被回放**。LRC 桌面端比 DSH
   * 晚起 20 分钟是已发生过的真实事故，那段时间里抽到的约束若直接丢弃，
   * 就永久消失了（`flush()` 为此保留了 pending 计数，prose 路径同理）。
   */
  let proseBacklog: DistilledItem[] = [];
  const PROSE_BACKLOG_MAX = 30;
  /**
   * 快照写入代次（防乱序覆盖）。
   *
   * 多条 prose 的 migrate 往返可能乱序完成，晚完成的那条会用更早的内容
   * 覆盖快照 —— 症状是 `[LRC 状态]` 内容「倒退」。每发起一次就递增，
   * 回调里代次不符即丢弃。
   */
  let snapshotGeneration = 0;
  /** 整轮没有正文的轮次数（标签根本没地方出现，不该计入分母） */
  let turnNoText = 0;
  /** 当前轮状态 */
  let turnHadText = false;
  let turnTagSeen = false;
  let turnReasoning: string[] = [];
  let turnReasoningChars = 0;
  /**
   * 磁盘上那份快照（**只读一次**，进程启动时的值）。
   *
   * 它是「上一个进程留下的」内容，可能属于本会话也可能属于别的会话。
   * 只在 `bindSnapshotToSession()` 确认归属后才允许进入 `latestSnapshot`。
   */
  const storedSnapshot = loadSnapshot();
  /**
   * 最近一次沉淀产出的状态快照，注入下一轮上下文（闭环的"读"路径）。
   *
   * **初值必须为空**，不能预置 `storedSnapshot.text`：
   * `text()` 回调签名是 `() => string`，拿不到 session 参数，所以它在
   * **任何**时刻被调用都只能返回当前变量值。而宿主恢复会话时不会重放
   * `session/event`（`dsh-session` 源码：seed events 从不 publish），
   * 于是「进程已启动、快照已读入、`currentSessionId` 还是空」这个窗口里，
   * 任何一次渲染（打开会话 / UI 预览 / 标题生成）都会把**上一个会话**
   * 的快照注入进来 —— 这正是那起「方向已定，不再问你」事故的成因。
   *
   * 代价是「首次沉淀前读路径为空」，可以接受：一次沉淀即可重建。
   */
  let latestSnapshot = '';
  /**
   * 当前`latestSnapshot` 归属的会话 ID。
   *
   * 必须与 `currentSessionId` 分开：前者是「这份内容是谁的」，
   * 后者是「现在在跟谁说话」。两者不一致时**绝不能注入**。
   * 用一个可变变量而不是拿启动时的 `storedSnapshot.sessionId` 比对，
   * 否则 A→B→A 切回时会把 A 刚写的内容误判成别人的（见 `bindSnapshotToSession`）。
   */
  let snapshotOwner = storedSnapshot.sessionId;
  /** 当前会话 ID（用于判定快照归属）。空串表示还没见过会话事件。 */
  let currentSessionId = '';
  /** 快照是否已被渲染层取走（只记一次日志）。 */
  let snapshotServed = false;
  /** 步进控制器：能力门控 + 熔断 + 节流 + 有序执行。 */
  const governor = createGovernorState();
  /** 统一预算（首次 pre-step 解析一次）。 */
  let budget: ResolvedBudget | null = null;
  /** 已记录过的裁剪未生效原因（每种只记一次，避免每步刷屏）。 */
  const trimReasonsLogged = new Set<string>();
  /** 最近一次 pre-step 的 agent：`lrc_handoff` 工具需要它拿当前会话。 */
  let lastAgent: unknown;

  /**
   * 把状态快照绑定到当前会话：**归属不符就丢弃**。
   *
   * ## 为什么必须有这一步
   *
   * 快照文件是进程级单例，语义却是「本会话沉淀出的状态」。实测事故
   * （2026-11-12，session-644bba1d 新开会话）第一轮就被注入：
   *
   * ```
   * [LRC 状态] 方向已定，不再问你。细节在 LRC，需要时 recall。
   * ```
   *
   * 这句话来自**上一个会话**（做视频时定的方向），新会话的模型
   * 根本不知道「方向」指什么。它不会报错，只会：
   * 1. 把「方向已定」当成既定前提，跳过需求确认；
   * 2. 或反复追问「什么方向」——两者都是误导。
   *
   * ## 为什么用可变的 `snapshotOwner`，而不是比 `storedSnapshot.sessionId`
   *
   * `storedSnapshot` 是**进程启动时**的磁盘值，之后再不变。用它比对会出现
   * 「A→B→A 切回时丢掉 A 自己刚写的快照」：A 写了 T_A，切到 B，再切回 A，
   * 判定仍是 `storedSnapshot.sessionId(=OLD) !== 'A'` ⇒ 把 T_A 丢掉，
   * 症状是「切回来状态行消失且不会自己回来」，而 `lrc_status` 还显示
   * 「为空（还没有成功沉淀过）」——与事实相反。
   *
   * 所以归属必须跟着**内存里的实际内容**走：`saveSnapshot` 写谁就更新谁。
   *
   * @param sessionId - 本次会话 ID
   */
  function bindSnapshotToSession(sessionId: string): void {
    if (sessionId.length === 0) return;
    if (sessionId === currentSessionId) return;
    currentSessionId = sessionId;

    // ── 所有「会话级状态」必须在这里一并重置 ──
    //
    // 引入会话边界后，只修快照是不够的：召回注入的 `recallText`/`recallFingerprint`
    // 同样是会话级的。若不清，新会话第一句若恰好算出与旧会话相同的指纹
    // （例如都以「继续」开头，而指纹继承逻辑会沿用上一指纹），
    // 就会直接跳过检索、沿用**上一个会话**注入的记忆 —— 与快照泄漏同构，
    // 只是更难观察（要撞上同指纹才复现）。
    if (recallText.length > 0 || recallFingerprint.length > 0) {
      recallText = '';
      recallFingerprint = '';
      recallGeneration += 1;
    }

    // 快照候选池同样是会话级状态：换会话后不能继续用上一场的约束拼快照，
    // 与 `latestSnapshot` 归属判定同源（`bindSnapshotToSession` 的目的）。
    offloader.resetSnapshotPool();
    proseBacklog = [];
    snapshotGeneration += 1;

    // 归属不符：磁盘里那份是别人的，不能带进本会话
    if (snapshotOwner !== sessionId) {
      // 注意判据是「磁盘上有没有内容」，不是 `latestSnapshot.length`：
      // 初值已置空（见 `latestSnapshot` 声明处），后者恒为 0，会让这条
      // 本该出现的日志永远不打印 —— 而「快照被丢弃」正是排障时最需要看到的。
      if (storedSnapshot.text.length > 0) {
        ctx.logger.info(
          `[lrc] 快照属于其他会话（${snapshotOwner || '无归属'}），` +
            `已丢弃 ${storedSnapshot.text.length} 字符，避免跨会话误导`,
        );
      }
      latestSnapshot = '';
      snapshotServed = false;
      return;
    }

    // 归属相符（同一会话的重启续跑）：恢复磁盘内容
    if (latestSnapshot.length === 0 && storedSnapshot.text.length > 0) {
      latestSnapshot = storedSnapshot.text;
      ctx.logger.info(`[lrc] 快照归属本会话（${sessionId}），已恢复 ${latestSnapshot.length} 字符`);
    }
  }

  /**
   * 注入开关的单一判定点。
   *
   * 配置可能来自裸对象（缺字段），必须走 `=== true` 而不是真值判断：
   * 宿主若传字符串 `"false"`，真值判断会把它当成开启 —— 用户明明关了却还在注入。
   */
  const recallInjectOn = config.recallInjectEnabled === true;

  // 注册系统提示段落：让模型在回答末尾输出 <lrc_memory>。
  //
  // 用 `ctx.get()` 而不是 `inject`：systemPrompt 是可选依赖 ——
  // 缺了它只影响第二层提炼，不该让整个插件（含沉淀）加载失败。
  const systemPrompt = ctx.get('systemPrompt') as
    | {
        section?: (section: { name: string; order: number; text: string }) => unknown;
        context?: (entry: { name: string; order: number; text: () => string }) => unknown;
      }
    | undefined;
  if (typeof systemPrompt?.section === 'function') {
    try {
      systemPrompt.section({ name: PROMPT_SECTION, order: 9000, text: buildPromptText(recallInjectOn) });
    // 快照回填：把最近一次沉淀的状态注入下一轮上下文。
    // 这是闭环的"读"路径 —— 之前 buildSnapshot() 只作为工具返回值渲染，
    // 下一轮上下文里根本看不到 `[LRC 状态]`。
    // 没有快照时返回空串，渲染层会跳过空段。
    systemPrompt.context?.({
      name: 'lrc:snapshot',
      // ★2026-11-07（缓存命中率）：order 取 9999，让 LRC 快照排在
      // runtime-context 快照的**最末尾**（宿主内置 context 最高 210）。
      // 宿主把整块 runtime-context 作为一条 user 消息 append 到 surface 尾部，
      // 因此快照位于历史之后、不打断前缀；order 只决定块内顺序。
      order: 9999,
      text: () => {
        // 两段内容拼在一起，共用同一个注入点（避免多开一个 context 段，
        // 那会让宿主多 append 一条 user 消息，反而更伤缓存）：
        //   · recallText：本轮话题相关的历史（按话题指纹更新）
        //   · latestSnapshot：上一轮沉淀的状态（低频变化）
        const merged =
          recallText.length === 0
            ? latestSnapshot
            : latestSnapshot.length === 0
              ? recallText
              : `${recallText}\n\n${latestSnapshot}`;

        // 诊断：确认注入到底有没有被渲染层取走。
        // `systemPrompt.context` 是**动态 user-role 快照**，不进 system prompt，
        // 所以查 `request/header.system` 永远看不到它 —— 这条日志才是判据。
        if (merged.length > 0 && !snapshotServed) {
          snapshotServed = true;
          ctx.logger.info(
            `[lrc] 已注入上下文（${merged.length} 字符` +
              `${recallText.length > 0 ? `，含召回 ${recallText.length}` : ''}）`,
          );
        }
        return merged;
      },
    });
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 系统提示注册失败（不影响沉淀）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    ctx.logger.warn('[lrc] systemPrompt 服务不可用，跳过 <lrc_memory> 提示注入（沉淀仍走硬规则）');
  }

  // 插件卸载/重载时停掉托管实例，否则子进程会泄漏
  ctx.effect(() => () => runtime.stop(), 'lrc.runtime.stop()');

  // 诊断：探测 compaction 服务是否可达。
  //
  // 主动裁剪上下文（`ctx.compaction.compactRegion`）依赖这个服务。
  // 桌面 profile 里它挂在 preset 的隔离组中（`isolate: { compaction: true }`），
  // 宿主层插件可能拿不到 —— 这条日志用来确认到底可不可达。
  const compaction = ctx.get('compaction') as { compactRegion?: unknown } | undefined;
  ctx.logger.info(
    `[lrc] compaction 服务：${
      compaction === undefined
        ? '不可达（preset 隔离）'
        : typeof compaction.compactRegion === 'function'
          ? '可用（支持 compactRegion）'
          : '存在但无 compactRegion'
    }`,
  );

  /**
   * Offloader **一开始就以「未连接」状态创建**，计数器立即开始工作。
   *
   * 这样 LRC 晚启动时，之前那些轮次的 pending 计数不会丢 —— 一旦连上就能补写。
   * 此前是整个 Offloader 都不创建，LRC 恢复后那批内容已永久丢失。
   */
  offloader = new Offloader(
    null,
    new CursorStore(join(cacheDir, 'cursor.json')),
    {
      turnsThreshold: config.offloadTurns,
      charsThreshold: config.offloadChars,
      stepsThreshold: config.offloadSteps,
      project: config.project,
      maxItems: config.maxItems,
    },
    new RecentStore(join(cacheDir, 'recent.json')),
  );

  /** 连接就绪后把 client 注入 Offloader（保留其全部计数器与游标）。 */
  function attachOffloader(client: LrcClient): void {
    offloader?.bind(client);
  }

  // 预热：不阻塞插件加载，失败只记一次日志；之后由工具调用按需重试
  void (async () => {
    const client = await connection.get();
    if (client === null) {
      const status = connection.status();
      ctx.logger.warn(
        `[lrc] 暂未连上 LRC（${status.lastError ?? '未知原因'}）。` +
          `将在工具调用时按退避重试（下次最早 ${Math.round(status.retryInMs / 1000)}s 后）。`,
      );
      return;
    }
    ctx.logger.info(`[lrc] 记忆沉淀已就绪：${client.baseUrl}`);
    // 快照与写入解耦：上次进程没来得及沉淀时，从 LRC 索引重建
    void bootstrapSnapshot();
    // 回灌「未连接期间」暂存的正文约束。
    // `assistant/message` 不会被回放，错过就永久丢（见 proseBacklog）。
    if (proseBacklog.length > 0) {
      const pending = proseBacklog;
      proseBacklog = [];
      void offloader
        .offloadItems(pending)
        .then((result) => {
          if (result.distilled > 0) {
            if (result.snapshot.length > 0) saveSnapshot(result.snapshot, currentSessionId);
            ctx.logger.info(
              `[lrc] 补写未连接期间的 ${result.distilled} 条约束/决策（写入 ${result.written}）`,
            );
          }
        })
        .catch((error: unknown) => {
          ctx.logger.warn(
            `[lrc] 补写暂存约束失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  })();

  /**
   * 启动时确认 LRC 索引可用（**不再用它拼装 `[LRC 状态]`**）。
   *
   * ## 为什么原来要重建，现在为什么不能
   *
   * 原实现从项目级索引取最近 3 条记忆，拼成
   * `[LRC 状态] …。细节在 LRC，需要时 recall。` 注入上下文，目的是
   * 让进程重启后读路径不空。
   *
   * 但这个「状态」标签是**谎报**：索引是**跨会话的项目级记忆**，
   * 不含任何会话边界。实测事故（2026-11-12，新会话说 `session-644bba1d`）：
   *
   * ```
   * [LRC 状态] 方向已定，不再问你。细节在 LRC，需要时 recall。
   * ```
   *
   * 「方向」是上一场会话（做视频）的指代，新会话的模型无从解释 ——
   * 只能把「方向已定」当既定前提，跳过需求确认，或反复追问「什么方向」。
   *
   * ## 缺口已由别处覆盖
   *
   * 它想解决的「重启后读路径为空」，现在由**带会话归属的磁盘快照**
   * 覆盖（见 `bindSnapshotToSession`）：同一会话重启照常恢复，
   * 换会话则正确丢弃。项目级记忆的正确入口是 `lrc_recall` / 主动召回注入，
   * 那里天然带查询语义，模型知道「这是检索结果」而不是「我的状态」。
   *
   * 因此这里退化为**只做可用性探测**：确认索引服务在，便于 `lrc_status`
   * 排障，但绝不把跨会话记忆打扮成会话状态。
   */
  async function bootstrapSnapshot(): Promise<void> {
    const client = connection.peek();
    if (client === null) return;
    try {
      const index = await client.index(config.project, 3);
      ctx.logger.info(
        `[lrc] 项目索引可用（${index.total} 条）。注意：跨会话记忆不注入为 [LRC 状态]，` +
          `需要时用 lrc_recall 或开启 recallInjectEnabled`,
      );
    } catch {
      // 索引不可用不影响对话
    }
  }

  /**
   * 工具层取连接：未就绪时**当场重试一次**（受退避约束），并给出可读原因。
   *
   * 这是本次修复的关键：以前工具直接 `if (client === null) return 未就绪`，
   * 等于把「启动那一瞬间的状态」当成永久事实。现在每次调用都有机会自愈。
   *
   * @returns 客户端，或说明为何不可用的文案
   */
  async function acquireClient(): Promise<{ client: LrcClient } | { reason: string }> {
    const client = await connection.get();
    if (client !== null) return { client };
    const status = connection.status();
    const wait = Math.ceil(status.retryInMs / 1000);
    return {
      reason:
        `LRC 暂时不可用：${status.lastError ?? '未知原因'}` +
        (wait > 0 ? `（约 ${wait}s 后自动重试）` : ''),
    };
  }

  /**
   * 热路径统一的失败处理：连接类错误作废连接，其余原样返回原因。
   *
   * 抽出来是为了让 4 个工具的行为完全一致 —— 否则又会各自漂移，
   * 这次的问题正是「同一类缺陷在 6 处各写一遍」。
   */
  function noteToolFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (isConnectionError(error)) {
      connection.invalidate(message);
      offloader?.bind(null);
      ctx.logger.warn(`[lrc][tool] 连接失效，已标记重连：${message}`);
    }
    return message;
  }

  /**
   * 刷新「相关记忆」注入。
   *
   * # 为什么要有这一层
   *
   * 实测（379 步真实会话）模型**从未想起**调用 `lrc_recall` ——
   * 系统提示写了"涉及历史先调 lrc_recall"，工具也注册了，但它的注意力
   * 全在当前任务上，记忆检索没进候选集。这不是"规则不够硬"，是
   * **决策点本身就该被消除**：由插件把记忆推进去。
   *
   * # 三道防护（缺一不可）
   *
   * 1. **话题指纹去重**：同一话题的多轮追问（"先做A"→"A好了"→"继续"）
   *    指纹相同 ⇒ 完全不重算、不改文本 ⇒ 缓存不受影响。
   * 2. **失败不清空**：查询失败时保留上一次的 recallText。
   *    清空会让文本变化（反而伤缓存），且丢了本来有效的信息。
   * 3. **无结果不注入**：返回空串时保持 recallText=''，
   *    此时注入文本一个字符都不变，等同"没开这个功能"。
   */
  async function refreshRecallInjection(rawQuery: unknown): Promise<void> {
    // maxItems=0 是「显式不要注入」：连检索都不该发，省一次 HTTP 往返
    if (!recallInjectOn || recallOptions.maxItems <= 0) return;

    const query = textBlocksOnly(rawQuery).trim();
    if (query.length === 0) return;

    // 传 previous：让"继续/然后呢"这类续接短句沿用上一指纹，不打断缓存
    const fingerprint = topicFingerprint(query, recallFingerprint);
    if (fingerprint.length === 0) return;
    // 同一话题：完全不动作（这是缓存友好的核心）
    if (fingerprint === recallFingerprint) return;

    // 并发闸门：用户连发两条不同话题时，两次 recall 会同时在飞。
    // 若不加代次校验，先发的慢查询可能后回来，把新话题的注入**覆盖成旧话题**
    // ——模型于是拿到与当前问题无关的记忆，且这个错误会持续到下次换话题。
    const generation = recallGeneration + 1;
    recallGeneration = generation;

    const acquired = await acquireClient();
    if ('reason' in acquired) {
      // 拿不到连接：保留旧文本，等下次用户发言再试
      return;
    }

    try {
      // 截断 query：enrich 不需要长文本，过长反而稀释语义
      const result = await acquired.client.recall(query.slice(0, 200), {
        topK: Math.max(recallOptions.maxItems * 3, 3),
      });
      // 已被更新的一次调用取代：直接丢弃本次结果（连指纹也不写）
      if (generation !== recallGeneration) return;

      const next = formatRecallInjection(result.memories, recallOptions);

      recallFingerprint = fingerprint;
      if (next === recallText) return;

      recallText = next;
      // 计数：注入文本每变一次，宿主的前缀缓存就断一次。
      // 这是评估"注入代价"的唯一实测口径，必须可观测。
      recallRewrites += 1;
      ctx.logger.info(
        next.length === 0
          ? `[lrc] 本轮无相关记忆，不注入（指纹 ${fingerprint}）`
          : `[lrc] 注入 ${result.memories.length} 条候选中的 ${recallOptions.maxItems} 条` +
              `（${next.length} 字符，指纹 ${fingerprint}，累计改写 ${recallRewrites} 次）`,
      );
    } catch (error) {
      // 保留旧值：失败不应让上下文抖动
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        connection.invalidate(message);
        offloader.bind(null);
      }
      ctx.logger.warn(`[lrc] 召回注入失败（保留上次内容）：${message}`);
    }
  }

  /**
   * 执行一次沉淀。
   *
   * `flushing` 是必要的：`agent/pre-step` 与 `turn/end` 可能同时触发，
   * 并发跑两次会把同一段文本写两遍。
   */
  async function flush(session: unknown, reason: string): Promise<void> {
    if (flushing) return;
    if (!offloader.hasPending()) return;
    // 未连接时**保留 pending 计数**，等连上再沉淀。
    // 此前是「offloader 为 null 直接 return」，LRC 一晚启动这批内容就永久丢了。
    if (!offloader.connected) {
      // 顺手触发一次后台重连（不阻塞本步）
      void connection.get();
      return;
    }
    flushing = true;
    try {
      // 用 `''` 而不是 `'default'`：假 ID 会让快照被标成「属于 default」，
      // 而 `bindSnapshotToSession` 拿到的是真实 ID ⇒ 下次启动判定归属不符、
      // 把本会话的快照丢掉。空串让"取不到 ID"这件事显式可辨（见 saveSnapshot）。
      const sessionId = (session as { id?: string })?.id ?? '';
      const lines = linesFromSession(session);
      if (lines.length === 0) {
        // 只警告一次：否则每一步都会刷同一条日志
        if (!warnedEmpty) {
          warnedEmpty = true;
          ctx.logger.warn('[lrc] 会话日志里没有可沉淀的文本行，本次跳过');
        }
        // **长任务中途兜底**：工具密集型轮次里 assistant 只有 reasoning + tool-call，
        // 正文要等到最后一条回答才出现。如果这里直接 return，整轮中途快照永远是空的，
        // `[LRC 状态]` 也就一直不出现。所以从本轮累计推理里抽结论句先沉淀一批。
        const conclusions = conclusionsFromReasoning(turnReasoning.join('\n'));
        if (conclusions.length === 0 && turnReasoning.length > 0 && !warnedNoConclusion) {
          warnedNoConclusion = true;
          ctx.logger.info(
            `[lrc] 推理兜底：本轮推理 ${turnReasoningChars} 字符，未抽到结论句（词表未命中）`,
          );
        }
        if (conclusions.length > 0) {
          try {
            const result = await offloader.offloadItems(itemsFromTag(conclusions.join('\n')));
            if (result.distilled > 0) {
              // ★2026-11-07：只有实质变化才更新快照，避免宿主每轮 append 新 runtime-context
              if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
                // sessionId 用本函数开头捕获的真实值，不用全局 currentSessionId
                saveSnapshot(result.snapshot, sessionId);
              }
              ctx.logger.info(
                `[lrc] 推理兜底沉淀 ${result.distilled} 条（写入 ${result.written}，合并 ${result.merged}` +
                  `${result.deduped > 0 ? `；本地去重 ${result.deduped}` : ''}，触发：${reason}）`,
              );
            }
          } catch (error) {
            ctx.logger.warn(
              `[lrc] 推理兜底沉淀失败（不影响对话）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          // 已消费：清空避免 turn/end 再写一遍
          turnReasoning = [];
          turnReasoningChars = 0;
        }
        // **必须重置计数器**：否则 pendingSteps 会一直累积，
        // 每一步都判定"应当沉淀"并白扫一遍全量日志（实测 60 次重复尝试）。
        offloader.resetCounters();
        return;
      }
      const result = await offloader.offload(sessionId, lines);
      if (result !== null) {
        // 快照回填：下一轮上下文会带上这一行。
        // ★2026-11-07：只有实质变化才更新，避免宿主每轮 append 新 runtime-context。
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          saveSnapshot(result.snapshot, sessionId);
        }
        // LRC 的 `written` 是"成功处理条数"，`merged` 是"其中走合并的条数"，
        // 两者是包含关系，不是互斥的"新增 / 合并"。
        ctx.logger.info(
          `[lrc] 已沉淀 ${result.distilled} 条（写入 ${result.written}，其中合并 ${result.merged}` +
            `${result.deduped > 0 ? `；本地去重 ${result.deduped}` : ''}，触发：${reason}）`,
        );
      }
    } catch (error) {
      // 连接类错误（对端重启/断网）⇒ 作废连接，下次调用会重连。
      // 业务错误（400/422 等）不动连接：那说明服务是活的，掐掉反而误伤。
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        connection.invalidate(message);
        offloader?.bind(null);
        ctx.logger.warn(`[lrc] 沉淀失败，连接已标记失效（下次调用重连）：${message}`);
      } else {
        ctx.logger.warn(`[lrc] 沉淀失败（不影响对话）：${message}`);
      }
    } finally {
      flushing = false;
    }
  }

  /** 重置当前轮状态（turn/start 与 turn/end 都调用，防止漏事件导致串轮）。 */
  function resetTurnState(): void {
    turnHadText = false;
    turnTagSeen = false;
    turnReasoning = [];
    turnReasoningChars = 0;
  }

  /** 单轮累计推理的字符上限：超过就不再收，避免长任务把内存撑爆。 */
  const REASONING_CAP = 20000;

  /**
   * 一轮结束时的收尾：按轮记账 → 主路径沉淀 → 推理兜底。
   *
   * 为什么需要推理兜底：工具密集型轮次里 assistant 只有 reasoning + tool-call，
   * 正文占比 0%，`<lrc_memory>` 标签根本没地方出现。这类轮次只能从推理里
   * 抽带结论标记的句子，否则整轮内容一条都搬不走。
   */
  async function finishTurn(session: unknown): Promise<void> {
    // 1. 按轮记账：只有"本轮有正文"才计入分母
    //
    // ★2026-11-12：标签已改为**可选**（模型 98.2% 的轮次不输出它，
    // 强制要求等于没有要求）。所以这个「命中率」不再是健康指标 ——
    // 长期 0% 是正常的，沉淀改走正文抽取那条路。
    // 两者一起打印，避免看到 0% 就误判成插件坏了。
    if (turnHadText) {
      if (turnTagSeen) turnHits += 1;
      else turnMisses += 1;
      const seen = turnHits + turnMisses;
      if (seen % 20 === 0) {
        ctx.logger.info(
          `[lrc] 沉淀来源：显式标签 ${turnHits}/${seen} 轮，正文抽取命中 ${proseTurns} 条消息` +
            `（另有 ${turnNoText} 轮无正文）`,
        );
      }
    } else {
      turnNoText += 1;
    }

    const hadText = turnHadText;
    const reasoning = turnReasoning.join('\n');
    resetTurnState();

    // 本轮的会话 ID **在 await 之前**捕获：`flush` 内部要等两次 HTTP，
    // 期间用户可能已经切到别的会话，之后再读全局 currentSessionId 就是别人的。
    const sessionId = (session as { id?: string })?.id ?? '';

    // 2. 主路径：正文行（长任务的最终报告只在这里出现一次）
    await flush(session, 'turn/end');

    // 3. 兜底：本轮没有正文时，从推理里抽结论句
    if (hadText || reasoning.length === 0) return;
    const conclusions = conclusionsFromReasoning(reasoning);
    if (conclusions.length === 0) return;
    try {
      const result = await offloader.offloadItems(itemsFromTag(conclusions.join('\n')));
      if (result.distilled > 0) {
        // ★2026-11-07：只有实质变化才更新快照，避免宿主每轮 append 新 runtime-context
        if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
          saveSnapshot(result.snapshot, sessionId);
        }
        ctx.logger.info(
          `[lrc] 推理兜底沉淀 ${result.distilled} 条（写入 ${result.written}，合并 ${result.merged}` +
            `${result.deduped > 0 ? `；本地去重 ${result.deduped}` : ''}）`,
        );
      }
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 推理兜底沉淀失败（不影响对话）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // 订阅会话事件：累计新增文本 + turn 结束时兜底沉淀
  ctx.on('session/event', (session: unknown, event: unknown) => {
    const type = (event as { type?: string })?.type;

    // 会话归属确认：**必须排在所有分支之前**。
    // 快照在构造时就已从磁盘读入（可能是上一个会话的状态），
    // 若在确认归属前就被渲染层取走，新会话就会带着别人的结论开局
    // （实测「方向已定，不再问你」泄漏到新会话）。
    // `session/event` 是能拿到 session.id 的最早入口，故在此收口。
    const sessionId = (session as { id?: string })?.id ?? '';
    bindSnapshotToSession(sessionId);

    if (type === 'turn/start') {
      resetTurnState();
      return;
    }

    // turn 结束：长任务的最终报告只在这里出现一次，必须兜底收走
    if (type === 'turn/end') {
      void finishTurn(session);
      return;
    }

    // 用户发言：刷新「相关记忆」注入（主动推，不依赖模型想起调 lrc_recall）
    //
    // 为什么挂在这里而不是 turn/start：turn/start 时本轮用户消息还没进 log，
    // 拿不到 query。用户消息事件是**最早能拿到 query 的时刻**，
    // 且此时尚未到下一次 LLM 请求，改 recallText 还来得及生效。
    //
    // 必须用 `userMessageText`：`messageContent` 只认 assistant 消息，
    // 对用户消息恒返回 undefined（曾因此让本功能从未触发过）。
    if (type === 'user/message' && isRealUserMessage(event)) {
      void refreshRecallInjection(userMessageText(event));
      return;
    }

    // 只关心助手消息；其余事件（用户消息、工具调用等）直接跳过，
    // 否则会在第一条非 assistant 事件上误报「取不到文本」。
    if (type !== 'assistant/message') return;

    const content = messageContent(event);
    // **口径必须与 linesFromSession 一致**：只取正文块。
    const text = textBlocksOnly(content);
    const reasoning = reasoningBlocksOnly(content);

    if (text.length > 0) {
      turnHadText = true;
      if (extractMemoryTag(text) !== null) turnTagSeen = true;
      offloader.observe(text);

      // ★2026-11-12：**不等 turn 结束**，正文里出现约束/决策就立刻收走。
      //
      // 为什么必须另开一条路：系统提示要求模型每轮输出 `<lrc_memory>`，
      // 实测 56 条正文里只有 1 条带标签（1.8%）。于是沉淀几乎全靠
      // 推理流兜底，抽到的是「CLI 已安装」这类过程记录。
      //
      // 模型其实一直在正文里说约束（「不要用 IDM 下载」「已改用 --stdin」），
      // 只是没按要求的格式重写。这里直接抓它已经说出口的话。
      //
      // 为什么在事件里而不是 turn/end：turn 可能被用户中止（实测 turn 2/3
      // 都是 aborted by user），中止时不会走到轮末兜底，那批约束就丢了。
      const prose = constraintsFromProse(text);
      if (prose.length > 0) {
        // **在同步阶段捕获 sessionId**：下面的 `.then` 是异步的（要等 distill +
        // migrate 两次 HTTP），期间用户可能已切到别的会话。若那时才读
        // `currentSessionId`，会把 A 的约束写成 B 的归属 —— 正是上一轮
        // 在 `flush()` 里修过的同一个坑，不能在新路径上重犯。
        const proseSessionId = sessionId;
        const items = itemsFromTag(prose.join('\n'));

        // **未连接时不直接丢**：`assistant/message` 事件不会被回放，
        // 而 LRC 桌面端比 DSH 晚起 20 分钟是已发生过的真实事故。
        // 那 20 分钟里若直接 catch 掉，这批约束就永久丢了。
        if (!offloader.connected) {
          proseBacklog.push(...items);
          if (proseBacklog.length > PROSE_BACKLOG_MAX) {
            proseBacklog = proseBacklog.slice(-PROSE_BACKLOG_MAX);
          }
          void connection.get();
          return;
        }

        proseTurns += 1;
        // 代次闸门：多条 prose 的 HTTP 往返可能乱序（migrate 超时 20s），
        // 晚完成的那条会用更早的内容覆盖快照 —— 症状是注入内容「倒退」。
        const gen = ++snapshotGeneration;
        void offloader
          .offloadItems(items)
          .then((result) => {
            if (gen !== snapshotGeneration) return; // 有更新的一次在飞，丢弃
            if (result.distilled > 0) {
              if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
                saveSnapshot(result.snapshot, proseSessionId);
              }
              ctx.logger.info(
                `[lrc] 正文抽取 ${result.distilled} 条约束/决策（写入 ${result.written}）`,
              );
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(
              `[lrc] 正文抽取沉淀失败（不影响对话）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    } else if (!warnedShape && hasMalformedTextBlock(content)) {
      // 只有「声明了 text/reasoning 块但 text 不是字符串」才是结构异常。
      // 纯 tool-call 消息本来就没有这两类块，不该报警（实测 39 条误报）。
      warnedShape = true;
      const data = (event as { data?: unknown })?.data;
      const keys =
        data !== null && typeof data === 'object' ? Object.keys(data as object).join(',') : typeof data;
      ctx.logger.warn(`[lrc] assistant/message 文本块结构异常（data 字段：${keys}）`);
    }

    // 累计推理：工具密集型轮次没有正文，轮末从这里抽结论句兜底
    if (reasoning.length > 0 && turnReasoningChars < REASONING_CAP) {
      turnReasoning.push(reasoning);
      turnReasoningChars += reasoning.length;
    }
  });

  // 每步开始前：能力探测（一次）→ 控制器有序执行 → 沉淀检查
  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const agent = (payload as { agent?: unknown })?.agent;
    lastAgent = agent;

    // 能力矩阵：首次探测 + **能力缺失时定期复查**。
    //
    // 为什么不能只探一次：依赖的宿主服务可能是后起的（compaction 在 preset 里
    // 初始化、tokenMeter 随模型切换才就绪）。一次性探测会把"启动那一刻还没准备好"
    // 固化成"整场会话不可用"，于是裁剪/剪枝永久停摆，上下文一路涨。
    if (!probed) {
      probed = true;
      try {
        governor.capabilities = probeCapabilities(ctx, agent);
        for (const line of formatCapabilities(governor.capabilities)) ctx.logger.info(line);
      } catch (error) {
        ctx.logger.warn(
          `[lrc][cap] 能力探测异常：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (
      capabilityRecheckSteps > 0 &&
      governor.steps > 0 &&
      governor.steps % capabilityRecheckSteps === 0
    ) {
      // 只复查「当前判定为不可用」的项：已可用的没必要反复探（省开销且更稳）
      const before = governor.capabilities;
      const needsRecheck =
        before === null ||
        !before.compaction.available ||
        !before.tokenMeter.available ||
        !before.toolResultPruner.available;
      if (needsRecheck) {
        try {
          const after = probeCapabilities(ctx, agent);
          governor.capabilities = after;
          const recovered: string[] = [];
          if (before !== null && !before.compaction.available && after.compaction.available) {
            recovered.push('compaction');
          }
          if (before !== null && !before.tokenMeter.available && after.tokenMeter.available) {
            recovered.push('tokenMeter');
          }
          if (
            before !== null &&
            !before.toolResultPruner.available &&
            after.toolResultPruner.available
          ) {
            recovered.push('toolResultPruner');
          }
          if (recovered.length > 0) {
            ctx.logger.info(`[lrc][cap] 复查后恢复可用：${recovered.join('、')}`);
          }
        } catch {
          // 复查失败保持原判，不影响本步
        }
      }
    }
    const caps = governor.capabilities;

    // 统一预算：按模型窗口比例推导阈值。
    //
    // ## 为什么按固定步数复查，而不是「只在 fallback 时复查」
    //
    // 原逻辑：只有 `source === 'fallback'` 才复查。它默认「一旦拿到可信窗口，
    // 窗口就不会变」——但用户**随时可以换模型**（1M 的 flash ↔ 128K 的小模型），
    // 换完窗口就完全不同，而预算永远停在旧值：
    // - 1M → 128K：阈值仍是按 1M 算的 100000，128K 窗口永远到不了 ⇒ **一次都不裁**；
    // - 128K → 1M：阈值 12800 ⇒ 每步都裁 ⇒ 缓存全废（本轮的实测事故就是这个量级）。
    //
    // 所以按步数定期复查所有来源，并在「窗口或来源变化」时打日志。
    // 复查成本很低：`requestHeader()` 是同步读取，只在没声明窗口时才走异步探测。
    if (
      budget === null ||
      (budgetRecheckSteps > 0 && governor.steps % budgetRecheckSteps === 0)
    ) {
      try {
        const resolved = await resolveBudget({
          ctx,
          agent,
          config: {
            contextWindowTokens: config.contextWindowTokens,
            trimRatio: config.trimRatio,
            pruneRatio: config.pruneRatio,
            trimMinTokens: config.trimMinTokens,
            pruneResultThreshold: config.pruneResultThreshold,
          },
        });
        if (budget === null || resolved.source !== budget.source || resolved.windowTokens !== budget.windowTokens) {
          ctx.logger.info(formatBudget(resolved));
        }
        budget = resolved;
      } catch (error) {
        ctx.logger.warn(
          `[lrc][budget] 预算解析失败，使用配置绝对值：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const trimMinTokens = budget?.trimMinTokens ?? config.trimMinTokens;
    const pruneResultThreshold = budget?.pruneResultThreshold ?? config.pruneResultThreshold;

    const actions: GovernorAction[] = [
      {
        name: 'prune-results',
        enabled: config.pruneEnabled && (caps === null || caps.toolResultPruner.available),
        run: () => {
          const outcome = pruneToolResults({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            thresholdChars: pruneResultThreshold,
          });
          return { ok: outcome.ok, reason: outcome.reason };
        },
      },
      {
        name: 'prune-args',
        enabled: config.pruneArgsEnabled,
        run: () => {
          const outcome = pruneToolCallArguments({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            options: {
              thresholdChars: config.pruneArgsThreshold,
              headChars: config.pruneArgsHead,
              keepRecentNodes: config.keepRecentNodes,
            },
          });
          return { ok: outcome.ok, reason: outcome.reason };
        },
      },
      {
        name: 'prune-reasoning',
        enabled: config.pruneReasoningEnabled,
        run: () => {
          const outcome = pruneReasoning({
            ctx,
            agent,
            log: (message) => ctx.logger.info(message),
            options: { keepRecentNodes: config.keepRecentNodes },
          });
          return { ok: outcome.ok, reason: outcome.reason };
        },
      },
      {
        name: 'trim',
        enabled:
          config.trimEnabled &&
          (caps === null || (caps.compaction.available && caps.tokenMeter.available)),
        throttleSteps: config.trimMinSteps,
        run: async () => {
          // 节点数硬上限：不依赖 token 计量，作为「阈值失真」时的兜底触发
          const surfaceNodes = (agent as { session?: { surface?: { nodes?: unknown } } })?.session
            ?.surface?.nodes;
          const nodeCount = Array.isArray(surfaceNodes) ? surfaceNodes.length : 0;
          const force = nodeCount > config.trimMaxNodes;
          if (force) {
            ctx.logger.info(
              `[lrc][trim] 节点数 ${nodeCount} 超过上限 ${config.trimMaxNodes}，跳过 token 阈值强制裁剪`,
            );
          }
          const outcome = await trimContext({
            ctx,
            agent,
            signal: (payload as { signal?: AbortSignal })?.signal,
            options: {
              minTokens: trimMinTokens,
              keepRecentNodes: config.keepRecentNodes,
              maxSummaryChars: config.trimMaxSummaryChars,
              force,
              // 用归一化后的值：宿主 patch 通常不含该字段，直接用会退化为旧行为
              maxNodesPerRun: force ? trimMaxNodesPerRun : undefined,
            },
            log: (message) => ctx.logger.info(message),
          });
          // 非异常原因（below-threshold / no-range）每种只记一次
          if (!outcome.ok && !outcome.reason.startsWith('error')) {
            if (!trimReasonsLogged.has(outcome.reason)) {
              trimReasonsLogged.add(outcome.reason);
              ctx.logger.info(
                `[lrc][trim] 未裁剪：${outcome.reason}` +
                  `${outcome.detail === undefined ? '' : `（${outcome.detail}）`}`,
              );
            }
          }
          return {
            ok: outcome.ok,
            reason: outcome.reason,
            detail: outcome.summaryStats ?? outcome.detail,
          };
        },
      },
    ];

    await runGovernor({
      state: governor,
      actions,
      log: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    });

    // 上下文画像：每 10 步打一行，哪一类在膨胀能立刻看出来
    if (governor.steps % 10 === 0) {
      try {
        ctx.logger.info(formatProfile(profileSurface((agent as { session?: unknown })?.session)));
      } catch {
        // 画像失败不影响对话
      }
    }

    offloader.observeStep();
    if (offloader.shouldOffload()) {
      const session = (payload as { agent?: { session?: unknown } })?.agent?.session;
      // **不 await**：沉淀要走 distill + migrate 两次 HTTP，
      // 阻塞在这里会让模型调用前多等几百毫秒。`flushing` 已保证不并发。
      void flush(session, 'threshold');
    }
    const decision = await next();
    // ★2026-11-07（缓存命中率）：把 runtime-context 快照移到当前用户消息**之前**。
    //
    // 宿主默认把 runtime-context 作为一条 user 消息 append 在 claimed 消息之后
    // （见 dsh-agent-loop 的 step()：先 append 用户消息，再 append context）。
    // 这样快照落在用户提问之后，且每轮都会在历史中间留下一条。
    //
    // 这里只调整 `decision.messages` 里 runtime-context 标记的位置：
    // 宿主遇到该标记时会把**整块** runtime-context 插到标记处，因此把它移到
    // 队首即可让快照紧挨在用户提问之前，历史前缀（system + 旧对话）完全不变。
    if (decision !== null && typeof decision === 'object') {
      const d = decision as { kind?: string; messages?: unknown };
      if (d.kind === 'enter' && Array.isArray(d.messages)) {
        const messages = d.messages as Array<{ source?: { kind?: string } }>;
        const ctxIdx = messages.findIndex((m) => m?.source?.kind === 'runtime-context');
        if (ctxIdx > 0) {
          const [ctx] = messages.splice(ctxIdx, 1);
          messages.unshift(ctx);
        }
      }
    }
    return decision;
  });

  /**
   * 注册工具，失败只告警不抛错。
   *
   * `defineTool()` 在**参数求值阶段**就会校验 schema（例如参数上写
   * `required: false` 会抛 JsonSchemaError）。如果直接写成
   * `ctx.tools.register(defineTool(...))`，异常会掀翻整个 apply()，
   * 连沉淀、剪枝、事件监听一起停摆（实测回归）。
   * 所以把 `defineTool` 的调用也包进 try。
   */
  function registerTool(name: string, factory: () => unknown): void {
    try {
      ctx.tools.register(factory() as never);
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 工具 ${name} 注册失败（不影响沉淀与剪枝）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // 手动触发工具
  registerTool('lrc_remember_now', () =>
    defineTool({
      name: 'lrc_remember_now',
      description:
        '立即把当前对话的结论沉淀到 LRC 长期记忆库。' +
        '用于用户要求"把这段记下来"或上下文即将变长时。返回一行状态快照。',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: '要沉淀的对话原文（可含多轮，按换行分隔）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            snapshot: { type: 'string', required: true },
            distilled: { type: 'number', required: true },
            written: { type: 'number', required: true },
            merged: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: { snapshot: string }) => [
          { type: 'text', text: value.snapshot },
        ],
      },
      async execute(args: { text: string }) {
        const acquired = await acquireClient();
        if ('reason' in acquired) {
          return { snapshot: acquired.reason, distilled: 0, written: 0, merged: 0 };
        }
        const { client } = acquired;
        try {
          // 与自动沉淀路径保持一致：标签内容直接成条目，**绕过 distill**。
          // 否则 `- 决策：…` 会被 LRC 的规则式打分丢掉（DECISION_WORDS 无「决策」）。
          const tag = extractMemoryTag(args.text);
          if (tag !== null) {
            if (isNoUpdate(tag)) {
              return { snapshot: '本轮无新增，未沉淀', distilled: 0, written: 0, merged: 0 };
            }
            const items = itemsFromTag(tag);
            const migrated = await client.migrate(items, config.project);
            ctx.logger.info(
              `[lrc][tool] lrc_remember_now 沉淀 ${items.length} 条（写入 ${migrated.written}，合并 ${migrated.merged}）`,
            );
            return {
              snapshot: `已沉淀 ${items.length} 条（写入 ${migrated.written}，其中合并 ${migrated.merged}）`,
              distilled: items.length,
              written: migrated.written,
              merged: migrated.merged,
            };
          }
          const result = await client.migrateText(args.text, config.project, config.maxItems);
          ctx.logger.info(
            `[lrc][tool] lrc_remember_now 沉淀 ${result.distilled} 条（写入 ${result.written}，合并 ${result.merged}）`,
          );
          return {
            snapshot: result.indexLine,
            distilled: result.distilled,
            written: result.written,
            merged: result.merged,
          };
        } catch (error) {
          return {
            snapshot: `本次未沉淀：${noteToolFailure(error).slice(0, 160)}`,
            distilled: 0,
            written: 0,
            merged: 0,
          };
        }
      },
    }),
  );

  // 读路径：DSH 没有 MCP 客户端，AI 看不到 LRC 的 `recall` 工具，
  // 只能通过这个原生工具把记忆读回来。没有它，插件就是纯单向写入器。
  //
  // 召回结果的统一措辞：日志与返回文本**共用同一函数**，避免两处漂移。
  // `total` 是三路（fast/deep/semantic）候选并集、**融合前**，随库状态变化，
  // 既不是「匹配数」也不是「删除量」——必须显式标注「融合前」，否则会被误读。
  const describeRecall = (returned: number, total: number): string =>
    `召回 ${returned} 条（三路候选 ${total} 条，融合前；已折叠近重复）`;
  registerTool('lrc_recall', () =>
    defineTool({
      name: 'lrc_recall',
      description:
        '从 LRC 长期记忆库检索相关记忆。涉及项目历史、用户偏好、之前做过的决定、' +
        '上次怎么改的，先调这个工具，不要直接 Grep 或翻文件。' +
        '返回按相关度排序的记忆条目（已做近重复折叠）。',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '自然语言查询，如「上次那个检索接口怎么改的」',
        },
        top_k: {
          type: 'number',
          description: '返回条数，默认 5，最大 20',
        },
        project: {
          type: 'string',
          description: '按项目过滤（可选，缺省搜全部项目）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            count: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { query: string; top_k?: number; project?: string }) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (query.length === 0) {
          return { text: 'lrc_recall 需要非空的 query。', count: 0 };
        }
        // 每次调用都尝试取连接（受退避约束），而不是沿用启动瞬间的判定。
        // 这是本次事故的直接修复点：以前这里只看一次 client 是否为 null。
        const acquired = await acquireClient();
        if ('reason' in acquired) {
          return { text: `${acquired.reason}。可先用内置搜索。`, count: 0 };
        }
        const { client } = acquired;
        try {
          const topK = Math.min(Math.max(args.top_k ?? 5, 1), 20);
          const result = await client.recall(query, {
            topK,
            // 缺省不按项目过滤：插件沉淀写 config.project，手工 remember 可能写别的项目，
            // 过滤会漏掉一半。需要收窄时由调用方显式传 project。
            project: args.project,
          });
          // 工具调用必须可观测：此前 recall 无任何日志，排查时看不到它是否被调用。
          ctx.logger.info(
            `[lrc][tool] lrc_recall "${query}" → ${describeRecall(result.memories.length, result.total)}`,
          );
          if (result.memories.length === 0) {
            return { text: 'LRC 未命中，可回退内置搜索。', count: 0 };
          }
          const lines = result.memories.map((m, i) => {
            const rel = Math.round((m.score_norm ?? 0) * 100);
            const kind = m.memory_type ?? 'fact';
            // 带上 id：AI 发现某条是错的时，用 lrc_forget 精确撤回
            return `（记忆 #${i + 1} · 相关度 ${rel}% · ${kind} · id=${m.id}）\n${m.content}`;
          });
          return {
            text:
              `LRC ${describeRecall(result.memories.length, result.total)}：\n\n` +
              lines.join('\n\n'),
            count: result.memories.length,
          };
        } catch (error) {
          return { text: `LRC 召回失败：${noteToolFailure(error).slice(0, 200)}`, count: 0 };
        }
      },
    }),
  );

  // 纠错路径：AI 发现某条记忆是错的（例如把「没找到」误写成「不存在」），
  // 必须能撤回，否则错误结论会被持续召回、污染后续所有对话。
  registerTool('lrc_forget', () =>
    defineTool({
      name: 'lrc_forget',
      description:
        '删除一条错误的 LRC 记忆。当 lrc_recall 返回的某条记忆与事实不符' +
        '（例如把「没找到」误写成「不存在」、把旧结论当成现状），用这个工具撤回。' +
        'memory_id 从 lrc_recall 的输出里取。',
      parameters: {
        memory_id: {
          type: 'string',
          required: true,
          description: '要删除的记忆 ID（lrc_recall 输出里的 id=...）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            deleted: { type: 'boolean', required: true },
          },
        },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { memory_id: string }) {
        const memoryId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
        if (memoryId.length === 0) {
          return { text: 'lrc_forget 需要非空的 memory_id。', deleted: false };
        }
        const acquired = await acquireClient();
        if ('reason' in acquired) {
          return { text: acquired.reason, deleted: false };
        }
        const { client } = acquired;
        try {
          const result = await client.forget(memoryId);
          // 工具调用必须可观测：删除是纠错闭环的关键一步，必须留痕。
          ctx.logger.info(
            `[lrc][tool] lrc_forget ${memoryId} → ${
              result.deleted ? '已删除' : result.alreadyDeleted ? '幂等不存在' : '未删除'
            }`,
          );
          if (result.deleted) {
            return { text: `已删除记忆 ${memoryId}。`, deleted: true };
          }
          if (result.alreadyDeleted) {
            return { text: `记忆 ${memoryId} 已不存在（幂等）。`, deleted: true };
          }
          return { text: `记忆 ${memoryId} 未删除（服务端返回 deleted=false）。`, deleted: false };
        } catch (error) {
          return { text: `LRC 删除失败：${noteToolFailure(error).slice(0, 200)}`, deleted: false };
        }
      },
    }),
  );

  // 路径 6：会话交接（新建会话 + 摘要注入）
  //
  // 显式工具而非自动触发：新建会话会改变用户的工作现场，
  // 自动判断失误会让用户突然发现自己在另一个会话里。
  registerTool('lrc_handoff', () =>
    defineTool({
      name: 'lrc_handoff',
      description:
        '把当前会话整理成交接摘要，并新建一个会话注入该摘要（原会话保留）。' +
        '用于上下文接近上限、需要另起炉灶继续同一任务时。',
      parameters: {
        // **不要写 `required: false`**：DSH 的 defineTool 规定参数上的
        // `required` 只要出现就必须是 `true`，省略该键才表示可选。
        // 写成 false 会抛 JsonSchemaError，把整个 apply() 掀翻（实测回归）。
        note: {
          type: 'string',
          description: '给接手方的下一步说明（可选）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            sessionId: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: { ok: boolean; sessionId: string; mode: string; text: string }) => [
          {
            type: 'text',
            text:
              (value.ok
                ? `已创建交接会话（${value.mode}）：${value.sessionId}`
                : '未能创建新会话，仅返回交接摘要') + `\n\n${value.text}`,
          },
        ],
      },
      async execute(args: { note?: string }) {
        const session = (lastAgent as { session?: unknown } | undefined)?.session;
        const source = extractHandoffSource(session);

        // LRC 归档索引：拿不到就跳过，不影响交接
        let indexLines: string[] = [];
        const client = connection.peek();
        if (client !== null) {
          try {
            const index = await client.index(config.project, 10);
            indexLines = index.items.map((item) => item.content_preview);
          } catch {
            // 忽略：索引只是锦上添花
          }
        }

        const text = buildHandoffText({
          lastUserRequest: source.lastUserRequest,
          recentAssistant: source.recentAssistant,
          snapshot: latestSnapshot,
          indexLines,
          note: args.note ?? '',
        });

        const result = await createHandoffSession({
          ctx,
          agent: lastAgent,
          text,
          log: (message) => ctx.logger.info(message),
        });

        ctx.logger.info(
          `[lrc][tool] lrc_handoff → ${result.ok ? '已创建交接会话' : '仅返回摘要'}（${result.mode}）`,
        );
        return {
          ok: result.ok,
          sessionId: result.sessionId ?? '',
          mode: result.mode,
          text: result.text,
        };
      },
    }),
  );

  // 状态自检：把能力矩阵、熔断状态、计数器直接暴露出来，
  // 不用再靠翻日志和手工跑探针。
  registerTool('lrc_status', () =>
    defineTool({
      name: 'lrc_status',
      description:
        '查看 LRC 插件的运行状态：能力矩阵（哪些路径可用）、各动作执行次数与熔断状态、' +
        '当前配置阈值、快照是否存在。排查"为什么没生效"时先调这个。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        ctx.logger.info('[lrc][tool] lrc_status 调用');
        const lines: string[] = ['# LRC 状态', ''];

        lines.push('## 能力矩阵');
        if (governor.capabilities === null) {
          lines.push('尚未探测（还没有走过一步）');
        } else {
          lines.push(...formatCapabilities(governor.capabilities));
        }
        lines.push('');

        lines.push('## 动作状态');
        lines.push(formatGovernorState(governor));
        lines.push('');

        lines.push('## 连接');
        {
          const conn = connection.status();
          const rt = runtime.status();
          const stateText =
            conn.state === 'ready'
              ? '已连接'
              : conn.state === 'failed'
                ? `未连接（${conn.lastError ?? '未知原因'}）`
                : '尚未尝试';
          lines.push(
            `- LRC 连接：${stateText}` +
              (conn.state === 'ready'
                ? ''
                : `｜重试倒计时 ${Math.ceil(conn.retryInMs / 1000)}s（退避 ${Math.round(conn.lastBackoffMs / 1000)}s）`),
          );
          lines.push(
            `- 累计：成功 ${conn.successes} 次 / 失败 ${conn.failures} 次（连续 ${conn.consecutiveFailures}）`,
          );
          lines.push(
            `- 运行时：${rt.mode}｜连续降级 ${rt.degradeCount} 次｜下次重探 ${Math.ceil(rt.retryInMs / 1000)}s`,
          );
          if (conn.lastError !== undefined && conn.state !== 'ready') {
            lines.push(`- 最近错误：${conn.lastError}`);
          }
        }
        lines.push('');

        lines.push('## 上下文画像');
        try {
          lines.push(formatProfile(profileSurface((lastAgent as { session?: unknown } | undefined)?.session)));
        } catch {
          lines.push('不可用');
        }
        lines.push('');

        lines.push('## 沉淀');
        {
          const stats = offloader.stats();
          // 未连接时 pending 只增不减是**预期行为**（等连上再沉淀），要显式说明，
          // 否则会被误读成"卡住了"。
          if (!offloader.connected) {
            lines.push('连接未就绪：本轮新增内容已计入待沉淀队列，连上后会自动补写。');
          }
          lines.push(
            `累计 ${stats.flushCount} 次：新写入 ${stats.totalWritten} 条 / 合并 ${stats.totalMerged} 条` +
              ` / 本地查重拦下 ${stats.totalDeduped} 块`,
          );
          lines.push(
            stats.lastFlushAt === 0
              ? '最近一次：尚未沉淀'
              : `最近一次：${new Date(stats.lastFlushAt).toISOString()}` +
                  `（写入 ${stats.lastFlushWritten} / 合并 ${stats.lastFlushMerged}）`,
          );
          lines.push(`查重窗口：${stats.recentWindow} 块`);
        }
        lines.push('');

        lines.push('## 预算');
        lines.push(budget === null ? '尚未解析' : formatBudget(budget));
        lines.push('');

        lines.push('## 配置');
        lines.push(
          [
            `prune=${config.pruneEnabled}（阈值 ${budget?.pruneResultThreshold ?? config.pruneResultThreshold} 字符）`,
            `pruneArgs=${config.pruneArgsEnabled}（阈值 ${config.pruneArgsThreshold} 字符）`,
            `pruneReasoning=${config.pruneReasoningEnabled}（保留最近 ${config.keepRecentNodes} 节点）`,
            `trim=${config.trimEnabled}（阈值 ${budget?.trimMinTokens ?? config.trimMinTokens} tokens，每 ${config.trimMinSteps} 步，节点上限 ${config.trimMaxNodes}）`,
            `offload=${config.offloadTurns} 轮 / ${config.offloadChars} 字符 / ${config.offloadSteps} 步`,
          ].join('\n'),
        );
        // 宿主**不会**为老 patch 自动补齐新配置项（`cordis.patch.yml` 里
        // 没写的字段在 apply 时就是 undefined）。因此「有这个开关」和
        // 「用户能打开它」是两件事：不给出文件路径与可粘贴片段，
        // 用户就永远不知道该怎么启用（实测新会话 0 次注入，正是因为
        // 真实 patch 里没有 recallInjectEnabled 这一行）。
        if (!recallInjectOn) {
          // 路径从 `cacheDir` 反推，不能直接 `DSH_HOME ?? homedir()`：
          // 本机实测 `DSH_HOME` 未设置、`homedir()` 是 `C:\Users\Administrator`，
          // 而 DSH 真实 home 是 `D:\Users\.dsh`（由 DSH NEXT 的
          // `desktop-next-location.json` 指向）。
          // C 盘那个同名目录**确实存在**且含 cordis.patch.yml，但里面没有
          // dsh-plugin-lrc 段 —— 照它改，改完重启什么都不会发生。
          // `cacheDir` 已由宿主 HOME 推导且实测落盘正确，上溯两级最可靠。
          const dshHome = dirname(dirname(cacheDir));
          const patchPath = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
          lines.push('');
          lines.push('### 主动召回注入未启用');
          lines.push(
            `在 \`${patchPath}\` 的 \`id: dsh-plugin-lrc\` → \`config:\` 下补以下四行，然后重启 DSH：`,
          );
          lines.push('```yaml');
          lines.push('        recallInjectEnabled: true');
          lines.push('        recallInjectMaxItems: 2');
          lines.push('        recallInjectMinScore: 0.5');
          lines.push('        recallInjectMaxCharsPerItem: 80');
          lines.push('```');
          lines.push('（上溯路径来自本插件实际使用的缓存目录；多 profile 时请确认当前 profile 名。）');
        }
        lines.push('');

        lines.push('## 快照');
        lines.push(
          latestSnapshot.length > 0
            ? `已存在（${latestSnapshot.length} 字符）${snapshotServed ? '，已被渲染层取走' : '，尚未被取走'}`
            : '为空（还没有成功沉淀过）',
        );
        lines.push('');

        lines.push('## 主动召回注入');
        if (!recallInjectOn) {
          lines.push('已关闭（recallInjectEnabled=false）');
        } else {
          lines.push(
            recallText.length > 0
              ? `已注入 ${recallText.length} 字符｜指纹 ${recallFingerprint}`
              : `本轮无匹配，未注入｜指纹 ${recallFingerprint || '(空)'}`,
          );
          lines.push(
            `配置：最多 ${recallOptions.maxItems} 条｜阈值 ${recallOptions.minScore}` +
              `｜单条 ${recallOptions.maxCharsPerItem} 字符｜总长 ${recallOptions.maxTotalChars}`,
          );
          lines.push(`累计改写 ${recallRewrites} 次（每次改写会打断一次前缀缓存）`);
          if (recallText.length > 0) {
            lines.push('内容：');
            for (const line of recallText.split('\n')) lines.push(`  ${line}`);
          }
        }

        return { text: lines.join('\n') };
      },
    }),
  );
}
