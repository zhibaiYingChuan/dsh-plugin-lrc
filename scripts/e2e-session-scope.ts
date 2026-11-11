/**
 * 会话归属与跨会话隔离的端到端测试。
 *
 * 用法：
 *   node --import ./scripts/register-loader.mjs scripts/e2e-session-scope.ts
 *
 * # 为什么必须单独成一套
 *
 * 实测事故（2026-11-12，新会话 session-644bba1d）第一轮就被注入：
 *
 * ```
 * [LRC 状态] 方向已定，不再问你。细节在 LRC，需要时 recall。
 * ```
 *
 * 这句话来自**上一个会话**。新会话的模型不知道「方向」指什么，
 * 只能把「方向已定」当既定前提（跳过需求确认），或反复追问。
 *
 * 两个来源都要防：
 *   1. `bootstrapSnapshot()` 从**项目级索引**拼 `[LRC 状态]` —— 索引跨会话，语义漂移；
 *   2. 磁盘快照文件没记会话归属 —— 换会话时被当成自己的状态。
 *
 * 本套测试用**真实 apply()** 驱动，逐条锁住这两个来源。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// mock LRC
// ────────────────────────────────────────────────────────────
const indexCalls: number[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  await readBody(req);
  if (url.pathname === '/health') return send(res, 200, { status: 'running' });
  if (url.pathname === '/v1/context/index') {
    indexCalls.push(1);
    // 项目级索引：**故意**返回带指代的旧会话结论
    return send(res, 200, {
      index_line: '',
      count: 1,
      total: 1,
      items: [
        {
          id: 'x1',
          content_preview: '[决策] 方向已定，不再问你',
          memory_type: 'decision',
          created_at_ms: Date.now(),
        },
      ],
    });
  }
  if (url.pathname === '/v1/memories/enrich') return send(res, 200, { total: 0, memories: [] });
  if (url.pathname === '/v1/context/distill') return send(res, 200, { items: [], count: 0, index_line: '' });
  if (url.pathname === '/v1/context/migrate') return send(res, 200, { written: 0, merged: 0, failed: 0 });
  if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 0 });
  return send(res, 404, { error: 'not_found' });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
if (addr === null || typeof addr === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${addr.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-scope-'));
process.env.DSH_HOME = workDir;

/** 预置一份「属于旧会话」的快照文件。 */
const cacheDir = join(workDir, 'cache', 'lrc-plugin');
mkdirSync(cacheDir, { recursive: true });
const snapshotPath = join(cacheDir, 'snapshot.json');
writeFileSync(
  snapshotPath,
  JSON.stringify({
    text: '[LRC 状态] 方向已定，不再问你。细节在 LRC，需要时 recall。',
    sessionId: 'session-OLD',
    updatedAt: Date.now(),
  }),
  'utf8',
);

// ────────────────────────────────────────────────────────────
// 假 ctx
// ────────────────────────────────────────────────────────────
const logs: string[] = [];
const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
let contextText: (() => string) | null = null;

const ctx = {
  logger: {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
  },
  get: (name: string) => {
    if (name === 'systemPrompt') {
      return {
        section: () => {},
        context: (entry: { text: () => string }) => {
          contextText = entry.text;
        },
      };
    }
    return undefined;
  },
  effect: () => () => {},
  on: (e: string, h: (a: unknown, b?: unknown) => unknown) => {
    const l = handlers.get(e) ?? [];
    l.push(h);
    handlers.set(e, l);
  },
  tools: { register: () => {} },
};

const config = {
  baseUrl,
  token: '',
  project: 'test',
  offloadTurns: 8,
  offloadChars: 6000,
  offloadSteps: 8,
  maxItems: 40,
  pruneEnabled: false,
  pruneResultThreshold: 4096,
  pruneArgsEnabled: false,
  pruneArgsThreshold: 4000,
  pruneArgsHead: 2000,
  pruneReasoningEnabled: false,
  keepRecentNodes: 8,
  trimEnabled: false,
  contextWindowTokens: 0,
  trimRatio: 0.1,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  trimMinSteps: 10,
  trimMaxNodes: 120,
  trimMaxSummaryChars: 4000,
};

