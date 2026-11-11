/**
 * 可恢复资源：把「启动时决定一次、之后永久生效」改成「可失效、可重试」。
 *
 * ## 为什么需要这个模块
 *
 * 一类反复出现的故障，形态完全一致：
 *
 * ```
 * 启动时探测一次 → 失败 → 把失败结果永久缓存 → 整场会话再也不会重试
 * ```
 *
 * 真实事故：LRC 桌面端比 DSH 晚 20 分钟启动，插件在那一刻探测失败、
 * 判为 degraded，然后 `client` 永久为 null。此后 LRC 明明已经健康，
 * 5 次 `lrc_recall` 仍全部返回「LRC 未就绪」——**用户完全无从察觉**。
 *
 * 同一反模式在本插件里有 6 处（client / offloader / runtime.result /
 * capabilities / budget / governor 熔断）。逐个打补丁的话，下一个
 * 一次性状态还会再犯一次，所以这里把它收敛成一个可复用抽象。
 *
 * ## 语义
 *
 * - **成功结果不失效**：拿到就复用，不会每次都重连（那是性能倒退）。
 * - **失败结果会失效**：要么等到指数退避窗口过去后自动重试，
 *   要么被显式 `invalidate()`（热路径发现连接断了，立刻作废）。
 * - **单飞**：并发调用只会有一次真正在跑 factory，其余等同一个 promise，
 *   避免每次 recall 都各自发起一次连接。
 *
 * ## 何时该用、何时不该用
 *
 * 该用：资源可能「暂时不可用」且「之后会自己好起来」（网络对端、外部进程、可选服务）。
 * 不该用：失败是确定性的（配置写错、平台不支持）或结果天然一次性（本轮的 token 计数）。
 */

/** 资源状态（`lrc_status` 展示用）。 */
export type RecoverableState = 'idle' | 'ready' | 'failed';

/** 退避策略。 */
export interface BackoffPolicy {
  /** 首次失败后等待多久再重试（毫秒） */
  baseMs: number;
  /** 退避上限（毫秒）：连续失败也不会无限拉长，保证最终能自愈 */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  // 2s 起步：足够躲开「刚失败就立刻重试」的抖动，又不至于让用户等太久
  baseMs: 2_000,
  // 60s 封顶：即使连续失败很久，一分钟后至少还有一次机会自愈
  maxMs: 60_000,
};

/**
 * 把外部传入的退避参数规范化。
 *
 * 为什么必须校验：配置对象来自宿主（`cordis.patch.yml` / 测试桩），
 * 字段可能缺失或非数字。若直接把 `undefined` 参与算术，会得到 `NaN`，
 * 而 `now() >= NaN` 恒为 false ⇒ `get()` 每次都真连 —— 退避静默消失，
 * 从「自愈」退化成「每次调用都卡一次健康检查超时」。
 *
 * 这类失败是**静默**的（不报错、日志正常），实测正是它让 e2e-turn 在没有
 * 新字段的情况下「通过」了测试。故在这里兜底，而不是依赖调用方守规矩。
 */
function normalizeBackoff(input: unknown): BackoffPolicy {
  const raw = (input ?? {}) as Partial<BackoffPolicy>;
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const baseMs = pick(raw.baseMs, DEFAULT_BACKOFF.baseMs);
  const maxMs = pick(raw.maxMs, DEFAULT_BACKOFF.maxMs);
  // 上限不得小于起步，否则指数退避会「越退越快」，语义矛盾
  return { baseMs, maxMs: Math.max(baseMs, maxMs) };
}

/** 状态快照（只读，供诊断使用）。 */
export interface RecoverableStatus {
  state: RecoverableState;
  /** 累计成功次数 */
  successes: number;
  /** 累计失败次数 */
  failures: number;
  /** 连续失败次数（成功后归零） */
  consecutiveFailures: number;
  /** 最近一次失败原因 */
  lastError?: string;
  /** 还需要等多久才能再试（毫秒）；0 表示现在就可以试 */
  retryInMs: number;
  /** 上次失败时用的退避时长（诊断指数退避是否生效） */
  lastBackoffMs: number;
}

/**
 * 可恢复资源。
 *
 * @typeParam T - 资源类型（如 LrcClient）
 */
export class Recoverable<T> {
  private readonly factory: () => Promise<T>;
  private readonly now: () => number;
  private readonly backoff: BackoffPolicy;

