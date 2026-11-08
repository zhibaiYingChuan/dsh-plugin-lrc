/**
 * 能力矩阵 + 步进控制器的集成测试。
 *
 * 用法：node scripts/e2e-governor.ts
 *
 * 覆盖：
 *   1. 能力探测（全可用 / 全不可用 / surfaceOp 形状）
 *   2. 控制器：有序执行、能力门控、节流、熔断、非异常原因不熔断
 *   3. 状态格式化
 */
import {
  formatCapabilities,
  probeCapabilities,
  probeSurfaceOpShape,
} from '../src/capabilities.ts';
import {
  createGovernorState,
  formatGovernorState,
  MAX_CONSECUTIVE_FAILURES,
  runGovernor,
  type GovernorAction,
} from '../src/governor.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// 1. 能力探测
// ────────────────────────────────────────────────────────────
console.log('=== 1) 能力探测 ===');

const fullEngine = {
  compactRegion: () => {},
  ctx: {
    get: (n: string) =>
      n === 'tokenMeter'
        ? { measure: () => ({ totalTokens: 1 }) }
        : n === 'toolResultPruner'
          ? { pruneSession: () => ({}) }
          : undefined,
  },
};
const fullCtx = {
  get: (n: string) =>
    n === 'agentPresets'
      ? { serviceFor: (_a: unknown, name: string) => (name === 'compaction' ? fullEngine : undefined) }
      : n === 'sessions'
        ? { create: () => ({}) }
        : n === 'agents'
          ? { create: async () => ({}) }
          : n === 'systemPrompt'
            ? { section: () => {}, context: () => {} }
            : undefined,
};
const fullAgent = {
  session: {
    log: [
      { type: 'user/message', surfaceOp: 'append' },
      { type: 'assistant/message', surfaceOp: { op: 'replace', start: 0, end: 0 } },
    ],
  },
};
const full = probeCapabilities(fullCtx, fullAgent);
check('compaction 可用', full.compaction.available === true, full.compaction);
check('tokenMeter 可用', full.tokenMeter.available === true, full.tokenMeter);
check('toolResultPruner 可用', full.toolResultPruner.available === true, full.toolResultPruner);
check('sessions 可用', full.sessions.available === true, full.sessions);
check('agents 可用', full.agents.available === true, full.agents);
check('systemPrompt 可用', full.systemPrompt.available === true, full.systemPrompt);
check('surfaceOp 形状为 start-end', full.surfaceOpShape === 'start-end', full.surfaceOpShape);

const empty = probeCapabilities({ get: () => undefined }, {});
check('空 ctx：compaction 不可用', empty.compaction.available === false, empty.compaction);
check('空 ctx：tokenMeter 不可用', empty.tokenMeter.available === false, empty.tokenMeter);
check('空 ctx：surfaceOp 形状 unknown', empty.surfaceOpShape === 'unknown', empty.surfaceOpShape);

check(
  'surfaceOp 形状 startSeq-endSeq',
  probeSurfaceOpShape({
    log: [{ type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }],
  }) === 'startSeq-endSeq',
);
check('无 replace 事件时 unknown', probeSurfaceOpShape({ log: [] }) === 'unknown');
check('session 为 null 时 unknown', probeSurfaceOpShape(null) === 'unknown');

const capLines = formatCapabilities(full);
check('能力矩阵可格式化', capLines.length === 7 && capLines[0]?.includes('compaction'), capLines);

// ────────────────────────────────────────────────────────────
// 2. 控制器
// ────────────────────────────────────────────────────────────
console.log('=== 2) 步进控制器 ===');

// 2a. 有序执行 + 能力门控
{
  const state = createGovernorState();
  const order: string[] = [];
  const actions: GovernorAction[] = [
    { name: 'a', enabled: true, run: () => (order.push('a'), { ok: true, reason: 'ok' }) },
    { name: 'b', enabled: false, run: () => (order.push('b'), { ok: true, reason: 'ok' }) },
    { name: 'c', enabled: true, run: () => (order.push('c'), { ok: true, reason: 'ok' }) },
  ];
  await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  check('按顺序执行启用的动作', order.join(',') === 'a,c', order);
  check('步数递增', state.steps === 1, state.steps);
}