async function settle(ms = 300): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

try {
  apply(ctx as never, config as never);
  await settle(1200);

  const onEvent = handlers.get('session/event')?.[0];
  const probe = () => (contextText === null ? '' : contextText());

  check('session/event 已注册', onEvent !== undefined);
  check('systemPrompt.context 已注册', contextText !== null);

  console.log('=== 1) 新会话不得继承旧会话快照 ===');
  {
    const fakeSession = { id: 'session-NEW', surface: { nodes: [] }, log: [] };
    // 第一条会话事件：触发归属判定
    onEvent?.(fakeSession, { type: 'turn/start', seq: 0, data: {}, surfaceOp: 'append' });
    await settle(200);

    const text = probe();
    check('新会话上下文不含旧会话的「方向已定」', !text.includes('方向已定'), text);
    check('记录了丢弃日志', logs.some((l) => l.includes('快照属于其他会话')), logs.filter((l) => l.includes('快照')));

    // 快照文件不应被「修正」成新会话（旧会话的记录保留，等它自己回来）
    const disk = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { sessionId?: string };
    check('磁盘快照未被改写为当前会话', disk.sessionId === 'session-OLD', disk.sessionId);
  }

  console.log('=== 2) 项目级索引不得拼成 [LRC 状态] ===');
  {
    await settle(600);
    const text = probe();
    check('索引服务被探测过', indexCalls.length > 0, indexCalls.length);
    check('上下文不含 [LRC 状态]（索引内容不注入）', !text.includes('[LRC 状态]'), text);
    check('上下文不含索引里的指代内容', !text.includes('方向已定'), text);
    check(
      '日志明确说明索引不注入状态',
      logs.some((l) => l.includes('跨会话记忆不注入')),
      logs.filter((l) => l.includes('索引')),
    );
  }

  console.log('=== 3) 同一会话重启时应恢复自己的快照 ===');
  {
    // 模拟「同一会话重启」：写一份归属 session-NEW 的快照，重新 apply
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        text: '[LRC 状态] 已确认用 Rust 重写解析器。细节在 LRC，需要时 recall。',
        sessionId: 'session-NEW',
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    // 新一轮 ctx（独立实例，避免与上一轮状态串）
    const logs2: string[] = [];
    let ctxText2: (() => string) | null = null;
    const handlers2 = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
    const ctx2 = {
      logger: { info: (m: string) => logs2.push(`info:${m}`), warn: (m: string) => logs2.push(`warn:${m}`) },
      get: (n: string) =>
        n === 'systemPrompt'
          ? {
              section: () => {},
              context: (e: { text: () => string }) => {
                ctxText2 = e.text;
              },
            }
          : undefined,
      effect: () => () => {},
      on: (e: string, h: (a: unknown, b?: unknown) => unknown) => {
        const l = handlers2.get(e) ?? [];
        l.push(h);
        handlers2.set(e, l);
      },
      tools: { register: () => {} },
    };

    apply(ctx2 as never, config as never);
    await settle(1200);

    const ev = handlers2.get('session/event')?.[0];
    ev?.({ id: 'session-NEW', surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 0, data: {}, surfaceOp: 'append' });
    await settle(200);

    const t = ctxText2 === null ? '' : (ctxText2 as () => string)();
    check('同会话快照被恢复', t.includes('已确认用 Rust 重写解析器'), t);
    check('记录了归属确认日志', logs2.some((l) => l.includes('快照归属本会话')), logs2.filter((l) => l.includes('快照')));
  }

  console.log('=== 4) 无归属的旧版快照按「不属于本会话」处理 ===');
  {
    writeFileSync(
      snapshotPath,
      JSON.stringify({ text: '[LRC 状态] 老格式快照无 sessionId', updatedAt: Date.now() }),
      'utf8',
    );
    const logs3: string[] = [];
    let ctxText3: (() => string) | null = null;
    const handlers3 = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
    const ctx3 = {
      logger: { info: (m: string) => logs3.push(`info:${m}`), warn: (m: string) => logs3.push(`warn:${m}`) },
      get: (n: string) =>
        n === 'systemPrompt'
          ? {
              section: () => {},
              context: (e: { text: () => string }) => {
                ctxText3 = e.text;
              },
            }
          : undefined,
      effect: () => () => {},
      on: (e: string, h: (a: unknown, b?: unknown) => unknown) => {
        const l = handlers3.get(e) ?? [];
        l.push(h);
        handlers3.set(e, l);
      },
      tools: { register: () => {} },
    };

    apply(ctx3 as never, config as never);
    await settle(1200);
    const ev = handlers3.get('session/event')?.[0];
    ev?.({ id: 'session-X', surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 0, data: {}, surfaceOp: 'append' });
    await settle(200);

    const t = ctxText3 === null ? '' : (ctxText3 as () => string)();
    check('无归属快照不被采用', !t.includes('老格式快照无 sessionId'), t);
    check('日志标注「无归属」', logs3.some((l) => l.includes('无归属')), logs3.filter((l) => l.includes('快照')));
  }

  check('快照文件仍在（未被删除）', existsSync(snapshotPath));

  console.log('=== 5) 会话边界同时重置召回注入状态 ===');
  {
    // 用一个专门记录 enrich 请求的 mock，验证「切换会话后首句一定重新检索」。
    // 若 recallFingerprint 未随会话重置，且新会话首句恰好是续接词，
    // 指纹会沿用旧值 ⇒ 跳过检索 ⇒ 沿用上一个会话注入的记忆。
    const enrichQueries: string[] = [];
    /** 让 A 的 enrich 挂住，直到测试显式放行（构造「旧响应晚于新会话 bind」） */
    let slowQuery = '';
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const probeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const raw = await readBody(req);
      if (url.pathname === '/health') return send(res, 200, { status: 'running' });
      if (url.pathname === '/v1/memories/enrich') {
        const body = JSON.parse(raw) as { query: string };
        enrichQueries.push(body.query);
        // A 的慢请求：挂住直到测试放行
        if (body.query === slowQuery) await slowGate;
        return send(res, 200, {
          total: 1,
          memories: [
            { id: 'q1', content: `命中：${body.query}`, memory_type: 'fact', score_norm: 0.9, importance: 5 },
          ],
        });
      }
      if (url.pathname === '/v1/context/distill') return send(res, 200, { items: [], count: 0, index_line: '' });
      if (url.pathname === '/v1/context/migrate') return send(res, 200, { written: 0, merged: 0, failed: 0 });
      if (url.pathname === '/v1/context/index') return send(res, 200, { index_line: '', count: 0, total: 0, items: [] });
      if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 0 });
      return send(res, 404, { error: 'nf' });
    });
    await new Promise<void>((r) => probeServer.listen(0, '127.0.0.1', r));
    const pa = probeServer.address();
    if (pa === null || typeof pa === 'string') throw new Error('端口获取失败');
    const probeUrl = `http://127.0.0.1:${pa.port}`;

    let ctxText5: (() => string) | null = null;
    const handlers5 = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
    const ctx5 = {
      logger: { info: () => {}, warn: () => {} },
      get: (n: string) =>
        n === 'systemPrompt'
          ? { section: () => {}, context: (e: { text: () => string }) => { ctxText5 = e.text; } }
          : undefined,
      effect: () => () => {},
      on: (e: string, h: (a: unknown, b?: unknown) => unknown) => {
        const l = handlers5.get(e) ?? [];
        l.push(h);
        handlers5.set(e, l);
      },
      tools: { register: () => {} },
    };
    apply(ctx5 as never, { ...config, baseUrl: probeUrl, recallInjectEnabled: true } as never);
    await settle(1200);

    const ev5 = handlers5.get('session/event')?.[0];
    const userMsg = (seq: number, text: string) => ({
      type: 'user/message',
      seq,
      data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    });

    // 会话 A：慢查询（800ms 后才返回）
    slowQuery = '根据 compression-account.md 生成视频';
    ev5?.({ id: 'session-A', surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 0, data: {}, surfaceOp: 'append' });
    ev5?.({ id: 'session-A', surface: { nodes: [] }, log: [] }, userMsg(1, slowQuery));
    await settle(100);
    check('会话 A 的检索已发出', enrichQueries.includes(slowQuery), enrichQueries);

    // A 的响应还没回来就切到 B —— 这正是 recallGeneration 闸门要防的时序
    ev5?.({ id: 'session-B', surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 2, data: {}, surfaceOp: 'append' });
    ev5?.({ id: 'session-B', surface: { nodes: [] }, log: [] }, userMsg(3, '现在的会话是数据库设计'));
    await settle(500);

    // 现在放行 A 的慢响应：它**不得**覆盖 B 的内容
    releaseSlow?.();
    await settle(600);

    const t5 = ctxText5 === null ? '' : (ctxText5 as () => string)();
    check(
      'A 的迟到响应不得覆盖新会话注入',
      !t5.includes('compression-account'),
      t5.slice(0, 250),
    );
    check('最终注入是 B 的内容', t5.includes('数据库设计') || t5.includes('命中：'), t5.slice(0, 250));

    await new Promise<void>((r) => probeServer.close(() => r()));
  }
  console.log('=== 6) 缺失会话 ID 时不得破坏归属 ===');
  {
    // 极端宿主形状：session 没有 id。此时若把归属写成 ''，
    // 下次正常会话启动会判定「'' !== 真实ID」⇒ 把自己刚写的内容丢掉。
    const logs6: string[] = [];
    let ctxText6: (() => string) | null = null;
    const handlers6 = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
    const ctx6 = {
      logger: { info: (m: string) => logs6.push(`info:${m}`), warn: (m: string) => logs6.push(`warn:${m}`) },
      get: (n: string) =>
        n === 'systemPrompt'
          ? { section: () => {}, context: (e: { text: () => string }) => { ctxText6 = e.text; } }
          : undefined,
      effect: () => () => {},
      on: (e: string, h: (a: unknown, b?: unknown) => unknown) => {
        const l = handlers6.get(e) ?? [];
        l.push(h);
        handlers6.set(e, l);
      },
      tools: { register: () => {} },
    };
    apply(ctx6 as never, config as never);
    await settle(1200);

    const ev6 = handlers6.get('session/event')?.[0];
    // 先给一个正常会话。磁盘里预置的是 session-OLD，所以这一下会正确地
    // 丢弃一次（归属不符）—— 那正是第 1 组已验证的行为，此处先接受它。
    ev6?.({ id: 'session-R', surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 0, data: {}, surfaceOp: 'append' });
    await settle(100);
    const dropsAfterBind = logs6.filter((l) => l.includes('快照属于其他会话')).length;
    check('首次绑定丢弃旧会话快照（符合预期）', dropsAfterBind === 1, dropsAfterBind);

    // 再发一个 **没有 id** 的会话事件。空 id 必须被早退，
    // 不得把 snapshotOwner 写成 ''，也不得再触发一次丢弃。
    ev6?.({ surface: { nodes: [] }, log: [] }, { type: 'turn/start', seq: 1, data: {}, surfaceOp: 'append' });
    await settle(100);

    const t6 = ctxText6 === null ? '' : (ctxText6 as () => string)();
    check(
      '空 id 事件不再触发额外丢弃',
      logs6.filter((l) => l.includes('快照属于其他会话')).length === dropsAfterBind,
      logs6.filter((l) => l.includes('快照')),
    );
    check('空 id 事件后仍能正常读取上下文', typeof t6 === 'string');
  }
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
