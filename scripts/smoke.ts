/**
 * 客户端冒烟测试（不依赖 DSH，也不依赖真实 LRC）。
 *
 * 用法：node scripts/smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LrcClient } from '../src/lrc-client.ts';

const received: Array<{ path: string; body: unknown }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const raw = await readBody(req);
  received.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });

  if (url.pathname === '/health') return send(res, 200, { status: 'running' });
  if (url.pathname === '/v1/context/distill') {
    return send(res, 200, {
      items: [
        {
          content: '[决策] 用 pnpm 替代 npm',
          memory_type: 'decision',
          tags: ['decision', 'distilled'],
          importance: 7,
          source_turns: [0, 0],
        },
      ],
      count: 1,
      index_line: '前序对话已提炼 1 条至 LRC（项目：demo）',
    });
  }
  if (url.pathname === '/v1/context/migrate') {
    return send(res, 200, { written: 1, merged: 0, failed: 0 });
  }
  if (url.pathname === '/v1/context/index') {
    return send(res, 200, { index_line: 'LRC 归档区 1 条', count: 1, total: 1, items: [] });
  }
  if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 1 });
  if (url.pathname === '/v1/context/boom') return send(res, 500, { error: 'boom' });
  send(res, 404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

try {
  const client = new LrcClient({ baseUrl, token: 'test-token' });

  console.log('1) health');
  check('健康检查通过', await client.health());

  console.log('2) distill');
  const distilled = await client.distill('我们决定用 pnpm 替代 npm。', 'demo', 10);
  check('返回 1 条', distilled.count === 1, distilled);
  const distillReq = received.at(-1)?.body as Record<string, unknown>;
  check(
    '请求体含 text/project/max_items',
    typeof distillReq?.text === 'string' &&
      distillReq?.project === 'demo' &&
      distillReq?.max_items === 10,
    distillReq,
  );

  console.log('3) migrate');
  const migrated = await client.migrate(distilled.items, 'demo');
  check('written=1', migrated.written === 1, migrated);

  console.log('4) index');
  const index = await client.index('demo', 5);
  check('count=1', index.count === 1, index);

  console.log('5) totalMemories');
  check('总数=1', (await client.totalMemories()) === 1);

  console.log('6) migrateText');
  const combined = await client.migrateText('我们决定用 pnpm 替代 npm。', 'demo');
  check('distilled=1 且 written=1', combined.distilled === 1 && combined.written === 1, combined);

  console.log('7) 错误路径：5xx');
  let threw = false;
  try {
    await client.request('/v1/context/boom', { method: 'GET' });
  } catch (error) {
    threw = true;
    check('错误信息含 500', String(error).includes('500'), String(error));
  }
  check('5xx 抛出异常', threw);

  console.log('8) 错误路径：服务不可达');
  const dead = new LrcClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
  check('不可达时 health 返回 false', (await dead.health()) === false);
  let deadThrew = false;
  try {
    await dead.index('demo');
  } catch {
    deadThrew = true;
  }
  check('不可达时请求抛出', deadThrew);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