// 2b. 节流
{
  const state = createGovernorState();
  let runs = 0;
  const actions: GovernorAction[] = [
    {
      name: 'slow',
      enabled: true,
      throttleSteps: 3,
      run: () => {
        runs += 1;
        return { ok: true, reason: 'ok' };
      },
    },
  ];
  for (let i = 0; i < 7; i += 1) {
    await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  }
  // 第 1、4、7 步执行
  check('节流按步数间隔执行', runs === 3, runs);
}

// 2c. 熔断
{
  const state = createGovernorState();
  let runs = 0;
  const warnings: string[] = [];
  const actions: GovernorAction[] = [
    {
      name: 'broken',
      enabled: true,
      run: () => {
        runs += 1;
        return { ok: false, reason: 'error:boom' };
      },
    },
  ];
  for (let i = 0; i < 6; i += 1) {
    await runGovernor({ state, actions, log: () => {}, warn: (m) => warnings.push(m) });
  }
  check('连续失败后熔断', state.disabled.has('broken') === true, [...state.disabled]);
  check('熔断后不再执行', runs === MAX_CONSECUTIVE_FAILURES, runs);
  check('熔断只告警一次', warnings.filter((w) => w.includes('已熔断')).length === 1, warnings);
}

// 2d. 非异常原因不熔断
{
  const state = createGovernorState();
  let runs = 0;
  const actions: GovernorAction[] = [
    {
      name: 'below',
      enabled: true,
      run: () => {
        runs += 1;
        return { ok: false, reason: 'below-threshold' };
      },
    },
  ];
  for (let i = 0; i < 6; i += 1) {
    await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  }
  check('below-threshold 不熔断', state.disabled.has('below') === false, [...state.disabled]);
  check('below-threshold 每步都执行', runs === 6, runs);
}

// 2e. 动作抛错被转成 error 结果
{
  const state = createGovernorState();
  const actions: GovernorAction[] = [
    {
      name: 'throws',
      enabled: true,
      run: () => {
        throw new Error('kaboom');
      },
    },
  ];
  await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  check(
    '抛错被转成 error 结果',
    state.lastOutcome['throws']?.reason === 'error:kaboom',
    state.lastOutcome['throws'],
  );
}

// 2f. 成功后失败计数清零
{
  const state = createGovernorState();
  let attempt = 0;
  const actions: GovernorAction[] = [
    {
      name: 'flaky',
      enabled: true,
      run: () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, reason: 'error:first' }
          : { ok: true, reason: 'ok' };
      },
    },
  ];
  await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  check('成功后失败计数清零', state.failures['flaky'] === 0, state.failures['flaky']);
}

// ────────────────────────────────────────────────────────────
// 3. 状态格式化
// ────────────────────────────────────────────────────────────
console.log('=== 3) 状态格式化 ===');

{
  const state = createGovernorState();
  const actions: GovernorAction[] = [
    { name: 'ok-action', enabled: true, run: () => ({ ok: true, reason: 'ok' }) },
    { name: 'bad-action', enabled: true, run: () => ({ ok: false, reason: 'error:x' }) },
  ];
  for (let i = 0; i < 3; i += 1) {
    await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  }
  const text = formatGovernorState(state);
  check('状态含步数', text.includes('步数：3'), text);
  check('状态含成功动作', text.includes('ok-action'), text);
  check('状态标记熔断', text.includes('bad-action') && text.includes('已熔断'), text);
}

// 最近一次成功的诊断细节（如 trim 的摘要四数）要出现在状态里
{
  const state = createGovernorState();
  const actions: GovernorAction[] = [
    {
      name: 'trim',
      enabled: true,
      run: () => ({ ok: true, reason: 'ok', detail: '请求 8 / 结论 10 / 错误 0 / 调用 13' }),
    },
  ];
  await runGovernor({ state, actions, log: () => {}, warn: () => {} });
  const text = formatGovernorState(state);
  check('状态含最近一次诊断细节', text.includes('请求 8 / 结论 10'), text);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