  private value: T | null = null;
  private state: RecoverableState = 'idle';
  private inflight: Promise<T | null> | null = null;
  /** 下次允许尝试的时刻（毫秒时间戳） */
  private nextAttemptAt = 0;
  private successes = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private lastBackoffMs = 0;
  /**
   * 显式作废后置位。
   *
   * 与「失败退避」区分开：作废是「之前好好的，刚才那一下断了」，
   * 应该**立刻**允许重连；退避只在连续失败时才拉长等待。
   */
  private invalidated = false;

  constructor(
    factory: () => Promise<T>,
    options: { now?: () => number; backoff?: Partial<BackoffPolicy> } = {},
  ) {
    this.factory = factory;
    this.now = options.now ?? (() => Date.now());
    this.backoff = normalizeBackoff(options.backoff);
  }

  /** 当前是否已有可用值（不触发任何重试）。 */
  get ready(): boolean {
    return this.value !== null;
  }

  /** 已就绪则直接返回，否则 null（不触发重试）。 */
  peek(): T | null {
    return this.value;
  }

  /**
   * 取资源。未就绪时按需重试。
   *
   * @returns 资源；本轮不该尝试（退避中）或重试失败时为 null
   */
  async get(): Promise<T | null> {
    if (this.value !== null) return this.value;

    // 退避窗口内直接放弃——但**不能返回 undefined**，调用方据此给用户明确失败提示
    if (this.now() < this.nextAttemptAt) return null;

    // 单飞：并发调用共用同一次尝试
    if (this.inflight !== null) return this.inflight;

    this.inflight = this.attempt();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** 执行一次真实的初始化尝试。 */
  private async attempt(): Promise<T | null> {
    try {
      const value = await this.factory();
      this.value = value;
      this.state = 'ready';
      this.successes += 1;
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      this.nextAttemptAt = 0;
      this.invalidated = false;
      return value;
    } catch (error) {
      this.failures += 1;
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = 'failed';
      this.value = null;
      // 指数退避：2s → 4s → 8s …，上限 maxMs
      const exp = this.backoff.baseMs * 2 ** Math.min(this.consecutiveFailures - 1, 10);
      this.lastBackoffMs = Math.min(exp, this.backoff.maxMs);
      this.nextAttemptAt = this.now() + this.lastBackoffMs;
      return null;
    }
  }

  /**
   * 作废当前值，下次 `get()` 立刻重试。
   *
   * 用于**热路径发现连接断了**的场景：既然是刚断的，就没必要再等退避。
   * 注意不清零 `consecutiveFailures`——连续失败仍然会拉长下一次的等待。
   */
  invalidate(reason?: string): void {
    this.value = null;
    this.state = 'failed';
    this.invalidated = true;
    if (reason !== undefined) this.lastError = reason;
    // 作废后立即允许重试，但保留退避时长供诊断
    this.nextAttemptAt = 0;
  }

  /** 状态快照。 */
  status(): RecoverableStatus {
    const wait = Math.max(0, this.nextAttemptAt - this.now());
    return {
      state: this.state,
      successes: this.successes,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      retryInMs: this.value === null ? wait : 0,
      lastBackoffMs: this.lastBackoffMs,
    };
  }

  /** 是否处于「作废后待重连」状态（诊断用）。 */
  get wasInvalidated(): boolean {
    return this.invalidated;
  }
}

/**
 * 判断一个错误是否值得「作废连接再重试」。
 *
 * 区分两类失败：
 *
 * - **连接类**（ECONNREFUSED / fetch failed / 超时）：对端可能只是暂时没起，
 *   重连有意义 ⇒ 作废。
 * - **业务类**（HTTP 400 / 404 / 422）：服务是活的，只是这个请求不对。
 *   作废只会白白打断正常连接 ⇒ 不作废。
 *
 * 保守起见：只把「明确是连接问题」判为可恢复，其余一律按业务错误处理。
 * 宁可少重连，也不要因为一个参数错误把整条连接掐掉。
 */
export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // LrcClient 统一包成 `LRC <path> 返回 <status>: ...`，此时服务是活的
  if (/返回 \d{3}:/.test(message)) return false;
  // AbortSignal.timeout 触发
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|network/i.test(
    message,
  );
}
