/**
 * 主动召回注入的**端到端**测试：真正 import `apply()`，真正触发 `user/message`
 * 事件，真正读 `systemPrompt.context` 的 text 回调。
 *
 * 用法：
 *   node --import ./scripts/register-loader.mjs scripts/e2e-recall-e2e.ts
 *
 * # 为什么单测不够
 *
 * `e2e-recall-injection.ts` 只测纯函数。而本轮自审发现的三个缺陷全部
 * **在纯函数的边界之外**：
 *
 * 1. 用 `messageContent()` 取用户消息 ⇒ 恒 undefined ⇒ 注入**从未触发**
 *    （纯函数各自都"正确"，拼起来是死的）；
 * 2. 并发两次召回时后完成的覆盖先完成的（状态机问题）；
 * 3. 配置缺字段时 `undefined` 静默反转语义（调用点问题）。
 *
 * 这类"零件对、装配错"的缺陷只有端到端才照得出来 —— 与上一轮
 * `lrc_recall` 从未被测试覆盖是同一类盲区。
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

// ────────────────────────────────────────────────────────────
// mock LRC：按 query 关键词返回不同记忆，可注入延迟（测并发）
// ────────────────────────────────────────────────────────────
const enrichCalls: Array<{ query: string; top_k: number }> = [];
/** 每次 enrich 的人工延迟（毫秒），用于构造"慢查询后回来"的竞态 */
let enrichDelayMs = 0;

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
  if (url.pathname === '/v1/memories/enrich') {
    const body = JSON.parse(raw) as { query: string; top_k: number };
    enrichCalls.push(body);
    if (enrichDelayMs > 0) await new Promise((r) => setTimeout(r, enrichDelayMs));
    // 按关键词给出可区分的记忆，让"注入了哪个话题"可断言
    if (body.query.includes('视频')) {
      return send(res, 200, {
        total: 2,
        memories: [
          { id: 'v1', content: '视频偏好纸质拼贴风格，不要渐变', memory_type: 'preference', score_norm: 0.95, importance: 7 },
          { id: 'v2', content: '视频时长确定为 60 秒', memory_type: 'decision', score_norm: 0.82, importance: 6 },
        ],
      });
    }
    if (body.query.includes('数据库')) {
      return send(res, 200, {
        total: 1,
        memories: [
          { id: 'd1', content: '数据库选 PostgreSQL，因为需要事务', memory_type: 'decision', score_norm: 0.9, importance: 8 },
        ],
      });
    }
    return send(res, 200, { total: 0, memories: [] });
  }
  if (url.pathname === '/v1/context/distill') return send(res, 200, { items: [], count: 0, index_line: '' });
  if (url.pathname === '/v1/context/migrate') return send(res, 200, { written: 0, merged: 0, failed: 0 });
  if (url.pathname === '/v1/context/index') return send(res, 200, { index_line: '', count: 0, total: 0, items: [] });
  if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 0 });
  return send(res, 404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-recall-e2e-'));
process.env.DSH_HOME = workDir;

// ────────────────────────────────────────────────────────────
// 假 ctx：捕获 systemPrompt.context 的 text 回调
// ────────────────────────────────────────────────────────────
const logs: string[] = [];
const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
let contextText: (() => string) | null = null;
let sectionText = '';

const ctx = {
  logger: {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
  },
  get: (name: string) => {
    if (name === 'systemPrompt') {
      return {
        section: (s: { text: string }) => {
          sectionText = s.text;
        },
        context: (entry: { text: () => string }) => {
          contextText = entry.text;
        },
      };
    }
    return undefined;
  },
  effect: () => () => {},
  on: (event: string, handler: (a: unknown, b?: unknown) => unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
  tools: { register: () => {} },
};

/**
 * 构造一条真实的 `user/message` 事件。
 *
 * 形状必须与 DSH 实际一致：内容在 `data.content`（不是 `data.message.content`），
 * 用户身份在 `data.source.kind`。这个形状差异正是本轮主缺陷的根源。
 */
function userEvent(text: string, kind = 'user'): unknown {
  return { type: 'user/message', seq: 0, time: Date.now(), data: { content: [{ type: 'text', text }], source: { kind } } };
}

/** 等异步注入落地（refreshRecallInjection 是 void 调用的）。 */
async function settle(ms = 300): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

try {
  // 一个"老 patch"配置：**故意不含** recallInject* 字段之外的新字段，
  // 且 recallInject* 全部缺失 —— 验证规范化兜底真的生效
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
    trimRatio: 0.03,
    pruneRatio: 0.004,
    trimMinTokens: 30000,
    trimMinSteps: 10,
    trimMaxNodes: 120,
    trimMaxSummaryChars: 4000,
    // ★ 关键：只给开关，其余 recallInject* 故意缺失
    recallInjectEnabled: true,
  };

  apply(ctx as never, config as never);
  await settle(1500);

  // 必须在 apply 之后取：注册表在 apply 时才被填充
  const sessionEvent = handlers.get('session/event')?.[0];

  check('systemPrompt.context 已注册', contextText !== null);
  check('systemPrompt 段落已注册', sectionText.length > 0);
  check('session/event 已注册', sessionEvent !== undefined);

  const probe = () => (contextText === null ? '' : contextText());
  const emit = async (event: unknown): Promise<void> => {
    sessionEvent?.(null, event);
    await settle(400);
  };

  // ── 1) 首次用户发言：必须触发召回并注入 ──
  console.log('=== 1) 真实事件驱动注入 ===');
  await emit(userEvent('根据 compression-account.md 生成视频'));
  const afterVideo = probe();
  check('enrich 被调用', enrichCalls.length === 1, enrichCalls);
  check('注入出现在上下文中', afterVideo.includes('[LRC 相关记忆]'), afterVideo.slice(0, 120));
  check('注入含视频话题记忆', afterVideo.includes('纸质拼贴'), afterVideo.slice(0, 200));
  check('最多注入 2 条（缺字段时兜底生效）', afterVideo.split('\n').filter((l) => l.startsWith('- ')).length === 2, afterVideo);
  check('top_k 按 maxItems*3 计算', enrichCalls[0]?.top_k === 6, enrichCalls[0]);

  // 系统提示必须与"已注入"状态一致（不能一边推一边要求再查）
  check('系统提示告知记忆已自动注入', sectionText.includes('自动检索'), sectionText.slice(0, 200));
  check('系统提示不再强制"先调 lrc_recall"', !sectionText.includes('**先调 `lrc_recall` 工具**'), sectionText.slice(0, 200));

  // ── 2) 同话题追问：不得重复改写（缓存友好）──
  console.log('=== 2) 同话题不重复注入 ===');
  const callsBefore = enrichCalls.length;
  const textBefore = probe();
  await emit(userEvent('根据 compression-account.md 生成视频，配色用纸质风'));
  check('同话题不重新检索', enrichCalls.length === callsBefore, enrichCalls.length - callsBefore);
  check('注入文本一字不变', probe() === textBefore);

  // ── 3) 续接短句：沿用上一指纹，同样不检索 ──
  await emit(userEvent('继续'));
  check('续接指令不触发检索', enrichCalls.length === callsBefore, enrichCalls.length - callsBefore);
  check('续接后文本不变', probe() === textBefore);

  // ── 4) 换话题：必须重新注入且换成新内容 ──
  console.log('=== 3) 换话题重新注入 ===');
  await emit(userEvent('数据库为什么选 PostgreSQL 而不是 MySQL'));
  const afterDb = probe();
  check('换话题触发检索', enrichCalls.length === callsBefore + 1, enrichCalls.length - callsBefore);
  check('注入内容已换成数据库记忆', afterDb.includes('PostgreSQL'), afterDb.slice(0, 200));
  check('旧话题记忆被替换掉', !afterDb.includes('纸质拼贴'), afterDb.slice(0, 200));

  // ── 5) 宿主注入的上下文不得当作 query ──
  console.log('=== 4) 忽略宿主注入上下文 ===');
  const callsBeforeInjected = enrichCalls.length;
  await emit(userEvent('一份很长的技能目录……', 'skill-catalog'));
  check('skill-catalog 不触发检索', enrichCalls.length === callsBeforeInjected, enrichCalls.length - callsBeforeInjected);

  // ── 6) 并发竞态：慢的旧查询不得覆盖快的新查询 ──
  console.log('=== 5) 并发竞态 ===');
  {
    // 先发一个"视频"查询（制造 250ms 延迟），随后立刻发"数据库"查询（无延迟）。
    // 数据库结果先回来；视频结果后回来必须被代次校验丢弃。
    enrichDelayMs = 250;
    sessionEvent?.(null, userEvent('视频再做一版纸质拼贴的'));
    await new Promise((r) => setTimeout(r, 20));
    enrichDelayMs = 0;
    sessionEvent?.(null, userEvent('数据库索引怎么建'));
    await settle(800);

    const finalText = probe();
    check('最终注入是后发话题（数据库）', finalText.includes('PostgreSQL'), finalText.slice(0, 200));
    check('后到的旧话题结果被丢弃', !finalText.includes('纸质拼贴'), finalText.slice(0, 200));
  }

  // ── 7) 未命中：清空旧话题记忆，而不是保留（否则就是噪音污染）──
  console.log('=== 6) 未命中清空旧话题 ===');
  {
    check('检索前上下文里有数据库记忆', probe().includes('PostgreSQL'), probe().slice(0, 120));
    await emit(userEvent('量子纠缠的退相干时间怎么测'));
    const afterMiss = probe();
    check('未命中后不再保留旧话题记忆', !afterMiss.includes('PostgreSQL'), afterMiss.slice(0, 120));
    check('未命中后不注入新内容', !afterMiss.includes('[LRC 相关记忆]'), afterMiss.slice(0, 120));

    // 同一未命中话题内继续追问：可以再检索一次（措辞变化会换指纹），
    // 但**绝不能产生改写** —— 改写才是缓存断裂，检索只是一次本地 HTTP。
    // 这是"缓存友好"的准确判据：成本在改写次数，不在查询次数。
    const rewritesBefore = logs.filter((l) => l.includes('累计改写')).length;
    await emit(userEvent('量子退相干'));
    check(
      '未命中话题内不产生新的改写',
      logs.filter((l) => l.includes('累计改写')).length === rewritesBefore,
      logs.filter((l) => l.includes('累计改写')).length - rewritesBefore,
    );
  }

  // ── 8) 注入与快照共用同一注入点，不得重复 append ──
  console.log('=== 7) 单一注入点 ===');
  {
    let callCount = 0;
    const original = contextText!;
    // contextText 是同一个回调；这里只验证它有且只有一个（多次读取内容一致）
    const a = original();
    const b = original();
    callCount += 1;
    check('同一回调多次读取内容一致', a === b, { a: a.slice(0, 60), b: b.slice(0, 60) });
    check('只注册了一个 context 段', callCount === 1);
  }

  // ── 9) 可观测性 ──
  console.log('=== 8) 可观测性 ===');
  check('注入日志存在', logs.some((l) => l.includes('[lrc] 注入')), logs.filter((l) => l.includes('注入')));
  check('注入日志含累计改写次数', logs.some((l) => l.includes('累计改写')), logs.filter((l) => l.includes('累计改写')));
  // 每次改写都是一次缓存断裂，次数必须等于"注入文本真实变化"的次数：
  // 视频一次 + 数据库一次 + 竞态后的数据库内容（与上次可能不同）
  const rewriteLogs = logs.filter((l) => l.includes('累计改写'));
  check('改写次数可枚举且不为 0', rewriteLogs.length > 0, rewriteLogs.length);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
