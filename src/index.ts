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
import { LrcClient, type DistilledItem, type RecallItem } from './lrc-client.ts';
import { Recoverable, isConnectionError } from './recoverable.ts';
import {
  normalizeRecallOptions,
  formatRecallInjection,
  isHistoryQuery,
  topicFingerprint,
} from './recall-injection.ts';
import { CursorStore, RecentStore, snapshotChanged } from './cursor.ts';
import { Offloader } from './offloader.ts';
import {
  hasMalformedTextBlock,
  isRealUserMessage,
  linesWithOrigin,
  messageContent,
  reasoningBlocksOnly,
  textBlocksOnly,
  userMessageText,
} from './session-text.ts';
import { areNearDuplicate, extractMemoryTag } from './memory-filter.ts';
import {
  attachTopic,
  extractFacts,
  extractFactsFromReasoning,
  factsFromLlmLines,
} from './memory-extract.ts';
import { factKey, factsToItems, makeArtifactFact, renderFact, validateFact, type MemoryFact } from './memory-schema.ts';
import {
  DEFAULT_MAX_NODES_PER_RUN,
  normalizeMaxNodes,
  pruneReasoning,
  pruneToolCallArguments,
  pruneToolResults,
  trimContext,
} from './context-trim.ts';
import { buildHandoffText, createHandoffSession, extractHandoffSource } from './handoff.ts';
import { projectHandoff } from './handoff-projection.ts';
import {
  buildMinutes,
  canOverwriteMinutes,
  minutesEventId,
  MinutesLedgerStore,
  parseMinutesTurns,
  shouldRewriteMinutes,
  writeMinutes,
  type MinutesLedgerState,
  type TurnRecord,
} from './session-minutes.ts';
import { ArtifactStore, isArtifactWorthy } from './artifact-store.ts';
import { extractWithLlm, shouldFallbackToLlm } from './llm-extract.ts';
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
  /** 相对分下限（0–1，`score_norm`，top1 恒为 1.0） */
  recallInjectMinScore: number;
  /** 绝对分下限（`score`，RRF 融合原始分，实测量级 0.016–0.032） */
  recallInjectMinRawScore: number;
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: number;
  /**
   * 碎片前缀判据（正则源码，空串 = 关闭）。
   *
   * 实测 dsh 项目 92% 的记忆是未折叠碎片，会挤占 top2 注入槽位。
   * 判据是「以悬空词开头」（主语被切掉），不是长度 —— 长度会误伤
   * 「用户偏好纸质拼贴风格」这类完整短句。
   */
  recallInjectFragmentPrefixes: string;
  /** 碎片豁免的重要性门槛（1–10）。够重要就不受前缀判据限制。 */
  recallInjectFragmentExemptImportance: number;
  /**
   * 规则抽不到关键信息时，是否用一次独立模型调用兜底。
   *
   * 默认关闭：这是**唯一会额外产生模型请求**的路径，必须由用户显式开启。
   * 开启后仍受下面三项配额约束。
   */
  llmExtractEnabled: boolean;
  /** 会话级最大兜底调用次数（0 = 不限制） */
  llmExtractMaxCalls: number;
  /**
   * **进程级**最大兜底调用次数（0 = 不限制）。
   *
   * 会话配额是按桶独立的，多窗口场景下总量会成倍放大（21 个会话 × 40 次
   * = 840 次）。而且会话桶会因 Map 上限被淘汰重建，单靠它约束不住进程总量。
   * 这是最终的硬上限：打满后任何会话都不再兜底。
   */
  llmExtractGlobalMaxCalls: number;
  /** 两次兜底调用之间的最小间隔（毫秒） */
  llmExtractMinIntervalMs: number;
  /** 正文短于此长度不触发兜底（碎片不值得单独问一次） */
  llmExtractMinChars: number;
  /** 单次发送给兜底模型的正文上限（字符，超出取尾部） */
  llmExtractMaxInputChars: number;

  // ── 同批折叠（★2026-11-16）──
  //
  // ## 这些字段必须与 `Config` Schema 一一对应（2026-11-17 引入 tsc 后暴露）
  //
  // 旧版 `Config` 接口只声明了前 30 个字段，后面 8 项（fold / minutes /
  // artifact 三组）只写在 Schema 里。运行期没问题（Schema 决定默认值），
  // 但类型层看不见它们 ⇒ `config.foldEnabled` 之类只能靠 `any` 隐式通过，
  // 拼错字段名不会被任何检查拦住。
  /** 是否启用同批折叠（一批 N 条碎片压成 1 条摘要） */
  foldEnabled: boolean;
  /** 低于多少条不折叠 */
  foldMinFacts: number;
  /** 折叠摘要的字符上限 */
  foldMaxChars: number;

  // ── 会话纪要（★2026-11-17）──
  /** 是否生成会话纪要 */
  minutesEnabled: boolean;
  /** 每满多少轮写一次纪要 */
  minutesEveryTurns: number;
  /** 空闲多少毫秒后强制落一次纪要（0 = 关闭空闲触发） */
  minutesIdleMs: number;
  /**
   * 一轮尚未结束时的**阶段写入**间隔（毫秒，0 = 关闭）。
   *
   * 实测单轮可跑 30 分钟以上、70+ 步（工具密集型任务），
   * 期间 `turn/end` 一直不来 ⇒ 整轮没有任何纪要可回溯。
   */
  minutesStageMs: number;

  // ── 工件库 ──
  /** 是否启用长文本落盘 */
  artifactEnabled: boolean;
  /** 超过多少字符才落盘 */
  artifactMinChars: number;
  /** 工件库磁盘配额（MB） */
  artifactQuotaMb: number;
}

export const Config: Schema = Schema.object({
  baseUrl: Schema.string().default(''),
  token: Schema.string().default(''),
  project: Schema.string().default('dsh'),
  offloadTurns: Schema.number().default(4),
  offloadChars: Schema.number().default(6000),
  // 20 步对工具密集型轮次太晚：实测 16 步的会话一次都没触发，
  // 快照始终为空。降到 8 步，让中途也能沉淀出 `[LRC 状态]`。
  offloadSteps: Schema.number().default(8),
  maxItems: Schema.number().default(40),
  // ★2026-11-16：同批折叠。实测一个会话写入 1515 条、长度中位数仅 33 字，
  // 19.3% ≤ 20 字 —— 抽取器是句子级的，同一次推理被切成一串互不相关的碎片。
  // 开启后同一批（一次 flush）的 N 条先压成 1 条摘要再入库，原文仍进工件库。
  foldEnabled: Schema.boolean().default(true),
  // 低于 4 条不折叠：2~3 条本就是一次完整表述，折叠反而损失精度。
  foldMinFacts: Schema.number().default(4),
  // 摘要字符上限：正常批次（10~14 条 × 35 字）约 500 字，远低于此值，
  // 该上限只用于挡住异常长的批次（如一次贴进整份报告）。
  foldMaxChars: Schema.number().default(2000),
  // ── 会话纪要（★2026-11-17）──
  //
  // ## 为什么纪要必须单独做，不能复用压缩摘要（实测）
  //
  // 把 247 次 compaction 的摘要全存进库：966,414 字符，其中 **92% 是工具调用
  // 回显**；剩下的「助手结论」段 1161 条、p50 仅 27 字，含因果理由的比例
  // 11.5% —— 反而低于正文直抽（15.4%）。所以纪要要**重新生成**。
  //
  // ## 一份对话一份纪要
  //
  // `event_id = session-minutes:<sessionId>` 恒定；两侧（插件写入闸门 +
  // LRC 内容相似度合并）共同保证库里恒为 1 条完整纪要。
  minutesEnabled: Schema.boolean().default(true),
  // 每满多少轮落一次纪要。
  //
  // ★2026-11-17：20 → 5。实测每会话轮数 **p50 仅 2 轮**，20 轮的门槛
  // 意味着绝大多数会话永远不会产出纪要 —— 而短会话恰恰最需要它
  // （用户不再回来，时间线再也没机会落库）。
  minutesEveryTurns: Schema.number().default(5),
  // 空闲多久强制落一次（毫秒，0 = 关闭）。兜住「短会话不再有新轮次」。
  minutesIdleMs: Schema.number().default(600_000),
  // 一轮未结束时的阶段写入间隔（毫秒，0 = 关闭）。
  //
  // ★2026-11-17 实测：单轮可跑 30 分钟 / 72 步仍未 turn/end。
  // 而纪要的触发点（turn/end、idle、dispose）全部在轮末 ⇒ 这一整轮
  // 没有任何可回溯的中间状态。给「进行中」的轮次留一份阶段稿。
  minutesStageMs: Schema.number().default(600_000),
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
  // 系统提示写了也没用。改为由插件把**相关**记忆推进上下文。
  //
  // 默认仍关闭：这是会改动系统提示的路径，需用户在自己的 patch 里显式开启。
  // 是否启用由 `cordis.patch.yml` 决定（真正生效的是 profile 层那份）。
  /** 是否主动注入相关记忆 */
  recallInjectEnabled: Schema.boolean().default(false),
  /** 最多注入几条 */
  recallInjectMaxItems: Schema.number().default(2),
  /** 相对分下限（top1 恒为 1.0，单靠它等于永远放行一条） */
  recallInjectMinScore: Schema.number().default(0.85),
  /**
   * 绝对分下限（RRF 融合分，**名次信号而非语义相关度**）。
   *
   * RRF = Σ1/(60+rank)，值域 `(0, 2/61]`。实测三个离散簇：单路 0.0164 /
   * 双路 0.0301 / 双路靠前 0.0328，无中间值。0.025 等价于「要求至少两路命中」。
   * 实测区分力：项目内查询 12/12 过线，生活类无关查询 2/12 过线。
   */
  recallInjectMinRawScore: Schema.number().default(0.025),
  /** 单条截断字符数 */
  recallInjectMaxCharsPerItem: Schema.number().default(80),
  /**
   * 碎片前缀判据（正则源码，空串 = 关闭）。
   *
   * 实测 dsh 项目 2217 条记忆里 2037 条（92%）是未折叠碎片，会挤占
   * top2 注入槽位。判据是「以悬空词开头」（主语被切掉），不是长度 ——
   * 长度会误伤「用户偏好纸质拼贴风格」这类完整短句。
   */
  recallInjectFragmentPrefixes: Schema.string().default(
    '^(?:改成|改用|换成|改为|换掉|删掉|去掉|只保留)',
  ),
  /** 碎片豁免的重要性门槛（1–10）：够重要就不受前缀判据限制 */
  recallInjectFragmentExemptImportance: Schema.number().default(9),

  // ── LLM 兜底提取 ──
  // 规则层（正则）只能覆盖「见过的措辞」，而模型表达是开放的。
  // 实测真实日志 214 句含信号句，规则抽出 113 句，边界外仍有真结论。
  // 兜底路径用**一次独立模型调用**补足 —— 这是结构约束，不是提示词。
  //
  // ★默认关闭：这是唯一会额外产生模型请求的路径，必须用户显式开启。
  // 开启后受「仅规则落空时触发 + 长度下限 + 会话额度 + 最小间隔」四重约束。
  /** 是否启用 LLM 兜底提取 */
  llmExtractEnabled: Schema.boolean().default(false),
  /**
   * 会话级最大调用次数（0 = 不限制）。
   *
   * ## 为什么是 200 而不是 40（★2026-11-14）
   *
   * 40 是按「类型缺口偶尔触发」估的。改成「有待裁决句子就触发」后，
   * 长正文几乎每轮都有待裁决句（实测 7258 字符报告里 79/82 句是待裁决），
   * 40 次会在一次长任务内用完，之后**静默关闭** —— 表现为「用着用着就不
   * 提炼了」，用户完全不知道发生了什么。
   *
   * 200 的量级：一次长任务约 30–60 次真实调用。压缩侧已经很省（trim 只在
   * 超阈值时触发），这部分成本换的是信息质量 —— 用户明确要求「既然已经
   * 节省了，就要保证信息质量」。
   */
  llmExtractMaxCalls: Schema.number().default(200),
  /**
   * 进程级最大调用次数（0 = 不限制），滑动窗口 1 小时。
   *
   * 会话配额按桶独立，多窗口下总量会成倍放大。这是最终硬上限。
   * 默认 500：约合 2.5 个满额会话/小时，足够单人常驻使用。
   */
  llmExtractGlobalMaxCalls: Schema.number().default(500),
  /**
   * 两次调用的最小间隔（毫秒）。
   *
   * 从 30 秒降到 5 秒：待裁决句是逐条消息产的，30 秒间隔会让同一轮里
   * 连续几条消息只有第一条能兜底，其余静默跳过。5 秒只用于防异常循环
   * （真正的总量控制由上面两个配额负责）。
   */
  llmExtractMinIntervalMs: Schema.number().default(5000),
  /** 正文短于此长度不触发（默认 120 字符，短碎片不值得单独问） */
  llmExtractMinChars: Schema.number().default(120),
  /** 单次发送的正文上限（默认 6000 字符，超出取尾部） */
  llmExtractMaxInputChars: Schema.number().default(6000),

  // ── 工件库（长文本落盘）──
  //
  // 用户粘贴的几百页文档 / 超长代码若留在对话里，会直接吃满窗口；
  // 若塞进 LRC，`recall` 会把长文档片段召回来，等于把上下文重新灌满。
  // 所以单独落盘，只在 LRC 留一条指针 Fact，按 hash 取回。
  /** 是否启用长文本落盘（默认开启：这是纯收益，无模型调用） */
  artifactEnabled: Schema.boolean().default(true),
  /** 超过多少字符才落盘 */
  artifactMinChars: Schema.number().default(8000),
  /** 工件库磁盘配额（MB），超额按最久未访问淘汰 */
  artifactQuotaMb: Schema.number().default(200),
});

/** 系统提示段落名（全局唯一，避免与宿主段落冲突）。 */
const PROMPT_SECTION = 'lrc:memory-capture';

/**
 * 单次取回工件的字符上限。
 *
 * 取回的原文直接进上下文，所以必须分段 —— 一个 2MB 文档一次全返回，
 * 等于立刻把窗口打满，与「省上下文」的目的完全相反。
 * 8000 字符约 4K tokens，是「够模型看懂结构」与「不挤占推理空间」的折中。
 */
const ARTIFACT_CHUNK_CHARS = 8000;

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
 * 开启主动注入后，`[LRC 历史记忆…]` 段落已经出现在上下文里。此时若仍写
 * 「先调 `lrc_recall` 工具」，模型会面对**两套相互竞争的指令**：
 * 一边已经拿到记忆，一边被要求再去调工具查一遍。实测这类矛盾提示会
 * 让模型两头都不做（既不调工具，也不信任注入内容）。
 *
 * # 注入版为什么写成「软提示」
 *
 * 注入内容来自历史，可能与当前任务无关、或已被后续决定推翻。若提示写成
 * 「直接当事实使用」，模型会为了迎合它而改变当前做法 —— 这正是上下文偏移
 * 与幻觉的来源。所以提示只声明**它是什么**、**什么时候该查**，
 * 判断权留给正在工作的模型。
 *
 * # 为什么还要给**具体触发词**（2026-11-19 六钥匙裁决）
 *
 * 只写「用不用由你判断」实测等于「永远不用」：最近 8000 行日志里
 * `lrc_recall` 调用 **0 次**。软提示必须给出**可执行的触发条件**，
 * 否则「判断权交给模型」就退化成「没人判断」。
 */
