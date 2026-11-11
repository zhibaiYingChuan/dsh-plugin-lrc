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
 * 探测值达到这个数就**不再当作比例基线**：宿主对未知模型会返回
 * 1,000,000 这个哨兵值，而我们无法从探测结果本身区分「真实 1M 窗口」
 * 与「未知模型」。
 *
 * ⚠️ 2026-11-12 实测修正（重要）：此前的结论「降级值 30000/4096 是保守档，
 * 方向安全」是**错的**，实测证明它代价极高：
 *
 * - 真实模型 `deepseek-v4.1-flash` 的窗口确实是 1,048,576（`cordis.patch.yml`
 *   里 `contextWindow: 1048576` 是用户显式配置的真实值）；
 * - 按 30000 触发 trim ⇒ **窗口利用率仅 2.9%** 就开始重写历史；
 * - KV 缓存是**前缀缓存**，改写早期节点会让后续全部失效；
 * - 实测（session-644bba1d，50 次请求）：4 次 trim 每次只降 3~7K tokens，
 *   却丢失 14~37K tokens 的缓存前缀，其中 2 次直接 `cacheRead=0`（全价重发）。
 *   **净亏**，且上下文仍在几步内涨回原水位。
 *
 * 结论：哨兵值不能靠「探测到 1M 就降级」处理，必须靠**显式配置**
 * （`contextWindowTokens`）区分。本函数只负责在探测路径上保守，
 * 而 `configured` 路径完全信任用户声明的窗口。
 */
const MAX_TRUSTED_WINDOW = 1_000_000;

/**
 * 窗口已知但很小时的裁剪阈值下限。
 *
 * 为什么不是简单的 `window * ratio`：128K 窗口按 3% 只有 3.8K，
 * 一次工具输出就能超过，会导致每步都裁剪（实测 22/30 节点反复重写）。
 * 用 8000 兜住，保证「至少攒够 8K 再裁」。
 */
const MIN_TRIM_TOKENS = 8_000;

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
export function routedTarget(
  session: unknown,
): { provider: string; model: string } | undefined {
  const config = (session as { requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } })
    ?.requestHeader?.()?.config;
  const provider = config?.provider;
  const model = config?.model;
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * 从会话的**已解析路由元数据**里取真实窗口。
 *
 * ## 为什么是 `requestContext()` 而不是 `requestHeader()`
 *
 * 这是本轮最关键的一处踩坑，必须写清楚，否则下一个人一定会再犯：
 *
 * - `requestHeader().config` 只有 `{ provider, model, maxTokens }`。
 *   实测（session-644bba1d，43 条 `request/header`）**从未**出现 `contextWindow`。
 *   宿主的 `canonicalHeader()` 只保留 `config/adapterDefaults/tools`，
 *   而 `config` 是 `resolveCallConfig` 补过 `maxTokens` 的结果，不含窗口。
 * - 窗口在 `request/context` 事件里。宿主 `agent-loop` 在每次请求前比较
 *   `preparedCall.context.contextWindow`，**变化时**才 append 一条
 *   `request/context`；`session.requestContext()` 折叠出的就是最新值。
 *
 * 结论：只能读 `requestContext().contextWindow`。读 `requestHeader()` 会
 * 恒返回 undefined —— 而那会让整个「用真实窗口推导阈值」的修复**静默失效**，
 * 退回 30000 绝对值（窗口利用率 2.9% 就压缩历史，反复打断前缀缓存）。
 *
 * ## 边界
 *
 * - 首次请求之前没有 `request/context` 事件 ⇒ 返回 undefined，调用方继续探测。
 * - 该值来自用户自己的模型配置，**没有哨兵值语义**，故调用方不得再套
 *   `MAX_TRUSTED_WINDOW` 判定（真实 1M 窗口恰好会撞上该常量）。
 */
function declaredWindow(session: unknown): number | undefined {
  const context = (session as {
    requestContext?: () => { contextWindow?: unknown } | undefined;
  })?.requestContext?.();
  const window = context?.contextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return undefined;
  // 只在数值合理时采用，防止配置写错（如填了 1 或 1e12）
  if (window < MIN_SANE_WINDOW || window > 100_000_000) return undefined;
  return window;
}

/**
 * 解析预算。
 *
 * 永不抛错：探测失败一律退回配置绝对值。
 *
 * ## 优先级（从高到低）
 *
 * 1. `config.contextWindowTokens` —— 插件配置显式指定，最权威
 * 2. `session.requestContext().contextWindow` —— 宿主实际解析出的路由窗口
 * 3. `llm.resolveModelInfo()` 探测 —— 最不可靠（自定义端点查不到，
 *    只回哨兵值），因此达到可信上限时降级为绝对值
 * 4. 配置里的绝对值兜底
 *
 * ⚠️ 1、2 两条都**不经过** `MAX_TRUSTED_WINDOW` 判定：前两个是可信来源，
 * 只有第 3 条（按名字探测）才有哨兵值风险。若对声明值也套该判定，
 * 真实 1M 窗口会被二次误判为「未知模型」，修好的东西立刻失效。
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

  // 1) 显式配置优先
  if (config.contextWindowTokens > 0) {
    return derive(config.contextWindowTokens, config, 'configured');
  }

  const session = (agent as { session?: unknown })?.session;

  // 2) 宿主已解析的真实窗口：比按名字探测可靠得多
  const declared = declaredWindow(session);
  if (declared !== undefined) {
    return { ...derive(declared, config, 'configured'), note: 'from requestContext' };
  }

  // 自动探测：llm.resolveModelInfo(provider, model)
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
    // 下限用 MIN_TRIM_TOKENS：窗口按比例算出来太小时，攒够再裁，
    // 避免「一次工具输出就超阈值 ⇒ 每步重写历史 ⇒ 缓存永不命中」。
    trimMinTokens: clamp(
      Math.floor(windowTokens * config.trimRatio),
      MIN_TRIM_TOKENS,
      200_000,
    ),
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
