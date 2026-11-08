/**
 * 能力矩阵：启动时探测一次，之后所有路径按矩阵决定「做不做」。
 *
 * ## 为什么需要
 *
 * 前几轮故障的共同形态是「调用时才发现不可用」：
 * - `session.events` 在某些版本不存在 → trim 静默失效
 * - `surfaceOp` 字段名 `start/end` vs `startSeq/endSeq` → 剪枝 100% 失败
 * - `engine.ctx.tokenMeter` 直接属性访问 → inject 崩溃
 *
 * 把探测集中到一处，好处是：失败只发生一次、日志只打一次、
 * 调用方拿到的是明确的「可用/不可用」而不是运行时异常。
 *
 * ## 探测原则
 *
 * 只读、不写、不抛错。任何一项探测失败都记为「不可用 + 原因」，
 * 绝不让探测本身掀翻插件。
 */
import { resolveSessionEvents } from './context-trim.ts';

/** 单项能力。 */
export interface Capability {
  available: boolean;
  /** 诊断细节：不可用时说明原因，可用时说明来源 */
  detail: string;
}

/** surfaceOp 的字段名形状（不同 DSH 版本不一致）。 */
export type SurfaceOpShape = 'start-end' | 'startSeq-endSeq' | 'unknown';

/** 一次探测得到的完整能力矩阵。 */
export interface CapabilityMatrix {
  /** 压缩引擎（路径 1 依赖） */
  compaction: Capability;
  /** token 计量（路径 1 的阈值判断依赖） */
  tokenMeter: Capability;
  /** 官方工具输出剪枝器（路径 2 依赖） */
  toolResultPruner: Capability;
  /** 会话存储（路径 6 兜底依赖） */
  sessions: Capability;
  /** agent 工厂（路径 6 首选依赖） */
  agents: Capability;
  /** 系统提示注册（快照注入依赖） */
  systemPrompt: Capability;
  /** replace 事件的字段名形状 */
  surfaceOpShape: SurfaceOpShape;
  /** 探测时间 */
  probedAt: number;
}

function safeGet(ctx: unknown, name: string): unknown {
  try {
    return (ctx as { get?: (n: string) => unknown })?.get?.(name);
  } catch {
    return undefined;
  }
}

function hasFn(value: unknown, name: string): boolean {
  return typeof (value as Record<string, unknown> | undefined)?.[name] === 'function';
}

/** 从引擎的 ctx 取服务（引擎 ctx 在 preset 隔离组内，宿主层可能拿不到）。 */
function fromEngine(engine: unknown, name: string): unknown {
  try {
    return (engine as { ctx?: { get?: (n: string) => unknown } } | undefined)?.ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * 探测 surfaceOp 的字段名形状。
 *
 * 扫描会话里已有的 replace 事件：有 `start` 就是 start-end，
 * 有 `startSeq` 就是 startSeq-endSeq。都没有则 unknown（调用方两种都试）。
 */
export function probeSurfaceOpShape(session: unknown): SurfaceOpShape {
  const events = resolveSessionEvents(session);
  if (events === undefined) return 'unknown';
  for (const raw of events) {
    const op = (raw as { surfaceOp?: unknown })?.surfaceOp;
    if (op === null || typeof op !== 'object') continue;
    const record = op as Record<string, unknown>;
    if (record['op'] !== 'replace') continue;
    if (Object.hasOwn(record, 'start') && Object.hasOwn(record, 'end')) return 'start-end';
    if (Object.hasOwn(record, 'startSeq') && Object.hasOwn(record, 'endSeq')) return 'startSeq-endSeq';
  }
  return 'unknown';
}

/**
 * 探测一次完整能力矩阵。
 *
 * @param ctx - 宿主上下文
 * @param agent - 当前 agent（用于穿透 preset 隔离）
 * @returns 能力矩阵（永不抛错）
 */
export function probeCapabilities(ctx: unknown, agent: unknown): CapabilityMatrix {
  const presets = safeGet(ctx, 'agentPresets') as
    | { serviceFor?: (a: unknown, n: string) => unknown }
    | undefined;

  // 压缩引擎
  let engine: unknown;
  let engineError = '';
  try {
    engine = presets?.serviceFor?.(agent, 'compaction');
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
  }
  const compaction: Capability = {
    available: hasFn(engine, 'compactRegion'),
    detail:
      engineError !== ''
        ? `serviceFor 抛错：${engineError}`
        : engine === undefined
          ? 'serviceFor 返回 undefined'
          : `引擎=${(engine as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'}`,
  };

  // token 计量：引擎 ctx 优先，宿主层兜底
  const meter = fromEngine(engine, 'tokenMeter') ?? safeGet(ctx, 'tokenMeter');
  const tokenMeter: Capability = {
    available: hasFn(meter, 'measure'),
    detail: meter === undefined ? 'tokenMeter 不可达' : 'measure 可用',
  };

  // 官方剪枝器：三条路
  const pruner =
    safeGet(ctx, 'toolResultPruner') ??
    (() => {
      try {
        return presets?.serviceFor?.(agent, 'toolResultPruner');
      } catch {
        return undefined;
      }
    })() ??
    fromEngine(engine, 'toolResultPruner');
  const toolResultPruner: Capability = {
    available: hasFn(pruner, 'pruneSession'),
    detail: pruner === undefined ? 'toolResultPruner 不可达' : 'pruneSession 可用',
  };

  const sessions = safeGet(ctx, 'sessions');
  const agents = safeGet(ctx, 'agents');
  const systemPrompt = safeGet(ctx, 'systemPrompt');

  return {
    compaction,
    tokenMeter,
    toolResultPruner,
    sessions: {
      available: hasFn(sessions, 'create'),
      detail: sessions === undefined ? 'sessions 不可达' : 'create 可用',
    },
    agents: {
      available: hasFn(agents, 'create'),
      detail: agents === undefined ? 'agents 不可达' : 'create 可用',
    },
    systemPrompt: {
      available: hasFn(systemPrompt, 'section') || hasFn(systemPrompt, 'context'),
      detail: systemPrompt === undefined ? 'systemPrompt 不可达' : 'section/context 可用',
    },
    surfaceOpShape: probeSurfaceOpShape((agent as { session?: unknown })?.session),
    probedAt: Date.now(),
  };
}

/** 把能力矩阵压成一行行日志（启动时打一次）。 */
export function formatCapabilities(matrix: CapabilityMatrix): string[] {
  const rows: Array<[string, Capability]> = [
    ['compaction', matrix.compaction],
    ['tokenMeter', matrix.tokenMeter],
    ['toolResultPruner', matrix.toolResultPruner],
    ['sessions', matrix.sessions],
    ['agents', matrix.agents],
    ['systemPrompt', matrix.systemPrompt],
  ];
  const lines = rows.map(
    ([name, cap]) => `[lrc][cap] ${cap.available ? '可用  ' : '不可用'} ${name} | ${cap.detail}`,
  );
  lines.push(`[lrc][cap] surfaceOp 形状：${matrix.surfaceOpShape}`);
  return lines;
}
