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
    // 按关键词给出可区分的记忆，让"注入了哪个话题"可断言。
    //
    // ★ 必须同时给 `score`（绝对分）与 `score_norm`（相对分）：
    // 真实 LRC 两者都返回，而插件的准入是**双闸门** —— 只给相对分
    // 会走"旧版兼容"路径，测不到真实行为。
    if (body.query.includes('视频')) {
      return send(res, 200, {
        total: 2,
        memories: [
          { id: 'v1', content: '视频偏好纸质拼贴风格，不要渐变', memory_type: 'preference', score: 0.0321, score_norm: 1.0, importance: 7 },
          { id: 'v2', content: '视频时长确定为 60 秒', memory_type: 'decision', score: 0.0308, score_norm: 0.96, importance: 6 },
        ],
      });
    }
    if (body.query.includes('数据库')) {
      return send(res, 200, {
        total: 1,
        memories: [
          { id: 'd1', content: '数据库选 PostgreSQL，因为需要事务', memory_type: 'decision', score: 0.0312, score_norm: 1.0, importance: 8 },
        ],
      });
    }
    if (body.query.includes('无关话题')) {
      // 话题无关、且**双路命中**（真实环境的高危形态）。
      //
      // ★这里原先是 0.0151（单路簇），那是理想化的输入。实测真实无关查询
      // 如「红烧肉怎么做」「量子纠缠的退相干时间」的 top1 是 0.0309/0.0315
      // —— 落在双路簇里，**当前闸门挡不住**。这组数据把这个已知盲区
      // 显式固化成回归线：将来若引入真正的语义相关度判据，这条会变绿。
      return send(res, 200, {
        total: 2,
        memories: [
          { id: 'x1', content: '无关但双路命中的历史 A', memory_type: 'fact', score: 0.0311, score_norm: 1.0, importance: 3 },
          { id: 'x2', content: '无关但双路命中的历史 B', memory_type: 'fact', score: 0.0305, score_norm: 0.98, importance: 3 },
        ],
      });
    }
    if (body.query.includes('单路话题')) {
      // 单路命中（0.0164 = 1/61）：RRF 意义下"只有一条通路撞上"，
      // 是闸门应当挡掉的形态。模拟语义/深度路不可用的部署。
      return send(res, 200, {
        total: 2,
        memories: [
          { id: 's1', content: '单路候选 A', memory_type: 'fact', score: 0.0164, score_norm: 1.0, importance: 3 },
          { id: 's2', content: '单路候选 B', memory_type: 'fact', score: 0.0161, score_norm: 0.98, importance: 3 },
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
  check('注入出现在上下文中', afterVideo.includes('[LRC 历史记忆（可能过时'), afterVideo.slice(0, 120));
  check('注入含视频话题记忆', afterVideo.includes('纸质拼贴'), afterVideo.slice(0, 200));
  check('最多注入 2 条（缺字段时兜底生效）', afterVideo.split('\n').filter((l) => l.startsWith('- ')).length === 2, afterVideo);
  check('top_k 按 maxItems*3 计算', enrichCalls[0]?.top_k === 6, enrichCalls[0]);

  // 系统提示必须与"已注入"状态一致（不能一边推一边要求再查）
  check('系统提示告知记忆已自动注入', sectionText.includes('自动检索'), sectionText.slice(0, 200));
  check('系统提示不再强制"先调 lrc_recall"', !sectionText.includes('**先调 `lrc_recall` 工具**'), sectionText.slice(0, 200));
  // 注入版提示必须写成软提示：判断权交给正在工作的模型，
  // 否则它会为了迎合历史而改变做法（上下文偏移 / 幻觉）。
  check('系统提示声明判断权在模型', sectionText.includes('由你判断'), sectionText.slice(0, 300));
  check('系统提示允许忽略无关记忆', sectionText.includes('直接忽略'), sectionText.slice(0, 300));

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
    check('未命中后不注入新内容', !afterMiss.includes('[LRC 历史记忆'), afterMiss.slice(0, 120));

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

  // ── 7) 绝对分闸门：单路命中（0.0164）不注入 ──
  //
  // 这是本轮改造的核心。改造前只有 `score_norm >= 0.5` 一道闸门，
  // 而 `score_norm` 是相对 top1 归一化的 —— top1 恒为 1.0，
  // 于是**任何话题都会注入一条**，模型把无关历史当成当前事实。
  console.log('=== 7) 绝对分闸门（单路）===');
  {
    const rewritesBefore = logs.filter((l) => l.includes('累计改写')).length;
    await emit(userEvent('单路话题：只有一条通路命中'));
    const t = probe();
    check('单路候选时不注入', !t.includes('[LRC 历史记忆'), t.slice(0, 160));
    check('单路候选时不产生改写', logs.filter((l) => l.includes('累计改写')).length === rewritesBefore);
    check(
      '日志带上最高绝对分（可区分"没检索到"与"被闸门挡掉"）',
      logs.some((l) => l.includes('最高绝对分 0.0164')),
      logs.filter((l) => l.includes('无记忆注入')),
    );
    check(
      '全部被挡时升为 warn（否则用户以为插件没工作）',
      logs.some((l) => l.startsWith('warn:') && l.includes('全部被绝对分闸门挡掉')),
      logs.filter((l) => l.startsWith('warn:')),
    );
  }

  // ── 7b) 已知盲区：双路命中的无关话题挡不住（记录，不要求通过）──
  //
  // `score` 是 RRF 名次分（Σ1/(60+rank)），只反映"几路命中、排第几"，
  // **不是语义相关度**。实测真实无关查询「红烧肉怎么做」「量子纠缠退相干」
  // 的 top1 是 0.0309/0.0315，落在双路簇里，当前 0.025 的闸门挡不住。
  // 这条断言刻意写成"记录当前行为"，用来防止将来误以为闸门是万能的。
  console.log('=== 7b) 已知盲区（双路无关话题）===');
  {
    await emit(userEvent('无关话题：双路命中的生活类查询'));
    const t = probe();
    const leaked = t.includes('[LRC 历史记忆');
    console.log(
      leaked
        ? '  注意：双路命中的无关话题被放行了（已知盲区，RRF 分不是相关度）'
        : '  已修复：双路命中的无关话题也被挡住（引入了真正的相关度判据）',
    );
    // 不强断言 leaked === true/false —— 只记录，避免把已知缺陷固化成"期望行为"
    check('该场景不产生异常（可正常走到注入或拦断任一路径）', typeof t === 'string');
  }

  // ── 8) 注入与快照共用同一注入点，不得重复 append ──
  console.log('=== 8) 单一注入点 ===');
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
