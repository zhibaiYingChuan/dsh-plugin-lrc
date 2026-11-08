/**
 * 统一预算：把散落的魔法数字收敛成「按模型窗口比例推导」。
 *
 * ## 为什么需要
 *
 * 之前 `trimMinTokens=60000` 是按某个默认模型拍的，换到 1M 窗口就变成 6%，
 * 33K 的会话永远不触发；`pruneResultThreshold=8192` 同理。
 * 阈值应该跟着模型窗口走，而不是写死。
 *
 * ## 推导规则
 *
 * ```
 * trimMinTokens        = clamp(window * trimRatio,  8000, 200000)
 * pruneResultThreshold = clamp(window * pruneRatio, 2048, 8192)
 * ```
 *
 * 窗口未知时退回配置里的绝对值，绝不因为探测失败而停摆。
 */

/** 预算配置（来自插件配置）。 */
export interface BudgetConfig {
  /** 显式指定模型窗口；0 表示自动探测 */
  contextWindowTokens: number;
  /** 裁剪阈值占窗口的比例 */
  trimRatio: number;
  /** 工具输出剪枝阈值占窗口的比例 */
  pruneRatio: number;
  /** 窗口未知时的裁剪阈值（绝对值） */
  trimMinTokens: number;
  /** 窗口未知时的剪枝阈值（绝对值） */
  pruneResultThreshold: number;
}

/** 解析后的预算。 */
export interface ResolvedBudget {
  /** 模型窗口；0 表示未知 */
  windowTokens: number;
  trimMinTokens: number;
  pruneResultThreshold: number;
  /** auto = 从模型探测；configured = 显式配置；fallback = 探测失败用绝对值 */
  source: 'auto' | 'configured' | 'fallback';
  /** 探测到的模型名（诊断用；fallback 时为空） */
  model?: string;
  /** 降级原因（诊断用） */
  note?: string;
}

/** 窗口的合理下限：低于 8K 视为探测异常。 */
const MIN_SANE_WINDOW = 8_192;
/**
 * 可信窗口上限（不含）。
 *
 * 探测值达到这个数就**不再当作比例基线**：实测宿主对未知模型会返回
 * 1,000,000 这个哨兵值，而真实会话只有 80K —— 按 1M 推导出的
 * `trim=30000`（3%）看似能用，但分母是错的，任何比例缩放都失去意义。
 *
 * 降级后的绝对值（30000/4096）是实测可用的保守档，方向安全：宁可早裁，不可溢出。
 *
 * ⚠️ 2026-11-08 实测修正：`deepseek-v4.1-flash` 的 contextWindow 确实是
 * 1,048,576，探测到的 1,000,000 是**真实窗口**而非哨兵值。也就是说这条规则
 * 会把「真实 1M 窗口」误判为「未知模型」。当前不造成危害——降级值 30000
 * 恰好落在成本 U 形曲线的低成本区（最优点约 53K，仅差 11%），且方向偏保守。
 * 若将来要按真实窗口推导，应显式配置 `contextWindowTokens`，而不是依赖探测。
 */
const MAX_TRUSTED_WINDOW = 1_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeGet(ctx: unknown, name: string): unknown {
  try {
    return (ctx as { get?: (n: string) => unknown })?.get?.(name);
  } catch {
    return undefined;
  }
}

/** 从会话的请求头里取当前路由的 provider/model。 */
function routedTarget(session: unknown): { provider: string; model: string } | undefined {
  const config = (session as { requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } })
    ?.requestHeader?.()?.config;
  const provider = config?.provider;
  const model = config?.model;
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * 解析预算。
 *
 * 永不抛错：探测失败一律退回配置绝对值。
 *
 * @param deps - 宿主 ctx、agent、预算配置
 * @returns 解析后的预算
 */
export async function resolveBudget(deps: {
  ctx: unknown;
  agent: unknown;
  config: BudgetConfig;
}): Promise<ResolvedBudget> {
  const { ctx, agent, config } = deps;

  // 显式配置优先
  if (config.contextWindowTokens > 0) {
    return derive(config.contextWindowTokens, config, 'configured');
  }

  // 自动探测：llm.resolveModelInfo(provider, model)
  const session = (agent as { session?: unknown })?.session;
  const target = routedTarget(session);
  if (target === undefined) {
    return {
      windowTokens: 0,
      trimMinTokens: config.trimMinTokens,
      pruneResultThreshold: config.pruneResultThreshold,
      source: 'fallback',
    };
  }

  const llm = safeGet(ctx, 'llm') as
    | {
        resolveModelInfo?: (
          provider: string,
          model: string,
        ) => Promise<{ context?: { contextWindow?: unknown } }>;
      }
    | undefined;
  if (typeof llm?.resolveModelInfo !== 'function') {
    return {
      windowTokens: 0,
      trimMinTokens: config.trimMinTokens,
      pruneResultThreshold: config.pruneResultThreshold,
      source: 'fallback',
    };
  }

  try {
    const info = await llm.resolveModelInfo(target.provider, target.model);
    const window = info?.context?.contextWindow;
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      // 探测值达到上限 → 视为「未知模型的哨兵值」，退回绝对值。
      // 不能钳到 1M 继续用：分母错了，所有按比例推导的阈值都失去意义。
      if (window >= MAX_TRUSTED_WINDOW) {
        return {
          windowTokens: 0,
          trimMinTokens: config.trimMinTokens,
          pruneResultThreshold: config.pruneResultThreshold,
          source: 'fallback',
          model: target.model,
          // 提示可显式配置：哨兵值无法区分「真实 1M 窗口」与「未知模型」，
          // 若确知模型窗口，配置 contextWindowTokens 即可按真实窗口推导阈值。
          note: `probe=${window} 达到可信上限，视为未知模型；如确知窗口请显式配置 contextWindowTokens`,
        };
      }
      // 过小的探测值钳到下限，避免 trim 阈值等于整个窗口
      const sane = Math.max(MIN_SANE_WINDOW, window);
      return { ...derive(sane, config, 'auto'), model: target.model };
    }
  } catch {
    // 探测失败：退回绝对值
  }

  return {
    windowTokens: 0,
    trimMinTokens: config.trimMinTokens,
    pruneResultThreshold: config.pruneResultThreshold,
    source: 'fallback',
  };
}

function derive(
  windowTokens: number,
  config: BudgetConfig,
  source: 'auto' | 'configured',
): ResolvedBudget {
  return {
    windowTokens,
    trimMinTokens: clamp(Math.floor(windowTokens * config.trimRatio), 8000, 200000),
    pruneResultThreshold: clamp(Math.floor(windowTokens * config.pruneRatio), 2048, 8192),
    source,
  };
}

/** 一行可读摘要（启动日志用）。 */
export function formatBudget(budget: ResolvedBudget): string {
  const window = budget.windowTokens > 0 ? `${budget.windowTokens} tokens` : '未知';
  const model = budget.model === undefined ? '' : ` model=${budget.model}`;
  const note = budget.note === undefined ? '' : ` note=${budget.note}`;
  return (
    `[lrc][budget] 窗口=${window}（${budget.source}）${model}${note}` +
    ` trim=${budget.trimMinTokens} tokens prune=${budget.pruneResultThreshold} 字符`
  );
}
