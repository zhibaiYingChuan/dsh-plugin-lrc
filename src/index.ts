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
  extractFacts,
  extractFactsFromReasoning,
  factsFromLlmLines,
} from './memory-extract.ts';
import { factKey, factsToItems, makeArtifactFact, renderFact, validateFact, type MemoryFact } from './memory-schema.ts';
import {
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_NODES_PER_RUN,
  normalizeCount,
  normalizeMaxNodes,
  pruneReasoning,
  pruneToolCallArguments,
  pruneToolResults,
  trimContext,
} from './context-trim.ts';
import { buildHandoffText, createHandoffSession, extractHandoffSource } from './handoff.ts';
import { projectHandoff } from './handoff-projection.ts';
import { ArtifactStore, hashContent, isArtifactWorthy } from './artifact-store.ts';
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
 */
function buildPromptText(recallInjected: boolean): string {
  const recallRule = recallInjected
    ? [
        '上下文里可能出现 `[LRC 历史记忆（可能过时，与当前任务无关时请忽略）]` 段落，',
        '那是插件按当前话题自动检索出来的历史记录。**用不用、信不信由你判断**：',
        '与当前任务相关就参考；明显无关或与已验证事实冲突时直接忽略，不要为了迎合它改变做法。',
        '若某条记忆与你已知的事实冲突，以**你能当场验证的**为准，并可用 `lrc_recall` 复核。',
        '遇到需要更早的细节、或该段落缺失时，再调 `lrc_recall` 补充检索；',
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
    // Fact 账本也是会话级：交接文档只应包含**本会话**的结论。
    // 不清会让新会话的交接文档里混进上一个会话的任务上下文。
    sessionFacts.length = 0;
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
    // **每次连接就绪都要回灌**，不只是启动时。
    //
    // `assistant/message` 不会被回放，未连接期间抽到的约束错过就永久丢。
    // 原来这段写在启动 IIFE 里、且在 `if (client === null) return` 之后 ——
    // 而它要解决的正是「启动时连不上」的场景，于是永远走不到（死代码）。
    // 实测：LRC 晚起 → 收到约束 → 重连成功 → 旧约束从未被补写。
    drainProseBacklog();
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
   * 把一批**已通过 schema 校验**的记忆送进 LRC，并更新快照。
   *
   * 所有来源（正文 / 用户消息 / 推理兜底 / LLM 补全）共用这一个出口：
   * 「未连接先暂存、代次闸门防乱序、失败只告警」这套处理完全一样，
   * 分开写必然漂移。
   *
   * @param facts - schema 层产出的记忆
   * @param ownerSessionId - 归属会话（**同步阶段捕获**，不能等 `.then` 再读）
   * @param label - 日志用来源名
   */
  function offloadExtracted(
    facts: MemoryFact[],
    ownerSessionId: string,
    label: string,
  ): void {
    if (facts.length === 0) return;
    // 账本在**同步阶段**记录：它用于交接文档投影，与写库成功与否无关
    // （写库失败时用户仍可能在同一会话里要求交接）。
    recordSessionFacts(facts);
    // **未连接时不直接丢**：这类事件不会被回放，而 LRC 桌面端比 DSH
    // 晚起 20 分钟是已发生过的真实事故。那段时间里若直接 catch 掉，
    // 这批约束就永久丢了。
    if (!offloader.connected) {
      pushProseBacklog(ownerSessionId, facts);
      void connection.get();
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
      offloadExtracted(extracted.facts, ownerSessionId, 'LLM 兜底');
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
    ctx.logger.info(`[lrc] 记忆沉淀已就绪：${client.baseUrl}`);
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

      // ★可观测性必须优先于短路。
      //
      // 原实现是「`next === recallText` 就 return」，而双闸门挡掉整批时
      // `next` 与旧的 `recallText` 都是空串 ⇒ **一条日志都不留**。
      // 于是「检索到了 2 条候选但被绝对分挡掉」和「压根没检索」在日志里
      // 完全同形，排查时只能看到「插件没工作」。这是本轮测试抓到的真实缺陷。
      const changed = next !== recallText;
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
          `${top >= 0 ? top.toFixed(4) : '缺失'}，阈值 ${recallOptions.minRawScore}，指纹 ${fingerprint}）`;
        if (result.memories.length > 0 && top >= 0 && top < recallOptions.minRawScore) {
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
            `指纹 ${fingerprint}，累计改写 ${recallRewrites} 次）`,
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
          try {
            const result = await offloader.offloadFacts(fromReasoning.facts);
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

    // 2. 主路径：正文行（长任务的最终报告只在这里出现一次）
    await flush(session, 'turn/end');

    // 3. 兜底：本轮没有正文时，从推理里抽结论句（走同一个提取器）
    if (hadText || reasoning.length === 0) return;
    const fromReasoning = extractFactsFromReasoning({
      text: reasoning,
      origin: 'assistant',
      sessionId,
    });
    if (fromReasoning.facts.length === 0) return;
    try {
      const result = await offloader.offloadFacts(fromReasoning.facts);
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
      const userText = userMessageText(event);
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
        void runLlmFallback(
          userText,
          session,
          sessionId,
          result.facts.map((f) => f.statement),
          result.pending,
          'user',
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
      offloadExtracted(extracted.facts, sessionId, '正文抽取');

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
        void runLlmFallback(text, session, sessionId, alreadyExtracted, extracted.pending);
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