function buildPromptText(recallInjected: boolean): string {
  const recallRule = recallInjected
    ? [
        '上下文里可能出现 `[LRC 历史记忆（可能过时，与当前任务无关时请忽略）]` 段落，',
        '那是插件按当前话题自动检索出来的历史记录。**用不用、信不信由你判断**：',
        '与当前任务相关就参考；明显无关或与已验证事实冲突时直接忽略，不要为了迎合它改变做法。',
        '若某条记忆与你已知的事实冲突，以**你能当场验证的**为准，并可用 `lrc_recall` 复核。',
        '',
        '**必须主动调 `lrc_recall` 的情形**（不要凭印象回答）：',
        '- 用户提到「上次」「之前」「以前」「当初」「我们决定过」「不是定过吗」',
        '- 用户问「为什么这么设计」「为什么用这个」「那个方案是什么」',
        '- 用户说「继续上次」「接着之前那个」',
        '- 需要引用具体的历史数字、路径、结论，而当前上下文里没有',
        '',
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
    '## 长文档与工件',
    '',
    '超长输入（整份文档、几百行代码）会由插件落盘为「工件」，上下文里只留一条',
    '`[工件] …（hash=xxxx）` 指针。需要看原文时调 `lrc_fetch_artifact(hash)`，',
    '它单次返回上限 8000 字符，更长的用 `offset` 分段读。',
    '**不要凭预览句臆测原文内容**，需要细节就取回。',
    '',
    '## 长期记忆沉淀',
    '',
    '插件会自动从你的回答里提取**约束**、**决策**、**结论**、**目标**、**范围限定**，',
    '所以不需要额外格式化输出。只要在回答里把结论说清楚即可。',
    '',
    '**最有价值的是这几类**（会被长期保留、跨会话复用）：',
    '- 约束：必须 / 禁止 / 只能 / 只支持 / 不要',
    '- 决策：改用 / 采用 / 定为 / 选型',
    '- 结论：根因 / 排查结论 / 定位到',
    '- 目标：压到 N 以下 / 降到 N 以内 / 不超过 N',
    '- 范围：这次只做什么、明确不做什么',
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
   * 工件库：长文本落盘（与 LRC 分开，见 `artifact-store.ts` 注释）。
   *
   * ## 配额必须防 NaN（★2026-11-14 审查 P0）
   *
   * `config.artifactQuotaMb` 来自 `cordis.patch.yml`，而**旧 patch 不会自动
   * 包含新字段**。上一版写的是：
   * ```ts
   * Math.max(1, config.artifactQuotaMb) * 1024 * 1024
   * ```
   * `Math.max(1, undefined)` 得到 `NaN`，`NaN * 1024 * 1024` 仍是 `NaN`。
   * 而 `ArtifactStore.evictIfNeeded()` 里 `usage <= NaN` 恒为 **false** ——
   * 于是**每次落盘都会把所有工件全部淘汰**（包括刚写的那个），
   * 且 `lrc_fetch_artifact` 永远返回「未找到」。
   *
   * 这是「配置缺失静默失效」的又一种形态，必须显式兜底。
   */
  const quotaMb =
    typeof config.artifactQuotaMb === 'number' && Number.isFinite(config.artifactQuotaMb) && config.artifactQuotaMb > 0
      ? config.artifactQuotaMb
      : 200;
  const artifactStore = new ArtifactStore(join(cacheDir, 'artifacts'), Math.floor(quotaMb * 1024 * 1024));
  /**
   * 功能开关：**缺失即视为开启**（★2026-11-14 审查 P1）。
   *
   * ## 为什么不能写 `config.artifactEnabled === true`
   *
   * `cordis.patch.yml` 是用户侧文件，**旧 patch 不会自动包含新字段**。
   * 之前所有布尔开关都写 `=== true`，那对「默认关闭」的开关是对的
   * （`llmExtractEnabled` 要花钱，必须显式开启）。但 artifact 落盘是
   * **纯收益**：不花模型调用、不改变对话行为、磁盘占用有配额兜底。
   *
   * 写成 `=== true` 的后果：升级插件后旧 patch 没有这个键 ⇒ 长文本落盘
   * 静默不生效，而且**没有任何日志提示**。用户以为功能上线了，实际从未跑过。
   *
   * 所以这里用「只有显式 false 才关闭」：缺字段 = 开启。
   */
  const artifactEnabled = config.artifactEnabled !== false;
  const artifactMinChars =
    typeof config.artifactMinChars === 'number' && config.artifactMinChars > 0
      ? Math.floor(config.artifactMinChars)
      : 8000;

  /**
   * 纪要账本的轮次上限（40 轮 ≈ 2 倍于实测最长会话 22 轮）。
   *
   * 提前到配置解析之前声明：`minutesEveryTurns` 的夹取要用到它。
   */
  const TURN_LEDGER_MAX = 40;

  /**
   * 会话纪要开关与节奏。
   *
   * ## `!== false` 而不是 `=== true`（2026-11-17 独立审查 C3）
   *
   * 与 `artifactEnabled` 完全同源的理由：`cordis.patch.yml` 是用户侧文件，
   * **旧 patch 不会自动包含新字段**。包内 patch 实测确实没有 `minutesEnabled`
   * 这个键（见 `cordis.patch.yml`）—— 若写成 `config.minutesEnabled === true`，
   * 升级后纪要会**静默不生效**，日志里连一行都没有。
   *
   * 纪要是纯收益：不花模型调用、不改对话行为、写入量被 N 轮/空闲节流。
   */
  const minutesEnabled = config.minutesEnabled !== false;
  /**
   * 每满多少轮落一次纪要。
   *
   * ## 20 → 5（2026-11-17 独立审查 M5）
   *
   * 实测每会话轮数 **p50 只有 2 轮**（分布主体是很短的会话）。
   * 默认 20 轮意味着绝大多数会话**永远不会写出纪要**。
   * 降到 5 轮后仍属于「把写入量放大 5 倍以内」，配合空闲定时器
   * （`minutesIdleMs`）可覆盖短会话。
   */
  const minutesEveryTurns = (() => {
    const raw = Math.floor(config.minutesEveryTurns);
    if (!Number.isFinite(raw) || raw <= 0) return 5;
    return Math.min(raw, TURN_LEDGER_MAX);
  })();
  /**
   * 空闲多久后强制落一次纪要（毫秒，0 = 关闭空闲触发）。
   *
   * 10 分钟：实测一轮的长任务可以持续很久（88 步），但「两轮之间」
   * 的用户思考间隔通常远小于 10 分钟。它只用来兜住「短会话再也不会
   * 有新轮次」这个场景，不参与常规节奏。
   */
  const MINUTES_IDLE_DEFAULT_MS = 10 * 60 * 1000;
  const minutesIdleMs = (() => {
    const raw = typeof config.minutesIdleMs === 'number' ? config.minutesIdleMs : Number.NaN;
    if (!Number.isFinite(raw)) return MINUTES_IDLE_DEFAULT_MS;
    return Math.max(0, Math.floor(raw));
  })();
  /**
   * 轮内阶段写入间隔（毫秒，0 = 关闭）。
   *
   * ## 为什么必须有（2026-11-17 DSH 实测）
   *
   * 纪要的原有触发点全部落在**轮末**：`turn/end`、idle 定时器（只在
   * `archiveTurn` 里重排）、dispose。实测一轮工具密集型任务可以跑
   * **30 分钟 / 72 步**仍未 `turn/end` —— 这期间若用户关窗或进程崩溃，
   * 这一整轮（往往正是最花时间、最有价值的那轮）没有任何纪要。
   *
   * 10 分钟与 idle 同量级：足够长到不会把一份纪要写成碎片，
   * 又足够短到在常见长任务里至少落一份中间态。
   *
   * 每次写入是一次 `remember`，LRC 侧要做全库相似度扫描
   * （`find_similar_in_snapshot`）。**不要配到秒级** —— 那等于持续给
   * LRC 加压；内容指纹判据能挡住"内容没变"的重复写，但挡不住
   * "内容一直在变"的场景。生产建议 >= 60 秒。
   */
  const MINUTES_STAGE_DEFAULT_MS = 10 * 60 * 1000;
  const minutesStageMs = (() => {
    const raw = typeof config.minutesStageMs === 'number' ? config.minutesStageMs : Number.NaN;
    if (!Number.isFinite(raw)) return MINUTES_STAGE_DEFAULT_MS;
    return Math.max(0, Math.floor(raw));
  })();
  if (!minutesEnabled) {
    ctx.logger.info('[lrc] 会话纪要已关闭（minutesEnabled=false），不会生成任何纪要');
  }

  /**
   * 会话级 **Fact 账本**：交接文档的投影来源。
   *
   * ## 为什么需要本地账本
   *
   * 交接文档要按 kind 分组渲染，而 LRC 的 `recall` 是**语义检索** ——
   * 它返回「与某段文字相似的 Top-K」，不是「本会话的全部 Fact」。
   * 用它来投影交接文档，结果取决于查询词，不可靠。
   *
   * 所以本会话写入的每条 Fact 都在这里留一份（上限 200 条，够覆盖
   * 任意真实会话；超出按最旧淘汰）。会话切换时清空。
   */
  const sessionFacts: MemoryFact[] = [];
  const SESSION_FACTS_MAX = 200;

  /**
   * 会话纪要的**轮次账本**（★2026-11-17）。
   *
   * ## 与 `sessionFacts` 的分工
   *
   * - `sessionFacts`：世界状态快照（当前有哪些约束/决策），upsert 语义，
   *   用于交接文档与裁剪摘要的「助手结论」段。
   * - `turnLedger`：**时间线**（每一轮发生了什么、什么时候、成功还是中止），
   *   append 语义，用于生成会话纪要。
   *
   * 两者不能合并：账本要「同键覆盖」（新的值取代旧的），
   * 纪要要「逐轮保留」（用户改了三次需求，三次都要在纪要里）。
   *
   * ## 上限
   *
   * 40 轮 ≈ 2 倍于实测最长会话（22 轮），足以覆盖任意真实会话；
   * 超出按最旧淘汰（纪要只是丢失最早几轮，不是整份丢失）。
   */
  const turnLedger: TurnRecord[] = [];

  /**
   * **累计归档轮数**（单调递增，永不因账本淘汰而回退）。
   *
   * ## 为什么不能用 `turnLedger.length` 做触发判据
   * （2026-11-17 独立审查 C1，已复算确认）
   *
   * `turnLedger` 在 40 轮处 `splice` 淘汰最旧，长度**恒定为 40**。
   * 若用「账本长度 - 上次写入长度」判增量：
   * ```
   * 第 40 轮写入 ⇒ 已写入标记 = 40
   * 第 41~120 轮 ⇒ 40 - 40 = 0 < every ⇒ 永远 return
   * 实测：120 轮会话只在第 20、40 轮各写一次，之后 67% 的时间线永久缺失
   * ```
   * 改用单调计数器后，触发判据与淘汰策略彻底解耦。
   */
  let archivedTurns = 0;
  /** 上次写纪要时的 `archivedTurns`（初值 -1 表示从未写过）。 */
  let minutesWrittenAtArchived = -1;

  /**
   * 已成功写入库的**轮数**（**仅用于 `lrc_status` 展示**）。
   *
   * ## 为什么它不参与写入闸门（三段审查 M1）
   *
   * 闸门已改用单调的 `writtenAtArchived`。用轮数做闸门有三种失真：
   * 账本 40 轮上限饱和后恒等、恢复出短账本时变小、合并后可能超过上限。
   *
   * ## 为什么仍然保留
   *
   * `lrc_status` 要回答「这段对话已经写进库多少轮」—— 那是个**展示**问题，
   * 用轮数最直观。它读不准的代价只是一行诊断文案偏移，不影响任何写入决策。
   */
  let minutesWrittenTurns = 0;

  /**
   * 上次成功写入的记忆 ID（六轮审查 M-A）。
   *
   * ## 为什么必须有
   *
   * LRC 不是按 `event_id` 覆盖，而是「内容 Jaccard ≥ 0.5 才合并」。
   * 首轮纪要（1 行诉求）与第 3 轮纪要（多行）相似度可能只有 0.35 ⇒ **不合并**
   * ⇒ 同一个 `session-minutes:<sid>` 在库里出现两条：一条停在 1 轮的过时版本
   * （importance=9，会被召回），一条是新的。
   *
   * 记下 ID 后，`persistLedger` 在发现「新 id ≠ 旧 id」时 `forget(旧 id)`，
   * 保证库里恒为 1 条。
   */
  let minutesMemoryId = '';

  /**
   * `minutesMemoryId` 的来源（三态，见 `MinutesLedgerState.memoryIdFromProbe`）。
   *
   * `true` = 探查捡来的（永不 forget）；`false` = 自己写的；
   * `undefined` = **未知**（旧版账本）⇒ 保守不删。
   */
  let minutesMemoryIdFromProbe: boolean | undefined = undefined;

  /** 本会话**首次观测**时间（Unix 毫秒）—— `source_timestamp_ms` 恒取它。 */
  let minutesStartedAt = 0;

  /**
   * 上次**轮内阶段写入**覆盖到的轮 `idx`（0 = 从未写过）。
   *
   * 与 `minutesWrittenAtArchived` 刻意分开：阶段稿不代表任何轮「已完成」。
   * 详见 `MinutesLedgerState.stageWrittenTurnIdx` 的注释。
   */
  let minutesStageWrittenTurnIdx = 0;

  /** 当前账本归属的会话（内存里的账本只属于一个会话）。 */
  let minutesOwnerSessionId = '';

  /**
   * 纪要账本的**按会话落盘**。
   *
   * 这是 C2 的根治手段：账本只在内存时，DSH 一重启就归零，
   * 下一份纪要会从「1 轮」重新开始 —— 而它要么被合并（丢内容）、
   * 要么新增一条重复纪要（同 event_id 两条）。
   * 落盘后，重启命中同一 sessionId 直接**恢复**账本。
   */
  const minutesLedgerStore = new MinutesLedgerStore(join(cacheDir, 'minutes'));
  const MINUTES_LEDGER_MAX_FILES = 40;

  /**
   * 纪要的**会话归属**：`liveTurn` 与结论收集必须校验归属。
   *
   * ## 为什么需要（2026-11-17 独立审查 M5）
   *
   * `runLlmFallback` 是 `void` 异步的：它 `await` 模型调用后才
   * 调 `offloadExtracted(...)`。若这次调用在用户切会话之后才 resolve，
   * `liveTurn` 已是**新会话**的槽位 ⇒ 旧会话的结论被推进新会话纪要。
   * 召回路径为此专门做了代次闸门（`recallGeneration`），纪要路径必须对等。
   */
  let liveTurnSessionId = '';

  /**
   * 一轮的临时记录（`turn/start` 建立，`turn/end` 归档进 `turnLedger`）。
   *
   * `lastActivityAt` 必须单独记：`turn/end` 可能因事件丢失而不来，
   * 此时用 `turn/start` 兜底归档，`endedAt` 若取 `Date.now()` 会记成
   * **下一轮的开始时刻**（2026-11-17 独立审查 M6）。取最后一次实际活动的
   * 时间才符合事实。
   */
  interface TurnSlot {
    idx: number;
    startedAt: number;
    /** 最后一次收到用户消息/结论的时间（`endedAt` 的真实来源） */
    lastActivityAt: number;
    sessionId: string;
    userText: string;
    conclusions: string[];
  }

  let liveTurn: TurnSlot | undefined;

  /**
   * 已完成 `turn/end`、但 `finishTurn` 还没跑完的轮次。
   *
   * ## 为什么不能直接归档（2026-11-17 独立审查 C5，已复算确认）
   *
   * `finishTurn` 里的**推理兜底**会从推理流抽出结论。旧顺序是
   * 「先归档并清空 `liveTurn`，再 `finishTurn`」——
   * 于是推理兜底抽出的结论找不到收集目标，**工具密集型轮次
   * （正文占比 0%）的结论永远进不了纪要**。
   *
   * 现在把轮次从这里过渡：`turn/end` 先摘进本数组，`finishTurn` 的
   * `finally` 里再归档。`offloadExtracted` 收集结论时同时看
   * `liveTurn` 与这里，两条路径都不丢。
   *
   * 用数组而非单变量：`finishTurn` 是 `void` 异步的，上一轮的收尾
   * 可能与下一轮的 `turn/end` 重叠。按 sessionId 取最近一个即可。
   */
  const finishingTurns: TurnSlot[] = [];

  /**
   * `finishingTurns` 的**过期兜底**（十一轮审查 M-B）。
   *
   * ## 为什么必须有
   *
   * 出队的唯一入口是 `finishTurn().finally()`。若 `finishTurn` 内某个
   * `await` 永不 settle（`connection.get()` 的 factory、`offloader.flushTurn`
   * 链路上没有超时兜底），该槽位会永久留在数组里，后果是：
   * 1. 之后**每次**写入都把它当 `in-progress` 写进库 ⇒ 库里永远挂一行
   *    「（in-progress）」，且内容实际早已冻死；
   * 2. `nextStageMarker` 每次都能扫到它 ⇒ 标记恒非 0；
   * 3. `maybeWriteMinutes` 的 `stageTurnStillActive` 恒为真 ⇒
   *    「阶段稿收尾放行」这条快路径在整个会话生命周期内失效。
   *
   * 且全程没有任何日志可定位。
   *
   * 5 分钟：远大于正常收尾（实测秒级），又足够短到不会长期污染。
   */
  const FINISHING_TURN_TTL_MS = 5 * 60 * 1000;

  /**
   * 清掉超时未收尾的槽位，并**先归档**（不让内容丢）。
   *
   * 归档用 `'no-end'`：这一轮确实没有走完正常收尾，纪要里应能看出来。
   * 归档后 `archiveTurn` 会自行落盘并排空闲定时器。
   */
  function expireStuckFinishingTurns(): void {
    if (finishingTurns.length === 0) return;
    const now = Date.now();
    for (let i = finishingTurns.length - 1; i >= 0; i -= 1) {
      const slot = finishingTurns[i];
      if (slot === undefined) continue;
      const last = slot.lastActivityAt > 0 ? slot.lastActivityAt : slot.startedAt;
      if (now - last < FINISHING_TURN_TTL_MS) continue;
      finishingTurns.splice(i, 1);
      // 先归档再丢弃引用：内容必须留住
      archiveTurn(slot, 'no-end');
      ctx.logger.warn(
        `[lrc] 轮次收尾超过 ${Math.round(FINISHING_TURN_TTL_MS / 60000)} 分钟未完成，` +
          `已按 no-end 归档（第 ${slot.idx} 轮，${slot.sessionId}）`,
      );
    }
  }

  /**
   * **未写成功的纪要**（按会话暂存的待重试状态）。
   *
   * ## 为什么必须有（2026-11-17 独立审查 C2/C4）
   *
   * 首版在切换会话时直接清空账本，注释写「下一轮会带着完整账本重写」——
   * 但账本已清空、新会话从零开始，**不存在任何重写路径**。
   * 更严重的是首版的 `minutesBacklog` **只写不读**：12 处引用里只有
   * 一处用它显示条数，注释声称的「下次重连重试」并不存在。
   *
   * 现在有两个消费点，缺一不可：
   * 1. `retryPendingMinutes()` —— 连接就绪（`attachOffloader`）时补写
   * 2. `maybeWriteMinutes()` —— 每 N 轮或空闲触发时补写
   *
   * 内容同时落盘（`MinutesLedgerStore`），因此进程重启也不丢。
   */
  const minutesBacklog = new Map<string, MinutesLedgerState>();
  const MINUTES_BACKLOG_MAX = 8;

  /** 把账本裁剪到上限（淘汰最旧轮次）。 */
  function trimTurnLedger(): void {
    if (turnLedger.length > TURN_LEDGER_MAX) {
      turnLedger.splice(0, turnLedger.length - TURN_LEDGER_MAX);
    }
  }

  /** 当前内存账本 → 可落盘/可写入的形状。 */
  function currentLedgerState(): MinutesLedgerState {
    return {
      sessionId: minutesOwnerSessionId,
      turns: [...turnLedger],
      archivedTurns,
      writtenAtArchived: minutesWrittenAtArchived,
      startedAt: minutesStartedAt,
      writtenTurns: minutesWrittenTurns,
      memoryId: minutesMemoryId,
      // ## 必须带上待删列表（八轮审查 M-3）
      //
      // `MinutesLedgerStore.save()` 是 `{...state}` **全量覆盖**。
      // 若这里不带 `pendingForget`，任何一次 `saveCurrentLedger()`
      // （每轮归档都会调）都会把磁盘上的待删 id 抹掉 ——
      // 而 `queueForget` 刚写进去的那份只活在内存里，进程一重启就永久失联。
      // M-2 的持久化保证会被这条路径完全绕过。
      pendingForget: [...(minutesPendingForget.get(minutesOwnerSessionId) ?? [])],
      // ## `memoryId` 的来源必须落盘（七轮审查 critical 1）
      //
      // 「探查来的 id 永不 forget」这条规则只存在进程内 Set 里时，
      // 重启后集合清空而账本仍指向那个 id ⇒ 下次写入会把它当「本稿
      // 旧版本」删掉（真实历史不可逆丢失）。所以来源随账本一起落盘。
      memoryIdFromProbe: minutesMemoryIdFromProbe,
      // 阶段稿进度必须随账本走：漏带会让「本轮已阶段写过」这件事在
      // 任何一次 `saveCurrentLedger()`（每轮归档都会调）后失忆。
      stageWrittenTurnIdx: minutesStageWrittenTurnIdx,
      updatedAt: Date.now(),
    };
  }

  /** 把当前会话账本落盘（归属为空时跳过）。 */
  function saveCurrentLedger(): void {
    if (minutesOwnerSessionId.length === 0) return;
    minutesLedgerStore.save(currentLedgerState());
  }

  /** 用落盘状态覆盖内存账本。 */
  function applyLedgerState(state: MinutesLedgerState): void {
    turnLedger.length = 0;
    for (const turn of state.turns) turnLedger.push(turn);
    trimTurnLedger();
    minutesOwnerSessionId = state.sessionId;
    // `archivedTurns` 是单调累加值，可能远大于 `turns.length`（账本饱和过）。
    // 只在「文件里明显更小」（旧版本文件没这个字段）时用长度兜底。
    archivedTurns = Math.max(state.archivedTurns, state.turns.length);
    minutesWrittenAtArchived = state.writtenAtArchived;
    minutesWrittenTurns = state.writtenTurns;
    minutesMemoryId = state.memoryId;
    minutesMemoryIdFromProbe = state.memoryIdFromProbe;
    // ## 待删列表必须一起回填（九轮审查 M-3′）
    //
    // 反例：A 有 `pendingForget=[X]` 落盘 → 切到 B → 切回 A。
    // `load` 拿到 X 只在 `state` 里，若不回填内存，下一轮 `archiveTurn`
    // 调 `saveCurrentLedger()` 会写 `pendingForget: []` ⇒ X 永久失联。
    // `currentLedgerState()` 读的是**内存** `minutesPendingForget`，
    // 所以这里必须同步。
    minutesPendingForget.set(state.sessionId, [...(state.pendingForget ?? [])]);
    minutesStageWrittenTurnIdx = state.stageWrittenTurnIdx ?? 0;
    minutesStartedAt =
      state.startedAt > 0 ? state.startedAt : (state.turns[0]?.startedAt ?? Date.now());
  }

  /** 清空内存账本（新会话，或落盘里没有该会话的账本）。 */
  function resetMinutesState(sessionId: string): void {
    turnLedger.length = 0;
    archivedTurns = 0;
    minutesWrittenAtArchived = -1;
    minutesWrittenTurns = 0;
    minutesMemoryId = '';
    minutesMemoryIdFromProbe = undefined;
    minutesStageWrittenTurnIdx = 0;
    // ## 阶段写入的时间节流必须一并清零（十轮审查 M4）
    //
    // 否则上一个会话的阶段写入时刻会推迟新会话的首次阶段稿：
    // ```
    // A 在 12:00:08 写了阶段稿
    // 12:00:10 切到 C，C 的第一轮
    // C 跑到 12:10:05 ⇒ now - lastMinutesStageAt = 597s < 600s ⇒ 跳过
    // ⇒ C 的首份阶段稿被无谓推迟（边界时漏一次）
    // ```
    lastMinutesStageAt = 0;
    lastMinutesStageConclusionCount = 0;
    minutesStartedAt = Date.now();
    minutesOwnerSessionId = sessionId;
  }

  /**
   * 切换纪要账本到指定会话：**命中落盘就恢复，否则从零开始**。
   *
   * 这是 C2 的关键路径。旧实现在切会话时无条件清零，
   * 于是「A → B → A」会把 A 已经积累的时间线全部丢掉。
   */
  function bindMinutesSession(sessionId: string): void {
    if (sessionId.length === 0) return;
    if (sessionId === minutesOwnerSessionId) return;
    // 先落盘旧会话（内存只保留当前会话的账本）
    saveCurrentLedger();
    const restored = minutesLedgerStore.load(sessionId);
    // ## 「有阶段稿但零轮次」的账本也必须恢复（十一轮审查 M-3）
    //
    // 反例：会话**第一个**轮次就是长任务，阶段稿写入成功时
    // `turnLedger` 仍为空 ⇒ 磁盘上是 `turns: []` + `stageWrittenTurnIdx: 1`
    // + `writtenAtArchived: 0`。重启后若只判 `turns.length > 0`，
    // 这份账本被当成「不存在」⇒ `resetMinutesState` ⇒
    // `writtenAtArchived` 与阶段标记一起归零 ⇒ 库里那条 in-progress
    // 阶段稿失去收尾入口，且下一次写入的闸门按「从未写过」无条件放行。
    //
    // 判据：有轮次 **或** 有阶段标记 **或** 有归档历史，任意一项成立即恢复。
    const hasStageWork =
      (restored?.stageWrittenTurnIdx ?? 0) > 0 || (restored?.archivedTurns ?? 0) > 0;
    if (restored !== null && (restored.turns.length > 0 || hasStageWork)) {
      applyLedgerState(restored);
      ctx.logger.info(
        `[lrc] 纪要账本已恢复（${sessionId}）：${restored.turns.length} 轮 / ` +
          `累计归档 ${restored.archivedTurns} 轮 / 已写入 ${restored.writtenTurns} 轮`,
      );
      // ## 恢复出「有增量但没写进库」的账本，必须挂进补写队列（三段审查 C2）
      //
      // 反例（修复前会永久丢）：
      // ```
      // A 写成功后切到 B；B 期间 A 没有新轮次 ⇒ A 的账本落盘但没入库
      // 切回 A ⇒ 恢复出 archivedTurns > writtenAtArchived
      // 用户直接关窗口 ⇒ dispose 只 saveCurrentLedger()，A 的增量从未进 LRC
      // ```
      // `retryPendingMinutes` 只遍历 `minutesBacklog`，不扫磁盘 ——
      // 所以恢复时必须主动入队，否则这条路径永远没有消费者。
      //
      // ## 但 `turns` 为空时不要入队（十一轮 minor-5）
      //
      // 「只有阶段标记、零轮次」的账本会被 `hasStageWork` 判为可恢复
      // （M-3 需要），可它没有任何可写内容 —— 入队后 `persistMinutes`
      // 会返回 `skipped`，`minutesBacklog` 里就长期占着一个永远写不出去
      // 的槽位（上限 8），`retryPendingMinutes` 每 60 步空跑一次。
      if (
        restored.turns.length > 0 &&
        shouldRewriteMinutes(restored.archivedTurns, restored.writtenAtArchived)
      ) {
        stashMinutes(currentLedgerState(), `恢复出未写入的 ${restored.turns.length} 轮，待补写`);
        // ## 入队后必须**立即尝试一次**（三段审查 C2 的闭合点）
        //
        // 只入队是不够的：`retryPendingMinutes` 的触发点是
        // 「连接就绪」与「每 60 步」，而这条路径发生在任意时刻 ——
        // 用户可能在补写发生前就关掉窗口。这里 `force` 跳过节奏闸门
        // 立刻写一次；失败时 `persistLedger` 会自己回落到 backlog，
        // 持久化路径仍然完整。
        void maybeWriteMinutes(sessionId, '恢复补写', true);
      }
      return;
    }
    resetMinutesState(sessionId);
  }

  /** 按 `idx + startedAt` 去重合并多份轮次记录（保持时间升序）。 */
  function mergeTurns(sources: ReadonlyArray<readonly TurnRecord[]>): TurnRecord[] {
    const unique = new Map<string, TurnRecord>();
    for (const turns of sources) {
      for (const turn of turns) {
        const key = `${turn.idx}@${turn.startedAt}`;
        if (!unique.has(key)) unique.set(key, turn);
      }
    }
    return [...unique.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 取最早的非零时间（`source_timestamp_ms` 必须是最小值）。 */
  function earliestPositive(values: readonly number[]): number {
    let best = 0;
    for (const value of values) {
      if (value > 0 && (best === 0 || value < best)) best = value;
    }
    return best;
  }

  /**
   * 探测到的「库里既有纪要」（按会话）。
   *
   * ## 为什么必须记住它（十二轮审查 C1）
   *
   * 探查回填 `memoryId` 之后，若不做保护，第一次写入就会删掉旧纪要：
   * ```
   * 冷启动：库里 primary = 22 轮 / 2776 字，回填 memoryId = primary
   * 本轮只观测到 1 轮 ⇒ 新稿 300 字
   * LRC: Jaccard(300字, 2776字) ≈ 0.05 < 0.5 ⇒ 新建 newId
   * previousId(=primary) ≠ newId ⇒ forget(primary)
   * ⇒ 库里只剩 1 轮的残稿，22 轮完整纪要永久丢失 ❌
   * ```
   * 「两条重复（至少还能找回完整版）」被升级成「一条残缺」，
   * 比不修更糟 —— 这是 D 方案唯一必然触发的致命路径。
   *
   * ## `segments` 必须保留**全部**同 `event_id` 的段（七轮审查 major 3）
   *
   * LRC 的合并判定是「与**任一**同项目记忆 Jaccard ≥ 0.5 就合并进它」，
   * 不是只比 primary。反例：
   * ```
   * 库里 P1(12 轮) + P2(2 轮，更新，被选为 primary)
   * 账本丢失、重放旧主题 7 轮
   * ⇒ 与 P2 相似度 0.3 < 0.5（不拦）
   * ⇒ 与 P1 相似度 0.8 ≥ 0.5 ⇒ LRC 合并进 P1 ⇒ 12 轮被 7 轮替换 ❌
   * ```
   * 所以保护判据必须对**每一段**都算一遍，取「会不会被任一段合并」。
   */
  const probedMinutes = new Map<
    string,
    {
      /** 最新那段的轮数（`lrc_status` / 日志展示用） */
      turns: number;
      /** 最新那段的正文（写入后作为新的比对基准） */
      content: string;
      /** 最新那段的 id */
      memoryId: string;
      /** 库里**全部**同 event_id 的段（合并判定要逐条比） */
      segments: Array<{ turns: number | null; content: string; id: string }>;
    }
  >();

  /**
   * `probedMinutes` 的会话上限（七轮审查 major 5）。
   *
   * 每条带整段纪要正文（数 KB）。长驻进程里会话数只增不减 ⇒ 数百个会话
   * 就是数 MB 常驻内存。取 `MINUTES_BACKLOG_MAX` 同量级即可：超出上限的
   * 会话本来就几乎不会再被写入（账本也按同量级 prune）。
   */
  const PROBED_MINUTES_MAX = 40;

  /** 写入 `probedMinutes` 并淘汰最旧会话（`Map` 保序）。 */
  function setProbedMinutes(
    sessionId: string,
    value: NonNullable<ReturnType<typeof probedMinutes.get>>,
  ): void {
    probedMinutes.delete(sessionId);
    probedMinutes.set(sessionId, value);
    while (probedMinutes.size > PROBED_MINUTES_MAX) {
      const oldest = probedMinutes.keys().next();
      if (oldest.done === true) break;
      probedMinutes.delete(oldest.value);
    }
  }

  /**
   * 从 LRC 库里**探查**本会话已有的纪要，回填 `memoryId`（D 方案）。
   *
   * ## 解决什么问题
   *
   * 本地账本可能根本不存在（旧版本升级、账本被 prune、换机器）：
   * ```
   * 库里已有 session-minutes:<sid>（22 轮 / 2776 字，importance=9）
   * 本地账本 null ⇒ minutesMemoryId = '' ⇒ previousId.length === 0
   * ⇒ 下次写入不去 forget 旧的那条
   * ⇒ 新稿与旧稿 Jaccard ≈ 0.05 < 0.5 ⇒ LRC 新建第二条
   * ⇒ 库里两条同名 importance=9 纪要，且不会自愈
   * ```
   *
   * ## 只回填 `memoryId`，**不伪造轮次**
   *
   * 这是刻意的边界：旧纪要正文只有「诉求演进」的行文本，没有
   * 逐轮的 `startedAt/endedAt/reason`，也没有「哪条结论属于哪一轮」。
   * 反推出来的轮次全是编造 —— 那会让时间线看起来完整、实际不可信。
   *
   * 所以本函数只做一件确定的事：让去重逻辑知道「库里已有一条」，
   * 从而在下一次写入时能正确 `forget` 掉被 LRC 判为新记录的那条。
   * 时间线的接续仍只依赖插件**真实观测到**的轮次。
   *
   * ## 多条并存时选哪条：**最新**
   *
   * 按 `created_at`（= 该段对话的起始时间）降序，取最新那段。
   * **不取「最长」** —— 真实数据里旧段 2776 字、新段 1104 字，
   * 但新段才是活跃的（而且它推翻了旧段的结论）。
   *
   * ## 绝不 forget 其它记录
   *
   * 同 `event_id` ≠ 重复。不同时间窗的两段是两段真实历史，
   * 删掉不可逆。`forget` 只用于「同一次写入被 LRC 判为新记录」的副本。
   */
  async function probeExistingMinutes(client: LrcClient, sessionId: string): Promise<boolean> {
    if (!minutesEnabled) return false;
    if (sessionId.length === 0) return false;
    // ## 记下探查**开始前**的磁盘账本（十二轮审查 M3）
    //
    // 探查有 HTTP 往返（秒级）。期间写链可能完成一次真实写入并落盘 ——
    // 此时回填旧 id 会把那次写入的记录点覆盖掉。
    //
    // ⚠ 判据必须是「磁盘**变了**」，不能是「磁盘非空」：
    // 真实案例里磁盘正指向一条历史短稿（7b6d69a6），而本次要做的
    // 恰恰是把它换成更完整的那条（C2）。用「非空即放弃」会让 C2 失效。
    const diskBefore = minutesLedgerStore.load(sessionId);
    const diskMemoryIdBefore = diskBefore?.memoryId ?? '';
    const diskWrittenBefore = diskBefore?.writtenAtArchived ?? -1;
    try {
      const result = await client.recall('会话纪要 时间线 诉求演进', {
        topK: 30,
        tags: [`session:${sessionId}`],
      });
      const expected = minutesEventId(sessionId);
      const found = result.memories.filter((m) => m.event_id === expected);
      if (found.length === 0) {
        // 库里确实没有 —— 这是真正的首次写入，什么都不用做。
        //
        // ## 必须记下「已探查」（十四轮审查 C3）
        //
        // `maybeProbeMinutesOnce` 的「已探过」判据是
        // `probedMinutes.has(sessionId)`。若这里不记，**新会话
        // （库里尚无纪要，也就是最普通的首次使用）每一轮 turn/start
        // 都会发一次 topK=30 的全库 enrich**（LRC 侧含 LLM 富化 +
        // 双路检索 + 关联补全，实测秒级）。
        // 记成 0 轮表示「库里没有更完整的版本」⇒ 不触发保护，语义正确。
        setProbedMinutes(sessionId, {
          turns: 0,
          content: '',
          memoryId: '',
          segments: [],
        });
        return true;
      }
      // ## 选「最新的一段」，不是「最长的一段」（十三轮 / 六钥匙裁决）
      //
      // 反例（真实数据）：
      // ```
      // 87f7d090  11-14 11:28 → 11-17 05:10  22 轮 / 2776 字（旧段）
      // a9584d98  11-17 23:03 → 11-18 04:10   2 轮 / 1104 字（新段）
      // ```
      // 新段更短但**更新**，而且它明确推翻了旧段的结论
      // （「上一轮我说视觉方向已完成，这是错的」）。
      // 按「最长」选会锁定在旧段 ⇒ 会话再也无法追加新内容，
      // 且新段的 20 多条结论会被当成「重复」删掉。
      //
      // 「最长」隐含了「更长的就是更新的」，在跨主题阶段时不成立。
      // 纪要的语义是「这个会话到目前为止的记录」—— 活跃的那段才该继续写。
      const latestTs = (m: { created_at?: string | null }): number => {
        const raw = m.created_at ?? '';
        const t = Date.parse(raw);
        return Number.isFinite(t) ? t : 0;
      };
      const sorted = [...found].sort((a, b) => {
        const diff = latestTs(b) - latestTs(a);
        // 时间相同（或缺字段）时退回「更长者优先」，保证确定性
        return diff !== 0 ? diff : b.content.length - a.content.length;
      });
      const primary = sorted[0];
      if (primary === undefined) return true;
      // ## 只在当前账本仍归属该会话时回填
      //
      // 探查有 HTTP 往返，期间用户可能切走会话。此时写全局
      // `minutesMemoryId` 会把 A 的记忆 id 记到 B 头上 ——
      // 下一次 B 的写入就会去 forget A 的纪要。
      if (sessionId !== minutesOwnerSessionId) return true;
      // ## 磁盘在探查期间发生了真实写入 ⇒ 放弃回填（十二轮审查 M3）
      //
      // `writtenAtArchived` 推进说明写链已经成功写过一次，那个新 id
      // 才是当前有效版本；回填旧 id 会覆盖掉它的记录点。
      const diskNow = minutesLedgerStore.load(sessionId);
      const diskWrittenNow = diskNow?.writtenAtArchived ?? -1;
      if (
        diskWrittenNow > diskWrittenBefore ||
        (diskNow?.memoryId ?? '') !== diskMemoryIdBefore
      ) {
        // 写链已在探查期间完成，它写的才是当前有效版本 ——
        // 记下「已探查」避免每轮重复发全库检索（C3）
        setProbedMinutes(sessionId, {
          turns: 0,
          content: '',
          memoryId: '',
          segments: [],
        });
        return true;
      }
      // ## 记下**全部**段的轮数与正文，外加 primary 的 id（七轮 major 3）
      //
      // 合并判定要逐段比 —— 只留 primary 会漏掉「本稿与更旧那段相似」的路径。
      // `turns` 保留 `null`（解析失败）而不是折成 0：0 表示「确实是空壳」，
      // null 表示「规格未知」，两者对保护判据的处置相反（八轮审查 minor）。
      const segments = sorted.map((m) => ({
        turns: parseMinutesTurns(m.content),
        content: m.content,
        id: m.id,
      }));
      const primaryTurns = parseMinutesTurns(primary.content);
      setProbedMinutes(sessionId, {
        turns: primaryTurns ?? 0,
        content: primary.content,
        memoryId: primary.id,
        segments,
      });
      // ## 正文解析不出轮数 ⇒ 不设「完整性基准」，但仍认它（major 4）
      //
      // 轮数未知就没有「更残缺」的判据 —— 记 `null`，`writeMinutes` 会按
      // 「相似度高就拦」处理（无法判断谁更全时，保留库里那份更安全）。
      //
      // ⚠ 但**不能**因此不切换 `memoryId`：账本可能还指向更旧的一段，
      // 那段的来源标记是 `undefined`（未知）⇒ 不会删；但新段若一直不认领，
      // 账本就永远指不到当前活跃的那段。切换 + 标记为 `true` 才是正确状态。
      if (primaryTurns === null) {
        ctx.logger.warn(
          `[lrc] 库里那段纪要格式无法解析轮数（${primary.id.slice(0, 8)}），` +
            `本次不作完整性保护（宁可多一条，也不误删）`,
        );
      }
      // ## 账本指向的不是「最新那段」时切过去（十二轮 C2）
      //
      // 反例（真实案例）：
      // ```
      // 库里 87f7d090(旧段) + a9584d98(新段)
      // 本地账本 memoryId = 87f7d090（更早写下的）
      // ⇒ 旧实现的 `if (minutesMemoryId.length > 0) return` 直接返回
      // ⇒ 永远不知道还有一段更新的
      // ```
      // 判据不能是「memoryId 是否为空」，而是「库里是否有一段更新的」。
      const shouldSwitch = minutesMemoryId !== primary.id;
      if (!shouldSwitch) {
        // ## 账本已指向这段，但来源标记可能是旧版缺失的（八轮审查 C1）
        //
        // 升级路径：上一版构建探查回填 `memoryId=P` 并落盘，但**没有**
        // `memoryIdFromProbe` 键 ⇒ `load` 退化为 false。此时若直接返回，
        // 下一次新建写入就会把 P 当「本稿旧版本」删掉（真实历史）。
        //
        // 判据：本地账本写得比它还短 ⇒ 这段不可能出自本账本 ⇒ 必是捡来的。
        // （`undefined` 已经是「未知 ⇒ 不删」，这里只是把它升级成确定值，
        //  让日志/状态可读；不升级也不会有删除风险。）
        if (minutesMemoryIdFromProbe !== true) {
          const localTurns = minutesWrittenTurns;
          if (primaryTurns !== null && localTurns < primaryTurns) {
            minutesMemoryIdFromProbe = true;
            saveCurrentLedger();
            ctx.logger.info(
              `[lrc] 账本指向的纪要（${primary.id.slice(0, 8)}，${primaryTurns} 轮）` +
                `比本地已写的 ${localTurns} 轮更完整 ⇒ 判定为探查来的历史，标记为不删`,
            );
          }
        }
        return true;
      }
      minutesMemoryId = primary.id;
      // ## 绝不 forget 其它同 event_id 的记录（六钥匙裁决）
      //
      // ## 为什么不再「顺带收敛重复」
      //
      // 早先这里把除 primary 外的所有记录都 `queueForget`，隐含假设
      // 「同 event_id ⇒ 重复」。真实数据推翻了它：
      // ```
      // 87f7d090  11-14 11:28 → 11-17 05:10  22 轮（像素兽视觉阶段）
      // a9584d98  11-17 23:03 → 11-18 04:10   2 轮（4 个整页 + 宽屏架构阶段）
      // 两段**时间窗不重叠、主题不同**，且新段推翻了旧段的结论
      // ```
      // 它们不是同一份内容的两个版本，而是两段真实历史。
      // 用「同 event_id」判重复，会把历史段当垃圾删掉 —— 不可逆。
      //
      // 正确的边界：
      // - `forget` 只用于「**同一次写入**被 LRC 判为新记录」产生的副本
      //   （那才是真的重复，见 `persistLedgerInner` 的 previousId 分支）
      // - 库里本来就存在的多段历史，一律保留
      //
      // ## 而且「探查来的 id」一律不参与 forget（六轮/七轮审查 critical）
      //
      // 这个 id 是**库里另一段历史**的，不是本稿的旧版本。`persistLedgerInner`
      // 以前把 `previousId` 无条件当「本稿旧版本」，于是：
      // ```
      // 探查回填 a9584d98（2 轮，11-17 段）
      // 本次写入 3 轮新主题 ⇒ Jaccard 0.05 < 0.5 ⇒ LRC 新建 mem-N
      // ⇒ newId ≠ previousId ⇒ forget(a9584d98) ❌ 那 2 轮真实历史被删
      // ```
      // 用「账本字段 `memoryIdFromProbe`」标出来源（**必须落盘**：
      // 只在进程内记会因重启而失忆），写入后只更新记录点，绝不删。
      minutesMemoryIdFromProbe = true;
      // ## 它若还挂在待删列表里，必须摘掉（七轮审查 critical 2）
      //
      // 反例：上一版插件曾把这条判为「过时重复」并入队，但 forget 一直失败。
      // 现在探查证明它是**库里还在用的那段** ⇒ 删它就是删真实历史。
      // `retryPendingForget` 在闸门之前执行，所以摘除必须在这之前生效。
      clearForget(sessionId, primary.id);
      saveCurrentLedger();
      ctx.logger.info(
        `[lrc] 会话纪要已从库中回填（${sessionId}）：采用最新一段 ` +
          `${primary.id.slice(0, 8)}（${primaryTurns ?? '?'} 轮，` +
          `起点 ${String(primary.created_at ?? '?').slice(0, 19)}）` +
          (sorted.length > 1 ? `；另保留 ${sorted.length - 1} 段历史记录` : ''),
      );
      return true;
    } catch (error) {
      // 探查失败不影响对话，也不影响后续写入。
      //
      // 用 `warn` 而不是 `info`（十二轮 m9）：探查失败是**可重试**的
      // 异常状态（M1 允许最多 3 次），运维需要能一眼看到。
      ctx.logger.warn(
        `[lrc] 会话纪要探查失败（将重试，不影响对话）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * 把一轮归档进 `turnLedger`。
   *
   * ## 为什么 aborted / error 也要归档
   *
   * 实测 99 轮里 19 轮非正常结束（**19.2%**）。用户中止的轮次同样产生了
   * 真实诉求（「整体上你画的还是太抽象了」），且往往正是**最有价值的反馈**。
   * 丢弃它们等于丢掉一半需求演进史。
   *
   * @param slot   - 待归档的轮次槽位
   * @param reason - 结束原因（`turn/end` 取事件里的 kind；兜底归档用 `'no-end'`）
   */
  function archiveTurn(slot: TurnSlot, reason: string): void {
    // 本轮既没用户发言也没结论 ⇒ 空轮（如纯工具调用被中断），不占纪要槽位
    if (slot.userText.length === 0 && slot.conclusions.length === 0) return;
    if (slot.sessionId !== minutesOwnerSessionId) {
      // 归属已变（切会话后才收尾的旧轮次）：推进它自己的账本文件，
      // 不能污染当前会话。
      const existing = minutesLedgerStore.load(slot.sessionId);
      const turns = mergeTurns([existing?.turns ?? [], [toTurnRecord(slot, reason)]]);
      const merged: MinutesLedgerState = {
        sessionId: slot.sessionId,
        turns,
        // ## 归档计数必须 +1，不能用 `turns.length`（二轮审查 X1）
        //
        // 旧写法 `Math.max(existing.archivedTurns, turns.length)` 在账本饱和后
        // 恒等于 40 —— 而每一轮归档都会挤掉最旧一轮（内容确实在变）。
        // 计数不增 ⇒ `shouldRewriteMinutes` 永远返回 false ⇒ 永不补写。
        archivedTurns: (existing?.archivedTurns ?? 0) + 1,
        writtenAtArchived: existing?.writtenAtArchived ?? -1,
        startedAt: earliestPositive([existing?.startedAt ?? 0, slot.startedAt]),
        writtenTurns: existing?.writtenTurns ?? 0,
        memoryId: existing?.memoryId ?? '',
        // 来源同样随行，否则 `save()` 全量覆盖会把「从库里捡来的」抹成 false
        // （三态必须原样带过：`undefined` = 未知，不能折成 false）
        memoryIdFromProbe: existing?.memoryIdFromProbe,
        // 待删列表必须随账本一起走，否则 `save()` 全量覆盖会抹掉它（八轮审查 M-3）
        pendingForget: existing?.pendingForget ?? [],
        // 阶段稿进度同样随行（十轮审查 C1）
        stageWrittenTurnIdx: existing?.stageWrittenTurnIdx ?? 0,
        updatedAt: Date.now(),
      };
      if (merged.turns.length > TURN_LEDGER_MAX) {
        merged.turns.splice(0, merged.turns.length - TURN_LEDGER_MAX);
      }
      minutesLedgerStore.save(merged);
      // ## 只落盘不够，还要进重试队列（审查 C4 的延伸）
      //
      // 这个会话可能再也不会被切回来（用户关掉就结束了）。只写磁盘等于
      // 「内容留在本地但永不进 LRC」—— 而用户查记忆只查 LRC。
      // 挂进 backlog 后，`retryPendingMinutes`（连接就绪）会把它补写出去。
      if (shouldRewriteMinutes(merged.archivedTurns, merged.writtenAtArchived)) {
        minutesBacklog.delete(merged.sessionId);
        minutesBacklog.set(merged.sessionId, merged);
        trimMinutesBacklog();
      }
      return;
    }
    turnLedger.push(toTurnRecord(slot, reason));
    archivedTurns += 1;
    trimTurnLedger();
    // 每轮归档即落盘：进程崩溃最多丢当前这一轮
    saveCurrentLedger();
    scheduleMinutesIdle();
  }

  function toTurnRecord(slot: TurnSlot, reason: string): TurnRecord {
    return {
      idx: slot.idx,
      startedAt: slot.startedAt,
      // 取最后一次实际活动，而不是归档那一刻（审查 M6）
      endedAt: slot.lastActivityAt > 0 ? slot.lastActivityAt : slot.startedAt,
      reason,
      userText: slot.userText,
      conclusions: slot.conclusions,
    };
  }

  /**
   * 纪要写入的**空闲定时器**（★2026-11-17 独立审查 M5）。
   *
   * ## 为什么必须有
   *
   * 实测每会话轮数 **p50 只有 2 轮**。若触发判据只看「每 N 轮」，
   * 绝大多数会话**永远不会有纪要** —— 而这正是最需要纪要的场景
   * （短会话结束后用户就不再回来，时间线再也没机会落库）。
   *
   * 空闲触发保证：任何会话只要产生过轮次，最迟在 `minutesIdleMs`
   * 后都会落一份纪要。
   */
  let minutesIdleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearMinutesIdle(): void {
    if (minutesIdleTimer !== null) {
      clearTimeout(minutesIdleTimer);
      minutesIdleTimer = null;
    }
  }

  /** 重置空闲计时器：每次有新轮次归档就重新计时。 */
  function scheduleMinutesIdle(): void {
    clearMinutesIdle();
    if (!minutesEnabled || minutesIdleMs <= 0) return;
    minutesIdleTimer = setTimeout(() => {
      minutesIdleTimer = null;
      const owner = minutesOwnerSessionId;
      if (owner.length === 0) return;
      // ## 必须 `force`（2026-11-17 二轮审查 X2）
      //
      // 不传 force 时走的是「满 N 轮才写」判定。实测每会话轮数 **p50 仅 2 轮**，
      // 而 N 默认 5 ⇒ 1~4 轮的短会话在这个分支被拦下，之后定时器已置 null
      // 且**只在 `archiveTurn` 时重排** —— 用户不再说话就没有下一个重排点。
      // 结果恰好是功能最该覆盖的短会话永远没有纪要。
      //
      // 空闲语义本身就是「不再有新内容了，收口吧」，与「攒够 N 轮」无关。
      //
      // ## 轮次仍在飞时不要 force（十轮审查 M1）
      //
      // idle 与阶段写入默认同为 10 分钟 ⇒ 长任务里两者会周期性撞车：
      // idle 的 force 正式稿若**不含在飞轮**，就会覆盖并 forget 掉阶段稿，
      // 然后阶段稿要再等一个周期 —— 等于每次 10 分钟截断一次中间态。
      //
      // 现在 `persistMinutes` 已把所有写入都带上在飞轮（C2 修法），
      // 两者内容一致、不会互相覆盖内容。但 idle 仍不该在长任务中途
      // 触发一次多余的写入，所以这里在「有在飞轮」时让位给阶段写入：
      // 阶段写入有自己的节流，且内容更及时。
      if (liveTurn !== undefined && liveTurn.sessionId === owner) {
        scheduleMinutesIdle();
        return;
      }
      void maybeWriteMinutes(owner, 'idle', true);
    }, minutesIdleMs);
    // 定时器不应阻止 DSH 退出
    minutesIdleTimer.unref?.();
  }

  /**
   * 按「每 N 轮」或「空闲」触发纪要写入。
   *
   * ## 为什么不是每轮都写
   *
   * 纪要走 `remember`（单条 HTTP + 全库相似度扫描），每轮写一次等于
   * 把写入量放大 N 倍，而内容增量只有 1~2 行。
   *
   * ## 为什么必须有这个触发（不能只等会话结束）
   *
   * DSH 没有可靠的「会话结束」事件（实测会话只有 `turn/end` 与
   * `session/end-seed`，后者 data 为空）。用户直接关窗口 / 进程崩溃时，
   * 若只在结束时写，整份纪要永久丢失。
   *
   * @param force - 跳过「N 轮增量」判定（重连补写、切会话冲刷用）
   */
  async function maybeWriteMinutes(
    sessionId: string,
    reason: string,
    force = false,
  ): Promise<void> {
    if (!minutesEnabled) return;
    if (sessionId.length === 0) return;
    if (sessionId !== minutesOwnerSessionId) {
      // 非当前会话：只有 backlog 里存着的待补写内容
      const state = minutesBacklog.get(sessionId);
      if (state !== undefined) await persistLedger(state, reason);
      return;
    }
    // ## 守卫必须把「在飞的那一轮」算进来（十一轮审查 C-2）
    //
    // 旧写法只判 `turnLedger.length === 0` 就直接返回。后果：
    // 新会话的**第一个**轮次就是长任务（实测 30 分钟 / 72 步），
    // 阶段稿已把它写进库，用户关窗 ⇒ dispose(force) ⇒
    // `turnLedger` 仍为空 ⇒ 一次写入都不发，这一轮彻底没有正式稿。
    //
    // 三种来源任一非空就值得写：已归档轮次、在飞/收尾中的轮次、待补写 backlog。
    const hasInflight =
      (liveTurn !== undefined && liveTurn.sessionId === sessionId) ||
      finishingTurns.some((t) => t.sessionId === sessionId);
    if (turnLedger.length === 0 && !hasInflight && !minutesBacklog.has(sessionId)) return;
    if (!force) {
      // ## 首次写入：**有任何轮次就写**（五轮审查 M1）
      //
      // 这里是本功能「持续性」的核心落点，必须讲清楚代价取舍。
      //
      // 反例（修复前必然发生）：
      // ```
      // 用户聊 2 轮（实测 p50 = 2），3 分钟后关窗
      // turn/end ⇒ archivedTurns(2) < minutesEveryTurns(5) ⇒ return
      // 空闲定时器 10 分钟未到期，dispose 时被 clearMinutesIdle() 清掉
      // ⇒ 这份对话【没有任何纪要】，重启后新 sessionId 也不会来 load 旧文件
      // ```
      // 这是用户「没有持续性的记忆是没有意义的」诉求的正面违背。
      //
      // 所以首次写入门槛固定为 **1 轮**：每个会话的第一份纪要一定会落库。
      // 代价是「每会话多一次 remember 调用」—— 而一次会话只会多这一次
      // （之后由 `minutesEveryTurns` 节流），换来「短会话也有时间线」。
      // 这个交换对本功能是必选：没有第一份，后面的节流都无从谈起。
      //
      // ## 阶段稿写成「孤儿」时放行正式稿（十轮审查后保留的唯一特例）
      //
      // 阶段稿会推进 `writtenAtArchived`（口径准确，见 `persistLedgerInner`），
      // 于是轮次结束后 `archivedTurns - writtenAtArchived` 只增加 1，
      // 达不到 `minutesEveryTurns(5)` ⇒ 正式稿被拦 ⇒ 库里永久停在
      // `in-progress`。这里补一个「阶段稿的轮次已彻底结束」的放行条件。
      //
      // ## 判据必须同时排除 `liveTurn` 与 `finishingTurns`
      //
      // `finishTurn` 是 `void` 异步的（内部多次 HTTP），期间该轮既不在
      // `liveTurn` 也不在 `turnLedger`，只在 `finishingTurns`。若只看
      // `liveTurn`，"旧轮收尾中 + 新轮已开"时会误放行，写出一份
      // **不含旧轮**的正式稿去覆盖阶段稿。
      //
      // 另外**不能**写成 `archivedTurns >= stageWrittenTurnIdx`：
      // 宿主轮号（`data.turn`）与归档轮数会分叉（前几轮可能是纯工具调用
      // 无正文），也兼容宿主重连后轮号从 1 重数。
      // ## 必须带 sessionId 校验（十一轮 minor-1）
      //
      // 宿主轮号会跨重连重数（见下方说明），只看 `idx` 会让**别的会话**
      // 里同号的 `liveTurn` 误抑制本会话的放行分支，反之亦然。
      const stageTurnStillActive =
        (liveTurn !== undefined &&
          liveTurn.sessionId === sessionId &&
          liveTurn.idx === minutesStageWrittenTurnIdx) ||
        finishingTurns.some(
          (t) => t.sessionId === sessionId && t.idx === minutesStageWrittenTurnIdx,
        );
      if (minutesStageWrittenTurnIdx > 0 && !stageTurnStillActive) {
        // 落到下面的 `persistMinutes`（等价 force）
      } else if (minutesWrittenAtArchived < 0) {
        if (archivedTurns < 1) return;
      } else if (archivedTurns - minutesWrittenAtArchived < minutesEveryTurns) {
        return;
      }
    }
    await persistMinutes(sessionId, reason);
  }

  /**
   * 计算本次写入后应当保留的「阶段稿标记」。
   *
   * ## 语义
   *
   * 标记 = 「库里那份稿里存在一个尚未收尾的轮次 idx」。它唯一的作用是让
   * `maybeWriteMinutes` 知道「这一轮结束后必须放行正式稿」（否则增量只有 1，
   * 会被「满 N 轮」节流永远拦住，库里永久停在 `in-progress`）。
   *
   * ## 为什么不能简单地「非阶段写入就清零」（十一轮审查 M-1）
   *
   * 清零发生在**正式稿**里，而正式稿本身可能就是「还没收尾」的那一份
   * （例如 dispose 写入时该轮仍在飞）。此时清零等于自毁收尾机制。
   *
   * ## 判据
   *
   * 1. 本次写入的轮次里，有没有 `reason === 'in-progress'` 的？
   *    - 有 ⇒ 那一条就是未收尾的，标记取它的 `idx`
   *    - 无 ⇒ 全部已完成，标记清零（收尾完成）
   * 2. 本次没写任何轮次（`turns` 为空）⇒ 沿用旧标记，不凭空清掉
   *
   * ## 不用「库里有什么」做等价声明（十一轮 minor-2）
   *
   * 这里对非零结果取了 `max(previous, ...)`：宿主重数轮号后，
   * `previous=9` 与本次内容里的 `in-progress idx=3` 会得到 9，
   * 而库里实际存在的是 3。这个偏向是**保守**的（宁可多放行一次），
   * 但意味着「标记 == 库内容里的在飞轮 idx」并不严格成立 —— 不要
   * 在此基础上再加依赖该等式的判据。
   *
   * @param keptTurns  - 本次实际写入的轮次（已裁剪）
   * @param stage      - 本次是否为阶段写入（阶段写入的槽位必然未收尾）
   * @param previous   - 旧标记（来自内存/backlog/磁盘的最大值）
   */
  function nextStageMarker(
    keptTurns: readonly TurnRecord[],
    stage: { slot: TurnSlot } | undefined,
    previous: number,
  ): number {
    // 阶段写入：本次写入必然带着未收尾的那一轮
    if (stage !== undefined) return Math.max(previous, stage.slot.idx);
    // 正式写入：看是否有轮次仍是 in-progress（dispose / 重连补写会遇到）
    let marker = 0;
    for (const t of keptTurns) {
      if (t.reason === 'in-progress' && t.idx > marker) marker = t.idx;
    }
    if (marker > 0) return Math.max(previous, marker);
    // 全部已完成：本次写入已把那一轮收尾，标记可以清掉
    return 0;
  }

  /**
   * 生成并写入当前会话的纪要。
   *
   * ## 为什么用 `remember` 而不是 `migrate`（实测决定）
   *
   * `migrate` 的请求体没有时间字段，LRC 侧硬编码 `source_timestamp: None`
   * ⇒ 落库时间恒为**摄入时刻**。实测写入一条「声称发生在 2026-01-01」的记忆：
   * ```
   * remember → created_at = 2026-01-01  （偏差 0.0 秒）✅
   * migrate  → created_at = 写入当天     （偏差 319.9 天）❌
   * ```
   * 纪要是 65.8 小时会话的产物，若落成「写入瞬间」，时序信息永久丢失。
   *
   * @param reason - 触发原因（日志用）
   */
  async function persistMinutes(
    sessionId: string,
    reason: string,
    stage?: { slot: TurnSlot },
  ): Promise<WriteOutcome> {
    if (!minutesEnabled) return 'skipped';
    // ## 非当前会话不该走这里（十一轮 minor-8）
    //
    // 本函数读的全是当前会话的全局变量（`archivedTurns` /
    // `minutesWrittenAtArchived` / `minutesStartedAt`），与入参 `sessionId`
    // 无关。非当前会话的补写走 `minutesBacklog` + `persistLedger`。
    if (sessionId !== minutesOwnerSessionId) {
      ctx.logger.warn(`[lrc] 纪要写入会话不一致（${sessionId}），已跳过`);
      return 'skipped';
    }
    const backlog = minutesBacklog.get(sessionId);
    // ## 合并 backlog（审查 C4）
    //
    // 旧实现写成功后会 `minutesBacklog.delete(sessionId)`，把积压的轮次
    // **连内容一起删掉** —— 那批轮次从此不在任何地方，永久丢失。
    // 现在写入时先合并，写成功才删。
    //
    // ## 「在飞的那一轮」必须**所有写入都带上**（十轮审查 C2）
    //
    // 早先只有阶段稿带在飞轮，正式稿只带已归档轮次 —— 而库内只保留
    // 一份同 `event_id` 的纪要。于是最关键的退出路径直接丢内容：
    // ```
    // 第 3 轮跑了 25 分钟，阶段稿已把「进行中的第 3 轮」写进库
    // 用户关窗 ⇒ dispose ⇒ maybeWriteMinutes(force=true)
    // 正式稿 = 前 2 轮（不含第 3 轮）
    // 闸门：archivedTurns 相等 ⇒ 放行
    // ⇒ Jaccard < 0.5 时新建第二条并 forget 掉阶段稿（第 3 轮永久丢失）
    //    或 LRC 合并 ⇒ 内容被覆盖成「不含第 3 轮」 ❌
    // ```
    // 现在正式稿同样是阶段稿的超集，闸门的「只增不减」才真正成立。
    //
    // `reason` 用 `in-progress` 标明这轮尚未收尾；轮次真正结束归档后，
    // `turnLedger` 里会有一条同 `idx` 的已完成记录，`mergeTurns` 按
    // `idx@startedAt` 去重，先到的优先 —— 所以这里要先放**已归档**的，
    // 让已完成的那条赢。
    const sources: TurnRecord[][] = [turnLedger, backlog?.turns ?? []];
    // ## 「在飞」有三种状态，必须全部收进来（十一轮审查 C-1）
    //
    // ```
    // 1. liveTurn        —— 本轮正在跑（长任务期间）
    // 2. finishingTurns  —— turn/end 已到，但 finishTurn 还没跑完
    //                       （内部多次 HTTP，实测可达秒级）
    // 3. 都没有          —— 该轮已归档进 turnLedger
    // ```
    // 上一版只处理了 1，于是 `turn/end` 之后、`finishTurn` 完成之前
    // 关窗（dispose）会写出一份**不含该轮**的正式稿去覆盖阶段稿 ——
    // 与 C2 完全同构，只是时间窗从「整轮」缩到「收尾的几秒」。
    //
    // `mergeTurns` 按 `idx@startedAt` 去重且先到者优先，所以这里把
    // 已归档的放最前：该轮归档后自动以「已完成」那条为准，不会重复。
    const inflightSlot =
      stage !== undefined
        ? stage.slot
        : liveTurn !== undefined && liveTurn.sessionId === sessionId
          ? liveTurn
          : undefined;
    if (inflightSlot !== undefined) sources.push([toTurnRecord(inflightSlot, 'in-progress')]);
    for (const slot of finishingTurns) {
      if (slot.sessionId === sessionId && slot !== inflightSlot) {
        sources.push([toTurnRecord(slot, 'in-progress')]);
      }
    }
    const merged = mergeTurns(sources);
    if (merged.length === 0) return 'skipped';
    // ## 合并结果必须裁剪到上限（2026-11-17 二轮审查 X1）
    //
    // 两份账本各 ≤ `TURN_LEDGER_MAX`，合并后可达 2 倍。若不裁剪，
    // 账面轮数与真实进度脱节（并且曾经把 `writtenTurns` 记成 80，
    // 使闸门永久失效）。裁剪后轮数恒 ≤ 上限。
    const kept = merged.length > TURN_LEDGER_MAX ? merged.slice(-TURN_LEDGER_MAX) : merged;
    const state: MinutesLedgerState = {
      sessionId,
      turns: kept,
      archivedTurns: Math.max(archivedTurns, backlog?.archivedTurns ?? 0),
      writtenAtArchived: Math.max(minutesWrittenAtArchived, backlog?.writtenAtArchived ?? -1),
      startedAt: earliestPositive([
        minutesStartedAt,
        backlog?.startedAt ?? 0,
        merged[0]?.startedAt ?? 0,
      ]),
      // ## `writtenTurns` 只增不减，不能 clamp（三段审查 M1）
      //
      // 曾经写成 `Math.min(max(...), kept.length)`，本意是「保证闸门不自锁」。
      // 但它在「恢复出较短账本」时把计数压小：
      // ```
      // 库里已有 40 轮纪要，本地账本被外部清空/旧版本文件只有 6 轮
      // clamp ⇒ writtenTurns = 6 ⇒ 闸门 canOverwriteMinutes(6, 6) 放行
      // ⇒ 6 轮稿覆盖 40 轮（Jaccard≈0.15 不合并 ⇒ 同 event_id 两条）❌
      // ```
      // 现在保持单调，让 `canOverwriteMinutes` 拦住更短稿；
      // 饱和情形（`nextTurns >= maxTurns`）已由闸门内置放行，不需要 clamp 兜底。
      writtenTurns: Math.max(minutesWrittenTurns, backlog?.writtenTurns ?? 0),
      // 上次写入的记忆 ID：优先用非空值（backlog 可能来自旧版文件）
      memoryId: minutesMemoryId.length > 0 ? minutesMemoryId : (backlog?.memoryId ?? ''),
      // ## 来源必须跟着走（七轮审查 critical 1）
      //
      // 漏带会让这次写入把账本里的 `true` 抹成 `false` ⇒ 下次写入时
      // 账本指向的「库里那段历史」被当成本稿旧版本删掉。
      memoryIdFromProbe:
        minutesMemoryId.length > 0
          ? minutesMemoryIdFromProbe
          : backlog?.memoryIdFromProbe,
      // 待删列表同样要随行（八轮审查 M-3）
      //
      // 用入参 `sessionId` 而不是 `minutesOwnerSessionId`（十一轮 minor-2）：
      // 当前 `persistMinutes` 只被 owner 调用，两者恒等；但 `persistLedger`
      // 明确支持非当前会话，这行随时会被踩成「把 A 的待办写给 B」。
      pendingForget: [
        ...new Set([
          ...(minutesPendingForget.get(sessionId) ?? []),
          ...(backlog?.pendingForget ?? []),
        ]),
      ],
      // ## 阶段标记的清除条件：只有「那一轮真的写完了」才清（十一轮审查 M-1）
      //
      // 早先写成 `stage === undefined ? 0 : ...` —— 任何一次非阶段写入
      // 都会清零。而清零会让「阶段稿抢跑后放行正式稿」的收尾机制失效：
      // ```
      // t0 第 5 轮阶段稿成功 ⇒ 库=t1..t4+t5(in-progress)，marker=5
      // t1 某次 force 正式稿（重连补写/dispose）⇒ marker 被清成 0
      // t2 第 5 轮 turn/end ⇒ 增量 1 < everyTurns(5) ⇒ 正式稿被拦
      // ⇒ 库里永久停在带 (in-progress) 的那一行 ❌
      // ```
      // 正确语义：标记代表「库里有一份未收尾的稿」。只要本次写入的内容里
      // 该 `idx` 仍是 `in-progress`，标记就必须留着。
      stageWrittenTurnIdx: nextStageMarker(kept, stage, backlog?.stageWrittenTurnIdx ?? 0),
      updatedAt: Date.now(),
    };
    return await persistLedger(state, reason, stage);
  }

  /**
   * 轮内**阶段写入**：一轮尚未 `turn/end` 时，定期把「进行中的这一轮」落进库。
   *
   * ## 为什么必须存在（2026-11-17 DSH 实测缺口）
   *
   * 纪要原本的触发点全部在轮末：`turn/end`、idle 定时器（只在
   * `archiveTurn` 里重排）、`dispose`。实测一轮工具密集型任务跑了
   * **30 分钟 / 72 步**仍未 `turn/end` —— 这期间没有任何纪要可回溯。
   * 若之后崩溃或用户直接关窗，这一整轮（往往正是最花时间的那轮）
   * 永久丢失。
   *
   * ## 节流口径：按轮开始时间
   *
   * 用「距离本轮开始是否已过 `minutesStageMs`」判定，而不是固定周期 ——
   * 这样短轮次永远不会触发阶段写入（零额外开销），
   * 而长轮次每 `minutesStageMs` 落一份。
   */
  /** 上次阶段写入的时刻（0 = 从未写过）。 */
  let lastMinutesStageAt = 0;
  /** 上一次阶段写入尝试时该轮的结论条数（用于判断「内容有没有增长」）。 */
  let lastMinutesStageConclusionCount = 0;
  /** 上一次阶段写入尝试时该轮的诉求字符数（用户中途补充也算增长）。 */
  let lastMinutesStageUserChars = 0;

  function maybeWriteStageMinutes(): void {
    // 先做过期兜底：卡死的收尾槽位会污染后面所有写入（十一轮审查 M-B）
    expireStuckFinishingTurns();
    if (!minutesEnabled || minutesStageMs <= 0) return;
    const slot = liveTurn;
    if (slot === undefined) return;
    if (slot.sessionId !== minutesOwnerSessionId) return;
    // 空轮（既无发言也无结论）不写：否则库会被「进行中·空」的壳占位
    if (slot.userText.length === 0 && slot.conclusions.length === 0) return;
    const now = Date.now();
    // 距上次阶段写入不足间隔 ⇒ 跳过
    if (lastMinutesStageAt > 0 && now - lastMinutesStageAt < minutesStageMs) return;
    // 本轮刚建立不足间隔 ⇒ 跳过（避免短轮次也被写一份中间态）
    if (now - slot.startedAt < minutesStageMs) return;
    // ## 内容没增长就跳过
    //
    // 「增长」两个维度都要看：结论条数（助手产出）与诉求字符数
    // （用户中途补充要求）。只看前者会漏掉「用户追加了要求但助手
    // 还没给出新结论」这一段 —— 而这恰恰是长任务里最常见的中期状态。
    const grew =
      minutesStageWrittenTurnIdx !== slot.idx ||
      slot.conclusions.length !== lastMinutesStageConclusionCount ||
      slot.userText.length !== lastMinutesStageUserChars;
    if (!grew) return;
    // ## 先记节流，失败后由返回值回滚（十一轮审查 M-2）
    //
    // 若只在成功时更新节流时间，失败会在下一步立刻重试 —— 而
    // 「每步一次全库相似度扫描」是不可接受的。
    // 若只更新不回滚，一次失败会让阶段稿**基本停摆**（结论稀疏的工具
    // 密集型轮次可能几十分钟都不再增长，判据恒跳过）。
    //
    // ⚠ 必须消费 `persistMinutes` 的**三态返回值**（十一轮审查 M-A）
    //
    // `persistLedger` 内部永不 reject（所有错误都转成返回值），所以
    // `.then` 的第二个回调永不执行 —— 上一版就是这么写的，回滚是死代码。
    // 而只判 `ok === false` 又过宽：`skipped`（闸门拦住 / 无可写内容）
    // **不是失败**，回滚会让下一步立刻重试 —— 配合「每步都跑」的调用点，
    // 等于每步一次全库相似度扫描。
    //
    // 只有 `failed`（连接不可用 / HTTP 抛错）才回滚，且回滚后
    // 由 `retryPendingMinutes`（连接就绪 / 每 60 步）负责真正的重试节奏。
    const prevConclusions = lastMinutesStageConclusionCount;
    const prevUserChars = lastMinutesStageUserChars;
    const prevAt = lastMinutesStageAt;
    lastMinutesStageAt = now;
    lastMinutesStageConclusionCount = slot.conclusions.length;
    lastMinutesStageUserChars = slot.userText.length;
    void persistMinutes(minutesOwnerSessionId, '轮内阶段', { slot }).then((outcome) => {
      if (outcome !== 'failed') return;
      // 真失败：回滚指纹与节流时间，让下一周期能重试同一份内容
      lastMinutesStageConclusionCount = prevConclusions;
      lastMinutesStageUserChars = prevUserChars;
      lastMinutesStageAt = prevAt;
    });
  }

  /**
   * 写入一份账本状态（**只增不减闸门在这里**）。
   *
   * 当前会话与非当前会话（backlog 补写）共用这一条路径，
   * 保证「闸门、失败回退、成功后计数」三件事只有一份实现。
   *
   * ## 同会话串行（七轮审查 M-1）
   *
   * `turn/end`、空闲定时器、`retryPendingMinutes`、`dispose` 都是 `void`
   * 调用，同一会话可能有两条写链同时在飞。若它们**乱序完成**：
   * ```
   * W1(id1, 3 轮) 先发出    W2(id2, 4 轮) 后发出
   * W2 先返回 ⇒ minutesMemoryId = id2
   * W1 后返回 ⇒ previousId(=刚开始读的 id0/id2) ≠ id1 ⇒ forget(id2) ❌
   * ```
   * 结果：删掉内容更新的那条，保留更旧的。所以必须按 sessionId 串行。
   */
  async function persistLedger(
    state: MinutesLedgerState,
    reason: string,
    stage?: { slot: TurnSlot },
  ): Promise<WriteOutcome> {
    const sessionId = state.sessionId;
    if (state.turns.length === 0) return 'skipped';
    // 同会话排队：前一条写完后才开始，避免乱序覆盖 / 误删
    const previous = minutesWriteQueue.get(sessionId) ?? Promise.resolve();
    let outcome: WriteOutcome = 'failed';
    const current = previous
      .catch(() => {
        // 前一条失败不影响本条（它内部已处理过 stash）
      })
      .then(async () => {
        outcome = await persistLedgerInner(state, reason, stage);
      })
      .catch((error: unknown) => {
        // ## 永不 reject（八轮审查 m-8）
        //
        // 绝大多数调用点是 `void persistLedger(...)` —— 一旦 reject 就是
        // unhandledRejection，Node 默认直接终止进程。
        // `persistLedgerInner` 内部已有 try/catch，这里是最后一道兜底：
        // 兜住的是「catch 块自身抛错」（落盘异常等）这类边缘情形。
        outcome = 'failed';
        ctx.logger.warn(
          `[lrc] 会话纪要写入收尾异常（不影响对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    minutesWriteQueue.set(sessionId, current);
    try {
      await current;
    } finally {
      // 队列尾巴清理：只有「我仍是最新那条」才删，避免删掉后加入的
      if (minutesWriteQueue.get(sessionId) === current) {
        minutesWriteQueue.delete(sessionId);
      }
    }
    return outcome;
  }

  /** 同会话写入队列（sessionId → 队尾 promise）。 */
  const minutesWriteQueue = new Map<string, Promise<void>>();

  /**
   * 待删除的过时记忆 ID（按会话暂存，落盘进账本）。
   *
   * 七轮审查 M-2：`forget` 失败时若不记下，旧 id 在 `memoryId` 更新后
   * 再无记录点 —— 那条 importance=9 的过时纪要将永久滞留库里，
   * 正是「一份对话一份纪要」要消灭的对象。
   */
  const minutesPendingForget = new Map<string, string[]>();
  /** 待删列表上限（八轮审查 m-7：防止持续失败导致无界增长）。 */
  const MINUTES_PENDING_FORGET_MAX = 20;

  /** 正在删除中的 id（防止同一 id 被并发重发，八轮审查 m-7）。 */
  const forgetInFlight = new Set<string>();

  /** 把待删 id 记入内存 + 账本文件。 */
  function queueForget(sessionId: string, memoryId: string): void {
    const list = minutesPendingForget.get(sessionId) ?? [];
    if (!list.includes(memoryId)) list.push(memoryId);
    // ## 上限保护（八轮审查 m-7）
    //
    // 若 LRC 侧某条 id 永远删不掉（持续 500），列表会随会话无限增长，
    // 每次写入都重试一遍 ⇒ 请求量按写频率放大。
    // 只保留最近 20 个：更早的已经跨越几十轮，即使残留也几乎不会被召回。
    if (list.length > MINUTES_PENDING_FORGET_MAX) {
      list.splice(0, list.length - MINUTES_PENDING_FORGET_MAX);
    }
    minutesPendingForget.set(sessionId, list);
    // 落盘：账本是这些 id 的唯一持久记录
    const onDisk = minutesLedgerStore.load(sessionId);
    if (onDisk !== null) {
      const merged = [...new Set([...onDisk.pendingForget ?? [], ...list])].slice(
        -MINUTES_PENDING_FORGET_MAX,
      );
      minutesLedgerStore.save({ ...onDisk, pendingForget: merged });
    } else if (sessionId === minutesOwnerSessionId) {
      // ## 磁盘上还没有该会话的账本时，用内存账本兜底落盘（九轮审查 minor）
      //
      // 直接 `return` 会让待办只活在内存里 —— 进程一重启就丢。
      // 当前会话有完整的内存账本可写，直接复用它的落盘路径。
      saveCurrentLedger();
    }
  }

  /** 从内存与账本里移除已成功的 id。 */
  function clearForget(sessionId: string, memoryId: string): void {
    const list = (minutesPendingForget.get(sessionId) ?? []).filter((id) => id !== memoryId);
    if (list.length === 0) minutesPendingForget.delete(sessionId);
    else minutesPendingForget.set(sessionId, list);
    const onDisk = minutesLedgerStore.load(sessionId);
    if (onDisk !== null) {
      minutesLedgerStore.save({
        ...onDisk,
        pendingForget: (onDisk.pendingForget ?? []).filter((id) => id !== memoryId),
      });
    }
  }

  /**
   * 删除一条过时纪要；失败则记入待办（下次写入前重试）。
   *
   * 不 `await`：清理是补偿动作，不能阻塞或影响「本次写入已成功」这件事。
   */
  function forgetWithRetry(
    client: Pick<LrcClient, 'forget'>,
    sessionId: string,
    memoryId: string,
  ): void {
    // 同一 id 只允许一条在飞请求（八轮审查 m-7）
    if (forgetInFlight.has(memoryId)) return;
    forgetInFlight.add(memoryId);
    void client
      .forget(memoryId)
      .then(
        (outcome) => {
          // 幂等：已删除（`alreadyDeleted`）也算成功，不必再重试
          if (outcome.deleted || outcome.alreadyDeleted) {
            clearForget(sessionId, memoryId);
            if (outcome.deleted) {
              ctx.logger.info(
                `[lrc] 会话纪要去重：删除过时版本 ${memoryId.slice(0, 8)}` +
                  `（新稿与它内容差异过大，LRC 未自动合并）`,
              );
            }
            return;
          }
          queueForget(sessionId, memoryId);
        },
        () => {
          // ## 失败必须留待办（七轮审查 M-2）
          queueForget(sessionId, memoryId);
          ctx.logger.info(
            `[lrc] 会话纪要去重推迟：${memoryId.slice(0, 8)} 删除失败，已记入待办`,
          );
        },
      )
      .catch((error: unknown) => {
        // 兜住回调自身抛错（例如落盘异常），否则会是 unhandledRejection（m-8）
        ctx.logger.warn(
          `[lrc] 纪要去重收尾异常（不影响对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        forgetInFlight.delete(memoryId);
      });
  }

  /** 重试该会话所有待删 id（每次写入前调用，代价极低）。 */
  function retryPendingForget(
    client: Pick<LrcClient, 'forget'>,
    sessionId: string,
  ): void {
    const inMemory = minutesPendingForget.get(sessionId) ?? [];
    const onDisk = minutesLedgerStore.load(sessionId)?.pendingForget ?? [];
    // ## 账本当前指向的那个 id 一律不删（七轮审查 critical 2）
    //
    // 反例：上一版插件曾把库里那段判成「过时重复」并入队，forget 一直失败。
    // 现在探查/写入证明它是**当前有效的那段** ⇒ 重试删它就是删真实历史。
    // 一旦它在待删列表里，必须当场摘掉而不是等下一轮。
    //
    // ## 只护这一个，不护 `segments`（八轮 M1 的修法回退）
    //
    // `segments` 来自 `recall`，而 LRC 会把**本插件自己刚写的记录**也返回。
    // 把它们一并护住会让「自写副本」永远删不掉 ⇒ 每轮多一条过时纪要
    // （正是 M-A 要消灭的问题，已实测复现）。真实历史那一段由
    // `memoryIdFromProbe` + `previousFromProbe` 保护，不依赖这里。
    const currentId =
      sessionId === minutesOwnerSessionId
        ? minutesMemoryId
        : (minutesLedgerStore.load(sessionId)?.memoryId ?? '');
    for (const id of new Set([...inMemory, ...onDisk])) {
      if (id.length === 0) continue;
      if (id === currentId) {
        clearForget(sessionId, id);
        continue;
      }
      forgetWithRetry(client, sessionId, id);
    }
  }

  /** `persistLedgerInner` 的返回语义（十一轮审查 M-A）。 */
  type WriteOutcome =
    | 'written' // 真的写进库了
    | 'skipped' // 正常跳过（闸门拦住 / 无可写内容）—— **不是失败，不要重试**
    | 'failed'; // 真失败（连接不可用 / HTTP 抛错）—— 可以重试

  /** `persistLedger` 的实际实现（已保证同会话串行）。返回写入结果三态。 */
  async function persistLedgerInner(
    state: MinutesLedgerState,
    reason: string,
    stage?: { slot: TurnSlot },
  ): Promise<WriteOutcome> {
    const sessionId = state.sessionId;
    // ## 待办重试必须排在闸门**之前**（八轮审查 m-9）
    //
    // 闸门可能长期拦住写入（例如本稿比库里短）。若重试逻辑放在闸门之后，
    // 那个会话的待删 id 就永远不会被重试 —— 过时纪要永久滞留。
    // 重试是独立动作，与「本次要不要写」无关。
    {
      const client = connection.peek();
      if (client !== null) retryPendingForget(client, sessionId);
    }
    // ── 只增不减 ──
    //
    // ## 判据用单调的 `archivedTurns`，不用 `turns.length`（三段审查 M1）
    //
    // `turns.length` 会被 40 轮上限钳住，恢复出短账本时还会变小 ——
    // 用它判「这次写的是不是比库里更全」在饱和与恢复两种情形下都失真。
    // `state.archivedTurns` 只增不减，是唯一可靠口径：
    // ```
    // 库里已写到第 40 个归档轮次；本次稿含第 41 个 ⇒ 41 > 40，放行
    // 本次稿只含第 6 个（旧账本）        ⇒ 6 < 40，跳过，保留完整版
    // ```
    // 本次稿的「库里已写到哪」取三方最大（九轮审查 m-5 的防御性修法）
    //
    // 入队时快照的 `writtenAtArchived` 可能低于队列里更早那条写成功后
    // 推进的值。偏低会**放松**闸门（`next >= written` 更容易成立），
    // 理论上可能让短稿覆盖长稿。磁盘上的值是最权威的，取 max 挡掉这条缝。
    const diskWritten = minutesLedgerStore.load(sessionId)?.writtenAtArchived ?? -1;
    const writtenFloor = Math.max(state.writtenAtArchived, diskWritten);
    // ⚠ 阶段稿**不需要**特殊闸门（十轮审查 C1/M2 后的简化）
    //
    // 早先给阶段稿单开了一套「按宿主轮号单调比较」的闸门，理由是
    // 「阶段写入不推进 `writtenAtArchived`，所以 `nextArchived >= written`
    // 永远不成立」。但那个前提已被推翻：阶段稿写入的确实是「截至上一轮的
    // 完整内容 + 在飞那一轮」，`archivedTurns` 口径完全成立，照常推进即可。
    // 推进后 `nextArchived === writtenFloor` ⇒ `>=` 天然成立 ⇒ 直接放行。
    //
    // 删掉那套判据还顺手消灭了两个缺陷：
    // 1. 宿主轮号不保证单调（重连/重启会从 1 重数）⇒ 高轮号阶段稿会把
    //    后续所有新轮永久拦住；
    // 2. 两套口径不一致时，阶段稿可能覆盖掉更长的正式稿。
    if (!canOverwriteMinutes(writtenFloor, state.archivedTurns, TURN_LEDGER_MAX)) {
      ctx.logger.info(
        `[lrc] 会话纪要跳过写入：本稿归档到第 ${state.archivedTurns} 轮 < 已写 ` +
          `第 ${writtenFloor} 轮（保留库里的完整版）`,
      );
      // 闸门拦住是**正常跳过**，不是失败：重试也不会变（库里那份更长），
      // 反而会让阶段写入按每步一次地空转（十一轮审查 M-A）
      return 'skipped';
    }
    // 用**实际生效的**下界作为本次写入的进度标记：否则成功后会把
    // `writtenAtArchived` 往低处写，下次闸门又变松。
    const archivedAtWrite = Math.max(state.archivedTurns, 0);
    try {
      // 与其它写路径同口径：用 `connection.get()` 拿客户端（内部处理重连）。
      // `get()` 在退避窗口内确定返回 null（`Recoverable.get` 签名是 `T | null`）。
      const client = await connection.get();
      if (client === null) {
        stashMinutes(state, `LRC 未就绪：${state.turns.length} 轮，待重连后补写`);
        // 连接不可用属于**可重试失败**，但阶段写入的重试由
        // `retryPendingMinutes`（连接就绪 / 每 60 步）负责，
        // 不该让 `maybeWriteStageMinutes` 每步都撞一次（M-A）
        return 'failed';
      }
      // ## 写入前拦「更残缺的稿」（十四轮审查 C2）
      //
      // 必须**在写入前**拦，不能写后再判：LRC 在 Jaccard ≥ 0.5 时会
      // 合并并**整体替换**内容（`apply_merge` → `update_content`，
      // 不做长度保护）。写后再 forget 也没用 —— 库里那份更完整的
      // 内容已经被覆盖，无法回滚。
      //
      // `probedMinutes.segments` 是库里**全部**同 event_id 段的轮数与正文。
      // `writeMinutes` 会挑相似度最高的那段当基线，把它的诉求行与结论
      // 并入本稿（grow-only）⇒ 发出的 content 是那段内容的**超集**。
      // 因此 LRC 的「合并并整体替换」不再会丢数据（六钥匙裁决）。
      //
      // ## 基准缺失时必须同步再探一次（八轮审查 M2）
      //
      // `recall` 与 `remember` 是两个端点：LRC 在线但 enrich 返回 503 时，
      // 探查失败 3 次后额度耗尽，而写入照常可用。此时账本丢失的会话
      // 首份残稿会在**没有任何基准**的情况下发出 —— 相似度 ≥ 0.5 时
      // `apply_merge` 直接整体覆盖库里那份 22 轮纪要（不可逆）。
      //
      // 兜底只做一次、只在「真的一无所知」时：账本没有 memoryId，
      // 也没有探查结果。仍失败则放行并留痕（宁可多一条，也不误删那条路
      // 已经由 `memoryIdFromProbe` 守住，这里守的是「覆盖」）。
      let effective = probedMinutes.get(sessionId);
      if (effective === undefined && (state.memoryId ?? '').length === 0) {
        await probeExistingMinutes(client, sessionId);
        effective = probedMinutes.get(sessionId);
      }
      const isCurrentSession = sessionId === minutesOwnerSessionId;
      const result = await writeMinutes(client, sessionId, state.turns, {
        project: config.project,
        startedAt: state.startedAt,
        ...(effective === undefined ? {} : { existingSegments: effective.segments }),
      });
      if (result.unchanged === true) {
        // ## 拼完基线后与库里那段一字不差（六钥匙裁决）
        //
        // 这是「账本丢失后重放旧内容」的正常结局，不是失败也不是「被拦」。
        // **必须推进进度计数**：否则 `shouldRewriteMinutes` 恒判「有增量」，
        // 每一轮都重新拼一遍再比对，白做一次全量相似度计算。
        ctx.logger.info(
          `[lrc] 会话纪要与库内那段完全一致（${result.turns} 轮），无需写入`,
        );
        if (isCurrentSession) {
          minutesWrittenTurns = Math.max(minutesWrittenTurns, state.turns.length);
          minutesWrittenAtArchived = Math.max(minutesWrittenAtArchived, archivedAtWrite);
          minutesMemoryId = state.memoryId || minutesMemoryId;
          saveCurrentLedger();
        }
        // ## 同样要消费 backlog（十轮审查 major 4）
        //
        // 反例：上次写入超时但服务端其实已提交 ⇒ `stashMinutes` 入队；
        // 重试时内容已在库 ⇒ 走这里返回 `skipped`。若不删 backlog，
        // 该条目会永久滞留，`retryPendingMinutes` 每 60 步重算一次
        // 全量相似度（纯浪费）。
        if (stage === undefined) {
          const pending = minutesBacklog.get(sessionId);
          if (pending === undefined || pending.archivedTurns <= archivedAtWrite) {
            minutesBacklog.delete(sessionId);
          }
        }
        return 'skipped';
      }
      if (!result.written) {
        // 没有可写内容（如全是机器输出被过滤），**不算失败**也不推进计数
        return 'skipped';
      }
      // ## 计数只回写「当前账本」（审查 C2 的连带修正）
      //
      // `persistLedger` 也服务于**非当前会话**的补写（backlog / 切会话冲刷）。
      // 那些 `await` 可能在切到别的会话之后才 resolve —— 无条件写全局
      // `minutesWrittenAtArchived` 会把旧会话的进度记到新会话头上，
      // 导致新会话误判「已经写过这么多轮」而跳过写入。
      //
      // ## `writtenTurns` 是**展示用**，不参与闸门（三段审查 M1）
      //
      // 闸门已改用 `writtenAtArchived`（单调）。这里的 `writtenTurns` 只用于
      // `lrc_status` 显示「写了多少轮」—— 因此它可以安全地取
      // `min(turns.length, ...)`，不会影响任何写入决策。
      const isCurrent = sessionId === minutesOwnerSessionId;
      // ## 清理重复纪要（六轮审查 M-A）
      //
      // ## 为什么会出现重复
      //
      // LRC 的写入不是 `event_id` 覆盖，而是「内容 Jaccard ≥ 0.5 才合并」。
      // 首轮纪要（1 行诉求，约 250 bigram）与第 3 轮纪要（约 450）交集约 180
      // ⇒ Jaccard ≈ 0.35 **< 0.5 ⇒ 不合并**，库里出现两条同 event_id 的纪要：
      // 一条停在 1 轮的过时版本（importance=9，会被召回），一条是新的。
      //
      // ## 修法
      //
      // 记住上次写入返回的 `memory_id`。本次返回的 id 若与之不同，
      // 说明 LRC 新建了一条 ⇒ `forget(旧 id)`，保证库里恒为 1 条。
      // 旧 id 为空（旧版账本 / 首次写入）时跳过 —— 宁可多一条也不误删别人的记忆。
      //
      // ## 删除失败必须留下待办（七轮审查 M-2）
      //
      // 只写空 catch 是不够的：随后 `minutesMemoryId = newId`，旧 id 再无记录点
      // ⇒ 那条 importance=9 的过时纪要将永久滞留库里（正是 M-A 要消灭的对象）。
      // 把失败的 id 记进 `pendingForget` 并落盘，下次任何写入前先重试。
      // ## 「更残缺的稿」已在写入前被拦掉（十四轮 C2）
      //
      // 早先这里是「写后判断 + 反过来 forget 新稿」，但那只对
      // 「LRC 新建」的分支有效；LRC 在 Jaccard ≥ 0.5 时走的是
      // **合并并整体替换**，此时 `newId === previousId`，两个分支都不进，
      // 而库里那份更完整的内容已经被覆盖 —— 无法回滚。
      // 现在保护前移到 `writeMinutes` 内部（相似度 + 轮数双判据）。
      //
      // ## 但 `previousId` 可能根本不是「本稿的旧版本」（六轮审查 critical 1）
      //
      // 冷启动探查会把它回填成**库里另一段历史**的 id（不同时间窗）。
      // 若照旧无条件 forget，就是删掉那段真实历史：
      // ```
      // 探查回填 a9584d98（2 轮，11-17 段）
      // 本次写 3 轮新主题 ⇒ LRC 新建 mem-N ⇒ newId ≠ previousId
      // ⇒ forget(a9584d98) ❌ 不可逆
      // ```
      // ## 只有「确认是自己写的」才允许 forget（八/九轮审查 M-1）
      //
      // 判据读**账本字段**（已落盘）而不是进程内 Set：重启后账本仍指向
      // 探查来的 id，若按 Set 判断会漏 ⇒ 照删（真实历史不可逆丢失）。
      //
      // `memoryIdFromProbe` 是三态：
      // - `true`      ⇒ 探查来的，**不删**
      // - `undefined` ⇒ 来源未知（旧版账本），**也不删**（宁可多一条）
      // - `false`     ⇒ 确认是自己写的 ⇒ 才是可清理的旧副本
      const previousId = isCurrent ? minutesMemoryId : (state.memoryId || '');
      const newId = result.memoryId;
      const previousSource = isCurrent ? minutesMemoryIdFromProbe : state.memoryIdFromProbe;
      const previousFromProbe = previousId.length > 0 && previousId !== newId && previousSource !== false;
      if (previousFromProbe) {
        // 只更新记录点（下面 `minutesMemoryId = newId` 会做），不删任何东西。
        ctx.logger.info(
          `[lrc] 会话纪要新增一段（${newId.slice(0, 8)}）：` +
            `保留库里原有那段历史 ${previousId.slice(0, 8)}（不同时间窗不是重复）`,
        );
      }
      if (
        previousId.length > 0 &&
        newId.length > 0 &&
        newId !== previousId &&
        !previousFromProbe
      ) {
        // ## 若新 id 恰好在待删列表里，只清理待办、不删它（八轮审查 m-6）
        //
        // LRC 可能把内容合并进一条「之前被判为过时、还没删掉」的记录并返回它。
        // 此时 `newId` 就是那条 —— 再 `forget(newId)` 会删掉刚写入的纪要。
        const pendingIds = new Set([
          ...(minutesPendingForget.get(sessionId) ?? []),
          ...(minutesLedgerStore.load(sessionId)?.pendingForget ?? []),
        ]);
        if (pendingIds.has(newId)) {
          // 新 id 曾被视为过时但没删成 —— 现在 LRC 把内容合并进了它。
          // 只清待办（不能再删它），但**仍要删掉上一版**（九轮审查 m-6）：
          // 否则 `memoryId` 改成 newId 后，`previousId` 再无记录点，
          // 库里会长期留着上一版（importance=9）。
          clearForget(sessionId, newId);
          if (previousId !== newId) {
            forgetWithRetry(client, sessionId, previousId);
          }
        } else {
          forgetWithRetry(client, sessionId, previousId);
        }
      }
      if (isCurrent) {
        minutesWrittenTurns = Math.max(minutesWrittenTurns, state.turns.length);
        // ## 进度口径：`archivedTurns` 只统计已完成轮次
        //
        // 阶段稿带的那一轮是 `in-progress`，不进 `archivedTurns`，
        // 所以推进 `writtenAtArchived` 是准确的，不会虚报「已完成」。
        minutesWrittenAtArchived = Math.max(minutesWrittenAtArchived, archivedAtWrite);
        // ## 阶段标记以 `state` 里的值为准（十一轮审查 M-1）
        //
        // 早先这里是 `stage === undefined ? 0 : stage.turnIdx` —— 与
        // `nextStageMarker` 是两套口径，且「正式稿一律清零」会让
        // 「阶段稿抢跑后放行正式稿」的收尾机制自毁（见 `nextStageMarker`）。
        //
        // `state.stageWrittenTurnIdx` 已由 `nextStageMarker` 算好：
        // - 本次写入仍含 in-progress ⇒ 保留该 idx
        // - 全部已完成 ⇒ 0（收尾完成，允许回落）
        minutesStageWrittenTurnIdx = state.stageWrittenTurnIdx ?? 0;
        // ## 用本次实际写入的轮数与正文刷新「库内那一份」（十四轮 C1）
        //
        // 不能 delete：库里现在就是 `result.turns` 轮 / 这段正文。若删掉，
        // 下一次残稿就失去保护，会把这份刚写好的内容覆盖掉
        // （「只防一次等于没防」）。
        //
        // 段列表按 id 更新：本次写入可能**新建**了一段（跨主题），也可能
        // **合并进**了某段。两种情形都必须让基准反映库里的真实状态。
        {
          const prevSegments = probedMinutes.get(sessionId)?.segments ?? [];
          const others = prevSegments.filter((s) => s.id !== newId);
          setProbedMinutes(sessionId, {
            turns: result.turns,
            content: result.content,
            memoryId: newId,
            segments: [...others, { turns: result.turns, content: result.content, id: newId }],
          });
        }
        // ## 新记录点是**自己写入得到的** ⇒ 来源复位（critical 1）
        //
        // 不复位会让「永不 forget」永久生效 ⇒ 这条纪要以后每次更新都
        // 会额外留一条过时副本（反而是 M-A 要消灭的问题）。
        // 注意：真实历史已由上面的 `previousFromProbe` 分支保住了。
        minutesMemoryIdFromProbe = false;
        minutesMemoryId = newId;
        saveCurrentLedger();
      } else {
        // 非当前会话：把「已写到第几个归档轮次」写回它自己的账本文件，
        // 下次恢复时闸门才准确。
        //
        // ## 库内那一份同样要刷新（十四轮审查 M1）
        //
        // 之前这里只写 `memoryId: newId`，漏了段基准：
        // 该会话下次被探时仍以为库里是旧的规模，保护判据失真。
        // 当前会话分支与这里必须同口径（含段列表更新）。
        {
          const prevSegments = probedMinutes.get(sessionId)?.segments ?? [];
          const others = prevSegments.filter((s) => s.id !== newId);
          setProbedMinutes(sessionId, {
            turns: result.turns,
            content: result.content,
            memoryId: newId,
            segments: [...others, { turns: result.turns, content: result.content, id: newId }],
          });
        }
        const own = minutesLedgerStore.load(sessionId) ?? state;
        const kept = mergeTurns([own.turns, state.turns]);
        const keptTrimmed = kept.length > TURN_LEDGER_MAX ? kept.slice(-TURN_LEDGER_MAX) : kept;
        minutesLedgerStore.save({
          ...own,
          // 轮次取并集：`own` 可能已被迟到的 `archiveTurn` 追加过，
          // 而 `state` 可能带更新的一批 —— 直接取一方会丢另一方的轮次
          turns: keptTrimmed,
          writtenTurns: Math.max(own.writtenTurns, state.turns.length),
          writtenAtArchived: Math.max(own.writtenAtArchived, archivedAtWrite),
          startedAt: earliestPositive([own.startedAt, state.startedAt]),
          memoryId: newId,
          // ## 非当前会话同样要复位来源（critical 1）
          //
          // 它自己账本文件里的 `memoryIdFromProbe` 若是 true（曾从库里
          // 捡来），而现在写入了自己的一条 ⇒ 来源变成「自己写的」。
          // 漏写会让那份账本永久「永不 forget」⇒ 每次更新都留过时副本。
          memoryIdFromProbe: false,
          // 待删列表取并集（八轮审查 M-3）
          pendingForget: [
            ...new Set([...(own.pendingForget ?? []), ...(state.pendingForget ?? [])]),
          ],
          // 阶段标记与当前会话同口径（十一轮 C1/M-1）
          //
          // ⚠ 这里故意用 `keptTrimmed`（磁盘并集）而非 `state.turns`：
          // 实际写进库的是 `state.turns`，但并集更大 ⇒ 标记偏保守
          // （最多多放行一次无谓写入），不会让真正需要的收尾入口丢失。
          // 十一轮 minor-3 指出过这个不一致 —— 保留并在此写明。
          stageWrittenTurnIdx: nextStageMarker(
            keptTrimmed,
            stage,
            Math.max(own.stageWrittenTurnIdx ?? 0, state.stageWrittenTurnIdx ?? 0),
          ),
        });
      }
      // 写成功 ⇒ 清掉该会话的暂存。
      //
      // ## 不能无条件 delete（四轮审查 M-c）
      //
      // 同一 sessionId 可能有两条在飞链（例如「恢复补写」与
      // `retryPendingMinutes`）。旧链（5 轮）后完成时若无条件 delete，
      // 会把新链（6 轮）刚入队的条目删掉 ⇒ 第 6 轮没有消费者。
      //
      // ## 也不能只按对象身份比对
      //
      // `persistMinutes` 每次构造新 state 对象（不复用 backlog 里那个），
      // 身份比对会永久不成立 ⇒ 旧 entry 永远留在 backlog，每次
      // `retryPendingMinutes` 都白写一遍。
      //
      // 正确判据是**进度**：只有当暂存项的进度不高于本次已写入的进度时，
      // 它才是冗余的（本次写入已覆盖它的全部内容）。
      //
      // ## 阶段写入不消费 backlog
      //
      // 阶段稿只是「当前这一轮的中间态」，不代表 backlog 里那批轮次已进库。
      // 若在这里 delete，backlog 的轮次就再没有消费者。
      if (stage === undefined) {
        const pending = minutesBacklog.get(sessionId);
        if (pending === undefined || pending.archivedTurns <= archivedAtWrite) {
          minutesBacklog.delete(sessionId);
        }
      }
      ctx.logger.info(
        `[lrc] 会话纪要已更新（触发：${reason}）：` +
          `${result.turns} 轮 / ${result.conclusions} 条结论 / ${result.chars} 字符 / ` +
          `id=${result.memoryId.slice(0, 8)}`,
      );
      return 'written';
    } catch (error) {
      // ## 失败必须留痕 + 回退，不能静默丢（审查 C2）
      //
      // ## 连接类错误必须作废连接（二轮审查 M-a）
      //
      // `retryPendingMinutes` 挂在 `Recoverable.factory` 里，只在该资源
      // **从 null 变成有值**时执行。若这里只 stash 不作废，连接仍是 ready
      // ⇒ factory 不再执行 ⇒ 非当前会话的 backlog **永远无人消费**。
      // 这正是 C4 声称修好、实际在稳态下不成立的那条路径。
      const message = error instanceof Error ? error.message : String(error);
      if (isConnectionError(error)) {
        connection.invalidate(message);
      }
      stashMinutes(
        state,
        `写入失败，已暂存 ${state.turns.length} 轮待重试（不影响对话）：${message}`,
      );
      return 'failed';
    }
  }

  /** 写入失败/未就绪：按会话暂存，并落盘（重启也不丢）。 */
  function stashMinutes(state: MinutesLedgerState, message: string): void {
    // ## 落盘前必须与磁盘上已有的账本合并（三段审查 m1）
    //
    // 这个 `state` 可能是几十毫秒前的快照。期间若有迟到轮次走了
    // `archiveTurn` 的旧会话分支，磁盘上已经有更新的账本 —— 直接 save
    // 会把那份新轮次覆盖掉（静默丢内容）。
    //
    // ## 合并结果必须同时写回**内存 backlog**（四轮审查 M-b）
    //
    // 只把合并结果写盘、backlog 里仍存旧快照时：
    // ```
    // backlog 存 {turns: 5 轮, writtenAtArchived: 3}，磁盘被合并成 40 轮
    // retryPendingMinutes ⇒ persistLedger(旧快照)
    // 闸门 canOverwriteMinutes(3, 5) ⇒ 5 >= 3 放行
    // ⇒ 用 5 轮稿覆盖库里的 40 轮 ❌
    // ```
    // 所以合并后的对象必须**同时**成为 backlog 里的那一条。
    const onDisk = minutesLedgerStore.load(state.sessionId);
    let mergedState = state;
    if (onDisk !== null) {
      const kept = mergeTurns([onDisk.turns, state.turns]);
      mergedState = {
        ...onDisk,
        turns: kept.length > TURN_LEDGER_MAX ? kept.slice(-TURN_LEDGER_MAX) : kept,
        // 单调字段一律取大值
        archivedTurns: Math.max(onDisk.archivedTurns, state.archivedTurns),
        writtenAtArchived: Math.max(onDisk.writtenAtArchived, state.writtenAtArchived),
        writtenTurns: Math.max(onDisk.writtenTurns, state.writtenTurns),
        startedAt: earliestPositive([onDisk.startedAt, state.startedAt]),
        // 记住已知的记忆 ID（哪一侧非空就用哪一侧）
        memoryId: onDisk.memoryId || state.memoryId,
        // ## 来源必须与 memoryId 同源（七轮审查 critical 1）
        //
        // `{...onDisk}` 会带上磁盘值，但 `state` 可能刚更新过（本次写入
        // 成功时已复位为 false）。必须按「谁提供了 memoryId」来取，
        // 否则会把刚复位的 false 覆盖回 true（或反之）。
        memoryIdFromProbe:
          onDisk.memoryId.length > 0 ? onDisk.memoryIdFromProbe : state.memoryIdFromProbe,
        // 待删列表取并集（八轮审查 M-3：全量覆盖会抹掉另一侧的待办）
        pendingForget: [
          ...new Set([...(onDisk.pendingForget ?? []), ...(state.pendingForget ?? [])]),
        ],
        // ## 阶段稿进度也取大值（十轮审查 C1）
        //
        // `{...onDisk}` 虽然能带上磁盘值，但 `state` 可能更新（同一次
        // 写入里刚推进过）。两侧取 max 才不会回退。
        stageWrittenTurnIdx: Math.max(
          onDisk.stageWrittenTurnIdx ?? 0,
          state.stageWrittenTurnIdx ?? 0,
        ),
        updatedAt: Date.now(),
      };
      minutesLedgerStore.save(mergedState);
    } else {
      minutesLedgerStore.save(state);
    }
    // ## 先删再设，把该会话提到 Map 末尾（二轮审查 m2）
    //
    // `Map.set` 对已存在的键**不改变插入顺序**（只是覆盖值）。于是
    // 「反复失败重试的会话」会一直停在第 1 位，被后续新会话挤掉 ——
    // 恰好在它最需要保留的时候被淘汰。先 delete 再 set 让它变成最新。
    minutesBacklog.delete(mergedState.sessionId);
    minutesBacklog.set(mergedState.sessionId, mergedState);
    trimMinutesBacklog();
    ctx.logger.info(`[lrc] 会话纪要暂存：${message}`);
  }

  /** 纪要暂存表的上限保护：只保留最新 8 个会话。 */
  function trimMinutesBacklog(): void {
    while (minutesBacklog.size > MINUTES_BACKLOG_MAX) {
      const first = minutesBacklog.keys().next();
      if (first.done === true) return;
      minutesBacklog.delete(first.value);
    }
  }

  /**
   * **补写所有未落库的纪要**（审查 C4 的消费点）。
   *
   * ## 为什么需要两个触发点（二轮审查 M-a）
   *
   * 单独挂在 `attachOffloader`（连接就绪）上是不够的：LRC 全程在线时
   * 那次 factory 只在启动预热跑一次。此后若某次写入超时失败，
   * 虽然 `persistLedger` 现在会 `connection.invalidate()` 触发重连，
   * 但**业务型拒绝**（如 LRC 侧 4xx）不会作废连接 ⇒ 没有重连
   * ⇒ 非当前会话的 backlog 再没有消费时机。
   *
   * 所以再加一个周期消费点（`agent/pre-step` 节流调用）。
   * 失败重试的那次尝试是有代价的（一次 HTTP），因此节流到
   * `MINUTES_RETRY_STEP_INTERVAL` 步一次；backlog 为空时立即返回，无开销。
   */
  const MINUTES_RETRY_STEP_INTERVAL = 60;

  function retryPendingMinutes(): void {
    if (!minutesEnabled) return;
    if (minutesBacklog.size === 0) {
      // 当前会话仍可能有未写轮次（如上次因未就绪被拦下）。
      // 这里**不传 force**：常规节奏由「每 N 轮」与「空闲定时器」负责，
      // 周期补写只兜「有一次写失败过」的情况，否则会变成每 60 步写一份。
      void maybeWriteMinutes(minutesOwnerSessionId, '重连补写');
      return;
    }
    for (const [sessionId, state] of [...minutesBacklog.entries()]) {
      if (sessionId === minutesOwnerSessionId) continue;
      void persistLedger(state, '重连补写');
    }
    // 当前会话若有未写轮次，也补一次（`force` 跳过 N 轮判定：
    // 这里是明确的「上次失败过」路径，不该再被节奏闸门挡住）
    void maybeWriteMinutes(minutesOwnerSessionId, '重连补写', true);
  }

  /**
   * 记录一批 Fact 到本会话账本（**upsert 语义**，★2026-11-15 六钥匙裁决）。
   *
   * ## 为什么不是 append
   *
   * 账本是**世界状态快照**，不是事件日志。append 积累出的是历史：
   * ```
   * 图标固定为 16px   ← 已被覆盖
   * 图标固定为 24px   ← 已被覆盖
   * 图标固定为 32px   ← 当前有效
   * ```
   * 实测 `factKey` 对这三条返回**同一个键** `decision|图标固|定为`，
   * 于是 3 条过时取值各占 1 个结论槽（15 槽里占 3 个），而摘要读者
   * 可能照着已废弃的 16px 去改代码 —— **过时取值是负信息**。
   *
   * ## 为什么 upsert 也是「压缩稳定性」的前提
   *
   * ```
   * append-only + 取最新 → 账本持续增长 → 每次裁剪的摘要都不同（新条目挤旧条目）
   * upsert        + 取最新 → 账本长度收敛到「不同 factKey 数」→ 摘要稳定
   * ```
   * 用户要求「既要高效压缩，又要信息高浓度」，稳定性是这个要求的直接推论。
   *
   * ## 演进历史会丢吗
   *
   * 不会。每一次写入都独立走了 `offloader.offloadFacts()` 进 LRC 长期库
   * （append 语义，可 `recall` 查到全过程），账本只服务于「本轮摘要」。
   *
   * ## 为什么对未富集 Fact 安全
   *
   * `factKey` 在 `predicate` 为空时退化成 `kind|statement|<全句归一化>`，
   * 所以两条不同的未富集陈述不会误合并（已实测 4/4 各自独立）。
   */
  function recordSessionFacts(facts: readonly MemoryFact[]): void {
    for (const fact of facts) {
      const key = factKey(fact);
      const at = sessionFacts.findIndex((prev) => factKey(prev) === key);
      // 同键 ⇒ 新值覆盖旧值且**移到末尾**（保持「越新越靠后」的数组不变式，
      // 摘要侧才能用 `slice(-N)` 取到最新）
      if (at >= 0) sessionFacts.splice(at, 1);
      sessionFacts.push(fact);
    }
    if (sessionFacts.length > SESSION_FACTS_MAX) {
      sessionFacts.splice(0, sessionFacts.length - SESSION_FACTS_MAX);
    }
  }

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
   * 单次裁剪节点数上限（统一走 `normalizeMaxNodes`）。
   *
   * ## 为什么必须与 `selectTrimRange` 用同一个函数
   *
   * 上一版在这里写 `normalizeCount(config.trimMaxNodesPerRun, 40, 1)`，
   * 而 `selectTrimRange` 用 `normalizeMaxNodes` —— 同一个配置在 `0.3` 上
   * 分别得到 40 和 1。e2e 断言的是后者，真实装配走的是前者 ⇒ 测试没验证真实路径。
   *
   * 现在只有一份语义（见 `normalizeMaxNodes`），两处结果必然一致。
   * 配置缺省（`undefined`）时取默认上限，**不再退化成「不限制」**。
   */
  const trimMaxNodesPerRun = normalizeMaxNodes(config.trimMaxNodesPerRun) ?? DEFAULT_MAX_NODES_PER_RUN;

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
   * 上一次「历史查询」的原文。
   *
   * 历史查询会绕过话题指纹去重（见 `refreshRecallInjection`），
   * 若用户连问两句同一件事（「上次那个方案是什么」→「再说一遍」），
   * 会连发两次 recall HTTP、连改两次注入文本。这里按原文去重。
   */
  let lastHistoryQuery = '';
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
    minRawScore: config.recallInjectMinRawScore,
    fragmentPrefixes: config.recallInjectFragmentPrefixes,
    fragmentExemptImportance: config.recallInjectFragmentExemptImportance,
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
   * LLM 兜底提取的调用统计（2026-11-13 新增）。
   *
   * 这一层要花真钱（每次一次独立模型请求），必须可观测：
   * 命中数、跳过原因、累计调用次数。三个计数只用于日志，不影响行为。
   */
  let llmExtractCalls = 0;
  let llmExtractHits = 0;
  let llmExtractFailures = 0;

  /**
   * 进程级**滑动窗口**的调用时间戳（毫秒）。
   *
   * ## 为什么不能只计总数
   *
   * 只计总数时，常驻进程里 5 个满额会话用完后兜底**永久关闭**，只能重启
   * 恢复 —— 这会让「用了一整天」的进程在下午就彻底失去该能力。
   *
   * 滑动窗口只统计最近 `LLM_EXTRACT_GLOBAL_WINDOW_MS` 内的调用，时间一过
   * 自动恢复额度，语义是「单位时间内的总预算」而不是「终身预算」。
   */
  const LLM_EXTRACT_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
  const llmExtractGlobalStamps: number[] = [];

  /** 清理窗口外的旧时间戳，返回窗口内的调用次数。 */
  function globalWindowCount(now: number): number {
    const cutoff = now - LLM_EXTRACT_GLOBAL_WINDOW_MS;
    // 时间戳天然有序（只在调用时 push），从头砍掉过期的即可
    while (llmExtractGlobalStamps.length > 0 && (llmExtractGlobalStamps[0] as number) <= cutoff) {
      llmExtractGlobalStamps.shift();
    }
    return llmExtractGlobalStamps.length;
  }

  /**
   * 未连接时暂存的正文约束（上限 30），**按归属会话分桶**。
   *
   * ## 为什么必须按会话分桶
   *
   * `assistant/message` 事件**不会被回放**。LRC 桌面端比 DSH 晚起 20 分钟
   * 是已发生过的真实事故，那段时间里抽到的约束若直接丢弃就永久消失了。
   *
   * 但也不能像上一版那样在切会话时整体清空 —— 那等于「离线期间攒的 20 条
   * 约束，用户一切会话就全丢」，与「绝不丢」的目标直接冲突。
   * 分桶后：A 会话的残留仍标着 A，补写时按原归属落库；
   * 桶总量仍受 `PROSE_BACKLOG_MAX` 约束（按最旧淘汰）。
   */
  const proseBacklog = new Map<string, MemoryFact[]>();
  const PROSE_BACKLOG_MAX = 30;

  /** 当前 backlog 总条数。 */
  function proseBacklogSize(): number {
    let total = 0;
    for (const list of proseBacklog.values()) total += list.length;
    return total;
  }

  /**
   * 往 backlog 追加一批条目（带全局上限）。
   *
   * @param owner - 归属会话 ID（空串表示「未知归属」，补写时按当前会话处理）
   * @param items - 条目
   */
  function pushProseBacklog(owner: string, items: MemoryFact[]): void {
    const list = proseBacklog.get(owner) ?? [];
    list.push(...items);
    proseBacklog.set(owner, list);
    // 超限从**最旧的那个桶**开始丢（Map 保留插入顺序）
    while (proseBacklogSize() > PROSE_BACKLOG_MAX) {
      const first = proseBacklog.keys().next();
      if (first.done === true) break;
      const head = proseBacklog.get(first.value) ?? [];
      const over = proseBacklogSize() - PROSE_BACKLOG_MAX;
      if (head.length <= over) proseBacklog.delete(first.value);
      else proseBacklog.set(first.value, head.slice(over));
    }
  }
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
    const previousSession = currentSessionId;
    currentSessionId = sessionId;

    // ★2026-11-17：切会话前冲刷**上一个会话**的轮内暂存。
    //
    // 暂存桶按会话分桶，但 `flushTurn(owner)` 需要显式指认归属。不冲刷的话
    // 旧会话那批 Fact 会一直留在内存，直到进程退出 —— 而它已经不会再
    // 收到 `turn/end` 了（那个会话已经结束）。
    if (previousSession.length > 0) {
      const pending = offloader.turnPending(previousSession);
      if (pending > 0) {
        // `intoPool: false`：此时池子已属于**新会话**，旧会话的约束推进去会
        // 让新会话下一次注入出现「B 的约束；A 私有：…」（与 drainProseBacklog 同源）。
        void offloader.flushTurn(previousSession, { intoPool: false }).catch(() => {
          // 冲刷失败不影响切会话：这批内容会回桶，随下次冲刷重试
        });
      }
    }

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
    // Fact 账本也是会话级：交接文档只应包含**本会话**的结论。
    // 不清会让新会话的交接文档里混进上一个会话的任务上下文。
    sessionFacts.length = 0;
    // ★2026-11-17：纪要账本按会话隔离，且**切换前先把旧会话落盘**。
    //
    // ## 与 `proseBacklog` 不同，纪要不能跨会话补写
    //
    // 它的 `event_id` 绑死旧 sessionId，内容也包含旧会话的完整时间线。
    //
    // ## 落盘 + 落盘失败才进 backlog（审查 C2/C4）
    //
    // 旧实现在这里把账本清零、`void` 异步写一次、失败只 warn，
    // 且 `minutesBacklog` 从未被读取过 —— LRC 未就绪时那批纪要永久丢失。
    // 现在：账本本来就在每轮归档时落过盘（`archiveTurn`），这里只需
    // 把「还没写进 LRC 的轮次」作为待补写状态挂进 backlog，
    // 由 `retryPendingMinutes`（连接就绪）与 `maybeWriteMinutes` 消费。
    //
    // ## 未收尾的轮次必须先归档，不能丢（三期集成测试抓出）
    //
    // 用户在长轮次执行中途切走会话时 `turn/end` 还没到。旧代码紧接着
    // `liveTurn = undefined`，那一轮的诉求与结论**静默消失**，
    // 之后再来的 `turn/end` 找不到槽位，等于整轮从未存在。
    // 必须在切走**之前**用 `'switched'` 归档（此时归属仍是旧会话）。
    if (liveTurn !== undefined && liveTurn.sessionId === previousSession) {
      archiveTurn(liveTurn, 'switched');
      liveTurn = undefined;
    }
    if (previousSession.length > 0 && turnLedger.length > 0) {
      const stale = currentLedgerState();
      // ## 归属必须以账本的实际归属为准（七轮审查 m-1）
      //
      // 上一版直接 `stale.sessionId = previousSession` 是「强行改标签」：
      // 一旦某条路径让 `minutesOwnerSessionId ≠ previousSession`，
      // 就会把别人的轮次与 `memoryId` 写到 A 的账本名下 ——
      // 后续 `memoryId` 不匹配就会 `forget` 掉别人的记忆。
      //
      // 两个变量当前恒同步绑定，但约束不应只存在于作者脑里。
      // 用账本自身的归属，并在不一致时留痕。
      if (stale.sessionId.length > 0 && stale.sessionId !== previousSession) {
        ctx.logger.warn(
          `[lrc] 纪要账本归属(${stale.sessionId}) 与上一会话(${previousSession}) 不一致，` +
            `按账本归属落盘（避免交叉污染）`,
        );
      }
      saveCurrentLedger();
      // ## 判据必须用单调的 `archivedTurns`（二轮审查 X1）
      //
      // `writtenTurns < turns.length` 在账本饱和（两者都是 40）时恒为假，
      // 第 41 轮之后的内容**永远不会被补写**。`archivedTurns` 只增不减，
      // 是唯一可靠的进度信号。
      if (shouldRewriteMinutes(stale.archivedTurns, stale.writtenAtArchived)) {
        void persistLedger(stale, '切换会话');
      }
    }
    // 切到新会话：命中落盘就恢复（重启续跑 / A→B→A 都不丢），否则从零开始
    bindMinutesSession(sessionId);
    liveTurn = undefined;
    liveTurnSessionId = '';
    // ## 在飞轮次只清引用、**不归档**（四轮审查 M-a）
    //
    // 上一版这里写 `for (slot of finishingTurns) archiveTurn(slot,'switched')`，
    // 想避免「迟到的结论无处可去」。但它引入了一个更糟的缺陷：
    // ```
    // bind 归档（reason='switched'）⇒ 引用清空
    // finishTurn().finally() ⇒ indexOf 返回 -1，但**仍会** archiveTurn(finished, 真实reason)
    // ⇒ 同一轮被归档两次：轮数虚增、真实 reason 被 'switched' 占位、
    //   而 finally 之后追加的推理结论因去重（先到优先）被丢弃
    // ```
    //
    // 正确认识：`finishTurn` 的 `finally` **必然执行**（除非进程崩溃），
    // 而 `slot` 已作为参数被闭包捕获 —— 所以清空数组引用不会丢归档。
    // 至于 `finishTurn` 内部推理兜底的结论收集：它靠**显式传 slot**，
    // 不看这个数组。`offloadExtracted` 的异步路径（LLM 兜底）也传了
    // `ownerSlot`。因此清空是安全的。
    finishingTurns.length = 0;
    clearMinutesIdle();
    // **proseBacklog 不清**：它按会话分桶，切会话后仍按原归属补写。
    // 上一版在这里整体清空，等于「离线期间攒的约束，用户一切会话就全丢」。
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

  // 纪要空闲定时器必须随插件卸载停掉：否则重载后会留下一个指向旧闭包的
  // 定时器，既重复触发写入，又持有整份账本内存。
  ctx.effect(
    () => () => {
      clearMinutesIdle();
      saveCurrentLedger();
      // ## 卸载时尽力写一次（五轮审查 M1）
      //
      // 这是「用户关窗」的最后一道机会。`void` 而非 await：`effect` 的
      // 清理函数不能异步阻塞卸载流程，而 HTTP 往返可能长达 20 秒。
      // 写不成功也无损 —— `persistLedger` 的 catch 会把状态 stash 并落盘，
      // 下次启动同会话时由 `bindMinutesSession` 恢复并补写。
      void maybeWriteMinutes(minutesOwnerSessionId, 'dispose', true);
    },
    'lrc.minutes.dispose()',
  );

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
      foldEnabled: config.foldEnabled,
      foldMinFacts: config.foldMinFacts,
      foldMaxChars: config.foldMaxChars,
    },
    new RecentStore(join(cacheDir, 'recent.json')),
  );

  // 账本文件清理：只保留最近 40 个会话，避免长期使用积累上百个小 JSON。
  // 放在这里（而非定时器）是因为插件生命周期内只做一次就够了。
  minutesLedgerStore.prune(MINUTES_LEDGER_MAX_FILES);

  /** 连接就绪后把 client 注入 Offloader（保留其全部计数器与游标）。 */
  function attachOffloader(client: LrcClient): void {
    offloader?.bind(client);
    // **每次连接就绪都要回灌**，不只是启动时。
    //
    // `assistant/message` 不会被回放，未连接期间抽到的约束错过就永久丢。
    // 原来这段写在启动 IIFE 里、且在 `if (client === null) return` 之后 ——
    // 而它要解决的正是「启动时连不上」的场景，于是永远走不到（死代码）。
    // 实测：LRC 晚起 → 收到约束 → 重连成功 → 旧约束从未被补写。
    drainProseBacklog();
    // ★2026-11-17：纪要与正文约束同源 —— 每次连接就绪都要补写。
    //
    // 这是 `minutesBacklog` 的**唯一真实消费点**（审查 C4）。
    // 首版的注释写了「下次重连重试」，但代码里没有任何读取处，
    // 那批已归档的轮次在切会话后就永久消失了。
    retryPendingMinutes();
    // ★D 方案：连接就绪时探查库里是否已有本会话纪要，回填 `memoryId`。
    //
    // ## 必须走 `maybeProbeMinutesOnce`，不能直接调 `probeExistingMinutes`
    //
    // `attachOffloader` 是 `Recoverable` factory 的一部分 —— 每次
    // `connection.invalidate()` 后的首次 `get()` 都会重跑它。
    // 而 `persistLedgerInner` 的 catch 里就会 `invalidate` ⇒ 写入持续失败
    // 时会形成「失败 → 重连 → 再探一次全库检索」的放大回路（十二轮 M2）。
    //
    // 走统一入口后：`probeAttempts` 上限 3 次，且成功即停。
    //
    // 连接就绪同时是「重置探查额度」的时机（六轮审查 major 3）：
    // 探查失败最常见的原因就是 LRC 还没起好，此时额度可能已耗尽。
    resetProbeAttempts();
    if (minutesOwnerSessionId.length > 0) {
      maybeProbeMinutesOnce(minutesOwnerSessionId);
    }
  }

  /**
   * 每个会话**最多探几次**（十二轮审查 M1）。
   *
   * ## 为什么不是「只探一次」
   *
   * 探查会失败，而失败原因恰是最常见的几种：
   * - `/v1/memories/enrich` 返回 503 `store_busy`（LRC 侧 15s 锁竞争）
   * - 查询富化的 LLM 超时
   * - `AbortSignal.timeout(20s)`
   *
   * 若失败也标记「已探过」，这个会话（可能持续数小时）整个生命周期内
   * `memoryId` 恒为空 ⇒ 回到修复前行为 ⇒ 继续制造重复。而 D 方案
   * 要解决的正是这个场景。
   *
   * 3 次足够：真失败会连着失败，偶发失败一次就能成功。上限防止
   * LRC 长期不可用时每轮都打一次全库检索。
   */
  const PROBE_MAX_ATTEMPTS = 3;
  /** 每会话的探查尝试次数（成功即删，失败累加；连接就绪时整体重置）。 */
  const probeAttempts = new Map<string, number>();
  /** 正在探查中的会话（防止 `attachOffloader` 与 `turn/start` 并发重复探查）。 */
  const probeInFlight = new Set<string>();

  /**
   * 每个会话**只探一次**库。
   *
   * ## 为什么不在 `attachOffloader` 里直接探
   *
   * 首次连接几乎总早于第一个 `turn/start` —— 那时 `minutesOwnerSessionId`
   * 还是空的，探不到任何会话。若只在连接就绪时探，冷启动场景
   * （插件启动即有账本缺失）会完全错过。
   *
   * 本函数由 `turn/start` 调用：此时归属已绑定、`memoryId` 是否为空
   * 已确定，是唯一正确的时机。
   */
  function maybeProbeMinutesOnce(sessionId: string): void {
    if (!minutesEnabled) return;
    if (sessionId.length === 0) return;
    // ## 已探过且无需再探的判据（十二轮审查 C2）
    //
    // 不能用「`memoryId` 非空就跳过」—— 真实案例里 memoryId 指向一条
    // 历史短稿，而库里还有更完整的版本，正是**必须**再探一次的场景。
    // 只在「这个会话已经探成功过」时跳过。
    if (probedMinutes.has(sessionId)) return;
    // ## 在飞去重（六轮审查 minor 5）
    //
    // `attachOffloader` 与 `turn/start` 会几乎同时到达。没有这道闸时
    // 两条链各发一次 topK=30 的全库 enrich（LRC 侧含 LLM 富化，秒级），
    // 并且「未连接不计次」那条分支会让额度消耗得更快。
    if (probeInFlight.has(sessionId)) return;
    const attempts = probeAttempts.get(sessionId) ?? 0;
    if (attempts >= PROBE_MAX_ATTEMPTS) return;
    probeAttempts.set(sessionId, attempts + 1);
    probeInFlight.add(sessionId);
    void connection
      .get()
      .then(async (client) => {
        if (client === null) {
          // 未连接：不计入失败次数（下次 turn/start 还能再试）
          probeAttempts.set(sessionId, attempts);
          return;
        }
        const ok = await probeExistingMinutes(client, sessionId);
        // 成功：清掉计数，之后不再探（`probedMinutes` 已记录）
        if (ok) probeAttempts.delete(sessionId);
        // ## 失败 3 次后不能永久失保（六轮审查 major 3）
        //
        // 反例：冷启动时 LRC 还在起（503 `store_busy`）⇒ 3 次全失败
        // ⇒ `probeAttempts` 满 ⇒ 该会话在**整个进程生命周期**内
        // 基准恒缺失 ⇒ 残稿无任何拦截直接写入。
        // 修法见 `attachOffloader`：连接恢复时调 `resetProbeAttempts()`，
        // 那正是「LRC 已就绪、重试有意义」的唯一时机。
      })
      .catch((error: unknown) => {
        // ## 必须 catch（十二轮审查 m8）
        //
        // `connection.get()` 与 `probeExistingMinutes` 当前都不 reject，
        // 但 `queueForget → saveCurrentLedger` 一旦抛错就是
        // unhandled rejection（项目在 `persistLedger` 专门处理过同类问题）。
        ctx.logger.warn(
          `[lrc] 会话纪要探查异常（不影响对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        // 无论成败都要摘掉在飞标记，否则该会话以后再也探不了
        probeInFlight.delete(sessionId);
      });
  }

  /**
   * 连接就绪时重置「探查额度」（六轮审查 major 3）。
   *
   * 探查失败的典型原因是 LRC 还没起好（503 `store_busy`）。额度耗尽后
   * 若永不重置，该会话在整个进程生命周期内都失去保护。而连接就绪
   * 恰好说明 LRC 已经可用 —— 这是重试的唯一有意义时机。
   */
  function resetProbeAttempts(): void {
    probeAttempts.clear();
  }

  /**
   * 把未连接期间暂存的正文约束补写出去（**按归属会话逐桶处理**）。
   *
   * 由 `attachOffloader`（连接就绪路径）调用 —— 每次重连都会触发，
   * 因此不依赖「启动那一刻就连上」这个不成立的前提。
   *
   * ## 为什么不能整体取出再一次性写
   *
   * 各桶的归属会话不同。合并成一批会把 A 的约束写成 B 的归属
   * （`saveSnapshot` 的归属就是错的）。而整体清空再失败回滚，
   * 又会把 B 的条目塞进 A 的桶 —— 所以逐桶独立处理。
   */
  function drainProseBacklog(): void {
    for (const [owner, list] of [...proseBacklog.entries()]) {
      if (list.length === 0) continue;
      proseBacklog.delete(owner);
      const pending = list;
      // 归属为空表示「离线时还不知道是哪个会话」，退化为当前会话
      const ownerSessionId = owner.length > 0 ? owner : currentSessionId;
      void offloader
        // **intoPool: false** —— 补写的是**旧会话**的 backlog，此时池子
        // 已属于当前会话。若照常入池，当前会话下一次注入会变成
        // 「B 的约束；A 会话私有：不要用 IDM」（实测已复现）。
        // 记忆仍写进 LRC，只是不参与当前会话的快照。
        .offloadFacts(pending, { intoPool: owner === currentSessionId })
        .then((result) => {
          if (result.distilled > 0) {
            // 空归属不落盘：写出去只会变成「无归属快照」，下次启动必被丢弃
            if (result.snapshot.length > 0 && ownerSessionId.length > 0) {
              saveSnapshot(result.snapshot, ownerSessionId);
            }
            ctx.logger.info(
              `[lrc] 补写未连接期间的 ${result.distilled} 条约束/决策（写入 ${result.written}）`,
            );
          }
        })
        .catch((error: unknown) => {
          // **只有连接类错误才回队重试**。
          //
          // 上一版不区分错误类型：LRC 明确拒绝（业务错误，如字段校验失败）
          // 也会回队，于是每次重连都重发同一批、每次都失败 —— 死循环，
          // 而且日志看起来像「一直在努力补写」。
          //
          // 连接类错误（超时 / 断连）才可能下次成功。注意：若 migrate 实际
          // 已落库但响应超时，回队重试会产生一次重复入库 —— LRC 侧有合并
          // 阈值会吃掉，且 `written/merged` 统计会略偏高。这是「宁重不漏」
          // 的已知代价，不再回滚本地 recent 掩盖它。
          if (isConnectionError(error)) {
            pushProseBacklog(owner, pending);
            ctx.logger.warn(
              `[lrc] 补写暂存约束失败（已放回队列重试）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
          ctx.logger.warn(
            `[lrc] 补写暂存约束被 LRC 拒绝，已丢弃 ${pending.length} 条（不重试）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  }

  /**
   * 本轮暂存的**硬上限**：达到即提前冲刷（防止整轮攒在内存里）。
   *
   * ## 为什么是 40 而不是配置项
   *
   * 它同时是「一次 LLM 兜底可能产出的上限」（`llmExtractMaxInputChars` 对应的
   * 典型产出量）与「一轮的常见碎片数」的粗略上界。取值不需要精确 ——
   * 它的作用只是**兜住异常长的轮次**，正常轮次由 `turn/end` 收口。
   *
   * 不作为配置项：这个数字调大没有任何收益（只增加崩溃丢失窗口），
   * 调小只是多切几批（多几条摘要），用户没有调它的合理动机。
   */
  const TURN_FLUSH_MAX = 40;

  /**
   * 暂存桶的**时间上限**：滞留超过这么久就提前沉淀（毫秒）。
   *
   * ## 为什么补这一条（2026-11-21 长期 goal 任务实测）
   *
   * `TURN_FLUSH_MAX` 只兜住「内容多」的情况。goal 任务里抽取是稀疏的 ——
   * 实测 2 小时只抽出 4 条，永远到不了 40 条，于是这 4 条一直等
   * `turn/end`，而 goal 任务可能跑几小时都不结束轮次。进程一崩就全丢。
   *
   * 30 分钟是「崩溃最多丢半小时」与「折叠批次不被切得太碎」的折中：
   * `foldMinFacts = 4`，半小时通常够攒一批；真不够时也只是多写一条。
   *
   * 与 `TURN_FLUSH_MAX` 同理**不作为配置项**：调大只增加丢失窗口，
   * 调小只是多切几批，用户没有调它的合理动机。
   */
  const TURN_FLUSH_MAX_MS = 30 * 60 * 1000;

  /**
   * 上一次「超时提前沉淀」的尝试时刻（0 = 从未尝试）。
   *
   * 失败时桶会被放回且时间戳保留 ⇒ 若不节流，LRC 挂掉期间会**每步**发起
   * 一次必然失败的 HTTP。60 秒足以避免刷屏，又不会让补写明显滞后。
   */
  let lastTurnFlushAttemptAt = 0;

  /**
   * 暂存桶滞留超时 ⇒ 提前沉淀（数量上限 `TURN_FLUSH_MAX` 的时间版）。
   *
   * 每步 O(1)：未超时不做任何 I/O。
   *
   * ## 为什么扫「所有桶」而不是只看当前会话（独立审查 major 1）
   *
   * 切会话时对旧桶的冲刷是尽力而为的。失败后桶和时间戳都还在，但
   * `pendingAgeMs(currentSessionId)` 再也看不到它 —— 那批数据只能等进程退出时丢。
   * 这里用 `staleOwners()` 把孤儿桶也扫出来，逐桶补写。
   *
   * ⚠ 孤儿桶必须传 `intoPool: false`：快照池此时已属于新会话，
   * 把旧会话的约束推进去会让下一次注入出现「B 的约束；A 会话私有：…」。
   *
   * @param stepSessionId - 本次 pre-step 所属会话（取 payload，避免与全局
   *   `currentSessionId` 在子代理/多会话交错时短暂不一致）
   */
  function maybeFlushTurnFacts(stepSessionId?: string): void {
    // 未连接时冲刷必然失败并把数据放回桶里，白跑一次 HTTP 超时
    if (!offloader.connected) return;
    const stale = offloader.staleOwners(TURN_FLUSH_MAX_MS);
    if (stale.length === 0) return;
    const now = Date.now();
    if (now - lastTurnFlushAttemptAt < 60_000) return;
    lastTurnFlushAttemptAt = now;
    // 先固化会话：`.then` 执行时 `currentSessionId` 可能已经变了。
    // 用 `||` 而非 `??`：`session.id` 可能是空串，空串必须回退到全局值，
    // 否则当前会话的桶会被当成孤儿（数据能写，但快照池不更新）。
    const owner = stepSessionId !== undefined && stepSessionId.length > 0 ? stepSessionId : currentSessionId;
    for (const sessionId of stale) {
      const age = offloader.pendingAgeMs(sessionId);
      const intoPool = sessionId === owner;
      void offloader
        .flushTurn(sessionId, { intoPool })
        .then((result) => {
          if (result.distilled === 0) return;
          if (intoPool && result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
            saveSnapshot(result.snapshot, owner);
          }
          ctx.logger.info(
            `[lrc] 暂存桶已滞留 ${Math.round(age / 60000)} 分钟${intoPool ? '' : '（旧会话）'}，` +
              `提前沉淀 ${result.distilled} 条（折叠 ${result.folded ?? 0} 条，写入 ${result.written}）`,
          );
        })
        .catch((error: unknown) => {
          ctx.logger.warn(
            `[lrc] 超时提前沉淀失败（不影响对话）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
  }

  /**
   * 把一批 Fact 里的**结论类**汇入本轮纪要槽位。
   *
   * 只收「能回答为什么」的四类：约束/决策/结论/事实。
   * 位置与工件不进纪要（它们是运行状态，不是对话结论）。
   *
   * ## 为什么单独成函数
   *
   * `offloadExtracted` 是所有 Fact 的唯一汇合点，但它只处理「已连接」的
   * 主路径。推理兜底在**未连接**时也会产出 Fact（走 proseBacklog），
   * 那些结论同样该进纪要 —— 而纪要不受连接状态影响（它是本地账本）。
   * 抽出来后两条路径都能调用。
   *
   * ## 必须能接收**显式槽位**（2026-11-17 二轮审查 X3）
   *
   * `finishTurn` 是 `void` 异步的且含多次 HTTP。实测时序：
   * ```
   * turn1/end → T1 进 finishingTurns，T1.finishTurn 开始（未完成）
   * turn2/end → T2 也进 finishingTurns  ⇒ [T1, T2]
   * T1 的推理兜底 resolve → 此时 liveTurn 已 undefined
   *                        → reverse().find(同会话) 命中 T2 ❌
   * ```
   * 结果：T1 的结论混进 T2，T1 自身纪要结论为空。
   *
   * 所以 `finishTurn` / 推理兜底路径**必须显式传入槽位**；
   * 只有「由事件驱动的、天然属于当前轮」的调用（`offloadExtracted`）
   * 才允许按 sessionId 模糊查找。
   *
   * @param explicitSlot - 显式指认的轮次槽位。**异步路径必传**：
   *   `runLlmFallback` / 推理兜底都要 `await` 一次 HTTP 才回到这里，
   *   期间 `finishingTurns` 可能已积累多个槽位，模糊查找会命中错误的轮次
   *   （三段审查 C1：T1 的 LLM 兜底结论进了 T2 纪要）。
   */
  function collectMinutesConclusions(
    facts: readonly MemoryFact[],
    ownerSessionId: string,
    label: string,
    explicitSlot?: TurnSlot,
  ): void {
    if (facts.length === 0) return;
    const slot =
      explicitSlot ??
      (liveTurn !== undefined && liveTurnSessionId === ownerSessionId
        ? liveTurn
        : [...finishingTurns].reverse().find((t) => t.sessionId === ownerSessionId));
    if (slot === undefined) {
      // ## 静默丢弃必须留痕（三段审查 M2）
      //
      // 切会话会清空 `finishingTurns`，那之后在飞的异步结论无处可去。
      // 不记日志的话，用户只看到「纪要里少了这部分」，无从判断是抽取失败
      // 还是归属丢失。这里记一次 info，足够排障且不刷屏（每批一条）。
      ctx.logger.info(
        `[lrc] 纪要未收 ${facts.length} 条结论（${label}）：本轮槽位已归档或跨会话`,
      );
      return;
    }
    for (const fact of facts) {
      if (
        fact.kind !== 'constraint' &&
        fact.kind !== 'decision' &&
        fact.kind !== 'conclusion' &&
        fact.kind !== 'statement'
      ) {
        continue;
      }
      const text = fact.statement.trim();
      if (text.length === 0) continue;
      if (slot.conclusions.includes(text)) continue;
      if (slot.conclusions.length >= 60) {
        // 超限留痕：静默截断会让用户以为纪要「就这些」
        ctx.logger.info(`[lrc] 纪要单轮结论已达 60 条上限，本轮后续结论不再收（${label}）`);
        break;
      }
      slot.conclusions.push(text);
      slot.lastActivityAt = Date.now();
    }
  }

  /**
   * 把一批**已通过 schema 校验**的记忆送进 LRC，并更新快照。
   *
   * 所有来源（正文 / 用户消息 / 推理兜底 / LLM 补全）共用这一个出口：
   * 「未连接先暂存、代次闸门防乱序、失败只告警」这套处理完全一样，
   * 分开写必然漂移。
   *
   * @param facts - schema 层产出的记忆
   * @param ownerSessionId - 归属会话（**同步阶段捕获**，不能等 `.then` 再读）
   * @param label - 日志用来源名
   * @param timing - 写入时机：
   *   - `'now'`（默认）：立即写库。用于用户消息、LLM 补全这类**低频、独立**
   *     的产出 —— 它们本身就是完整表述，不存在「同批碎片」问题。
   *   - `'turn'`：暂存到本轮，等 `turn/end`（或下一次 `turn/start`）
   *     统一折叠写入。用于**正文逐句抽取** —— 它是碎片的唯一来源。
   * @param slot - 结论应汇入的轮次槽位。**异步调用方必传**（三段审查 C1）：
   *   `runLlmFallback` 要 `await` 一次模型调用，期间 `turn/end` 可能已发生
   *   且 `finishingTurns` 里堆了多个槽位，模糊查找会串轮。
   *   同步路径（正文抽取、用户消息）不传 —— 那时 `liveTurn` 确定是本轮。
   */
  function offloadExtracted(
    facts: MemoryFact[],
    ownerSessionId: string,
    label: string,
    timing: 'now' | 'turn' = 'now',
    slot?: TurnSlot,
  ): void {
    if (facts.length === 0) return;
    // 账本在**同步阶段**记录：它用于交接文档投影，与写库成功与否无关
    // （写库失败时用户仍可能在同一会话里要求交接）。
    recordSessionFacts(facts);
    // ★2026-11-17：同时把结论汇入**纪要账本**的本轮记录。
    //
    // ## 为什么在出口统一收集，而不是各处分别记
    //
    // 产生 Fact 的路径有五条（正文抽取 / 用户消息 / 推理兜底 / LLM 兜底 / 工件指针）。
    // 分散记录必然漏掉某条（历史事故：LLM 兜底曾因漏 `attachTopic` 而全部无 topic）。
    // 这里是所有 Fact 的**唯一汇合点**。
    //
    // 只收「能回答为什么」的四类：约束/决策/结论/事实。
    // 位置与工件不进纪要（它们是运行状态，不是对话结论）。
    //
    // ## 必须校验会话归属（审查 M5）
    //
    // `runLlmFallback` 是 `void` 异步的：它 `await` 模型调用后才回到这里。
    // 若期间用户切了会话，`liveTurn` 已是新会话的槽位 —— 不校验就会把
    // 旧会话的结论写进新会话纪要。与召回路径的 `recallGeneration` 同源。
    //
    // ## 还要看 `finishingTurns`（审查 C5）
    //
    // `turn/end` 把轮次从 `liveTurn` 摘进 `finishingTurns`，`finishTurn`
    // 跑完才归档。推理兜底（`finishTurn` 内部）与 LLM 兜底（异步 resolve）
    // 都可能在这段时间内到达这里 —— 只看 `liveTurn` 会让这些结论**全部丢失**，
    // 症状是「工具密集型轮次（正文占比 0%）的纪要怎么都抽不出结论」。
    collectMinutesConclusions(facts, ownerSessionId, label, slot);
    // **未连接时不直接丢**：这类事件不会被回放，而 LRC 桌面端比 DSH
    // 晚起 20 分钟是已发生过的真实事故。那段时间里若直接 catch 掉，
    // 这批约束就永久丢了。
    if (!offloader.connected) {
      pushProseBacklog(ownerSessionId, facts);
      void connection.get();
      return;
    }

    // ── 轮内暂存：不写库，等轮末统一切 ──
    //
    // 边界必须是「轮」：正文抽取是逐条触发的，每条消息只抽 1~3 条，
    // 实测按分钟切分时 845/993 批不足 4 条（折叠几乎不生效）。
    // 一轮（5~15 分钟）能把「同一次排查」圈在一起，实测覆盖率 72%~87%。
    if (timing === 'turn') {
      offloader.accumulate(facts);
      const pendingForSession = offloader.turnPending(ownerSessionId);
      // ## 有界保护：超上限就提前冲刷
      //
      // 一轮的真实长度可以很长（实测 88 步 / 138 次工具调用）。若整轮都
      // 攒在内存里，一次进程崩溃会丢掉这一轮的全部内容 —— 而「宁重不漏」
      // 是本项目反复强调的红线。
      //
      // ## 判据必须用**本会话**条数，且用独立常量（2026-11-17 审查修出的 major）
      //
      // 旧写法 `pending >= Math.max(4, config.maxItems)` 有两个缺陷：
      // ① `pending` 是**全桶合计**，孤儿会话的残留会持续抬高判定，
      //    导致本会话明明只有 2 条也被判为「达上限」而提前冲刷；
      // ② `maxItems` 是**快照条数**配置，用户为快照调大到 200 后本保护
      //    形同虚设（`migrate` 本身无分片，不存在「反正要分批」这回事）。
      if (pendingForSession >= TURN_FLUSH_MAX) {
        void offloader
          .flushTurn(ownerSessionId)
          .then((result) => {
            if (result.distilled > 0) {
              if (
                result.snapshot.length > 0 &&
                snapshotChanged(latestSnapshot, result.snapshot)
              ) {
                saveSnapshot(result.snapshot, ownerSessionId);
              }
              ctx.logger.info(
                `[lrc] ${label} 暂存达上限，提前沉淀 ${result.distilled} 条` +
                  `（折叠 ${result.folded ?? 0} 条，写入 ${result.written}）`,
              );
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(
              `[lrc] ${label} 提前沉淀失败（不影响对话）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      } else {
        ctx.logger.info(
          `[lrc] ${label} ${facts.length} 条暂存本轮（累计 ${pendingForSession} 条），轮末统一沉淀`,
        );
      }
      return;
    }

    proseTurns += 1;
    // 代次闸门：多次 HTTP 往返可能乱序（migrate 超时 20s），
    // 晚完成的那条会用更早的内容覆盖快照 —— 症状是注入内容「倒退」。
    const gen = ++snapshotGeneration;
    void offloader
      .offloadFacts(facts)
      .then((result) => {
        if (gen !== snapshotGeneration) return; // 有更新的一次在飞，丢弃
        if (result.distilled > 0) {
          if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
            saveSnapshot(result.snapshot, ownerSessionId);
          }
          ctx.logger.info(`[lrc] ${label} ${result.distilled} 条关键信息（写入 ${result.written}）`);
        }
      })
      .catch((error: unknown) => {
        ctx.logger.warn(
          `[lrc] ${label}沉淀失败（不影响对话）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /**
   * 把超长文本落盘为工件，并写一条指针 Fact。
   *
   * ## 为什么不在上下文里替换原文
   *
   * 插件没有「改写用户已发消息」的能力（宿主不允许改 user/message 内容）。
   * 所以这里的职责是**登记**：把内容存进工件库、在 LRC 留一条可检索的
   * 指针，让后续轮次的模型能通过 `lrc_fetch_artifact` 取回，而不必
   * 依赖上下文里那段逐渐被裁掉的长文。
   *
   * 真正的「上下文瘦身」由已有的 trim / prune 路径完成 —— 它们会把
   * 旧的超长消息折进摘要。两条路径互补：trim 负责缩小上下文，
   * 工件库负责让被缩小的内容**仍然可取回**。
   *
   * ## 失败静默
   *
   * 落盘是增值功能，磁盘满 / 权限不足都不能影响对话。
   */
  function archiveLongText(text: string, sessionId: string): void {
    try {
      const { meta, reused } = artifactStore.store(text);
      const fact = makeArtifactFact({
        hash: meta.hash,
        preview: meta.preview,
        chars: meta.chars,
        kindLabel: '长文档',
        origin: 'user',
        sessionId,
      });
      const verdict = validateFact(fact);
      if (!verdict.ok) {
        ctx.logger.warn(`[lrc] 工件指针 Fact 未通过校验：${verdict.reason}`);
        return;
      }
      offloadExtracted([fact], sessionId, '工件指针');
      ctx.logger.info(
        `[lrc] 长文本已落盘（${meta.chars} 字符，hash=${meta.hash}${reused ? '，复用已有工件' : ''}）：` +
          `可用 lrc_fetch_artifact 取回`,
      );
    } catch (error) {
      ctx.logger.warn(
        `[lrc] 长文本落盘失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * LLM 兜底的**配额账本**：按会话 ID 分桶。
   *
   * ## 为什么必须是 Map，不能是三个标量
   *
   * 审查实测发现两个致命缺陷（`scripts/_probe-review.ts`）：
   *
   * 1. **重置永不触发**：原实现把「会话切换就清零」写在 `runLlmFallback`
   *    内部，而它的前置条件是 `shouldFallback` 返回 true；会话 A 用满 40 次后
   *    `shouldFallback` 恒为 false ⇒ `runLlmFallback` 永不调用 ⇒ 重置永不执行。
   *    切到会话 B 也仍被 A 的计数卡死，**直到进程重启**。
   * 2. **交替即清零**：原实现只有一个标量 + 一个 sessionId，两个会话交替
   *    产生事件时每次归属变化都清零，实测交替 200 次**一次都没被拦**，
   *    40 次上限完全失效 —— 成本护栏在真实多窗口场景下等于不存在。
   *
   * 分桶后每场会话各自记账，互不影响；并且**不做任何「清零」动作**，
   * 切回旧会话时它自己的计数仍在（这才是「按会话配额」的本义）。
   *
   * ## 为什么要有上限淘汰
   *
   * 长跑进程里会话只增不减会让 Map 无界增长。保留最近 N 场即可：
   * 更早的会话已经结束，它的配额状态没有保留价值。
   */
  interface ExtractQuota {
    count: number;
    /** 上一次**真正调用模型**的时刻（0 = 从未调用）。只有间隔判据用它。 */
    lastCallAt: number;
    /** 上一次**被访问**的时刻。只有 LRU 淘汰用它。 */
    touchedAt: number;
  }
  const LLM_EXTRACT_QUOTA_MAX = 20;
  const llmExtractQuota = new Map<string, ExtractQuota>();

  /**
   * 取（或建）某会话的配额条目；超出上限时按最久未访问淘汰。
   *
   * ## 为什么必须分成两个时间戳
   *
   * - `lastCallAt`：只有最小间隔判据用（`sinceLastMs`）
   * - `touchedAt`：只有 LRU 淘汰用
   *
   * 首版把两者合成一个 `lastAt`，然后在 `quotaFor` 里刷新它做 LRU，
   * 结果 `sinceLastMs` 恒为 0 ⇒ **最小间隔判据永久失效**。
   * 反过来若只更新调用时刻，则被配额拦下的**活跃**会话永远不会刷新
   * `lastAt` ⇒ 被当成「最久未用」删掉重建 ⇒ **配额被反复重置**
   * （复核实测：21 会话 × 50 轮 = 1050 条事件全部放行）。
   * 两者目的相反，必须分开。
   */
  function quotaFor(sessionId: string): ExtractQuota {
    const existing = llmExtractQuota.get(sessionId);
    if (existing !== undefined) {
      // 只刷新 LRU 时间戳，**不动** `lastCallAt`（否则间隔判据失效）
      existing.touchedAt = Date.now();
      return existing;
    }
    if (llmExtractQuota.size >= LLM_EXTRACT_QUOTA_MAX) {
      const maxCalls = Math.max(0, config.llmExtractMaxCalls);
      let victimKey: string | null = null;
      let victimAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of llmExtractQuota) {
        // 优先淘汰「未达配额上限」的桶：它还会继续花钱，淘汰它损失最小。
        // 全部达上限时退回「最久未访问」——**必须删掉一个**，否则 Map
        // 无界增长，且新桶会不断获得全额额度（复核实测：21 会话 × 50 轮
        // = 1050 次全部放行）。进程级配额是这种情况下的最终防线。
        const exhausted = maxCalls > 0 && value.count >= maxCalls;
        const rank = exhausted ? value.touchedAt + 1e15 : value.touchedAt;
        if (rank < victimAt) {
          victimAt = rank;
          victimKey = key;
        }
      }
      if (victimKey !== null) llmExtractQuota.delete(victimKey);
    }
    const now = Date.now();
    const fresh: ExtractQuota = { count: 0, lastCallAt: 0, touchedAt: now };
    llmExtractQuota.set(sessionId, fresh);
    return fresh;
  }

  /**
   * 是否值得为这条正文花一次模型调用。
   *
   * 判据本体在 `llm-extract.ts`（纯函数、可单测）；这里只负责喂入
   * **该会话自己的**配额状态。
   *
   * **必须传 sessionId**：不传就无法分桶，就会退回上一版「全局标量」
   * 的缺陷（见 `llmExtractQuota` 注释）。
   */
  function shouldFallback(
    text: string,
    extracted: readonly string[],
    sessionId: string,
    extractedKinds?: readonly string[],
    pending?: readonly string[],
  ): boolean {
    const quota = quotaFor(sessionId);
    return shouldFallbackToLlm({
      text,
      extracted,
      extractedKinds,
      pending,
      enabled: config.llmExtractEnabled,
      minChars: config.llmExtractMinChars,
      maxCalls: config.llmExtractMaxCalls,
      usedCalls: quota.count,
      minIntervalMs: config.llmExtractMinIntervalMs,
      sinceLastMs: quota.lastCallAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - quota.lastCallAt,
      globalCalls: globalWindowCount(Date.now()),
      globalMaxCalls: config.llmExtractGlobalMaxCalls,
    });
  }

  /**
   * 走一次独立模型调用提取关键信息。
   *
   * **失败必须静默**：兜底层是增值功能，任何异常都不能影响主对话，
   * 也不能让 pending 状态卡住。所有错误只记一次 warn。
   *
   * @param ownerSessionId - 配额归属会话（**调用方在同步阶段捕获**）
   */
  async function runLlmFallback(
    text: string,
    session: unknown,
    ownerSessionId: string,
    alreadyExtracted: readonly string[] = [],
    candidates: readonly string[] = [],
    /**
     * 来源（用户消息路径必须传 `'user'`，★2026-11-15 独立审查 P1）。
     *
     * 首版写死 `origin: 'assistant'`，而本函数也被用户消息路径调用 ⇒
     * 用户说的约束被标成助手说的。后果有两个且都不报错：
     * - `importanceOf` 的 `origin === 'user'` 加分（+1）永远拿不到
     * - 写进 LRC 的 `origin` 标签错误，`recall` 侧无法区分来源
     */
    origin: 'user' | 'assistant' = 'assistant',
    /**
     * 本轮纪要槽位（**调用方在同步阶段捕获**，三段审查 C1）。
     *
     * 本函数 `await` 一次模型调用（5~20 秒）才回到 `offloadExtracted`。
     * 期间用户可能已经结束本轮并开始下一轮，`finishingTurns` 里会有多个
     * 同会话槽位 —— 不显式指认就会把 T1 的结论写进 T2 的纪要。
     */
    ownerSlot?: TurnSlot,
  ): Promise<void> {
    // 记账在 await 之前完成：并发事件里两次调用不会共用同一个旧计数
    const quota = quotaFor(ownerSessionId);
    quota.count += 1;
    quota.lastCallAt = Date.now();
    llmExtractCalls += 1;
    llmExtractGlobalStamps.push(Date.now());

    try {
      const lines = await extractWithLlm(ctx, session, text, {
        maxInputChars: config.llmExtractMaxInputChars,
        // 有候选时走「判定」模式：模型只做二分类，产物可追溯到原文
        candidates,
        // ★失败必须留痕（2026-11-16 发布前审查 P1-3）
        //
        // 这是唯一产生额外计费的路径。若不区分「调用失败」与「模型判定无内容」，
        // 超时 / 401 / 路由拒绝在日志里与「没抽到」完全同形，排查时只能靠
        // `lrc_status` 的计数间接推断。
        onFailure: (reason) => {
          ctx.logger.warn(`[lrc] LLM 兜底调用失败（不影响主流程）：${reason.slice(0, 200)}`);
        },
      });
      if (lines.length === 0) {
        llmExtractFailures += 1;
        return;
      }

      // ## 跨批去重：与规则层已抽到的陈述比较
      //
      // 规则层给的是 `不要碰 3099`，LLM 层给的是 `不要再使用 3099 端口`。
      // 直接比整串会被同义改写骗过 —— 两条都进 `recent` 窗口，白占槽位。
      // LLM 返回的行仍带 `约束：` 前缀（那是它的输出契约），先剥掉再比。
      const stripPrefix = (line: string): string => line.replace(/^(约束|决策|结论|事实)：/, '').trim();
      const fresh = lines.filter((line) => {
        const body = stripPrefix(line);
        if (body.length === 0) return false;
        return !alreadyExtracted.some((prev) => {
          // 完全包含：`不要碰 3099` ⊂ `不要再使用 3099 端口…` 的常见形态
          if (prev.length >= 4 && body.includes(prev.slice(0, 8))) return true;
          return areNearDuplicate(prev, body, 0.85);
        });
      });
      if (fresh.length === 0) {
        llmExtractFailures += 1;
        return;
      }
      // LLM 只负责「发现候选」，是否入库仍由同一套 schema 校验裁决 ——
      // 这样规则层与 LLM 层不会有两套语义（这是旧实现的漂移来源）。
      const extracted = factsFromLlmLines(fresh, {
        origin,
        sessionId: ownerSessionId,
      });
      if (extracted.facts.length === 0) {
        llmExtractFailures += 1;
        ctx.logger.info(
          `[lrc] LLM 兜底 ${fresh.length} 条候选全部被 schema 拒绝：` +
            extracted.rejected.map((r) => r.reason).join(','),
        );
        return;
      }
      llmExtractHits += 1;
      // ## 必须补 topic（2026-11-17 实测新会话发现）
      //
      // `factsFromLlmLines` 不经过 `extractFacts`，因此改造时漏了它 ——
      // 实测新会话写入的 5 条全无 topic（`像素画的动感只能靠逐帧切换`），
      // 正是「脱离原文不知在说谁」的碎片。topic 是旁路字段，不参与去重。
      if (origin === 'assistant') attachTopic(extracted.facts, text);
      // ## 必须走**轮末暂存**（2026-11-17 实测新会话发现）
      //
      // 旧写法是 `timing='now'`，于是 LLM 兜底产出的碎片**绕过折叠直接入库**。
      // 实测该路径一次写入 5 条互不相关的短句，正是要消除的形态。
      // 改为 `timing='turn'` 后它们与正文抽取的 Fact 汇入同一轮次桶，
      // 一起参与「凑够 4 条就折叠」。
      offloadExtracted(extracted.facts, ownerSessionId, 'LLM 兜底', 'turn', ownerSlot);
    } catch (error) {
      llmExtractFailures += 1;
      ctx.logger.warn(
        `[lrc] LLM 兜底提取失败（不影响对话）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    const lrcVersion = runtime.status().version;
    ctx.logger.info(
      `[lrc] 记忆沉淀已就绪：${client.baseUrl}` +
        (lrcVersion === undefined ? '' : `（LRC v${lrcVersion}）`),
    );
    // 快照与写入解耦：上次进程没来得及沉淀时，从 LRC 索引重建
    void bootstrapSnapshot();
    drainProseBacklog();
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
    // ## 历史查询必须强制刷新（2026-11-19 六钥匙裁决）
    //
    // 反例：项目对话一直在同一话题，指纹不变 ⇒ 这里直接 return
    // ⇒ 用户中途问「上次那个方案是什么」时，插件**一次都不检索**。
    // 语言信号命中说明用户明确在问过去，此时必须绕过指纹去重。
    const historyQuery = isHistoryQuery(query);
    if (!historyQuery) {
      // 非历史消息：清空去重标记，让去重只覆盖「连续两轮」（第四轮审查 major 3）。
      // 否则「问历史 A → 做一段普通工作 → 再问历史 A」会被误去重，
      // 而此时 recallText 已被普通工作改写，用户第二次问拿不到任何刷新。
      lastHistoryQuery = '';
      // 同一话题：完全不动作（这是缓存友好的核心）
      if (fingerprint === recallFingerprint) return;
    } else if (query === lastHistoryQuery) {
      // 连续两轮问同一句：不重复检索
      return;
    }

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

      // 检索成功后才记去重标记：失败时同一句重问仍应重试（第四轮审查 major 3）
      if (historyQuery) lastHistoryQuery = query;

      // ## 历史查询只放宽**绝对分**闸门（独立审查 major 3）
      //
      // 用户明确在问过去时，「绝对分够不够高」不该成为拦路虎：
      // 单路召回上限 0.0164 永远低于 0.025，而这条记忆可能正是他要的。
      //
      // ⚠ **不能**把 `minScore`（相对分）也放到 0：那会让同批里明显掉队的
      // 第 3、4 条一起进来，而 LRC 全局模式跨项目共享记忆 —— 可能注入
      // 别的项目的决定。保留 0.85 仍能放行 top1（相对分恒 1.0）。
      const opts = historyQuery
        ? { ...recallOptions, minRawScore: 0 }
        : recallOptions;
      const next = formatRecallInjection(result.memories, opts);

      // ## 历史查询**不写回**指纹（复审 minor 7）
      //
      // 反例：用户问「上次那个方案」⇒ 指纹被改成历史句的指纹；
      // 下一条「继续」走 `isContinuation` 沿用上一指纹 ⇒ 与历史查询
      // 指纹相同 ⇒ 被跳过 ⇒ 注入文本停留在历史查询结果上。
      //
      // ⚠ 不写回**不等于**下一条会重算（第四轮审查 major 2）：
      // `topicFingerprint` 对续接句直接返回 previous，而 previous 就是
      // 未变的 `recallFingerprint` ⇒ 仍会早退。所以历史查询的注入文本
      // 会**粘到本话题结束**。这是有意的取舍：历史结果与当前话题相关，
      // 且保持文本不变对前缀缓存友好。真正要防的是「无结果时清空」，
      // 见下面的 `keepPrevious`。
      if (!historyQuery) recallFingerprint = fingerprint;

      // ★可观测性必须优先于短路。
      //
      // 原实现是「`next === recallText` 就 return」，而双闸门挡掉整批时
      // `next` 与旧的 `recallText` 都是空串 ⇒ **一条日志都不留**。
      // 于是「检索到了 2 条候选但被绝对分挡掉」和「压根没检索」在日志里
      // 完全同形，排查时只能看到「插件没工作」。这是本轮测试抓到的真实缺陷。
      // ## 历史查询**无结果时不清空**已有注入（第三轮审查 major 2）
      //
      // 反例：当前话题已注入 2 条有效记忆，用户中途问「上次那个方案」，
      // 历史查询恰好没命中 ⇒ `next=''` ⇒ 把当前话题的注入清空；
      // 而指纹没写回（见下），下一条同话题消息直接 return ⇒
      // **整个话题内再也恢复不了**。保留旧文本才是正确行为。
      const keepPrevious = historyQuery && next.length === 0 && recallText.length > 0;
      const changed = !keepPrevious && next !== recallText;
      if (changed) {
        recallText = next;
        // 计数：注入文本每变一次，宿主的前缀缓存就断一次。
        // 这是评估"注入代价"的唯一实测口径，必须可观测。
        recallRewrites += 1;
      }

      // 实际注入条数以文本里的行数为准：`maxItems` 是上限，过滤后可能更少
      // （绝对分那一道经常把整批挡掉，日志写 maxItems 会骗人）。
      const injected = next.length === 0 ? 0 : next.split('\n').length - 1;
      if (next.length === 0) {
        // ★必须带上最高绝对分，且「有候选但全被拦」要升为 warn。
        //
        // 只写「无相关记忆」会掩盖两种完全不同的情况：
        //   ① 检索真的没结果（候选 0 条）—— 正常；
        //   ② 检索到了 6 条，但全部被绝对分闸门挡掉（top1=0.0164 < 0.025）—— 异常。
        //
        // ②在 RRF 深度路/语义路不可用的部署里会**持续整场会话**发生（此时
        // 单路命中的上限就是 1/61≈0.0164，低于任何合理的闸门值）——
        // 用户会以为「插件没工作」。日志若与①同形，就永远查不出来。
        const top = result.memories.reduce<number>((max, m) => {
          const raw = typeof m.score === 'number' && Number.isFinite(m.score) ? m.score : -1;
          return raw > max ? raw : max;
        }, -1);
        const message =
          `[lrc] 本轮无记忆注入（候选 ${result.memories.length} 条，最高绝对分 ` +
          `${top >= 0 ? top.toFixed(4) : '缺失'}，阈值 ${opts.minRawScore}，指纹 ${fingerprint}` +
          `${historyQuery ? '，历史查询' : ''}` +
          `${keepPrevious ? `，已保留原注入 ${recallText.length} 字符` : ''}）`;
        if (result.memories.length > 0 && top >= 0 && top < opts.minRawScore) {
          ctx.logger.warn(
            `${message} —— 候选全部被绝对分闸门挡掉。若长期如此，` +
              `检查 LRC 的通路权重（语义/深度路不可用时单路上限约 0.0164）或调低 recallInjectMinRawScore`,
          );
        } else {
          ctx.logger.info(message);
        }
      } else if (changed) {
        ctx.logger.info(
          `[lrc] 注入 ${injected}/${result.memories.length} 条候选（${next.length} 字符，` +
            `指纹 ${fingerprint}${historyQuery ? '，历史查询强制注入' : ''}，` +
            `累计改写 ${recallRewrites} 次）`,
        );
      } else if (historyQuery) {
        // ## 历史查询命中但文本没变，也要留痕（独立审查 minor 5）
        //
        // 否则「功能到底触发没有」在日志里完全看不出来 —— 与之前
        // 「检索到了但被挡掉」和「压根没检索」同形是同一类可观测性缺陷。
        ctx.logger.info(
          `[lrc] 历史查询已检索（${result.memories.length} 条候选，` +
            `注入文本未变，指纹 ${fingerprint}）`,
        );
      }
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
      const lines = linesWithOrigin(session);
      if (lines.length === 0) {
        // 只警告一次：否则每一步都会刷同一条日志
        if (!warnedEmpty) {
          warnedEmpty = true;
          ctx.logger.warn('[lrc] 会话日志里没有可沉淀的文本行，本次跳过');
        }
        // **长任务中途兜底**：工具密集型轮次里 assistant 只有 reasoning + tool-call，
        // 正文要等到最后一条回答才出现。如果这里直接 return，整轮中途快照永远是空的，
        // `[LRC 状态]` 也就一直不出现。所以从本轮累计推理里走**同一个提取器**兜底。
        const fromReasoning = extractFactsFromReasoning({
          text: turnReasoning.join('\n'),
          origin: 'assistant',
          sessionId,
        });
        if (fromReasoning.facts.length === 0 && turnReasoning.length > 0 && !warnedNoConclusion) {
          warnedNoConclusion = true;
          ctx.logger.info(
            `[lrc] 推理兜底：本轮推理 ${turnReasoningChars} 字符，未拆出可用三元组` +
              `（拒绝原因：${[...new Set(fromReasoning.rejected.map((r) => r.reason))].join(',') || '无候选'}）`,
          );
        }
        if (fromReasoning.facts.length > 0) {
          // ## 结论必须先汇入纪要账本（审查 C5）
          //
          // 旧实现直接调 `offloader.offloadFacts`，绕过了 `offloadExtracted`
          // —— 而结论收集挂在统一出口上，绕过它等于**这条路径的结论永不进纪要**。
          // 症状：工具密集型轮次（正文占比 0%）的纪要里一条结论都没有。
          collectMinutesConclusions(fromReasoning.facts, sessionId, `推理兜底(${reason})`);
          try {
            // 延后到轮末：这批只有几条，单独写库会退化成碎片。
            //
            // ## 快照必须**在这里**落盘，不能只等轮末收口
            //
            // 长任务中途（`reason` = threshold）走的就是这个分支，而它可能
            // 连续几十步都等不到 turn/end（实测 88 步一轮）。若快照只在收口时写，
            // `[LRC 状态]` 整轮都不出现 —— 这正是 2026-11-07 修过的老问题
            // （快照恒空），e2e-turn 的「快照文件已生成」就是它的回归锁。
            // 收口时再写一次是幂等的（`snapshotChanged` 会拦住无变化）。
            const result = await offloader.offloadFacts(fromReasoning.facts, {
              deferToTurn: true,
            });
            if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
              saveSnapshot(result.snapshot, sessionId);
            }
            ctx.logger.info(
              `[lrc] 推理兜底暂存 ${result.distilled} 条（待轮末折叠，触发：${reason}）`,
            );
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
    // ## 阶段写入的时间节流也要在新轮重置（2026-11-17）
    //
    // `lastMinutesStageAt` 若跨轮保留，新轮的前 `minutesStageMs` 会被
    // 「距上次阶段写入不足间隔」挡掉 —— 而它本就是**上一轮**的写入时刻，
    // 与本轮无关。不清会让长轮次的首次阶段稿被无谓推迟。
    // `lastMinutesStageConclusionCount` 同理会把新轮判成「未增长」。
    lastMinutesStageAt = 0;
    lastMinutesStageConclusionCount = 0;
    // 第三个指纹必须一并清（十一轮审查 minor-1）：漏了它会让「用户中途
    // 追加诉求」这一维度跨轮延续，新轮的首次判定看起来「未增长」。
    lastMinutesStageUserChars = 0;
  }

  /** 单轮累计推理的字符上限：超过就不再收，避免长任务把内存撑爆。 */
  const REASONING_CAP = 20000;

  /**
   * 一轮结束时的收尾：按轮记账 → 主路径沉淀 → 推理兜底。
   *
   * 为什么需要推理兜底：工具密集型轮次里 assistant 只有 reasoning + tool-call，
   * 正文占比 0%，`<lrc_memory>` 标签根本没地方出现。这类轮次只能从推理里
   * 抽带结论标记的句子，否则整轮内容一条都搬不走。
   *
   * @param slot - 本轮对应的纪要槽位。**必须显式传入**（二轮审查 X3）：
   *   本函数是 `void` 异步的，执行期间可能已有后续轮次进入
   *   `finishingTurns`，按 sessionId 模糊查找会命中错误的轮次。
   */
  async function finishTurn(session: unknown, slot?: TurnSlot): Promise<void> {
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
            `（另有 ${turnNoText} 轮无正文）` +
            (config.llmExtractEnabled
              ? `；LLM 兜底 ${llmExtractCalls} 次调用，命中 ${llmExtractHits} 次，失败 ${llmExtractFailures} 次`
              : '；LLM 兜底未启用'),
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

    // 2. 冲刷**本轮暂存**的正文 Fact（折叠后一次写库）
    //
    // ## ⚠️ 必须在 `flush()` **之前**（2026-11-17 独立审查修出的 critical）
    //
    // `flush()` 会从 transcript 重新 `extractFacts` 并**立即 migrate 未折叠的碎片**，
    // 同时把那些 statement 推进 `recent`。若先执行 `flush()`：
    // ```
    // flush()  → 碎片逐条入库 + recent.push(碎片)
    // flushTurn → 同一批 statement 全部命中 isDuplicate ⇒ kept 为空
    //           ⇒ distilled=0 / folded=0，折叠**从未生效**
    // ```
    // 症状是静默的：日志里只有「写入 N 条」，没有任何报错。
    //
    // 先冲刷暂存则顺序正确：
    // ```
    // flushTurn → 折叠成 1 条入库 + recent.push(折叠后的整句)
    // flush()   → 再抽出的原始碎片与 recent 比对 ⇒ 被去重拦下（不重复写）
    // ```
    // 这是「宁重不漏」的方向：宁可让 flush 的碎片被去重，也不让折叠被去重。
    {
      const turnResult = await offloader.flushTurn(sessionId);
      if (turnResult.distilled > 0) {
        if (
          turnResult.snapshot.length > 0 &&
          snapshotChanged(latestSnapshot, turnResult.snapshot)
        ) {
          saveSnapshot(turnResult.snapshot, sessionId);
        }
        const folded = turnResult.folded ?? 0;
        ctx.logger.info(
          `[lrc] 轮末沉淀 ${turnResult.distilled} 条` +
            (folded > 0 ? `（其中 ${folded} 条碎片折叠为 1 条摘要）` : '') +
            `，写入 ${turnResult.written}，合并 ${turnResult.merged}`,
        );
      }
    }

    // 3. 兜底：本轮没有正文时，从推理里抽结论句（走同一个提取器）
    //
    // ## 必须在**轮末收口之前**（2026-11-17 实测新会话发现）
    //
    // 旧顺序是「收口 → 推理兜底」，于是推理兜底这一批**永远落在收口之后**，
    // 它们只能自己单独走一次 `offloadFacts`。实测该批次只有 1~3 条，
    // 凑不满折叠阈值 ⇒ 又是一批未折叠碎片。
    // 现在改为先抽、再与正文 Fact 一起收口。
    if (!hadText && reasoning.length > 0) {
      const fromReasoning = extractFactsFromReasoning({
        text: reasoning,
        origin: 'assistant',
        sessionId,
      });
      if (fromReasoning.facts.length > 0) {
        // ## 结论必须先汇入纪要账本（审查 C5）
        //
        // `archiveTurn` 已不在 `turn/end` 里直接执行（改为 `finishTurn` 的
        // `finally` 之后），所以这里是**推理兜底这条路径唯一的收集点**。
        // 少了它，工具密集型轮次的纪要固定为空。
        //
        // **必须传 `slot`**（二轮审查 X3）：本函数是 `void` 异步的，
        // 期间可能已有后续轮次进入 `finishingTurns`。
        collectMinutesConclusions(fromReasoning.facts, sessionId, '推理兜底(轮末)', slot);
        try {
          // 延后到轮末：与本轮正文 Fact 一起折叠（单批只有几条，独立写会成碎片）
          const result = await offloader.offloadFacts(fromReasoning.facts, {
            deferToTurn: true,
          });
          if (result.distilled > 0) {
            // 快照同样在这里落盘：轮末收口虽会再算一次，但若本轮已无其它 Fact，
            // 收口那次拿到的池子是一样的 —— 先写能保证「本轮结束就有状态可用」。
            if (result.snapshot.length > 0 && snapshotChanged(latestSnapshot, result.snapshot)) {
              saveSnapshot(result.snapshot, sessionId);
            }
            ctx.logger.info(`[lrc] 推理兜底暂存 ${result.distilled} 条（待轮末折叠）`);
          }
        } catch (error) {
          ctx.logger.warn(
            `[lrc] 推理兜底沉淀失败（不影响对话）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // 4. 主路径：正文行（长任务的最终报告只在这里出现一次）
    //
    // ## 折叠开启时，这里**只负责转交**，真正写库在步骤 5
    //
    // `offload()` 在 foldEnabled 时不再直接 migrate，而是把新增切片提取出的
    // Fact 交给本轮桶（见 offloader 里 `deferred` 的注释）。原因是它每次只处理
    // 游标之后的一小段，往往只有 1~2 条，凑不满折叠阈值 ⇒ 会退化成逐条碎片。
    await flush(session, 'turn/end');

    // 5. 轮末收口：把本轮桶里的全部 Fact 折叠后**一次写库**
    //
    // 漏掉这一步 = 整轮内容留在内存里不落库（数据丢失）。
    // 必须排在 `flush()` **之后**，才能接住它转交进来的那批。
    {
      const finalResult = await offloader.flushTurn(sessionId);
      if (finalResult.distilled > 0) {
        if (
          finalResult.snapshot.length > 0 &&
          snapshotChanged(latestSnapshot, finalResult.snapshot)
        ) {
          saveSnapshot(finalResult.snapshot, sessionId);
        }
        const folded = finalResult.folded ?? 0;
        ctx.logger.info(
          `[lrc] 轮末收口 ${finalResult.distilled} 条` +
            (folded > 0 ? `（其中 ${folded} 条碎片折叠为 1 条摘要）` : '') +
            `，写入 ${finalResult.written}，合并 ${finalResult.merged}`,
        );
      }
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
      // ★2026-11-17：纪要账本的本轮起点。
      //
      // 必须在 `turn/start` 建立：这是**唯一**能拿到「本轮真实开始时间」的时刻。
      // 若等用户消息到达才建，时间会晚几十毫秒到几秒（长任务里更多），
      // 而纪要的时间线要精确到分钟供人回溯。
      //
      // ## 先归档上一轮残留再建新槽（审查 M6）
      //
      // 单槽变量直接覆盖会丢内容：若 `turn/end` 因崩溃/事件丢失/宿主版本
      // 变化未到达，该轮的 `userText` 与 `conclusions` 被静默覆盖。
      // 这里用 `'no-end'` 标记，让纪要里能看出「这一轮没有正常收尾」。
      if (liveTurn !== undefined) {
        archiveTurn(liveTurn, 'no-end');
        liveTurn = undefined;
      }
      const turnIdx =
        ((event as { data?: { turn?: number } })?.data?.turn ?? archivedTurns + 1);
      // 本轮起点同时是账本归属的兜底：`bindSnapshotToSession` 已在最前面调过，
      // 正常情况下 `minutesOwnerSessionId` 就是 `sessionId`。
      if (minutesOwnerSessionId !== sessionId) bindMinutesSession(sessionId);
      // ★D 方案：账本绑定完成后探一次库，回填 `memoryId`。
      //
      // 必须在 `bindMinutesSession` **之后**：那里可能已从磁盘恢复出
      // `memoryId`，此时 `maybeProbeMinutesOnce` 会直接返回（省一次 HTTP）。
      // 只有「磁盘也没有」的冷启动场景才会真的去探。
      maybeProbeMinutesOnce(sessionId);
      const now = Date.now();
      liveTurn = {
        idx: turnIdx,
        startedAt: now,
        lastActivityAt: now,
        sessionId,
        userText: '',
        conclusions: [],
      };
      liveTurnSessionId = sessionId;
      // ★2026-11-17：**先冲刷上一轮残留，再重置本轮状态。**
      //
      // 顺序不能反：`resetTurnState` 只清轮级变量，不清 offloader 的暂存桶；
      // 但语义上必须先处理「上一轮还没来得及写的内容」。
      //
      // ## 为什么这里必须有冲刷
      //
      // 正文抽取改成了轮内暂存（`timing: 'turn'`），收口点是 `turn/end`。
      // 但**用户中止的轮次走不到 turn/end** —— 而这在真实会话里是常态
      // （代码库既有注释记载：实测 turn 2/3 都是 aborted by user）。
      // 不在这里补冲刷，被中止那一轮的全部结论就永久留在内存里。
      //
      // 用 `void` 而非 await：这里是事件回调，不能阻塞下一轮开始。
      const pending = offloader.turnPending(sessionId);
      if (pending > 0) {
        void offloader
          // `intoPool: false`：这是**上一轮**的残留，本轮快照还没建立，
          // 推进去会让本轮第一次注入带上上一轮的约束。
          .flushTurn(sessionId, { intoPool: false })
          .then((result) => {
            if (result.distilled > 0) {
              if (
                result.snapshot.length > 0 &&
                snapshotChanged(latestSnapshot, result.snapshot)
              ) {
                saveSnapshot(result.snapshot, sessionId);
              }
              ctx.logger.info(
                `[lrc] 上一轮被中止，补写暂存的 ${result.distilled} 条` +
                  `（折叠 ${result.folded ?? 0} 条，写入 ${result.written}）`,
              );
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn(
              `[lrc] 补写上一轮暂存失败（不影响对话）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      resetTurnState();
      return;
    }

    // turn 结束：长任务的最终报告只在这里出现一次，必须兜底收走
    if (type === 'turn/end') {
      // ★2026-11-17：把本轮**摘出** `liveTurn` 放进 `finishingTurns`，
      // 等 `finishTurn` 跑完再归档。
      //
      // ## 为什么不能先归档再 finishTurn（审查 C5）
      //
      // `finishTurn` 里的推理兜底会从推理流抽结论并调
      // `collectMinutesConclusions`。若 `liveTurn` 已被清空、轮次已归档，
      // 那批结论就**没有收集目标**，直接丢弃 —— 症状是工具密集型轮次
      // （正文占比 0%）的纪要固定为空。
      //
      // 摘出（而非原地保留）的理由：`finishTurn` 有多次 HTTP，期间可能
      // 收到下一轮 `turn/start`，那时 `liveTurn` 会被换成新槽位。
      const finished = liveTurn;
      if (finished !== undefined) {
        liveTurn = undefined;
        liveTurnSessionId = '';
        finishingTurns.push(finished);
      } else {
        // ## 无槽位必须留痕（五轮审查 m2）
        //
        // 只有在 `turn/start` 事件丢失时才会走到这里（`liveTurn` 从未建立）。
        // 不记日志的话，用户看到「这一轮没进纪要」时无法区分
        // 「抽取器没抽到结论」与「事件缺失导致整轮没记录」。
        ctx.logger.info(
          `[lrc] turn/end 但本轮无槽位（turn/start 可能丢失），该轮不进纪要（${sessionId}）`,
        );
      }
      const reason =
        ((event as { data?: { reason?: { kind?: string } } })?.data?.reason?.kind ?? 'unknown');
      void finishTurn(session, finished)
        .catch((error: unknown) => {
          // `finishTurn` 内部已各自 try/catch，这里兜住意外 reject：
          // 不 catch 会变成 unhandled rejection，且纪要触发被静默跳过。
          ctx.logger.warn(
            `[lrc] turn/end 收尾异常（不影响对话）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          // 归档放在 `finally`：即使 finishTurn 抛错，这一轮的诉求也不能丢。
          if (finished !== undefined) {
            const at = finishingTurns.indexOf(finished);
            if (at >= 0) finishingTurns.splice(at, 1);
            archiveTurn(finished, reason);
          }
          void maybeWriteMinutes(sessionId, 'turn/end');
        });
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
      const userText = userMessageText(event);
      // ★2026-11-17：记入纪要账本的本轮诉求。
      // 多句拼成一段（用户常先说一句、再补一句），与正文抽取消洗同口径。
      if (liveTurn !== undefined && userText.trim().length > 0) {
        liveTurn.userText = liveTurn.userText.length === 0
          ? userText.trim()
          : `${liveTurn.userText} ${userText.trim()}`;
        // `endedAt` 的真实来源（审查 M6）：`turn/end` 丢失时按最后活动时间归档，
        // 而不是记成「下一轮的开始时刻」。
        liveTurn.lastActivityAt = Date.now();
      }
      void refreshRecallInjection(userText);

      // ★用户消息走**同一个提取器**。
      //
      // 旧实现有两条独立路径：`constraintsFromUser`（纠正句式，要求
      // 「你」+ 危害词）与 `isKeyResourceLocation`（媒体文件 + 位置词），
      // 两者判据互不相干，且都收不住「使用 A 目录的音频加 B 目录的文案」
      // 这类多目录交代（实测 session-c8762e44 三处同时失守，注入 0 次）。
      //
      // 现在用户消息与助手正文共用 `extractFacts`，唯一区别是 `origin` ——
      // 它只影响资源位置这一类是否启用（助手正文里的路径是过程描述，
      // 用户说的才是交代）。
      const result = extractFacts({
        text: userText,
        origin: 'user',
        sessionId,
      });
      offloadExtracted(result.facts, sessionId, '用户消息');

      // ★用户消息同样要走 LLM 兜底（★2026-11-14 修复）
      //
      // ## 为什么这条路径曾经完全漏掉
      //
      // 兜底最初是为「助手正文里的结论」设计的，所以只挂在 assistant/message
      // 分支上。但实测 session-95eaf7e3（新项目开工）：用户粘贴了 16882
      // 字符的产品文档，切出 **188 条待裁决句**，一条都没送模型 —— 而这
      // 恰恰是整套系统里信息密度最高的一刻（需求、约束、交互规则全在
      // 这份文档里）。
      //
      // ## 与落盘的关系
      //
      // 落盘解决的是「不占上下文」，兜底解决的是「入库」。两者不冲突：
      // 文档落盘后模型仍需要知道「这份文档里定了哪几条硬约束」，那正是
      // 兜底产物（Fact）的作用。
      const userExtractedKinds = result.facts.map((f) => f.kind);
      if (shouldFallback(userText, result.facts.map((f) => f.statement), sessionId, userExtractedKinds, result.pending)) {
        // 同步阶段捕获本轮槽位：`runLlmFallback` 会 await 模型调用，
        // 期间 `turn/end` 可能已到、`finishingTurns` 可能有多个槽位（审查 C1）
        const ownerSlot = liveTurn !== undefined && liveTurnSessionId === sessionId ? liveTurn : undefined;
        void runLlmFallback(
          userText,
          session,
          sessionId,
          result.facts.map((f) => f.statement),
          result.pending,
          'user',
          ownerSlot,
        );
      }

      // ★长文本落盘：用户粘贴的整份文档 / 超长代码不该占着上下文。
      //
      // ## 为什么不在助手正文上做
      //
      // 助手的超长输出通常是它自己生成的分析，落盘后模型还可能在后续轮次
      // 引用它 —— 那会变成「引用了一个不存在于上下文里的东西」。用户的
      // 输入是**素材**，落盘后由用户自己决定何时取回，语义更清晰。
      if (artifactEnabled && isArtifactWorthy(userText, artifactMinChars)) {
        archiveLongText(userText, sessionId);
      }
      return;
    }

    // 只关心助手消息；其余事件（用户消息、工具调用等）直接跳过，
    // 否则会在第一条非 assistant 事件上误报「取不到文本」。
    if (type !== 'assistant/message') return;

    const content = messageContent(event);
    // **口径必须与 linesWithOrigin 一致**：只取正文块。
    const text = textBlocksOnly(content);
    const reasoning = reasoningBlocksOnly(content);

    if (text.length > 0) {
      turnHadText = true;
      if (extractMemoryTag(text) !== null) turnTagSeen = true;
      offloader.observe(text);

      // ★2026-11-12：**不等 turn 结束**，正文里出现关键信息就立刻收走。
      //
      // 为什么必须另开一条路：系统提示要求模型每轮输出 `<lrc_memory>`，
      // 实测 56 条正文里只有 1 条带标签（1.8%）。而 turn 可能被用户中止
      // （实测 turn 2/3 都是 aborted by user），中止时不会走到轮末兜底。
      //
      // ## 与旧实现的区别
      //
      // 旧路径是 `constraintsFromProse`（正则二分类），它只回答
      // 「这句像不像约束」。新路径是 `extractFacts`（schema 三元组），
      // 它回答「这句能不能拆成 subject + predicate + value」——
      // 后者有界（谓词词表可枚举），前者无界（措辞无穷）。
      const extracted = extractFacts({
        text,
        origin: 'assistant',
        sessionId,
      });
      // ★2026-11-17：正文抽取改为**轮内暂存**（`timing: 'turn'`）。
      //
      // 正文是逐句切分的，每条消息只抽 1~3 条 —— 立即写库会产生海量单句碎片
      // （实测 1515 条、长度中位 33 字、19.3% ≤ 20 字）。改为暂存到本轮后，
      // `turn/end` 会把这批折叠成 1 条带成员内容的摘要再写。
      //
      // 用户消息仍走 `'now'`（见下方）：它是低频的完整表述，不存在碎片问题。
      offloadExtracted(extracted.facts, sessionId, '正文抽取', 'turn');

      // ★2026-11-13：规则层抽得不够时，用一次独立模型调用补全。
      //
      // ## 为什么规则层不可能靠继续加正则解决
      //
      // 正则的能力边界是「我见过的措辞」，而模型的表达是开放的。
      // 每补一条正则就会有新措辞漏过去 —— 这是结构缺陷，不是覆盖不足。
      //
      // ## 注意这里**不是** else 分支
      //
      // 首版写成 `else`（规则 0 条才兜底），端到端实测立刻暴露漏洞：
      // ```
      // 正文 3 句 → 规则抽出 1 条「以后不要再碰 3099」
      // 但因为 ≥1 条，兜底不触发 ⇒ 漏掉「旧进程未退出」这条真结论
      // ```
      // 抽到一条不等于抽全。判据由 `shouldFallbackToLlm` 统一裁决。
      //
      // `alreadyExtracted` 用 statement 的列表（schema 之后不再有
      // `约束：` 这种人工前缀）。
      const alreadyExtracted = extracted.facts.map((f) => f.statement);
      // 类型缺口必须按**类别**判：`alreadyExtracted` 是 schema 生成的裸陈述，
      // 不含 `结论：` 这类中文前缀（见 `missingKinds` 注释）。
      const extractedKinds = extracted.facts.map((f) => f.kind);
      // ★2026-11-14：`pending` 是「结构合格但没命中谓词表」的句子。
      // 它们是兜底的主要输入 —— 实测这类句子占长正文的 96%。
      if (shouldFallback(text, alreadyExtracted, sessionId, extractedKinds, extracted.pending)) {
        // 同步阶段捕获槽位（审查 C1）：本调用在 assistant/message 事件里，
        // 此时 `liveTurn` 确定是本轮 —— 但 `runLlmFallback` 会 await 模型，
        // 回来时本轮可能已归档、后面又起了新轮次。
        const ownerSlot = liveTurn !== undefined && liveTurnSessionId === sessionId ? liveTurn : undefined;
        void runLlmFallback(text, session, sessionId, alreadyExtracted, extracted.pending, 'assistant', ownerSlot);
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
  //
  // ## 参数与返回类型交给宿主的上下文推断（2026-11-17 引入 tsc 后修正）
  //
  // 旧签名把 `payload` 标成 `unknown`、返回标成 `Promise<unknown>`，
  // 与宿主声明的 `(payload: { agent, … }, next: () => Promise<PreStepDecision>)
  // => Promise<PreStepDecision>` 不兼容。运行期一直是对的（函数体直接透传
  // `next()` 的返回值），但类型不匹配意味着**宿主签名一变就不会报错**。
  // 去掉显式标注后由 `ctx.on` 的事件表推断，逻辑一行不动。
  ctx.on('agent/pre-step', async (payload, next) => {
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
          // ## 必须显式兜底（★2026-11-16 发布前审查 P1-2）
          //
          // 宿主**不会**为老 patch 补齐新字段，`config.trimMaxNodes` 可能是
          // `undefined`，而 `nodeCount > undefined` **恒为 false** ⇒ 这条
          // 「token 计量失真时的最后一道硬上限」会**静默失效**，不报错、
          // 日志也正常。与 `artifactQuotaMb` 的 NaN 是同一类缺陷。
          const trimMaxNodes =
            typeof config.trimMaxNodes === 'number' && Number.isFinite(config.trimMaxNodes) && config.trimMaxNodes > 0
              ? config.trimMaxNodes
              : 120;
          const force = nodeCount > trimMaxNodes;
          if (force) {
            ctx.logger.info(
              `[lrc][trim] 节点数 ${nodeCount} 超过上限 ${trimMaxNodes}，跳过 token 阈值强制裁剪`,
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
              // **两条路径都必须限流，不只 force**。
              //
              // 事故形态（141 节点裁 131 / 137 裁 127）在真实日志里正是
              // 「节点数 >120 ⇒ force」触发的，所以上一版只给 force 加限制，
              // 看起来修好了。但 token 触发路径（窗口 300K~800K 时
              // trimMin 降到 8 万，节点数 114 就触发）传的是 `undefined`
              // ⇒ 一次裁 104（91%），**同一事故原样复发**。
              //
              // 节点数硬上限只是个「兜底触发器」；真正决定「一次裁多少」的
              // 是这里。所以两条路径统一用一个上限：见 `trimMaxNodesPerRun`。
              maxNodesPerRun: trimMaxNodesPerRun,
              // 摘要的「助手结论」段从这里投影，而不是靠 role 猜。
              // 不传的话，摘要会把「我先去仓库看看」这类过程叙述当结论。
              facts: sessionFacts,
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
    // 纪要 backlog 的周期消费点（二轮审查 M-a）。
    //
    // 只在 `minutesBacklog` 非空时才有实际开销（一次 HTTP）；为空时
    // `retryPendingMinutes` 立刻返回。节流是为了不每步都白跑一次判断。
    if (minutesBacklog.size > 0 && governor.steps % MINUTES_RETRY_STEP_INTERVAL === 0) {
      retryPendingMinutes();
    }
    // 轮内阶段纪要：长任务一轮可能跑几十分钟都不 turn/end，
    // 这里每步做一次 O(1) 判定（时间与结论数比较），到点才真正写。
    maybeWriteStageMinutes();
    // 轮内暂存的时间上限：内容稀疏但轮次很长的 goal 任务里，
    // 桶永远到不了 40 条，靠这里把崩溃丢失窗口压到 30 分钟。
    // 宿主 payload 走的是 cast，用 typeof 守卫兜住 null（不能只看空串）。
    const stepSessionId = (payload as { agent?: { session?: { id?: unknown } } })?.agent?.session?.id;
    maybeFlushTurnFacts(typeof stepSessionId === 'string' ? stepSessionId : undefined);
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
          // 与自动沉淀路径**完全同一套**：extractFacts → validateFact → migrate。
          //
          // 旧实现这里有第三条分支（`client.migrateText` 走服务端 distill 透传），
          // 那是本插件最大的污染源，已随 schema 化一并移除。
          const extracted = extractFacts({
            text: args.text,
            origin: 'assistant',
            sessionId: currentSessionId,
          });
          if (extracted.facts.length === 0) {
            const reasons = [...new Set(extracted.rejected.map((r) => r.reason))].join(',');
            ctx.logger.info(`[lrc][tool] lrc_remember_now 无可入库内容（${reasons || '无候选'}）`);
            return {
              snapshot: `未沉淀：没有可拆成「主体+关系+取值」的关键信息${reasons.length > 0 ? `（${reasons}）` : ''}`,
              distilled: 0,
              written: 0,
              merged: 0,
            };
          }
          const items = factsToItems(extracted.facts) as DistilledItem[];
          const migrated = await client.migrate(items, config.project);
          ctx.logger.info(
            `[lrc][tool] lrc_remember_now 沉淀 ${items.length} 条（写入 ${migrated.written}，合并 ${migrated.merged}）`,
          );
          return {
            snapshot: extracted.facts.map(renderFact).join('\n'),
            distilled: items.length,
            written: migrated.written,
            merged: migrated.merged,
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
          // DSH 工具框架在 execute 之前已校验 `top_k` 必须是有限数字
          // （实测传 NaN 会抛 ToolArgsError），这里只需处理缺省与范围钳制。
          const topK = Math.min(Math.max(args.top_k ?? 5, 1), 20);
          // ## 历史查询走「纪要优先」两段式（2026-11-19 六钥匙裁决）
          //
          // 实测 dsh 项目：2039 条未折叠碎片 vs 3 条结构化纪要。单次语义检索
          // 时碎片数量占绝对优势，会把纪要挤出 top_k —— 模型拿到一堆
          // 「改成 16px」，却看不到「这一轮到底在做什么」。
          //
          // 纪要必带 `session-minutes` 标签，可精确过滤（与冷启动探查同一手段）。
          // **只在历史查询时启用**：明细类问题（「图标尺寸是多少」）不需要
          // 3K 字符的纪要占位，直接走全库检索。
          const historyQuery = isHistoryQuery(query);
          let minutes: RecallItem[] = [];
          if (historyQuery) {
            // ## 纪要段独立 try（独立审查 major 1）
            //
            // 纪要只是增强项。若与明细共用外层 try，纪要段一次超时就会让
            // 整次召回返回「失败」，连明细也拿不到 —— 相对改动前是功能倒退。
            try {
              const m = await client.recall(query, {
                topK: 1,
                // ## 纪要段必须收窄项目（独立审查 major 3）
                //
                // 明细段缺省不过滤是为了不漏手工 remember 的记忆；但纪要段是
                // **硬取 top-1**，跨项目时会把别的项目 3K 字符的纪要塞进来。
                // 纪要恒写入 `config.project`，用它兜底是安全的。
                // ⚠ 用 `||` 而非 `??`：空串也要回退（复审 minor 3）
                project: args.project || config.project || undefined,
                tags: ['session-minutes'],
              });
              // ## 不加绝对分闸门，改为输出时标注（独立审查 major 2）
              //
              // `tags` 是**检索前过滤**（LRC 的 RecallFilter），候选集只有 3 条
              // 纪要，top-1 的 `score_norm` 恒为 1.0。若按 `score >= 0.02` 硬闸，
              // 单路命中（0.0164）的相关纪要会被误杀 —— RRF 是名次分不是相似度，
              // 用它做相关性判据会同时产生假阴与假阳。故保留纪要，但在输出里
              // 明确标注「按标签取回，非语义匹配」，把判断权交给模型。
              minutes = m.memories;
            } catch (error) {
              ctx.logger.warn(
                `[lrc][tool] 纪要段检索失败，降级为仅明细：${noteToolFailure(error).slice(0, 120)}`,
              );
            }
          }
          const detailK = Math.max(topK - minutes.length, 0);
          let detailMemories: RecallItem[] = [];
          let detailTotal = 0;
          if (detailK > 0) {
            try {
              const r = await client.recall(query, {
                topK: detailK,
                // 缺省不按项目过滤：插件沉淀写 config.project，手工 remember 可能写别的项目，
                // 过滤会漏掉一半。需要收窄时由调用方显式传 project。
                project: args.project,
              });
              detailMemories = r.memories;
              detailTotal = r.total;
            } catch (error) {
              // ## 明细段失败时用纪要兜底（复审 minor 5）
              //
              // 纪要已经取到了，不能因为明细失败就整次返回「失败」。
              // 只有两段都空时才让异常冒到外层。
              if (minutes.length === 0) throw error;
              ctx.logger.warn(
                `[lrc][tool] 明细段检索失败，仅返回纪要：${noteToolFailure(error).slice(0, 120)}`,
              );
            }
          }
          // 纪要可能同时出现在明细结果里，按 id 去重
          const seen = new Set(minutes.map((m) => m.id));
          // 防御性截断：LRC 已在服务端按 top_k 截断，这里只防未来变更（复审 minor 2）
          const merged = [...minutes, ...detailMemories.filter((m) => !seen.has(m.id))].slice(
            0,
            topK,
          );
          const detailCount = Math.max(0, merged.length - minutes.length);
          // 历史查询的措辞必须区分「纪要」与「明细」，否则「三路候选」会误导（复审 minor 4）
          const summary = historyQuery
            ? `召回 ${merged.length} 条（纪要 ${minutes.length} 条 + 明细 ${detailCount} 条）`
            : describeRecall(merged.length, detailTotal);
          // 工具调用必须可观测：此前 recall 无任何日志，排查时看不到它是否被调用。
          ctx.logger.info(`[lrc][tool] lrc_recall "${query}" → ${summary}`);
          if (merged.length === 0) {
            return { text: 'LRC 未命中，可回退内置搜索。', count: 0 };
          }
          const lines = merged.map((m, i) => {
            const kind = m.memory_type ?? 'fact';
            // 纪要的 score_norm 恒为 1.0（相对分），直接显示「相关度 100%」会误导
            if (seen.has(m.id)) {
              return `（记忆 #${i + 1} · 会话纪要 · 按标签取回，非语义匹配 · id=${m.id}）\n${m.content}`;
            }
            const rel = Math.round((m.score_norm ?? 0) * 100);
            // 带上 id：AI 发现某条是错的时，用 lrc_forget 精确撤回
            return `（记忆 #${i + 1} · 相关度 ${rel}% · ${kind} · id=${m.id}）\n${m.content}`;
          });
          return {
            text: `LRC ${summary}：\n\n` + lines.join('\n\n'),
            count: merged.length,
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

        // ── 从 Fact 账本投影交接文档（不是让模型写）──
        //
        // 详见 `handoff-projection.ts` 顶部注释：提示词要求模型输出三段式
        // 实测命中率 1.8%；而 arXiv 2608.11242 证明约束若埋在摘要散文里
        // 合规率只有 31.8%，独立列出则升到 99.7%。所以这里完全由结构化
        // Fact 渲染，零模型依赖。
        let text: string;
        if (sessionFacts.length > 0) {
          const projected = projectHandoff({
            facts: sessionFacts,
            task: source.lastUserRequest,
            note: args.note ?? '',
          });
          text = projected.text;
          ctx.logger.info(
            `[lrc][tool] lrc_handoff 从 ${sessionFacts.length} 条 Fact 投影：` +
              `事实 ${projected.sections.confirmed.length} / 进展 ${projected.sections.progress.length} / ` +
              `下一步 ${projected.sections.next.length}`,
          );
        } else if (connection.peek() !== null) {
          // 账本为空（插件中途加载 / 刚重启）：退回按索引行拼装。
          //
          // 这里**不能**假装有 Fact —— 索引行是记忆预览，不是本会话结论。
          // 明确降级并在日志里说明，比编造一份「看起来完整」的交接文档安全。
          let indexLines: string[] = [];
          try {
            const index = await connection.peek()!.index(config.project, 10);
            indexLines = index.items.map((item) => item.content_preview);
          } catch {
            // 索引只是锦上添花
          }
          text = buildHandoffText({
            lastUserRequest: source.lastUserRequest,
            recentAssistant: source.recentAssistant,
            snapshot: latestSnapshot,
            indexLines,
            note: args.note ?? '',
          });
          ctx.logger.info('[lrc][tool] lrc_handoff 本会话 Fact 账本为空，退回索引拼装');
        } else {
          text = buildHandoffText({
            lastUserRequest: source.lastUserRequest,
            recentAssistant: source.recentAssistant,
            snapshot: latestSnapshot,
            indexLines: [],
            note: args.note ?? '',
          });
          ctx.logger.info('[lrc][tool] lrc_handoff 无 Fact 账本且 LRC 未连接，退回纯文本交接');
        }

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

  // 工件取回：长文本落盘后的**唯一读取入口**。
  //
  // ## 为什么需要独立工具
  //
  // 落盘后上下文里只剩一条 `[工件] 长文档已存入工件库（… hash=abc123）：首行预览`。
  // 模型要读原文，必须有一个按 hash 取回的通道 —— 否则「存进去就再也取不回来」，
  // 比不落盘更糟。
  //
  // ## 为什么限制单次返回长度
  //
  // 取回的原文会直接进上下文。用户可能贴了 2MB 文档，一次全返回等于
  // 立刻把窗口打满，与本功能的目的相反。默认只返回前 N 字符，
  // 并明确告知总长度与偏移，让模型可以分段取。
  registerTool('lrc_fetch_artifact', () =>
    defineTool({
      name: 'lrc_fetch_artifact',
      description:
        '取回此前落盘的长文档 / 超长代码原文。' +
        '当上下文里出现「[工件] 长文档已存入工件库（… hash=xxx）」而你需要看原文时调用。' +
        `单次最多返回 ${ARTIFACT_CHUNK_CHARS} 字符，超长内容用 offset 分段读。`,
      parameters: {
        hash: {
          type: 'string',
          required: true,
          description: '工件 hash（从 [工件] 记忆条目里取 hash= 后面的值）',
        },
        offset: {
          type: 'number',
          description: '起始字符偏移，默认 0',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            found: { type: 'boolean', required: true },
            total: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { hash: string; offset?: number }) {
        const hash = typeof args.hash === 'string' ? args.hash.trim() : '';
        if (hash.length === 0) {
          return { text: 'lrc_fetch_artifact 需要非空的 hash。', found: false, total: 0 };
        }
        const body = artifactStore.fetch(hash);
        if (body === null) {
          return {
            text:
              `未找到工件 ${hash}。可能已被配额淘汰，或 hash 有误。` +
              `可用 lrc_recall 检索「工件」类记忆确认可用的 hash。`,
            found: false,
            total: 0,
          };
        }
        const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
        const chunk = body.slice(offset, offset + ARTIFACT_CHUNK_CHARS);
        const more = offset + chunk.length < body.length;
        const head =
          offset === 0
            ? `工件 ${hash}（共 ${body.length} 字符）`
            : `工件 ${hash}（共 ${body.length} 字符，从 ${offset} 开始）`;
        const tail = more ? `\n\n--- 还有 ${body.length - offset - chunk.length} 字符，用 offset=${offset + chunk.length} 继续读 ---` : '';
        ctx.logger.info(`[lrc][tool] lrc_fetch_artifact ${hash} → ${chunk.length}/${body.length} 字符`);
        return {
          text: `${head}\n\n${chunk}${tail}`,
          found: true,
          total: body.length,
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
            // 版本只在探测瞬间取一次，服务端热升级后这里不会自动变，故标注「探测时」
            `- 运行时：${rt.mode}${rt.version === undefined ? '' : `（探测时 LRC v${rt.version}）`}` +
              `｜连续降级 ${rt.degradeCount} 次｜下次重探 ${Math.ceil(rt.retryInMs / 1000)}s`,
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
          // 轮内暂存：正文抽取改为轮末统一切，这里要能看到「还没写的有多少」
          const turnPending = offloader.turnPending();
          if (turnPending > 0) {
            lines.push(`暂存（含旧会话）：${turnPending} 条待轮末沉淀（turn/end 或下次 turn/start 时写入）`);
          }
          // 折叠统计：回答「1515 条碎片现在压成多少条」。
          // 没有这一行时，用户只能看到「新写入 N 条」，无法判断碎片化是否改善。
          if (stats.foldBatches > 0) {
            const ratio = (stats.totalFolded / stats.foldBatches).toFixed(1);
            lines.push(
              `同批折叠：${stats.foldBatches} 批 / 覆盖 ${stats.totalFolded} 条原始结论` +
                `（平均每批 ${ratio} 条 → 1 条摘要）`,
            );
          } else {
            lines.push('同批折叠：尚未触发（一批不足 4 条时不折叠）');
          }
          // 会话纪要：回答「这段对话有没有被沉淀成一份纪要」。
          // 没有这一行时，用户只能靠 LRC 里搜 `session-minutes` 才知道有没有写。
          if (minutesEnabled) {
            if (turnLedger.length === 0) {
              lines.push(
                `会话纪要：本会话尚无轮次记录（首轮即写入，之后每 ${minutesEveryTurns} 轮更新` +
                  `${minutesIdleMs > 0 ? `，或空闲 ${Math.round(minutesIdleMs / 60000)} 分钟后` : ''}）`,
              );
            } else {
              const draft = buildMinutes(
                currentSessionId,
                turnLedger,
                undefined,
                minutesStartedAt,
              );
              const backlog = minutesBacklog.get(currentSessionId);
              // ## 展示值必须夹到 [0, archivedTurns]（五轮审查 m1）
              //
              // `writtenTurns` 是展示字段，旧版本账本里可能留着虚高值
              // （例如早期明细缺陷写进去的 80）。直接显示会出现
              // 「已写入 80 轮，累计归档 40 轮」这种自相矛盾的文案。
              const shownWritten = Math.min(minutesWrittenTurns, archivedTurns);
              const state =
                minutesWrittenAtArchived < 0
                  ? `尚未写入，首轮即写入，之后每 ${minutesEveryTurns} 轮更新`
                  : `已写入 ${shownWritten} 轮，累计归档 ${archivedTurns} 轮`;
              lines.push(
                `会话纪要：已记 ${turnLedger.length} 轮 / ` +
                  `${draft === null ? 0 : draft.conclusions} 条结论 / ` +
                  `${draft === null ? 0 : draft.content.length} 字符` +
                  `（${state}）` +
                  (backlog === undefined ? '' : ` ⚠ 另有 ${backlog.turns.length} 轮待补写`),
              );
            }
          } else {
            lines.push('会话纪要：已关闭（minutesEnabled=false）');
          }
        }
        lines.push('');

        lines.push('## 工件库');
        {
          // 这一节是排查「长文档为什么取不回」的唯一入口：
          // 配额撞 NaN 时工件会被全部淘汰，届时这里 usage 会显示 0。
          if (!artifactEnabled) {
            lines.push('已关闭（artifactEnabled=false）：长文本按原样留在上下文。');
          } else {
            const items = artifactStore.list();
            lines.push(
              `启用：阈值 ${artifactMinChars} 字符 / 配额 ${quotaMb} MB / 现有 ${items.length} 个` +
                ` / 占用 ${(artifactStore.usageBytes() / 1024 / 1024).toFixed(2)} MB`,
            );
            for (const item of items.slice(0, 5)) {
              lines.push(`- ${item.hash}（${item.chars} 字符）：${item.preview}`);
            }
            if (items.length > 5) lines.push(`- …另有 ${items.length - 5} 个`);
          }
          lines.push(`本会话 Fact 账本：${sessionFacts.length} 条（交接文档的数据源）`);
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
            `在 \`${patchPath}\` 的 \`id: dsh-plugin-lrc\` → \`config:\` 下补以下五行，然后重启 DSH：`,
          );
          lines.push('```yaml');
          lines.push('        recallInjectEnabled: true');
          lines.push('        recallInjectMaxItems: 2');
          lines.push('        recallInjectMinScore: 0.85');
          lines.push('        recallInjectMinRawScore: 0.025');
          lines.push('        recallInjectMaxCharsPerItem: 80');
          lines.push('        recallInjectFragmentExemptImportance: 9');
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
            `配置：最多 ${recallOptions.maxItems} 条｜相对分 ≥${recallOptions.minScore}` +
              `｜绝对分 ≥${recallOptions.minRawScore}` +
              `｜单条 ${recallOptions.maxCharsPerItem} 字符｜总长 ${recallOptions.maxTotalChars}`,
          );
          lines.push(
            recallOptions.fragmentPrefixes.length > 0
              ? `碎片过滤：以悬空词开头的残句不注入` +
                  `（importance ≥${recallOptions.fragmentExemptImportance} 豁免）`
              : '碎片过滤：已关闭（fragmentPrefixes 为空）',
          );
          // 绝对分闸门在单路部署里不可满足：RRF 单路上限 1/61≈0.0164，
          // 任何 >0.0164 的阈值都会让整场会话 0 注入，而状态栏若不说明，
          // 用户只会看到「本轮无匹配」并误判成插件失效。
          if (recallOptions.minRawScore > 0.0164) {
            lines.push(
              '（绝对分阈值为 RRF 名次分：单路命中上限约 0.0164。' +
                '若 LRC 的语义/深度通路不可用，该阈值会导致整场不注入 —— 见日志 warn。）',
            );
          }
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
