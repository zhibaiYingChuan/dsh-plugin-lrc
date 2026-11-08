/**
 * 单一步进控制器：能力门控 + 熔断 + 节流 + 有序执行。
 *
 * ## 为什么需要
 *
 * 之前每条路径各自判断「要不要跑、能不能跑、失败了怎么办」，
 * 结果是：一条路径失败后每步重试（实测 60 次重复 flush），
 * 另一条路径静默失效却没人知道。
 *
 * 把编排收口到一处后：
 * - **能力门控**：能力矩阵说不可用，就一次都不调用
 * - **熔断**：连续失败 N 次后禁用该动作，只告警一次
 * - **节流**：按步数间隔执行，避免每步白扫
 * - **有序**：先剪枝（便宜）再裁剪（贵），剪枝后 token 降下来裁剪可能就不必跑
 *
 * 本模块不依赖 DSH，纯编排，可直接单测。
 */
import type { CapabilityMatrix } from './capabilities.ts';

/** 单个动作的执行结果。 */
export interface GovernorOutcome {
  ok: boolean;
  /** 机器可读原因：ok / below-threshold / no-range / error:… */
  reason: string;
  /** 诊断细节 */
  detail?: string;
}

/** 一个受控动作。 */
export interface GovernorAction {
  /** 动作名（用于熔断与状态展示） */
  name: string;
  /** 是否启用（能力矩阵 + 配置共同决定） */
  enabled: boolean;
  /** 两次执行之间至少间隔多少步（默认 1 = 每步） */
  throttleSteps?: number;
  /** 执行一次；允许同步或异步 */
  run: () => GovernorOutcome | Promise<GovernorOutcome>;
}

/** 控制器状态（跨步保留）。 */
export interface GovernorState {
  /** 能力矩阵（首次探测后固定） */
  capabilities: CapabilityMatrix | null;
  /** 已执行步数 */
  steps: number;
  /** 每个动作的连续失败次数 */
  failures: Record<string, number>;
  /** 已熔断的动作 */
  disabled: Set<string>;
  /** 每个动作最近一次结果 */
  lastOutcome: Record<string, GovernorOutcome>;
  /** 每个动作上次执行的步数 */
  lastRunStep: Record<string, number>;
  /** 每个动作累计执行次数 */
  runs: Record<string, number>;
}

/** 连续失败多少次后熔断。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export function createGovernorState(): GovernorState {
  return {
    capabilities: null,
    steps: 0,
    failures: {},
    disabled: new Set<string>(),
    lastOutcome: {},
    lastRunStep: {},
    runs: {},
  };
}

/**
 * 执行一步。
 *
 * 动作按数组顺序执行；被禁用/熔断/未到节流间隔的跳过。
 * 单个动作抛错不会中断后续动作。
 *
 * @param deps - 状态、动作列表、日志函数
 * @returns 本步实际执行的动作名
 */
export async function runGovernor(deps: {
  state: GovernorState;
  actions: GovernorAction[];
  log: (message: string) => void;
  warn: (message: string) => void;
}): Promise<string[]> {
  const { state, actions, log, warn } = deps;
  state.steps += 1;
  const executed: string[] = [];

  for (const action of actions) {
    if (!action.enabled) continue;
    if (state.disabled.has(action.name)) continue;

    const throttle = action.throttleSteps ?? 1;
    const last = state.lastRunStep[action.name];
    if (last !== undefined && state.steps - last < throttle) continue;

    state.lastRunStep[action.name] = state.steps;
    state.runs[action.name] = (state.runs[action.name] ?? 0) + 1;
    executed.push(action.name);

    let outcome: GovernorOutcome;
    try {
      outcome = await action.run();
    } catch (error) {
      outcome = {
        ok: false,
        reason: `error:${error instanceof Error ? error.message : String(error)}`,
      };
    }
    state.lastOutcome[action.name] = outcome;

    if (outcome.ok) {
      state.failures[action.name] = 0;
      continue;
    }

    // 非异常原因（below-threshold / no-range）不算失败，不触发熔断
    if (!outcome.reason.startsWith('error')) continue;

    const failures = (state.failures[action.name] ?? 0) + 1;
    state.failures[action.name] = failures;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      state.disabled.add(action.name);
      warn(
        `[lrc][governor] ${action.name} 连续失败 ${failures} 次，已熔断（本次会话不再尝试）：${outcome.reason}`,
      );
    } else {
      warn(
        `[lrc][governor] ${action.name} 失败（${failures}/${MAX_CONSECUTIVE_FAILURES}）：${outcome.reason}`,
      );
    }
  }

  if (executed.length > 0) {
    log(`[lrc][governor] 第 ${state.steps} 步执行：${executed.join(' → ')}`);
  }
  return executed;
}

/** 把控制器状态压成可读文本（`lrc_status` 工具用）。 */
export function formatGovernorState(state: GovernorState): string {
  const lines: string[] = [`步数：${state.steps}`];
  const names = new Set([
    ...Object.keys(state.runs),
    ...Object.keys(state.lastOutcome),
    ...state.disabled,
  ]);
  if (names.size === 0) {
    lines.push('尚未执行任何动作');
    return lines.join('\n');
  }
  for (const name of names) {
    const outcome = state.lastOutcome[name];
    const disabled = state.disabled.has(name) ? ' [已熔断]' : '';
    const runs = state.runs[name] ?? 0;
    const failures = state.failures[name] ?? 0;
    lines.push(
      `- ${name}${disabled}：执行 ${runs} 次，连续失败 ${failures}` +
        `${outcome === undefined ? '' : `，最近 ${outcome.ok ? '成功' : outcome.reason}`}` +
        `${outcome?.detail === undefined ? '' : `（${outcome.detail}）`}`,
    );
  }
  return lines.join('\n');
}
