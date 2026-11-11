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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LrcRuntime } from './runtime.ts';
import { LrcClient } from './lrc-client.ts';
import { Recoverable, isConnectionError } from './recoverable.ts';
import { CursorStore, RecentStore, snapshotChanged } from './cursor.ts';
import { Offloader, itemsFromTag } from './offloader.ts';
import {
  hasMalformedTextBlock,
  linesFromSession,
  messageContent,
  reasoningBlocksOnly,
  textBlocksOnly,
} from './session-text.ts';
import { conclusionsFromReasoning, extractMemoryTag, isNoUpdate } from './memory-filter.ts';
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
  // 阈值按模型窗口比例推导：1M 窗口 → trim 30000 / prune 4000；
  // 128K 窗口 → trim 8000（下限）/ prune 2048（下限）。
  contextWindowTokens: Schema.number().default(0),
  trimRatio: Schema.number().default(0.03),
  pruneRatio: Schema.number().default(0.004),
  // 窗口探测失败时的绝对值兜底
  trimMinTokens: Schema.number().default(30000),

  trimMinSteps: Schema.number().default(10),
  // ★2026-11-08：节点数硬上限兜底。token 计量一旦失真（宿主换版本 / meter 返回 0 /
  // 阈值配错），纯 token 触发会让上下文无限增长；节点数不依赖任何服务，用它兜底。
  // 实测正常稳态 31–72 节点，120 只在异常时触发。
  trimMaxNodes: Schema.number().default(120),
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
});

/** 系统提示段落名（全局唯一，避免与宿主段落冲突）。 */
const PROMPT_SECTION = 'lrc:memory-capture';

/**
 * 让宿主 LLM 顺手做提炼。
 *
 * 为什么放在系统提示而不是再起一次 LLM 调用：宿主本来就要生成回答，
 * 顺手多写 1~3 句结论是零额外成本；单独调用一次模型既慢又费钱。
 *
 * 为什么要求"每次都输出"：实测把标签写成可选项时，模型十来轮一次都没照做，
 * 这一层等于不存在。改成强制契约后，触发率可观测，也能用 `无新增` 明确表达空。
 */
