/**
 * 自愈链路测试：把「一次性决策 → 永久失效」这类缺陷锁死。
 *
 * 用法：node scripts/e2e-recovery.ts
 *
 * ## 背景（真实事故）
 *
 * LRC 桌面端比 DSH 晚 20 分钟启动。插件在启动那一刻探测失败、判为 degraded，
 * 此后 `client` 永久为 null —— 会话里 5 次 `lrc_recall` 全部返回「未就绪」，
 * 而 LRC 早已健康。用户完全无从察觉。
 *
 * 根因不是某一处写错，而是同一反模式在多处重复：
 * **一次决策 + 永久缓存 + 无重试**。
 *
 * 本测试逐个锁住这些状态点的「可恢复性」，防止下一个同类缺陷再溜过去。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recoverable, isConnectionError, DEFAULT_BACKOFF } from '../src/recoverable.ts';
import { LrcRuntime } from '../src/runtime.ts';
import {
  createGovernorState,
  runGovernor,
  formatGovernorState,
  HALF_OPEN_AFTER_STEPS,
  MAX_CONSECUTIVE_FAILURES,
  type GovernorAction,
} from '../src/governor.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'lrc-recovery-'));

// ── 1) Recoverable：失败后可重试，成功后被复用 ──────────────────────
console.log('=== 1) Recoverable 基本语义 ===');
{
  let now = 1_000_000;
  let calls = 0;
  let shouldFail = true;
  const res = new Recoverable<string>(
    async () => {
      calls += 1;
      if (shouldFail) throw new Error('ECONNREFUSED');
      return 'connected';
    },
    { now: () => now, backoff: { baseMs: 1000, maxMs: 8000 } },
  );

  const first = await res.get();
  check('首次失败返回 null', first === null, first);
  check('记录了失败原因', (res.status().lastError ?? '').includes('ECONNREFUSED'), res.status());
  check('首次尝试只调用一次 factory', calls === 1, calls);

  // 退避窗口内：不应再调用 factory
  const during = await res.get();
  check('退避窗口内不重试', during === null && calls === 1, { during, calls });

  // 窗口过后：应当重试
  now += 1001;
  const second = await res.get();
  check('退避窗口过后自动重试', calls === 2, calls);
  check('仍然失败时继续返回 null', second === null, second);

  // 服务恢复
  shouldFail = false;
  now += 10_000;
  const third = await res.get();
  check('服务恢复后拿到值', third === 'connected', third);
  check('成功后状态为 ready', res.status().state === 'ready', res.status());

  // 成功结果不再重试（性能要求：不能每次都重连）
  const fourth = await res.get();
  check('成功结果被复用（不重复 factory）', fourth === 'connected' && calls === 3, calls);
}

// ── 2) Recoverable：指数退避 + 上限封顶 ──────────────────────────────
console.log('=== 2) 指数退避 ===');
{
  let now = 0;
  let calls = 0;
  const res = new Recoverable<string>(
    async () => {
      calls += 1;
      throw new Error('boom');
    },
    { now: () => now, backoff: { baseMs: 1000, maxMs: 5000 } },
  );

  await res.get();
  check('首次退避 = base', res.status().lastBackoffMs === 1000, res.status().lastBackoffMs);
  now += 1001;
  await res.get();
  check('第二次退避翻倍', res.status().lastBackoffMs === 2000, res.status().lastBackoffMs);
  now += 2001;
  await res.get();
  check('第三次退避再翻倍', res.status().lastBackoffMs === 4000, res.status().lastBackoffMs);
  now += 4001;
  await res.get();
  check('退避不超过上限', res.status().lastBackoffMs === 5000, res.status().lastBackoffMs);
  now += 5001;
  await res.get();
  check('封顶后保持上限', res.status().lastBackoffMs === 5000, res.status().lastBackoffMs);
  check('连续失败 5 次', res.status().consecutiveFailures === 5, res.status());
}

// ── 3) Recoverable：invalidate 立刻允许重连（热路径断连）───────────
console.log('=== 3) invalidate 立即重连 ===');
{
  let now = 1_000;
  let calls = 0;
  const res = new Recoverable<string>(
    async () => {
      calls += 1;
      return `conn-${calls}`;
    },
    { now: () => now, backoff: { baseMs: 5000, maxMs: 5000 } },
  );

  await res.get();
  check('首次连接成功', calls === 1, calls);

  // 模拟：连接好好的，但热路径发现断了
  res.invalidate('socket hang up');
  check('作废后不再 ready', res.ready === false);
  check('作废后 retryInMs 归零', res.status().retryInMs === 0, res.status());

  // 注意：作废不清退避窗口，所以这里应当能**立刻**重连（不需要等 5s）
  const again = await res.get();
  check('作废后立刻重连（不等退避）', calls === 2 && again === 'conn-2', { calls, again });
}

// ── 4) Recoverable：并发单飞（不能每次都各连一次）────────────────────
console.log('=== 4) 并发单飞 ===');
{
  let calls = 0;
  const res = new Recoverable<string>(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 50));
    return 'ok';
  });

  const results = await Promise.all([res.get(), res.get(), res.get(), res.get()]);
  check('并发 4 次只调用 1 次 factory', calls === 1, calls);
  check('四个调用都拿到同一个值', results.every((r) => r === 'ok'), results);
}

// ── 5) isConnectionError：连接类 vs 业务类 ──────────────────────────
console.log('=== 5) 错误分类 ===');
check('ECONNREFUSED 算连接错误', isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:3099')));
check('fetch failed 算连接错误', isConnectionError(new Error('fetch failed')));
check('超时算连接错误', isConnectionError(new Error('The operation was aborted due to timeout')));
check(
  'HTTP 400 不算连接错误（服务是活的）',
  !isConnectionError(new Error('LRC /v1/memories/enrich 返回 400: bad request')),
);
check(
  'HTTP 500 也不算（不掐正常连接）',
  !isConnectionError(new Error('LRC /v1/context/migrate 返回 500: oops')),
);

// ── 6) runtime：degraded 之后能重新探测 ─────────────────────────────
console.log('=== 6) runtime 降级后自愈 ===');
{
  // 起一个「先关后开」的健康服务，模拟 LRC 晚启动
  let healthy = false;
  const server = createServer((req, res) => {
    if (req.url === '/health' && healthy) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"running"}');
      return;
    }
    res.writeHead(503);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('端口获取失败');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const rt = new LrcRuntime({
    baseUrl,
    cacheDir: join(workDir, 'rt'),
    probeLocal: false,
    healthTimeoutMs: 800,
  });

  const d1 = await rt.ensure();
  check('LRC 未起时降级', d1.mode === 'degraded', d1);
  check('降级后记录退避', rt.status().mode === 'degraded', rt.status());

  // 退避窗口内重复 ensure 不应重探（否则每次都白等健康检查超时）
  const d2 = await rt.ensure();
  check('退避窗口内不重探（复用降级结果）', d2.mode === 'degraded', d2);
  check('退避倒计时大于 0', rt.status().retryInMs > 0, rt.status());

  // LRC 起来了
  healthy = true;
  rt.invalidate('测试：服务已就绪');
  const d3 = await rt.ensure();
  check('作废后重新探测成功', d3.mode === 'external', d3);
  check('检测到正确的 baseUrl', d3.baseUrl === baseUrl, d3);

  // 成功结果被复用
  const d4 = await rt.ensure();
  check('成功后直接复用（不再探测）', d4.mode === 'external', d4);

  rt.stop();
  await new Promise<void>((r) => server.close(() => r()));
}

// ── 7) governor：熔断后能半开恢复 ───────────────────────────────────
console.log('=== 7) 熔断半开恢复 ===');
{
  const state = createGovernorState();
  let shouldFail = true;
  let runs = 0;
  const action: GovernorAction = {
    name: 'trim',
    enabled: true,
    run: () => {
      runs += 1;
      if (shouldFail) return { ok: false, reason: 'error:boom' };
      return { ok: true, reason: 'ok' };
    },
  };

  const logs: string[] = [];
  const warns: string[] = [];
  const deps = {
    state,
    actions: [action],
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  };

  // 连败 3 次 → 熔断
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) await runGovernor(deps);
  check('连续失败后熔断', state.disabled.has('trim'), [...state.disabled]);
  check('熔断有告警', warns.some((w) => w.includes('已熔断')), warns);

  // 熔断期间不再执行
  const before = runs;
  await runGovernor(deps);
  check('熔断期间不执行', runs === before, { before, runs });

  // 走够 HALF_OPEN_AFTER_STEPS 步 → 半开
  shouldFail = false;
  // 注意：state.steps 每跑一步就自增，循环上限必须**事先固定**，
  // 否则条件里的 state.steps 会不断右移，变成死循环。
  const target = state.steps + HALF_OPEN_AFTER_STEPS;
  while (state.steps < target) {
    await runGovernor(deps);
  }
  check('半开后恢复执行', runs > before, { before, runs });
  check('恢复后解除熔断', !state.disabled.has('trim'), [...state.disabled]);
  check(
    '恢复后状态为成功',
    state.lastOutcome['trim']?.ok === true,
    state.lastOutcome['trim'],
  );

  // 熔断状态展示要给出半开倒计时
  const st2 = createGovernorState();
  st2.disabled.add('trim');
  st2.disabledAtStep['trim'] = 0;
  st2.steps = 5;
  const text = formatGovernorState(st2);
  check('状态里带半开倒计时', text.includes('步后半开'), text);
}

// ── 8) 组合场景：完整复现本次事故并证明已修复 ──────────────────────
console.log('=== 8) 事故复现：DSH 先起、LRC 后起 ===');
{
  let healthy = false;
  const server = createServer((req, res) => {
    if (req.url === '/health' && healthy) {
      res.writeHead(200);
      res.end('{"status":"running"}');
      return;
    }
    if (req.url?.startsWith('/v1/memories/enrich') && healthy) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memories: [{ id: 'm1', content: '记忆内容', memory_type: 'fact', score_norm: 1, importance: 5 }], total: 1 }));
      });
      return;
    }
    res.writeHead(503);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('端口获取失败');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const rt = new LrcRuntime({
    baseUrl,
    cacheDir: join(workDir, 'combo'),
    probeLocal: false,
    healthTimeoutMs: 600,
  });

  // 用 Recoverable 复刻 index.ts 里的 connection
  const connection = new Recoverable<{ base: string }>(
    async () => {
      // force 与 index.ts 一致：退避由 Recoverable 统一控制，不叠加 runtime 的那一层
      const result = await rt.ensure({ force: true });
      if (result.mode === 'degraded') throw new Error(result.reason ?? 'LRC 不可用');
      return { base: result.baseUrl };
    },
    { backoff: { baseMs: 1, maxMs: 5 } }, // 测试里把退避压到最小
  );

  const attempt1 = await connection.get();
  check('事故现场：LRC 未起 → 拿不到连接', attempt1 === null, attempt1);
  check('给出可读原因', (connection.status().lastError ?? '').includes('不可用'), connection.status());

  // —— 这是修复的核心：LRC 起来了，不需要重启插件，直接调用就能自愈 ——
  healthy = true;
  await new Promise((r) => setTimeout(r, 10));
  const attempt2 = await connection.get();
  check('LRC 后起后自动连上（无需重启插件）', attempt2 !== null, attempt2);
  check('连接指向正确地址', attempt2?.base === baseUrl, attempt2);

  // 模拟一次热路径断连
  connection.invalidate('socket hang up');
  const attempt3 = await connection.get();
  check('断连后能重新连上', attempt3 !== null, attempt3);

  await new Promise<void>((r) => server.close(() => r()));
}

// ── 9) 默认退避参数合理性 ───────────────────────────────────────────
console.log('=== 9) 默认参数 ===');
check('默认退避起步 2s', DEFAULT_BACKOFF.baseMs === 2000, DEFAULT_BACKOFF.baseMs);
check('默认退避封顶 60s', DEFAULT_BACKOFF.maxMs === 60000, DEFAULT_BACKOFF.maxMs);
check('封顶 ≥ 起步', DEFAULT_BACKOFF.maxMs >= DEFAULT_BACKOFF.baseMs);

// ── 10) 配置缺失/非法时退避不能静默失效 ────────────────────────────
//
// 这是本次自审抓到的真实回归：新配置项在旧 config（宿主 patch / 测试桩）
// 里不存在时，`baseMs * 2**n` 会得到 NaN，而 `now() >= NaN` 恒为 false，
// 于是**每次调用都真的去连** —— 退避静默消失，比不加退避更糟。
// 这种失败不报错、日志正常，必须有断言盯着。
console.log('=== 10) 退避参数兜底 ===');
{
  const cases: Array<[string, unknown]> = [
    ['全缺', { backoff: {} as never }],
    ['值为 undefined', { backoff: { baseMs: undefined, maxMs: undefined } as never }],
    ['值为 null', { backoff: { baseMs: null, maxMs: null } as never }],
    ['值为 NaN', { backoff: { baseMs: Number.NaN, maxMs: Number.NaN } as never }],
    ['值为字符串', { backoff: { baseMs: '2000', maxMs: '60000' } as never }],
    ['负值', { backoff: { baseMs: -5, maxMs: -1 } as never }],
  ];
  for (const [label, opts] of cases) {
    let calls = 0;
    const res = new Recoverable<string>(
      async () => {
        calls += 1;
        throw new Error('boom');
      },
      opts as never,
    );
    await res.get();
    const st = res.status();
    await res.get();
    await res.get();
    const finite =
      Number.isFinite(st.lastBackoffMs) && Number.isFinite(st.retryInMs) && st.lastBackoffMs > 0;
    check(`${label}：退避是有限正数`, finite, { lastBackoffMs: st.lastBackoffMs, retryInMs: st.retryInMs });
    check(`${label}：退避期间不重复连接`, calls === 1, `calls=${calls}`);
  }

  // 上限小于起步时应收敛为「上限 = 起步」，而不是越退越快
  let calls2 = 0;
  let now2 = 0;
  const b2 = new Recoverable<string>(
    async () => {
      calls2 += 1;
      throw new Error('boom');
    },
    { now: () => now2, backoff: { baseMs: 5000, maxMs: 1000 } },
  );
  await b2.get();
  check('上限<起步时收敛为起步', b2.status().lastBackoffMs === 5000, b2.status().lastBackoffMs);
  now2 += 5001;
  await b2.get();
  check('收敛后不会越退越快', b2.status().lastBackoffMs === 5000, b2.status().lastBackoffMs);
}

rmSync(workDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
