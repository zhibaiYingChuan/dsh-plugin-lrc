/**
 * 全轮集成测试：真正 import `apply()`，用假 session/engine/pruner 驱动 20 步，
 * 断言四条路径（剪枝 / 参数截断 / 裁剪 / 沉淀+快照）全部闭环。
 *
 * 用法：
 *   node --import ./scripts/register-loader.mjs scripts/e2e-turn.ts
 *
 * 这是本轮重构的安全网：之前每一类回归（required:false、tokenMeter inject、
 * surfaceOp 字段名、session.events）都能在这里被抓住。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';

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
// mock LRC
// ────────────────────────────────────────────────────────────
const migrateCalls: Array<{ items: unknown[] }> = [];
const indexCalls: number[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const raw = await readBody(req);
  if (url.pathname === '/health') return send(res, 200, { status: 'running' });
  if (url.pathname === '/v1/context/distill') {
    return send(res, 200, { items: [], count: 0, index_line: '' });
  }
  if (url.pathname === '/v1/context/migrate') {
    const body = JSON.parse(raw) as { items: unknown[] };
    migrateCalls.push({ items: body.items });
    return send(res, 200, { written: body.items.length, merged: 0, failed: 0 });
  }
  if (url.pathname === '/v1/context/index') {
    indexCalls.push(1);
    return send(res, 200, { index_line: '', count: 0, total: 0, items: [] });
  }
  if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 0 });
  return send(res, 404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;

// 隔离缓存目录，避免污染真实 $DSH_HOME
const workDir = mkdtempSync(join(tmpdir(), 'lrc-turn-'));
process.env.DSH_HOME = workDir;

// ────────────────────────────────────────────────────────────
// 假 session
// ────────────────────────────────────────────────────────────
interface FakeEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp: unknown;
  sourceEventSeqs?: number[];
}

class FakeSession {
  readonly id = 'session-turn';
  readonly header = { cwd: 'G:\\proj' };
  readonly log: FakeEvent[] = [];
  readonly surface = { nodes: [] as number[] };

  requestHeader(): { config: { provider: string; model: string } } {
    return { config: { provider: 'p', model: 'm' } };
  }

  append(type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }): FakeEvent {
    const seq = this.log.length;
    const surfaceOp = opts?.surfaceOp ?? 'append';
    const event: FakeEvent = {
      type,
      seq,
      time: Date.now(),
      data,
      surfaceOp,
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    };
    this.log.push(event);
    if (surfaceOp === 'append') {
      this.surface.nodes.push(seq);
    } else {
      const op = surfaceOp as { op?: string; start?: number; end?: number; startSeq?: number; endSeq?: number };
      if (op.op !== 'replace') throw new Error('unsupported surfaceOp');
      const start = op.start ?? op.startSeq;
      const end = op.end ?? op.endSeq;
      const startIdx = this.surface.nodes.indexOf(start as number);
      const endIdx = this.surface.nodes.indexOf(end as number);
      if (startIdx === -1 || endIdx === -1) {
        throw new Error('session event carries an invalid replace surfaceOp');
      }
      this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq);
    }
    return event;
  }
}

const session = new FakeSession();

// ────────────────────────────────────────────────────────────
// 假引擎 / 剪枝器 / 计量器
// ────────────────────────────────────────────────────────────
let step = 0;
const compactCalls: Array<{ start: number; end: number }> = [];
const pruneCalls: number[] = [];

const meter = {
  measure: () => ({
    totalTokens: 10_000 + step * 3_000,
    nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 1_000 })),
  }),
};

const pruner = {
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  pruneSession: () => {
    pruneCalls.push(1);
    return { pruned: [], charsRemoved: 0 };
  },
};

const engine = {
  ctx: {
    get: (n: string) =>
      n === 'tokenMeter' ? meter : n === 'toolResultPruner' ? pruner : undefined,
  },
  summarize: async () => ({
    summary: [{ type: 'text', text: '## 已裁剪的历史（确定性摘要）' }],
    provider: 'p',
    model: 'm',
  }),
  compactRegion: async (start: number, end: number) => {
    compactCalls.push({ start, end });
    await engine.summarize();
    session.append(
      'user/message',
      { content: [{ type: 'text', text: '摘要' }], source: { kind: 'plugin' } },
      { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [start, end] },
    );
    return {};
  },
};

// ────────────────────────────────────────────────────────────
// 假 ctx
// ────────────────────────────────────────────────────────────
const logs: string[] = [];
const tools: Array<{ name?: string; execute?: (args: unknown) => Promise<unknown> }> = [];
const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();

const ctx = {
  logger: {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
  },
  get: (name: string) => {
    if (name === 'agentPresets') {
      return {
        serviceFor: (_a: unknown, service: string) =>
          service === 'compaction' ? engine : service === 'toolResultPruner' ? pruner : undefined,
      };
    }
    if (name === 'sessions') return { create: () => session };
    if (name === 'agents') return { create: async () => ({ agent: { session } }) };
    if (name === 'systemPrompt') return { section: () => {}, context: () => {} };
    if (name === 'llm') {
      return { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) };
    }
    return undefined;
  },
  effect: () => () => {},
  on: (event: string, handler: (a: unknown, b?: unknown) => unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  tools: { register: (tool: unknown) => tools.push(tool as never) },
};

const config = {
  baseUrl,
  token: '',
  project: 'test',
  offloadTurns: 8,
  offloadChars: 6000,
  offloadSteps: 8,
  maxItems: 40,
  pruneEnabled: true,
  pruneResultThreshold: 4096,
  pruneArgsEnabled: true,
  pruneArgsThreshold: 4000,
  pruneArgsHead: 2000,
  pruneReasoningEnabled: true,
  keepRecentNodes: 8,
  trimEnabled: true,
  contextWindowTokens: 0,
  trimRatio: 0.03,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  trimMinSteps: 1,
  trimMaxNodes: 120,
  trimMaxSummaryChars: 2000,
};

try {
  apply(ctx as never, config as never);

  // 等异步初始化（runtime.ensure → offloader 就绪）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !logs.some((l) => l.includes('记忆沉淀已就绪'))) {
    await new Promise((r) => setTimeout(r, 20));
  }
  check('插件初始化完成', logs.some((l) => l.includes('记忆沉淀已就绪')), logs.slice(0, 5));

  const preStep = handlers.get('agent/pre-step')?.[0];
  const onSessionEvent = handlers.get('session/event')?.[0];
  check('pre-step 已注册', typeof preStep === 'function');
  check('session/event 已注册', typeof onSessionEvent === 'function');

  // ── 驱动 20 步 ──
  for (step = 1; step <= 20; step += 1) {
    const assistant = session.append('assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: `结论：第 ${step} 步确认路径可用，必须保持幂等。` },
          { type: 'tool-call', id: `c${step}`, name: 'read', arguments: 'x'.repeat(5000) },
        ],
      },
    });
    onSessionEvent?.(session, assistant);

    const result = session.append('tool/result', {
      message: {
        content: [{ type: 'tool-result', toolCallId: `c${step}`, content: [{ type: 'text', text: 'y'.repeat(6000) }] }],
      },
    });
    onSessionEvent?.(session, result);

    await preStep?.({ agent: { session }, signal: new AbortController().signal }, async () => undefined);
  }

  // 等异步沉淀（flush 是 void）
  await new Promise((r) => setTimeout(r, 400));

  // ── 断言 ──
  console.log('=== 闭环断言 ===');
  check('能力矩阵已打印', logs.some((l) => l.includes('[lrc][cap]')), logs.filter((l) => l.includes('[cap]')));
  check('预算已解析', logs.some((l) => l.includes('[lrc][budget]')), logs.filter((l) => l.includes('[budget]')));
  // 宿主对未知模型返回 1M 哨兵值：必须降级 fallback，用配置绝对值 trim=30000
  check(
    '1M 哨兵值降级 fallback 且 trim=30000',
    logs.some((l) => l.includes('trim=30000') && l.includes('fallback')),
    logs.filter((l) => l.includes('[budget]')),
  );
  check('prune-results 已执行', pruneCalls.length > 0, pruneCalls.length);
  check(
    'prune-args 因宿主不兼容而跳过（不产生 assistant replace）',
    !session.log.some((e) => {
      const op = e.surfaceOp as { op?: string } | undefined;
      return op?.op === 'replace' && e.type === 'assistant/message';
    }),
  );
  check(
    'prune-reasoning 跳过含 tool-call 的消息（保护 tool-pairing）',
    !logs.some((l) => l.includes('[lrc][prune-reasoning]')),
    logs.filter((l) => l.includes('prune-reasoning')),
  );
  check('trim 已执行（compactRegion 被调用）', compactCalls.length > 0, compactCalls);
  check('沉淀已写入 LRC', migrateCalls.length > 0, migrateCalls.length);

  const snapshotPath = join(workDir, 'cache', 'lrc-plugin', 'snapshot.json');
  check('快照文件已生成', existsSync(snapshotPath), snapshotPath);
  if (existsSync(snapshotPath)) {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { text?: string };
    check('快照内容非空', (snapshot.text ?? '').length > 0, snapshot.text);
  }

  // ── 快照位置：runtime-context 必须被移到用户消息之前（缓存前缀稳定） ──
  const userMsg = { content: [{ type: 'text', text: '用户提问' }], source: { kind: 'user' } };
  const ctxMsg = {
    content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier…' }],
    source: { kind: 'runtime-context' },
  };
  const reordered = (await preStep?.(
    { agent: { session }, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg, ctxMsg] }),
  )) as { messages?: Array<{ source?: { kind?: string } }> } | undefined;
  check(
    'runtime-context 被移到用户消息之前',
    reordered?.messages?.[0]?.source?.kind === 'runtime-context' &&
      reordered?.messages?.[1]?.source?.kind === 'user',
    reordered?.messages?.map((m) => m.source?.kind),
  );

  // lrc_status 工具
  const statusTool = tools.find((t) => t.name === 'lrc_status');
  check('lrc_status 已注册', statusTool !== undefined);
  if (statusTool?.execute !== undefined) {
    const value = (await statusTool.execute({})) as { text?: string };
    check('lrc_status 含能力矩阵', (value.text ?? '').includes('能力矩阵'), value.text?.slice(0, 80));
    check('lrc_status 含预算', (value.text ?? '').includes('预算'), value.text?.slice(0, 80));
    check('lrc_status 含动作状态', (value.text ?? '').includes('动作状态'), value.text?.slice(0, 80));
    check('lrc_status 含上下文画像', (value.text ?? '').includes('上下文画像'), value.text?.slice(0, 80));
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