const PROMPT_TEXT = [
  '## 长期记忆（LRC）',
  '',
  '涉及项目历史、用户偏好、之前做过的决定、上次怎么改的，**先调 `lrc_recall` 工具**，',
  '不要直接 Grep 或翻文件。检索为空时才回退内置搜索，并在回复中说明「LRC 未命中，已回退内置搜索」。',
  '',
  '发现某条记忆与事实不符时，用 `lrc_forget` 撤回（id 从 `lrc_recall` 输出里取），',
  '不要让它继续污染后续对话。',
  '',
  '## 长期记忆沉淀（必须遵守）',
  '',
  '每次回答的最后一行，必须输出一个 <lrc_memory> 块，格式固定：',
  '',
  '<lrc_memory>',
  '- 决策：…',
  '- 约束：…',
  '- 结论：…',
  '</lrc_memory>',
  '',
  '规则：',
  '- 只写本轮产生的决策、约束、最终结论；没有的条目直接省略。',
  '- 本轮没有任何值得长期保留的内容时，输出 <lrc_memory>无新增</lrc_memory>。',
  '- 只写结论，不写过程、待办清单、选项罗列或代码。',
  '- 标签必须出现在回答的最末尾，且每轮只出现一次。',
].join('\n');

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
   * 从磁盘恢复上次的快照。
   *
   * 不持久化的话，插件进程一重启 `latestSnapshot` 就变空串，
   * 读路径（`[LRC 状态]` 注入）直接断掉 —— 而 LRC 里的记忆还在。
   */
  function loadSnapshot(): string {
    try {
      if (!existsSync(snapshotPath)) return '';
      const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { text?: unknown };
      return typeof raw.text === 'string' ? raw.text : '';
    } catch (error) {
      // 不能静默：快照损坏会让 `[LRC 状态]` 凭空消失，而用户只会觉得"插件不工作了"。
      // 只告警一次，随后照常以降级方式继续（快照本身可以重建）。
      ctx.logger.warn(
        `[lrc] 快照文件读取失败，本次从空快照开始（${error instanceof Error ? error.message : String(error)}）：${snapshotPath}`,
      );
      return '';
    }
  }

  let warnedSaveSnapshot = false;

  function saveSnapshot(text: string): void {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify({ text, updatedAt: Date.now() }), 'utf8');
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
   * `<lrc_memory>` 命中统计：**按轮计，不按消息计**。
   *
   * 按消息计时，工具密集型轮次里的中间说明（"我先看下文件"）会被算成失败，
   * 分母被灌水，实测显示 2.5% 命中率，而真实带标签的轮次比例是 2/5、1/5、1/2。
   */
  let turnHits = 0;
  let turnMisses = 0;
  /** 整轮没有正文的轮次数（标签根本没地方出现，不该计入分母） */
  let turnNoText = 0;
  /** 当前轮状态 */
  let turnHadText = false;
  let turnTagSeen = false;
  let turnReasoning: string[] = [];
  let turnReasoningChars = 0;
  /** 最近一次沉淀产出的状态快照，注入下一轮上下文（闭环的"读"路径）。 */
  let latestSnapshot = loadSnapshot();
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
      systemPrompt.section({ name: PROMPT_SECTION, order: 9000, text: PROMPT_TEXT });
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
        // 诊断：确认快照到底有没有被渲染层取走。
        // `systemPrompt.context` 是**动态 user-role 快照**，不进 system prompt，
        // 所以查 `request/header.system` 永远看不到它 —— 这条日志才是判据。
        if (latestSnapshot.length > 0 && !snapshotServed) {
          snapshotServed = true;
          ctx.logger.info(`[lrc] 快照已注入上下文（${latestSnapshot.length} 字符）`);
        }
        return latestSnapshot;
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
  })();

  /**
   * 启动时从 LRC 索引重建快照。
   *
   * 快照原本只在上次沉淀成功时写盘；如果上次进程没来得及沉淀，
   * 重启后读路径就是空的。这里用 `/v1/context/index` 兜底，
   * 让 `[LRC 状态]` 在重启后也能立刻出现。
   */
  async function bootstrapSnapshot(): Promise<void> {
    if (latestSnapshot.length > 0) return;
    const client = connection.peek();
    if (client === null) return;
    try {
      const index = await client.index(config.project, 3);
      if (index.items.length === 0) return;
      const picked = index.items.map((item) => {
        const body = item.content_preview.replace(/^\[[^\]]+\]\s*/, '');
        return body.length > 120 ? `${body.slice(0, 120)}…` : body;
      });
      latestSnapshot = `[LRC 状态] ${picked.join('；')}。细节在 LRC，需要时 recall。`;
      saveSnapshot(latestSnapshot);
      ctx.logger.info(`[lrc] 快照已从 LRC 索引重建（${index.items.length} 条）`);
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
      const sessionId = (session as { id?: string })?.id ?? 'default';
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
                latestSnapshot = result.snapshot;
                saveSnapshot(result.snapshot);
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
          latestSnapshot = result.snapshot;
          saveSnapshot(result.snapshot);
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
    // 1. 按轮记账：只有"本轮有正文"才计入命中率分母
    if (turnHadText) {
      if (turnTagSeen) turnHits += 1;
      else turnMisses += 1;
      const seen = turnHits + turnMisses;
      if (seen % 20 === 0) {
        ctx.logger.info(
          `[lrc] <lrc_memory> 命中率 ${turnHits}/${seen} 轮（另有 ${turnNoText} 轮无正文）`,
        );
      }
    } else {
      turnNoText += 1;
    }

    const hadText = turnHadText;
    const reasoning = turnReasoning.join('\n');
    resetTurnState();

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
          latestSnapshot = result.snapshot;
          saveSnapshot(result.snapshot);
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

    if (type === 'turn/start') {
      resetTurnState();
      return;
    }

    // turn 结束：长任务的最终报告只在这里出现一次，必须兜底收走
    if (type === 'turn/end') {
      void finishTurn(session);
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
    // fallback（窗口未知）时允许复查 —— 模型可能中途切换（provider/model 变了），
    // 一次 fallback 就永久按绝对值裁剪并不合理。
    if (
      budget === null ||
      (budget.source === 'fallback' &&
        budgetRecheckSteps > 0 &&
        governor.steps % budgetRecheckSteps === 0)
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
        lines.push('');

        lines.push('## 快照');
        lines.push(
          latestSnapshot.length > 0
            ? `已存在（${latestSnapshot.length} 字符）${snapshotServed ? '，已被渲染层取走' : '，尚未被取走'}`
            : '为空（还没有成功沉淀过）',
        );

        return { text: lines.join('\n') };
      },
    }),
  );
}
