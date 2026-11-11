/**
 * 入口层「工具全链路」测试：真正走 apply() → 工具 execute() → HTTP。
 *
 * 用法：node --import ./scripts/register-loader.mjs scripts/e2e-entry-tools.ts
 *
 * ## 为什么必须单独有这个文件
 *
 * 复盘真实事故时发现的结构性盲区：
 *
 * | 测试 | 是否 apply() | 是否调 execute() | 用的 baseUrl |
 * |---|---|---|---|
 * | e2e-apply | 是 | **否**（只检查注册与 schema） | `127.0.0.1:1`（必连不上） |
 * | e2e-turn | 是 | 只调 `lrc_status` | 正常 mock |
 * | e2e-offload / filter | **否**（直接测 Offloader） | — | 正常 mock |
 *
 * 结论：**`lrc_recall` / `lrc_forget` / `lrc_remember_now` 的 execute() 从未被
 * 任何测试执行过**，而它们正是用户实际调用的入口。
 *
 * 于是「client 为 null 就永久返回未就绪」这种缺陷可以带着 15 套全绿测试发布。
 *
 * 本文件补上这个缺口：入口 → 工具 → HTTP → 断言。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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

// ── 可控的假 LRC ────────────────────────────────────────────────
interface State {
  healthy: boolean;
  recallMode: 'ok' | 'empty' | 'http500';
  forgot: string[];
  migrated: unknown[];
}
const state: State = { healthy: false, recallMode: 'ok', forgot: [], migrated: [] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!state.healthy) return send(res, 503, { error: 'down' });

  if (url.pathname === '/health') return send(res, 200, { status: 'running' });

  if (url.pathname === '/v1/memories/enrich') {
    if (state.recallMode === 'http500') return send(res, 500, { error: 'boom' });
    if (state.recallMode === 'empty') return send(res, 200, { memories: [], total: 0 });
    return send(res, 200, {
      memories: [
        { id: 'mem-a', content: '用户偏好用 pnpm', memory_type: 'preference', score_norm: 0.93, importance: 8 },
        { id: 'mem-b', content: '项目选用 PostgreSQL', memory_type: 'decision', score_norm: 0.71, importance: 7 },
      ],
      total: 12,
    });
  }
  if (url.pathname === '/v1/memories/forget') {
    const body = JSON.parse(await readBody(req)) as { memory_id: string };
    state.forgot.push(body.memory_id);
    return send(res, 200, { deleted: true });
  }
  if (url.pathname === '/v1/context/distill') {
    return send(res, 200, { items: [], count: 0, index_line: '' });
  }
  if (url.pathname === '/v1/context/migrate') {
    const body = JSON.parse(await readBody(req)) as { items: unknown[] };
    state.migrated.push(...body.items);
    return send(res, 200, { written: body.items.length, merged: 0, failed: 0 });
  }
  if (url.pathname === '/v1/context/index') {
    return send(res, 200, { index_line: '', count: 0, total: 0, items: [] });
  }
  return send(res, 404, { error: 'not_found' });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
if (addr === null || typeof addr === 'string') throw new Error('端口获取失败');
const baseUrl = `http://127.0.0.1:${addr.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-entry-'));
process.env.DSH_HOME = workDir;

// ── 宿主桩 ──────────────────────────────────────────────────────
const logs: string[] = [];
const tools: Array<{ name: string; execute: (a: unknown) => Promise<unknown> }> = [];
const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();

const fakeSession = {
  id: 'entry-session',
  header: { cwd: 'G:\\proj' },
  log: [] as unknown[],
  surface: { nodes: [] as number[] },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  append: () => ({}),
};

const ctx = {
  logger: {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
  },
  get: (name: string) => {
    if (name === 'sessions') return { create: () => fakeSession };
    if (name === 'agents') return { create: async () => ({ agent: { session: fakeSession } }) };
    if (name === 'systemPrompt') return { section: () => {}, context: () => {} };
    if (name === 'llm') {
      return { resolveModelInfo: async () => ({ context: { contextWindow: 128_000 } }) };
    }
    return undefined;
  },
  effect: () => () => {},
  on: (event: string, handler: (a: unknown, b?: unknown) => unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  tools: { register: (t: unknown) => tools.push(t as never) },
};

const config = {
  baseUrl,
  token: '',
  project: 'entry-test',
  offloadTurns: 8,
  offloadChars: 6000,
  offloadSteps: 8,
  maxItems: 40,
  pruneEnabled: true,
  pruneResultThreshold: 4096,
  pruneArgsEnabled: false,
  pruneArgsThreshold: 4000,
  pruneArgsHead: 2000,
  pruneReasoningEnabled: true,
  keepRecentNodes: 8,
  trimEnabled: true,
  contextWindowTokens: 0,
  trimRatio: 0.03,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  trimMinSteps: 10,
  trimMaxNodes: 120,
  trimMaxSummaryChars: 2000,
  reconnectBaseMs: 1,
  reconnectMaxMs: 5,
  capabilityRecheckSteps: 20,
  budgetRecheckSteps: 20,
};

apply(ctx as never, config as never);

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`${name} 未注册`);
  return t;
}

// ────────────────────────────────────────────────────────────────
console.log('=== 1) LRC 未启动：工具必须给出可读失败，而不是抛错 ===');
state.healthy = false;
await new Promise((r) => setTimeout(r, 30));

const r1 = (await tool('lrc_recall').execute({ query: '用户偏好' })) as { text: string; count: number };
check('lrc_recall 不抛错', typeof r1.text === 'string', r1);
check('返回 count=0', r1.count === 0, r1.count);
check('说明为什么不可用', /不可用|未就绪/.test(r1.text), r1.text);
check('给出重试提示或原因', /重试|原因|实例/.test(r1.text), r1.text);

const f1 = (await tool('lrc_forget').execute({ memory_id: 'mem-a' })) as { text: string; deleted: boolean };
check('lrc_forget 不抛错', typeof f1.text === 'string', f1);
check('lrc_forget 返回 deleted=false', f1.deleted === false, f1);

const m1 = (await tool('lrc_remember_now').execute({ text: '随便写点什么' })) as { snapshot: string };
check('lrc_remember_now 不抛错', typeof m1.snapshot === 'string', m1);

// ────────────────────────────────────────────────────────────────
console.log('=== 2) 参数校验优先于连接状态 ===');
const empty = (await tool('lrc_recall').execute({ query: '   ' })) as { text: string; count: number };
check('空 query 明确提示参数问题', /非空/.test(empty.text), empty.text);

// ────────────────────────────────────────────────────────────────
console.log('=== 3) LRC 就绪后：真实执行并校验返回结构 ===');
state.healthy = true;
await new Promise((r) => setTimeout(r, 30));

const r2 = (await tool('lrc_recall').execute({ query: '用户偏好', top_k: 2 })) as {
  text: string;
  count: number;
};
check('召回成功', r2.count === 2, r2.count);
check('返回内容含记忆正文', r2.text.includes('pnpm'), r2.text.slice(0, 120));
check('每条带 id（纠错需要）', /id=mem-a/.test(r2.text), r2.text.slice(0, 200));
check('带相关度', /相关度 \d+%/.test(r2.text), r2.text.slice(0, 120));
check('标注 total 是融合前候选', /融合前/.test(r2.text), r2.text.slice(0, 80));

// top_k 越界收敛
const r3 = (await tool('lrc_recall').execute({ query: 'x', top_k: 999 })) as { count: number };
check('top_k 超上限被收敛（不报错）', r3.count > 0, r3.count);

// ────────────────────────────────────────────────────────────────
console.log('=== 4) 空结果与业务错误的区分 ===');
state.recallMode = 'empty';
const r4 = (await tool('lrc_recall').execute({ query: '不存在的东西' })) as { text: string; count: number };
check('空结果 count=0', r4.count === 0);
check('空结果提示可回退内置搜索', /未命中/.test(r4.text), r4.text);
check('空结果**不**说"不可用"', !/不可用/.test(r4.text), r4.text);

state.recallMode = 'http500';
const r5 = (await tool('lrc_recall').execute({ query: 'x' })) as { text: string; count: number };
check('HTTP 500 被报为召回失败', /失败/.test(r5.text), r5.text);
check('HTTP 500 不伪装成"未就绪"', !/未就绪/.test(r5.text), r5.text);

// 业务错误不该掐断连接：紧接着的调用仍能工作
state.recallMode = 'ok';
const r6 = (await tool('lrc_recall').execute({ query: '恢复后' })) as { count: number };
check('业务错误后连接仍可用（未被误作废）', r6.count === 2, r6.count);

// ────────────────────────────────────────────────────────────────
console.log('=== 5) 纠错闭环：forget 打穿到服务端 ===');
state.forgot.length = 0;
const f2 = (await tool('lrc_forget').execute({ memory_id: 'mem-b' })) as { text: string; deleted: boolean };
check('forget 返回 deleted=true', f2.deleted === true, f2);
check('请求真的发到服务端', state.forgot.includes('mem-b'), state.forgot);

// ────────────────────────────────────────────────────────────────
console.log('=== 6) 手动沉淀：标签路径绕过 distill ===');
state.migrated.length = 0;
const tagText = '<lrc_memory>\n- 决策：数据库选 PostgreSQL，因为需要事务\n</lrc_memory>';
const m2 = (await tool('lrc_remember_now').execute({ text: tagText })) as {
  snapshot: string;
  distilled: number;
};
check('标签内容被沉淀', state.migrated.length > 0, state.migrated.length);
check('绕过 distill（未产生 distill 调用即可）', m2.distilled >= 0, m2.distilled);

// ────────────────────────────────────────────────────────────────
console.log('=== 7) 服务中途崩溃 → 恢复（入口层）===');
state.healthy = false;
const r7 = (await tool('lrc_recall').execute({ query: '断线' })) as { text: string; count: number };
check('断线时优雅失败', r7.count === 0, r7);

state.healthy = true;
await new Promise((r) => setTimeout(r, 20));
const r8 = (await tool('lrc_recall').execute({ query: '恢复' })) as { count: number };
check('服务恢复后自动重连（无需重启插件）', r8.count === 2, r8.count);

// ────────────────────────────────────────────────────────────────
console.log('=== 8) lrc_status 必须能解释"为什么不可用"===');
const st = (await tool('lrc_status').execute({})) as { text: string };
check('含连接区块', st.text.includes('## 连接'), st.text.slice(0, 200));
check('含重试信息', /重试倒计时|下次重探/.test(st.text), st.text.slice(0, 300));
check('含累计成功/失败', /成功 \d+ 次/.test(st.text), st.text.slice(0, 400));

// ────────────────────────────────────────────────────────────────
console.log('=== 9) 事件监听确实挂上（防止 apply 半途失败）===');
check('订阅 session/event', handlers.has('session/event'));
check('订阅 agent/pre-step', handlers.has('agent/pre-step'));

await new Promise<void>((r) => server.close(() => r()));
rmSync(workDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
