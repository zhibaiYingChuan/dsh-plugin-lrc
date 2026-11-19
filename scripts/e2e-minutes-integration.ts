/**
 * 会话纪要的**集成测试**：真正 import `apply()`，用假 session 驱动
 * `turn/start` / `user/message` / `turn/end` 事件，断言 `index.ts` 里
 * 那套状态机的行为。
 *
 * 用法：
 *   node --import ./scripts/register-loader.mjs scripts/e2e-minutes-integration.ts
 *
 * ## 为什么必须有这个文件（2026-11-17 二轮审查 M-b）
 *
 * `e2e-minutes.ts` 里的用例全部直接调 `buildMinutes` / `MinutesLedgerStore`
 * 这些**纯函数**。三个 critical 却都在 `index.ts` 的状态机里：
 * ```
 * X1 persistMinutes 合并后未裁剪 ⇒ writtenTurns=80 把闸门永久锁死
 * X2 空闲触发未传 force      ⇒ 短会话永远没有纪要
 * X3 finishingTurns 模糊查找 ⇒ T1 的结论落进 T2
 * M6 endedAt = Date.now()      ⇒ 记成下一轮开始时刻
 * ```
 * 纯函数用例对它们**完全无感**（把修复回退也照样通过）。所以这里走真路径。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';
import {
  buildMinutes,
  minutesSimilarity,
  MinutesLedgerStore,
  parseMinutesTurns,
  type MinutesLedgerState,
} from '../src/session-minutes.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// mock LRC：只关心 /v1/memories/remember（纪要走它）
// ────────────────────────────────────────────────────────────
interface Remembered {
  content: string;
  event_id?: string;
  source_timestamp_ms?: number;
  tags?: string[];
}
const remembered: Remembered[] = [];
/** 模拟 LRC 侧「每个 event_id 当前入库的那一条」（id + 内容）。 */
const byEvent = new Map<string, { memoryId: string; content: string }>();
/** 每次 remember 返回的新记忆 ID 分配器。 */
let nextId = 1;
/** forget 调用记录（验证「删掉过时重复纪要」）。 */
const forgot: string[] = [];
/** 首轮返回 500 的 id（验证 M-2 的「失败入待办 + 后续重试」）。 */
const failForgetOnce = new Set<string>();
/** 持续返回 500 的 id（验证「待办不会被后续账本重写抹掉」）。 */
const failForgetAlways = new Set<string>();

/**
 * `/v1/context/migrate` 的人为延迟（毫秒）。
 *
 * 第 3 段要靠它复现「T1 的 finishTurn 未完成时 T2 也 turn/end」；
 * 第 16 段要靠它把「turn/end 之后、finishTurn 完成之前」这个收尾窗口
 * 拉得足够宽 —— 默认 120ms 太短，`finishTurn` 会在观察窗口内就归档，
 * 于是「丢轮」的回归被后续的正常写入掩盖，用例永远测不出来（已实测确认）。
 */
let migrateDelayMs = 120;

/**
 * 「库里已有的历史记忆」——用于模拟冷启动探查（第 20 段）。
 *
 * 与 `byEvent` 刻意分开：`byEvent` 代表本进程写入的记录（会随写入变化），
 * 这个数组代表插件启动前就已经在库里的数据（不会自己变）。
 */
const seededMemories: Array<{
  id: string;
  content: string;
  memory_type: string;
  score: number;
  score_norm: number;
  importance: number;
  event_id?: string;
  created_at?: string;
  tags: string[];
}> = [];

/**
 * 字符二元组集合（近似 LRC 的相似度度量，用于 mock 的合并判定）。
 *
 * 只取中文/英文数字字符，去掉空白与标点 —— 与 LRC 侧
 * `find_similar_in_snapshot` 的「去噪后比较」精神一致。
 */
function flatten(text: string): Set<string> {
  const clean = text.replace(/[^\p{L}\p{N}]/gu, '');
  const grams = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) grams.add(clean.slice(i, i + 2));
  return grams;
}

/** Jaccard = |交| / |并|。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

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
    // ## 人为延迟（2026-11-17 三/四/五轮审查 M4、m-b、m4）
    //
    // 第 3 段要复现「T1 的 finishTurn 未完成时 T2 也 turn/end」。
    // 延迟必须加在**真实被调用的端点**上：`/v1/context/distill` 在当前
    // 实现里已无调用点（正文抽取直接走 migrate），加在那里的延迟是死代码。
    //
    // 实际产生延迟的调用链（本测试配置 `foldEnabled: false`）：
    // ```
    // finishTurn → flushTurn(空桶，无 HTTP)
    //            → 推理兜底 offloadFacts({deferToTurn:true})
    //              → foldEnabled=false ⇒ 不走 defer ⇒ 直接 migrate（就是这里）
    // ```
    await new Promise((r) => setTimeout(r, migrateDelayMs));
    const body = JSON.parse(raw) as { items?: unknown[] };
    return send(res, 200, { written: body.items?.length ?? 0, merged: 0, failed: 0 });
  }
  if (url.pathname === '/v1/context/index') {
    return send(res, 200, { index_line: '', count: 0, total: 0, items: [] });
  }
  if (url.pathname === '/v1/memories/stats') return send(res, 200, { total_memories: 0 });
  if (url.pathname === '/v1/memories/remember') {
    const body = JSON.parse(raw) as Remembered & { event_id?: string };
    // ## 模拟 LRC 的真实合并语义
    //
    // LRC **不是**按 `event_id` 覆盖，而是「内容 Jaccard ≥ 0.5 才合并」。
    // 这里按 event_id 维护「已入库的那一条」，只有相似度够高才复用 id：
    // ```
    // 复用 id  ⇒ 覆盖（对应真实 LRC 的 update_content）
    // 新建 id  ⇒ 库里出现两条（第 9 段要验证插件会 forget 掉旧的那条）
    // ```
    //
    // ## `forceNoMerge` 开关
    //
    // 第 9 段要测的是**插件对「LRC 返回了新 id」这个事实的反应**，
    // 而不是 LRC 的相似度阈值本身（那是 LRC 的实现，插件无权也无需验证）。
    // 用内容长度比例去逼近阈值会让用例变得脆弱（模板文本占比高时
    // 相似度总是够高），所以这里允许会话名带 `dup` 时强制不合并 ——
    // 相当于明确声明「本次模拟 LRC 判定为新记忆」。
    const key = body.event_id ?? `nokey-${remembered.length}`;
    const forceNoMerge = key.includes('dup-cleanup');
    // ## 「库里已有的那条」有两种来源（第 21 段）
    //
    // - `byEvent`        —— 本次进程写入的，随写入变化
    // - `seededMemories` —— 进程启动前就在库里的历史数据
    //
    // 只查 `byEvent` 会让预置的库内版本对合并判定不可见 ⇒ Jaccard
    // 恒为「无记录 ⇒ 新建」⇒ **合并路径（覆盖）永远测不到**。
    //
    // 多条同 `event_id` 时取**最后压入**的那条（= 最新那段），
    // 与 `probeExistingMinutes` 的「选最新」口径一致。
    const seeds = seededMemories.filter((m) => (m.event_id ?? '') === key);
    const seed = seeds.length > 0 ? seeds[seeds.length - 1] : undefined;
    const base =
      byEvent.get(key) ??
      (seed === undefined ? undefined : { memoryId: seed.id, content: seed.content });
    const similar =
      !forceNoMerge &&
      (base === undefined || jaccard(flatten(base.content), flatten(body.content)) >= 0.5);
    const memoryId = similar && base !== undefined ? base.memoryId : `mem-${nextId++}`;
    // ## 只有「合并」才写回内容
    //
    // `base` 在 `byEvent` 为空时会退回预置条目 —— 此时若 `similar === false`
    // 仍然是**新建**，预置那条一个字节都不该变。漏了这个条件会让
    // 「库内内容未被缩短」这类断言恒假（已实测踩过）。
    if (similar && seed !== undefined && base !== undefined && base.memoryId === seed.id) {
      seed.content = body.content;
    }
    byEvent.set(key, { memoryId, content: body.content });
    remembered.push(body);
    return send(res, 200, { success: true, memory_id: memoryId });
  }
  if (url.pathname === '/v1/memories/forget') {
    const body = JSON.parse(raw) as { memory_id?: string };
    const id = body.memory_id ?? '';
    // ## 可配置的持续失败（八轮审查 M-4）
    //
    // M-2 的持久化路径（`queueForget` 落盘 → 后续重试成功）只有在
    // forget 会失败时才会执行。恒成功的话那段代码是测试永远走不到的死路。
    // `always` 用于「先观察待办是否被后续账本重写抹掉」，`once` 用于「重试成功」。
    if (failForgetAlways.has(id) || failForgetOnce.has(id)) {
      failForgetOnce.delete(id);
      return send(res, 500, { error: 'transient' });
    }
    forgot.push(id);
    return send(res, 200, { success: true, deleted: true });
  }
  // ## 召回端点（第 20 段要用，模拟 D 方案的冷启动探查）
  //
  // 只需支持 tags 过滤：真实 LRC 的 `enrich` 也是按 tags 精确筛。
  // 预置条目放在 `seededMemories`，与本进程写入的 `byEvent` 分开维护
  // —— 前者代表「库里的历史数据」，后者代表「本次运行的写入」。
  if (url.pathname === '/v1/memories/enrich') {
    const body = JSON.parse(raw) as { tags?: string[] };
    const wantTags = body.tags ?? [];
    const pool = [
      ...seededMemories,
      ...[...byEvent.entries()].map(([eventId, v]) => ({
        id: v.memoryId,
        content: v.content,
        memory_type: 'conversation',
        score: 0.03,
        score_norm: 1,
        importance: 9,
        event_id: eventId,
        created_at: new Date().toISOString(),
        tags: [] as string[],
      })),
    ];
    const matched =
      wantTags.length === 0
        ? pool
        : pool.filter((m) => wantTags.some((t) => m.tags.includes(t)));
    return send(res, 200, { memories: matched, total: matched.length });
  }
  return send(res, 404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-min-int-'));
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
}

class FakeSession {
  readonly id: string;
  readonly header = { cwd: 'G:\\proj' };
  readonly log: FakeEvent[] = [];
  readonly surface = { nodes: [] as number[] };

  constructor(id: string) {
    this.id = id;
  }

  requestHeader(): { config: { provider: string; model: string } } {
    return { config: { provider: 'p', model: 'm' } };
  }

  append(type: string, data: unknown): FakeEvent {
    const seq = this.log.length;
    const event: FakeEvent = { type, seq, time: Date.now(), data, surfaceOp: 'append' };
    this.log.push(event);
    this.surface.nodes.push(seq);
    return event;
  }
}

// ────────────────────────────────────────────────────────────
// 假 ctx
// ────────────────────────────────────────────────────────────
const logs: string[] = [];
const handlers = new Map<string, Array<(a: unknown, b?: unknown) => unknown>>();
/** `ctx.effect(...)` 注册的清理函数（第 14 段要触发 dispose）。 */
const effects: Array<() => void> = [];

const ctx = {
  logger: {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
  },
  get: (name: string) => {
    if (name === 'agentPresets') return { serviceFor: () => undefined };
    if (name === 'sessions') return { create: () => null };
    if (name === 'agents') return { create: async () => ({ agent: {} }) };
    if (name === 'systemPrompt') return { section: () => {}, context: () => ({}) };
    if (name === 'llm') {
      return { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) };
    }
    return undefined;
  },
  // ## 记录清理函数，第 14 段要模拟「用户关窗」（十轮审查 C2）
  //
  // 生产代码用 `ctx.effect(() => () => { ... })` 注册 dispose。
  // 早先这里是空实现，导致 dispose 路径完全无法测试 —— 而那正是
  // 「在飞轮被更短正式稿覆盖」这个 critical 缺陷的触发点。
  effect: (fn: () => () => void) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') effects.push(cleanup as () => void);
    return cleanup;
  },
  on: (event: string, handler: (a: unknown, b?: unknown) => unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
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
  foldEnabled: false,
  foldMinFacts: 4,
  foldMaxChars: 2000,
  // ★ 关键：every=2 让「单轮会话」在常规节奏下不触发，
  // 只能靠空闲定时器写出 —— 这正是 X2 的反向证伪条件。
  // （every=1 时任何一轮都满足节奏，测不出 idle 是否真的兜底）
  minutesEnabled: true,
  minutesEveryTurns: 2,
  // ## 空闲触发必须**慢于**第 11 段的观察窗口（本次实测的教训）
  //
  // 空闲定时器走的是 `force` 路径，它会无条件写出一份正式稿 —— 于是
  // 「阶段稿把正式稿锁死」这个回归**永远测不出来**：回退修复后，
  // 空闲兜底仍会在 120ms 后写出正式稿，断言照样 PASS（已实测确认）。
  // 设成 2000ms 后，第 11 段只在 1200ms 内观察，空闲来不及介入；
  // 去掉放行分支则会超时变红。
  minutesIdleMs: 2000,
  // 阶段写入间隔：只在第 11 段显式驱动 `agent/pre-step` 时才会用到，
  // 其它段落从不调用该 handler，因此这里取小值不污染既有断言。
  minutesStageMs: 60,
  pruneEnabled: false,
  pruneResultEnabled: false,
  pruneArgsEnabled: false,
  pruneReasoningEnabled: false,
  keepRecentNodes: 8,
  trimEnabled: false,
  contextWindowTokens: 0,
  trimRatio: 0.1,
  pruneRatio: 0.004,
  trimMinTokens: 30000,
  trimMinSteps: 10,
  trimMaxNodes: 120,
  trimMaxNodesPerRun: 40,
  trimMaxSummaryChars: 4000,
  reconnectBaseMs: 2000,
  reconnectMaxMs: 60000,
  capabilityRecheckSteps: 20,
  budgetRecheckSteps: 20,
  recallInjectEnabled: false,
  recallInjectMaxItems: 2,
  recallInjectMinScore: 0.85,
  recallInjectMinRawScore: 0.025,
  recallInjectMaxCharsPerItem: 80,
  llmExtractEnabled: false,
  llmExtractMaxCalls: 200,
  llmExtractGlobalMaxCalls: 500,
  llmExtractMinIntervalMs: 5000,
  llmExtractMinChars: 120,
  llmExtractMaxInputChars: 6000,
  artifactEnabled: true,
  artifactMinChars: 8000,
  artifactQuotaMb: 200,
};

const minutesDir = join(workDir, 'cache', 'lrc-plugin', 'minutes');

/**
 * 读某个会话的账本文件（不存在返回 null）。
 *
 * 类型直接用 `MinutesLedgerState`（生产类型）而不是手写子集 ——
 * 手写子集会在账本加字段时静默落后（本文件就曾因缺 `reason`/`memoryId`
 * 报错，才发现两边漂移）。
 */
function readLedger(sessionId: string): MinutesLedgerState | null {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(minutesDir, `minutes-${safe}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as MinutesLedgerState;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

try {
  apply(ctx as never, config as never);

  const ready = await waitFor(() => logs.some((l) => l.includes('记忆沉淀已就绪')), 4000);
  check('插件初始化并连上 mock LRC', ready, logs.slice(0, 6));

  const onSessionEvent = handlers.get('session/event')?.[0] as
    | ((session: unknown, event: unknown) => unknown)
    | undefined;
  check('session/event 已注册', typeof onSessionEvent === 'function');

  /** 驱动一轮：turn/start → user/message → turn/end（不等待异步收尾）。 */
  function driveTurn(
    session: FakeSession,
    idx: number,
    userText: string,
    assistantText: string,
  ): void {
    const start = session.append('turn/start', { turn: idx });
    onSessionEvent?.(session, start);

    const user = session.append('user/message', {
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    });
    onSessionEvent?.(session, user);

    const assistant = session.append('assistant/message', {
      message: { content: [{ type: 'text', text: assistantText }] },
    });
    onSessionEvent?.(session, assistant);

    const end = session.append('turn/end', { reason: { kind: 'completed' } });
    onSessionEvent?.(session, end);
  }

  // ── 1) X2：空闲触发不被「满 N 轮」挡死 ──
  //
  // ## 为什么需要**两轮**（首轮门槛改为 1 之后）
  //
  // 五轮 M1 把首次门槛降成 1 轮，于是首轮 turn/end 就会写一次。
  // 要让空闲定时器成为**唯一**的触发来源，必须构造：
  // ```
  // 第 1 轮 → turn/end 写一次（writtenAtArchived = 1）
  // 第 2 轮 → turn/end 时增量 = 1 < every(2) ⇒ 被拦
  //        ⇒ 只剩空闲定时器能在 120ms 后写出 2 轮版本
  // ```
  // 回退 `force` 后本段变红（已验证）。
  console.log('\n=== 1) X2：空闲触发不被「满 N 轮」挡死 ===');
  {
    remembered.length = 0;
    const session = new FakeSession('session-idle-short');
    // 第 1 轮：首轮门槛触发写入
    driveTurn(
      session,
      1,
      '所有图标要用 SVG 绘制，不要用文字',
      '结论：图标改用像素点阵绘制，因为 SVG 路径在 16px 下会糊。',
    );
    const firstWrote = await waitFor(() => remembered.length > 0, 3000);
    check('第 1 轮（首轮门槛）写入了纪要', firstWrote, {
      remembered: remembered.length,
      logs: logs.slice(-8),
    });
    // 第 2 轮：增量不足 every ⇒ 只有空闲定时器能写出 2 轮版本
    driveTurn(
      session,
      2,
      '再加一个呼吸动效',
      '结论：呼吸动效要逐帧做，因为 CSS 补间会让像素画糊。',
    );
    const secondWrote = await waitFor(
      () =>
        remembered.some(
          (r) =>
            r.event_id === 'session-minutes:session-idle-short' && r.content.includes('2 轮'),
        ),
      // 必须明显长于 `minutesIdleMs`(2000)，否则测不出空闲兜底
      4000,
    );
    check('第 2 轮靠空闲定时器写出（不被「满 N 轮」挡死）', secondWrote, {
      contents: remembered.map((r) => r.content.slice(0, 60)),
      tailLogs: logs.slice(-8),
    });
    const wrote = firstWrote;
    if (wrote) {
      const body = remembered[remembered.length - 1] as Remembered;
      check(
        'event_id 是会话级',
        body.event_id === 'session-minutes:session-idle-short',
        body.event_id,
      );
      check('带真实发生时间（source_timestamp_ms）', typeof body.source_timestamp_ms === 'number', body.source_timestamp_ms);
      check('带 session-minutes 标签', (body.tags ?? []).includes('session-minutes'), body.tags);
    }
    // ## 反向断言：正常合并路径不得触发 forget（七轮审查 m-3）
    //
    // 本会话两轮内容只有一个字的差异级变化（诉求演进只多一行），
    // mock 的 Jaccard 判定会复用同一 id ⇒ 插件不该调用 forget。
    // 没有这条断言，一个「无条件 forget」的回归会让所有会话的纪要
    // 在写入后被立刻删掉，而第 9 段仍然通过（它只看「有没有 forget」）。
    check('正常合并路径不触发 forget（防误删）', forgot.length === 0, forgot);
  }

  // ── 2) M6：endedAt 必须取最后一次活动，不是归档时刻 ──
  console.log('\n=== 2) M6：endedAt 取最后一次活动 ===');
  {
    const session = new FakeSession('session-ended-at');
    const before = Date.now();
    driveTurn(session, 1, '第一轮的需求描述内容', '结论：接口应当幂等，因为重放会重复写入。');
    // ## 不能睡固定时长（三段审查 M4）
    //
    // 归档发生在 `finishTurn().finally()`，其耗时取决于 mock 的 distill 延迟
    // （当前 120ms）与 migrate 往返。固定 sleep 在慢机器上会读到未归档的账本
    // ⇒ 假失败。改为轮询「账本里出现该轮」。
    const archived = await waitFor(() => {
      const l = readLedger('session-ended-at');
      return l !== null && l.turns.length >= 1;
    }, 5000);
    const after = Date.now();
    check('轮次已归档（轮询而非固定等待）', archived, readLedger('session-ended-at')?.turns.length);
    const ledger = readLedger('session-ended-at');
    check('账本已落盘', ledger !== null, ledger);
    if (ledger !== null) {
      const t = ledger.turns[0];
      if (t !== undefined) {
        // endedAt 必须落在本次驱动的真实时间窗内（而不是下一秒/下一轮）
        check(
          'endedAt 落在本轮真实时间窗内',
          t.endedAt >= before && t.endedAt <= after + 500,
          { endedAt: t.endedAt, before, after },
        );
        check('endedAt 不早于 startedAt', t.endedAt >= t.startedAt, t);
      }
    }
  }

  // ── 3) X3：两轮并发收尾时结论不串轮 ──
  //
  // ## 必须用「纯推理轮次」（2026-11-17 二轮审查 M-b 的教训）
  //
  // 正文抽取的结论收集是**同步**的（在 assistant/message 事件里直接完成），
  // 那时 `liveTurn` 还在，所以正文路径根本不会走模糊查找 —— 用它测 X3
  // 永远通过（回退修复也通过）。
  //
  // X3 的真实触发条件：结论来自 `finishTurn` 内部的**推理兜底**，它要
  // `await offloader.offloadFacts`（一次 HTTP）之后才收集。此时：
  // ```
  // T1.turn/end → T1 进 finishingTurns，T1.finishTurn 开始（await 中）
  // T2.turn/end → T2 也进 finishingTurns ⇒ [T1, T2]
  // T1 推理兜底 resolve → liveTurn 已 undefined → 模糊查找命中 T2 ❌
  // ```
  // 所以这里用「只有 reasoning、没有正文」的 assistant 消息。
  console.log('\n=== 3) X3：并发收尾时结论不串轮 ===');
  {
    const session = new FakeSession('session-two-turns');

    /** 一轮纯推理（无正文块）：结论只能由轮末推理兜底抽出。 */
    function driveReasoningTurn(idx: number, userText: string, reasoning: string): void {
      onSessionEvent?.(session, session.append('turn/start', { turn: idx }));
      onSessionEvent?.(session, session.append('user/message', {
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }));
      onSessionEvent?.(session, session.append('assistant/message', {
        message: { content: [{ type: 'reasoning', text: reasoning }] },
      }));
    }

    driveReasoningTurn(1, '第一轮要加缓存层', '结论：缓存键必须用 hash，因为路径会变。');
    onSessionEvent?.(session, session.append('turn/end', { reason: { kind: 'completed' } }));
    // 不等 T1 的 finishTurn 跑完，立刻进 T2 —— 制造 finishingTurns 双槽
    driveReasoningTurn(2, '第二轮要加限流', '结论：限流必须用令牌桶，因为要允许突发。');
    onSessionEvent?.(session, session.append('turn/end', { reason: { kind: 'completed' } }));

    const ok = await waitFor(() => {
      const l = readLedger('session-two-turns');
      return l !== null && l.turns.length >= 2;
    }, 5000);
    const ledger = readLedger('session-two-turns');
    check('两轮都已归档', ok, ledger?.turns.length);
    if (ledger !== null && ledger.turns.length >= 2) {
      const t1 = ledger.turns.find((t) => t.idx === 1);
      const t2 = ledger.turns.find((t) => t.idx === 2);
      check('第 1 轮存在', t1 !== undefined, ledger.turns.map((t) => t.idx));
      check('第 2 轮存在', t2 !== undefined, ledger.turns.map((t) => t.idx));
      const t1HasCache = (t1?.conclusions ?? []).some((c) => c.includes('缓存键'));
      const t2HasRate = (t2?.conclusions ?? []).some((c) => c.includes('令牌桶'));
      check('第 1 轮的结论落在第 1 轮', t1HasCache, t1?.conclusions);
      check('第 2 轮的结论落在第 2 轮', t2HasRate, t2?.conclusions);
      // 反向证伪：T1 不应拿到 T2 的结论（回退 X3 修复后这一条会红）
      const t1HasT2 = (t1?.conclusions ?? []).some((c) => c.includes('令牌桶'));
      check('第 1 轮没有混入第 2 轮的结论', !t1HasT2, t1?.conclusions);
    }
  }

  // ── 4) X1：账本恢复后 writtenTurns 不会把闸门锁死 ──
  //
  // 旧实现在 persistMinutes 里把 `turnLedger + backlog` 合并后不裁剪，
  // `writtenTurns` 记成 2 倍，此后 `canOverwriteMinutes(80, ≤40)` 恒假。
  // 这里用「A → B → A」制造 backlog，再写 A，验证 A 仍能继续写。
  console.log('\n=== 4) X1：合并后裁剪，闸门不锁死 ===');
  {
    remembered.length = 0;
    // 预置一个含 40 轮的 A 账本 + writtenTurns=40（模拟已达上限的会话）
    const sessionA = new FakeSession('session-big-a');
    // 直接写账本文件（模拟「上次进程留下的完整账本」）
    mkdirSync(minutesDir, { recursive: true });
    const t0 = Date.now() - 3_600_000;
    const turns = Array.from({ length: 40 }, (_, i) => ({
      idx: i + 1,
      startedAt: t0 + i * 60_000,
      endedAt: t0 + i * 60_000 + 30_000,
      reason: 'completed',
      userText: `第 ${i + 1} 轮诉求`,
      conclusions: [`第 ${i + 1} 轮结论，因为要验证合并裁剪`],
    }));
    writeFileSync(
      join(minutesDir, 'minutes-session-big-a.json'),
      JSON.stringify({
        sessionId: 'session-big-a',
        turns,
        archivedTurns: 40,
        writtenAtArchived: 40,
        startedAt: t0,
        writtenTurns: 40,
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    // 切到 A（触发恢复），再切走（触发落盘 + 可能产生 backlog），再切回 A
    onSessionEvent?.(sessionA, sessionA.append('turn/start', { turn: 41 }));
    onSessionEvent?.(sessionA, sessionA.append('user/message', {
      content: [{ type: 'text', text: '第 41 轮：继续推进' }],
      source: { kind: 'user' },
    }));
    onSessionEvent?.(sessionA, sessionA.append('assistant/message', {
      message: { content: [{ type: 'text', text: '结论：第 41 轮确定了新的存储布局，因为旧布局不支持并发。' }] },
    }));

    const sessionB = new FakeSession('session-switch-b');
    onSessionEvent?.(sessionB, sessionB.append('turn/start', { turn: 1 }));
    onSessionEvent?.(sessionB, sessionB.append('user/message', {
      content: [{ type: 'text', text: '另一个会话的需求' }],
      source: { kind: 'user' },
    }));

    // 切回 A 并结束第 41 轮。
    //
    // 写入的触发点是「切走 A 时的单调补写」（`shouldRewriteMinutes`），
    // 而不是 turn/end 的节奏闸门（`minutesEveryTurns = 2`，单轮增量不够）。
    // 这正是 X1 想锁的行为：账本饱和后仍必须能补写。
    onSessionEvent?.(sessionA, sessionA.append('turn/end', { reason: { kind: 'completed' } }));
    const ok = await waitFor(() => {
      const l = readLedger('session-big-a');
      return l !== null && l.turns.some((t) => t.idx === 41);
    }, 4000);
    const ledger = readLedger('session-big-a');
    check('A 的第 41 轮已归档', ok, ledger?.turns.length);
    if (ledger !== null) {
      check('账本仍被裁剪在 40 轮', ledger.turns.length <= 40, ledger.turns.length);
      check(
        'writtenTurns 不超过账本长度（闸门不会自锁）',
        ledger.writtenTurns <= ledger.turns.length,
        { writtenTurns: ledger.writtenTurns, len: ledger.turns.length },
      );
    }
    // 纪要写入是异步链（persistLedger → HTTP），必须等它跑完再断言
    const wroteA = await waitFor(
      () =>
        remembered.some(
          (r) => r.event_id === 'session-minutes:session-big-a' && r.content.includes('第 41 轮'),
        ),
      4000,
    );
    check('A 恢复后仍能写入新纪要（闸门未锁死）', wroteA, {
      events: remembered.map((r) => r.event_id),
      contents: remembered.map((r) => r.content.slice(0, 90)),
      tailLogs: logs.slice(-14),
    });
  }

  // ── 5) C2：恢复出「有增量但没写进库」的账本必须被补写 ──
  //
  // ## 为什么单独测这一段（三段审查 C2）
  //
  // 反例路径：A 写成功后切到 B；B 期间 A 没新轮次 ⇒ A 的账本只在磁盘上。
  // 之后切回 A 会恢复出 `archivedTurns > writtenAtArchived`。
  // 修复前既不补写也不入 backlog —— 用户这时关窗口，A 的增量永久丢失。
  //
  // 这里直接构造这种磁盘状态，再触发一次切回，断言「补写真的发生了」。
  console.log('\n=== 5) C2：恢复出未写入的账本会被补写 ===');
  {
    const sessionId = 'session-resume-pending';
    const t0 = Date.now() - 600_000;
    const turns = [
      { idx: 1, startedAt: t0, endedAt: t0 + 30_000, reason: 'completed', userText: '第一轮诉求', conclusions: [`第一轮结论，因为要验证恢复补写`] },
      { idx: 2, startedAt: t0 + 60_000, endedAt: t0 + 90_000, reason: 'completed', userText: '第二轮诉求', conclusions: [`第二轮结论，因为要验证恢复补写`] },
    ];
    // archivedTurns=5 > writtenAtArchived=3 ⇒ 有 2 轮增量没写进库
    writeFileSync(
      join(minutesDir, `minutes-${sessionId}.json`),
      JSON.stringify({
        sessionId,
        turns,
        archivedTurns: 5,
        writtenAtArchived: 3,
        startedAt: t0,
        writtenTurns: 2,
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    const before = remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length;
    const resumed = new FakeSession(sessionId);
    // 触发切会话（bindSnapshotToSession 只在 sessionId 变化时执行）
    onSessionEvent?.(resumed, resumed.append('turn/start', { turn: 3 }));

    const filled = await waitFor(
      () => remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length > before,
      4000,
    );
    check('恢复出未写入的账本后被补写进 LRC', filled, {
      events: remembered.map((r) => r.event_id),
      tailLogs: logs.slice(-8),
    });
  }

  // ── 6) M-a：切会话时在飞轮次**不得被二次归档** ──
  //
  // ## 上一版这里是错的（四轮审查 M-a）
  //
  // `bindSnapshotToSession` 里曾写 `for (slot of finishingTurns) archiveTurn(slot,'switched')`，
  // 而 `finishTurn().finally()` 还会 `archiveTurn(finished, 真实reason)`。
  // 症状：同一轮在账本里出现两次（轮数虚增）、reason 被 'switched' 占位。
  //
  // 这里构造真实时序：T1 turn/end 后**立刻切到另一个会话**，
  // 等 T1 的 finishTurn 跑完，断言账本里 idx=1 只出现一次。
  console.log('\n=== 6) M-a：在飞轮次不被二次归档 ===');
  {
    const sessionId = 'session-double-archive';
    const s = new FakeSession(sessionId);
    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    onSessionEvent?.(s, s.append('user/message', {
      content: [{ type: 'text', text: '这一轮会被切走' }],
      source: { kind: 'user' },
    }));
    onSessionEvent?.(s, s.append('assistant/message', {
      message: { content: [{ type: 'reasoning', text: '结论：切走前要保证只归档一次，因为重复会让轮数虚增。' }] },
    }));
    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    // 不等 finishTurn 完成，立刻切会话
    const other = new FakeSession('session-interrupt-other');
    onSessionEvent?.(other, other.append('turn/start', { turn: 1 }));

    const settled = await waitFor(() => {
      const l = readLedger(sessionId);
      return l !== null && l.turns.length >= 1;
    }, 5000);
    // 再等一会儿，让迟到的 finally 也有机会执行
    await new Promise((r) => setTimeout(r, 300));
    const ledger = readLedger(sessionId);
    check('在飞轮次已归档', settled, ledger?.turns.length);
    if (ledger !== null) {
      const sameIdx = ledger.turns.filter((t) => t.idx === 1);
      check('同一轮只归档一次（无重复 idx）', sameIdx.length === 1, {
        count: sameIdx.length,
        reasons: sameIdx.map((t) => t.reason),
      });
      check(
        'reason 保留真实值而非 switched',
        sameIdx[0]?.reason === 'completed',
        sameIdx.map((t) => t.reason),
      );
    }
  }

  // ── 7) M1：首轮即写入（短会话关窗前也能落库） ──
  //
  // 反例（五轮审查 M1）：实测每会话 p50 仅 2 轮。
  // 若首次门槛是 `minutesEveryTurns`（默认 5），用户聊 2 轮就关窗：
  // turn/end 被拦、空闲定时器未到期、dispose 清掉定时器
  // ⇒ 这份对话没有任何纪要。
  //
  // ## 判据必须看**触发原因**，不能只看「有没有写入」
  //
  // 测试配置 `minutesIdleMs: 120`，空闲定时器最终也会写出纪要 ——
  // 所以「最终写入了」这件事在修复前后都成立，无法区分。
  // 真正的差异在日志的触发来源：`（触发：turn/end）` = 首轮门槛已放宽；
  // `（触发：idle）` = 只是空闲兜底在起作用（旧行为）。
  console.log('\n=== 7) M1：首轮即写入 ===');
  {
    remembered.length = 0;
    const logStart = logs.length;
    const sessionId = 'session-first-turn-only';
    const s = new FakeSession(sessionId);
    driveTurn(
      s,
      1,
      '只有这一轮，然后我就关窗口了',
      '结论：首轮也必须落一条纪要，因为短会话占多数。',
    );
    const wrote = await waitFor(
      () =>
        remembered.some((r) => r.event_id === `session-minutes:${sessionId}`) &&
        // ## 日志也要一起等（本次实测的竞态）
        //
        // `remembered.push` 发生在 mock server 侧，而「会话纪要已更新」这条
        // 日志由插件在 HTTP 返回**之后**才写。只等前者会让 `fresh` 里
        // 还没有那一行 ⇒ 断言随机变红（本轮实测就红了一次）。
        logs.slice(logStart).some((l) => l.includes('会话纪要已更新（触发：turn/end）')),
      3000,
    );
    check('单轮会话写出了纪要', wrote, {
      events: remembered.map((r) => r.event_id),
      tailLogs: logs.slice(-6),
    });
    // 关键断言：这次写入由 turn/end 触发，而不是 idle 兜底。
    // **只看本段新增的日志**：`logs` 是跨段累积的，用 `some` 会命中
    // 前面用例（同样是 1 轮 + turn/end），断言就形同虚设。
    const fresh = logs.slice(logStart);
    const byTurnEnd = fresh.some((l) => l.includes('会话纪要已更新（触发：turn/end）'));
    check('写入由 turn/end 触发（首轮门槛已放宽到 1 轮）', byTurnEnd, fresh.slice(-8));
    // 「只有 1 轮」这件事在正文里验，比在日志文案里抠字可靠
    const body = remembered.find((r) => r.event_id === `session-minutes:${sessionId}`);
    check('这一稿只含 1 轮（未虚增）', (body?.content ?? '').includes('1 轮'), {
      head: body?.content?.slice(0, 120),
    });
  }

  // ── 8) M2：prune 不淘汰「还有未补写增量」的账本 ──
  //
  // 反例（五轮审查 M2）：只按 mtime 淘汰会删掉那个「还有 2 轮没写进 LRC」
  // 的老会话账本 ⇒ 用户回来时 load 为 null ⇒ 闸门放行首轮稿
  // ⇒ 同一 event_id 因 Jaccard 低而新增第二条，原多轮纪要失去更新入口。
  console.log('\n=== 8) M2：prune 保护待补写账本 ===');
  {
    const dir = join(workDir, 'minutes-prune');
    const store = new MinutesLedgerStore(dir);
    const { utimesSync } = await import('node:fs');
    const now = Date.now();
    const mk = (id: string, writtenAtArchived: number, archivedTurns: number, ageMs: number): void => {
      store.save({
        sessionId: id,
        turns: [
          {
            idx: 1,
            startedAt: now - ageMs,
            endedAt: now - ageMs + 1000,
            reason: 'completed',
            userText: '诉求',
            conclusions: ['结论，因为要验证 prune 保护'],
          },
        ],
        archivedTurns,
        writtenAtArchived,
        startedAt: now - ageMs,
        writtenTurns: 1,
        memoryId: `mem-${id}`,
        updatedAt: 0,
      });
      // ## mtime 必须显式设置
      //
      // `save` 是同步写，四个文件的 mtime 会落在同一毫秒级 ——
      // 排序退化为「顺序随机」，用例就测不出「按 mtime 淘汰」的行为。
      // 用 `utimes` 把 age 真实写进文件时间戳。
      const path = join(dir, `minutes-${id}.json`);
      const t = (now - ageMs) / 1000;
      utimesSync(path, t, t);
    };
    // 3 个**已写完**的较新文件 + 1 个**还有增量**的最旧文件。
    //
    // ## 年龄必须让 pending 落在淘汰区（否则用例测不出问题）
    //
    // `prune(maxFiles)` 保留排序后的前 maxFiles 个、删除其余。
    // 纯 mtime 排序（新→旧）时 pending-oldest 排第 4，`prune(2)` 删的正是
    // 第 3、4 个 —— 它会被删掉。修复后 pending 被提前到第 1 位，幸存。
    mk('prune-done-1', 3, 3, 1_000);
    mk('prune-done-2', 3, 3, 2_000);
    mk('prune-done-3', 3, 3, 3_000);
    mk('prune-pending-oldest', 1, 5, 999_000); // 最旧，但 writtenAt(1) < archived(5)

    store.prune(2);

    check(
      '还有未补写增量的账本未被淘汰',
      existsSync(join(dir, 'minutes-prune-pending-oldest.json')),
      readdirSync(dir),
    );
    // 反向：已写完的旧文件确实被清掉（否则 prune 形同虚设）
    const remaining = readdirSync(dir);
    check('prune 确实淘汰了部分已写完的旧文件', remaining.length < 4, remaining);
  }

  // ── 9) M-A + M-2：重复纪要清理，且失败会入待办并重试 ──
  //
  // ## 反例（六轮 M-A + 七/八轮 M-2、M-3）
  //
  // LRC 不是按 event_id 覆盖，是「Jaccard ≥ 0.5 才合并」。
  // 首轮纪要约 1 行诉求，第 3 轮纪要多行 —— 相似度可能只有 0.35 ⇒ 不合并
  // ⇒ 库里出现两条同 event_id 的纪要，其中一条永远是「1 轮」的过时版本，
  // 且 importance=9 会被召回。
  //
  // 修法是记下 `memoryId` 并在 id 变化时 `forget(旧 id)`。但：
  // - 若 forget 失败只写空 catch，旧 id 就永久失联（M-2）
  // - 若账本落盘时漏带 `pendingForget`，待办被 `save()` 全量覆盖抹掉（M-3）
  //
  // 本段用 mock 的「首轮 500」开关把这条完整路径走一遍。
  console.log('\n=== 9) M-A + M-2：重复纪要清理与失败重试 ===');
  {
    remembered.length = 0;
    forgot.length = 0;
    const sessionId = 'session-dup-cleanup';
    const ledgerPath = join(minutesDir, `minutes-${sessionId}.json`);
    const s = new FakeSession(sessionId);

    // 第 1 轮：写入一份很短的首轮纪要
    driveTurn(s, 1, '第一轮诉求：做一个登录页', '结论：登录页用邮箱加密码，因为手机号还没接入。');
    await waitFor(
      () => remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length >= 1,
      3000,
    );
    check(
      '首轮写入成功（建立了旧 memory_id）',
      remembered.some((r) => r.event_id === `session-minutes:${sessionId}`),
      remembered.map((r) => r.event_id),
    );

    // 让下一次 forget 的「目标旧 id」**持续**失败：
    // 这样待办不会被「重试成功」提前清掉，能真实观察「后续账本重写是否抹掉它」。
    const firstId = byEvent.get(`session-minutes:${sessionId}`)?.memoryId ?? '';
    failForgetAlways.add(firstId);
    check('已预设旧 id 的 forget 持续失败', failForgetAlways.has(firstId), firstId);

    // 后续几轮大量新增内容（mock 对 dup-cleanup 强制返回新 id）
    driveTurn(s, 2, '第二轮：加注册和找回密码', '结论：注册走邀请码，因为要控制内测规模。');
    driveTurn(s, 3, '第三轮：加二次验证与风控', '结论：二次验证用 TOTP，因为短信成本高。');

    // ① 失败后待办必须**落盘**，且要能扛住后续的账本重写（M-3）
    //
    // ## 为什么不能只 `waitFor(出现过)`
    //
    // `queueForget` 会立刻把 id 写进磁盘，所以「出现过」几乎瞬间成立。
    // 但 M-3 的缺陷是**后续**的 `saveCurrentLedger()`（每轮归档都调一次）
    // 用 `{...state}` 全量覆盖整个文件，把待删列表抹掉。
    // 因此必须「等到再来一轮归档之后」再看磁盘是否仍在 —— 否则用例
    // 永远在缺陷生效前的那个瞬间通过。
    await new Promise((r) => setTimeout(r, 600));
    const readPending = (): string[] => {
      if (!existsSync(ledgerPath)) return [];
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as MinutesLedgerState;
      return parsed.pendingForget ?? [];
    };
    check(
      'forget 失败后旧 id 落盘进 pendingForget（多轮归档后仍未被抹掉）',
      readPending().includes(firstId),
      { pending: readPending(), firstId, tailLogs: logs.slice(-10) },
    );

    // ② 解除失败注入后，下一次写入前的重试必须成功
    //    （`retryPendingForget` 已提到闸门之前，所以即使本稿被闸门拦住也会重试）
    failForgetAlways.delete(firstId);
    driveTurn(s, 4, '第四轮：加审计日志与会话列表', '结论：审计日志保留 90 天，因为合规要求。');
    const retried = await waitFor(() => forgot.includes(firstId), 5000);
    check('待办在后续写入时被重试并成功删除', retried, {
      forgot,
      firstId,
      tailLogs: logs.slice(-10),
    });

    // ③ 成功后待办必须清空，否则每次写入都白重试一次
    const cleared = await waitFor(() => {
      const l = existsSync(ledgerPath)
        ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as MinutesLedgerState)
        : null;
      return !(l?.pendingForget ?? []).includes(firstId);
    }, 3000);
    check('删除成功后待办被清除', cleared, {
      ledger: existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null,
    });
  }

  // ── 10) 账本目录可观测 ──
  console.log('\n=== 10) 账本落盘可观测 ===');
  {
    check('minutes 目录已创建', existsSync(minutesDir), minutesDir);
    const files = existsSync(minutesDir) ? readdirSync(minutesDir) : [];
    check('至少一个会话账本文件', files.some((f) => f.endsWith('.json')), files);
  }
  // ── 11) 轮内阶段纪要：长任务不结束时也要有可回溯的中间态 ──
  //
  // ## 实测缺口（2026-11-17 DSH 真实环境）
  //
  // 一轮工具密集型任务跑了 **30 分钟 / 72 步**仍未收到 `turn/end`。
  // 纪要原本的触发点全部在轮末 ⇒ 整轮没有任何可回溯状态；
  // 此时崩溃或关窗，这轮（往往是最花时间的那轮）永久丢失。
  //
  // ## 本段验证三件事
  //
  // 1. 轮未结束时 `agent/pre-step` 能把「进行中的这一轮」写进库
  // 2. 阶段稿写完后，该轮 `turn/end` 仍能触发一份正式稿（不被节流拦死）
  // 3. 账本正确记录 `stageWrittenTurnIdx`，且不虚报已完成轮数
  console.log('\n=== 11) 轮内阶段纪要 ===');
  {
    const sessionId = 'session-stage-minutes';
    remembered.length = 0;
    const logStart = logs.length;
    const s = new FakeSession(sessionId);
    const preStep = handlers.get('agent/pre-step')?.[0] as
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    check('agent/pre-step 已注册', typeof preStep === 'function');

    // 只开轮、**不关轮**：模拟「跑了很久还没 turn/end」
    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '这一轮要做完整套视觉重构，可能很久' }],
        source: { kind: 'user' },
      }),
    );
    onSessionEvent?.(
      s,
      s.append('assistant/message', {
        message: {
          content: [{ type: 'text', text: '结论：兽的呼吸读不出来，因为整只兽一起平移了。' }],
        },
      }),
    );

    // 等到「本轮已持续超过 minutesStageMs(60ms)」
    await new Promise((r) => setTimeout(r, 90));
    await preStep?.({ agent: { session: s } }, async () => null);

    const stageWrote = await waitFor(
      () => remembered.some((r) => r.event_id === `session-minutes:${sessionId}`),
      3000,
    );
    check('轮未结束时写出了阶段稿（长任务不再无纪要）', stageWrote, {
      events: remembered.map((r) => r.event_id),
      tailLogs: logs.slice(-10),
    });
    const stageBody = remembered.find((r) => r.event_id === `session-minutes:${sessionId}`);
    check(
      '阶段稿标出该轮尚未收尾（in-progress）',
      (stageBody?.content ?? '').includes('in-progress'),
      stageBody?.content?.slice(0, 200),
    );
    check(
      '阶段稿日志标明触发来源是轮内阶段',
      logs.slice(logStart).some((l) => l.includes('会话纪要已更新（触发：轮内阶段）')),
      logs.slice(logStart).slice(-6),
    );

    // ## 关键：阶段稿留下「本轮已抢跑」的标记，且正式稿不能被节流死
    //
    // `writtenAtArchived` 照常推进（口径是**已完成**轮次，阶段稿确实
    // 已把截至上一轮的内容写进库，不会虚报）。真正会锁死的是：本轮结束后
    // `archivedTurns` 只 +1，按「满 N 轮(every=2)」判不满足 ⇒ 正式稿被拦。
    // 所以断言落在「archivedTurns 未被阶段稿虚增」上。
    const afterStage = await waitFor(() => {
      const l = readLedger(sessionId);
      return l !== null && (l.stageWrittenTurnIdx ?? 0) > 0;
    }, 3000);
    check('账本记录了阶段稿进度（stageWrittenTurnIdx）', afterStage, readLedger(sessionId));
    const staged = readLedger(sessionId);
    check(
      '阶段稿进度只记在 stageWrittenTurnIdx（未虚报已完成轮数）',
      staged === null || staged.archivedTurns === 0,
      { archivedTurns: staged?.archivedTurns, stageWrittenTurnIdx: staged?.stageWrittenTurnIdx },
    );

    // 现在真正收尾 —— 正式稿必须仍然写得出去
    //
    // ## 判据必须落在**内容**上，不能看日志（本次实测的教训）
    //
    // 上一版用 `logs.slice(logStart).some(l => l.includes('触发：turn/end'))`
    // 判定 —— 回退修复后仍然 PASS。原因是前几段留下的 `void` 异步写链
    // 会在这期间落地，把 `触发：turn/end` 写进本段的日志窗口。
    // 改用「库里出现了一条**不含 in-progress** 的本会话纪要」：
    // 阶段稿必然含 in-progress，正式稿不含，两者可精确区分。
    const beforeFinal = remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length;
    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    const finalWrote = await waitFor(
      () =>
        remembered
          .filter((r) => r.event_id === `session-minutes:${sessionId}`)
          .slice(beforeFinal)
          .some((r) => !r.content.includes('in-progress')),
      1200,
    );
    check('该轮 turn/end 后正式稿仍被写入（未被阶段稿自锁）', finalWrote, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.split('\n')[1]),
    });
  }

  // ── 12) 阶段稿的收尾判据不能依赖「归档轮数 ≥ 轮序号」 ──
  //
  // ## 反例（本次实现时发现的真实缺陷）
  //
  // `TurnSlot.idx` 取自宿主给的 `data.turn`（真实轮号），而 `archivedTurns`
  // 只统计**有内容的**轮次。两者会分叉：
  // ```
  // 宿主轮号 9（前面 8 轮全是纯工具调用，没进账本）
  // 阶段稿 ⇒ stageWrittenTurnIdx = 9
  // turn/end ⇒ archivedTurns = 1
  // 判据 `archivedTurns >= stageWrittenTurnIdx` ⇒ 1 >= 9 恒假
  // ⇒ 阶段稿永远收不了尾，库里长期挂着 in-progress ❌
  // ```
  // 正确判据：该轮**已不是在飞的那一轮**（`liveTurn` 已清空/换人）即需收尾。
  console.log('\n=== 12) 阶段稿收尾判据不依赖归档轮数 ===');
  {
    const sessionId = 'session-stage-high-idx';
    remembered.length = 0;
    const s = new FakeSession(sessionId);
    const preStep = handlers.get('agent/pre-step')?.[0] as
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;

    // ## 必须先让该会话「已经写过一次」（否则测不出判据差异）
    //
    // 首次写入门槛（`writtenAtArchived < 0` ⇒ 有 1 轮就写）会无条件放行，
    // 于是无论判据怎么写正式稿都会写出去 —— 反向证伪时用例照样 PASS
    // （已实测确认）。先跑一轮把 `writtenAtArchived` 建起来，
    // 后续才真正受「满 N 轮(every=2)」节流约束。
    driveTurn(s, 1, '第一轮：先建立一次写入基线', '结论：先写一次基线，因为要验证后续的节流。');
    await waitFor(() => (readLedger(sessionId)?.writtenAtArchived ?? -1) >= 0, 4000);
    check(
      '基线会话已写过一次（writtenAtArchived 已建立）',
      (readLedger(sessionId)?.writtenAtArchived ?? -1) >= 0,
      readLedger(sessionId),
    );

    // 宿主轮号刻意远大于归档轮数（真实会话里很常见：前几轮无正文）
    onSessionEvent?.(s, s.append('turn/start', { turn: 9 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '第九轮：这是一次很长的重构任务' }],
        source: { kind: 'user' },
      }),
    );
    await new Promise((r) => setTimeout(r, 90));
    await preStep?.({ agent: { session: s } }, async () => null);
    const staged = await waitFor(() => readLedger(sessionId)?.stageWrittenTurnIdx === 9, 3000);
    check('高轮号的阶段稿已写出（stageWrittenTurnIdx=9）', staged, readLedger(sessionId));

    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    // ## 必须只看**本次新增**的记录，且窗口短于 `minutesIdleMs`(2000)
    //
    // 两条都踩过坑：
    // 1. 用 `.some(!in-progress)` 会命中基线那一轮写过的旧记录 —— 判据错也 PASS
    // 2. 窗口超过空闲间隔时，`force` 兜底会在 2 秒后无条件写出正式稿 —— 同样 PASS
    const baseCount = remembered.filter(
      (r) => r.event_id === `session-minutes:${sessionId}`,
    ).length;
    const finalized = await waitFor(
      () =>
        remembered
          .filter((r) => r.event_id === `session-minutes:${sessionId}`)
          .slice(baseCount)
          .some((r) => !r.content.includes('in-progress')),
      1200,
    );
    check('归档轮数(1)远小于轮序号(9) 时阶段稿仍被正式稿取代', finalized, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.split('\n')[1]),
      ledger: readLedger(sessionId),
      finalContent: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.slice(0, 120)),
    });
  }

  // ── 13) 阶段标记必须经过 `MinutesLedgerStore.load` 往返（十轮审查 C1）──
  //
  // ## 为什么单独测
  //
  // 第 11/12 段都是直接 `JSON.parse(readFileSync(...))` 读磁盘，
  // **绕过了生产的读取路径**。于是 `load()` 漏字段这种 bug 完全测不出来：
  // 磁盘上明明有 `stageWrittenTurnIdx`，但 `load()` 返回的对象没有它，
  // `applyLedgerState` 拿到 `undefined` ⇒ 重启后阶段标记归零 ⇒
  // 库里那份 in-progress 阶段稿再也等不到正式稿收尾。
  //
  // 实测确认过这个 bug 曾经存在（`load` 返回 undefined）。
  console.log('\n=== 13) 阶段标记经 load 往返 ===');
  {
    const dir = join(workDir, 'minutes-roundtrip');
    const store = new MinutesLedgerStore(dir);
    const now = Date.now();
    store.save({
      sessionId: 'rt-session',
      turns: [
        {
          idx: 3,
          startedAt: now,
          endedAt: now + 100,
          reason: 'in-progress',
          userText: '往返测试',
          conclusions: ['结论，因为要验证 load 不丢字段'],
        },
      ],
      archivedTurns: 2,
      writtenAtArchived: 2,
      startedAt: now,
      writtenTurns: 1,
      memoryId: 'mem-rt',
      pendingForget: ['ghost-id'],
      stageWrittenTurnIdx: 7,
      updatedAt: 0,
    });
    const back = store.load('rt-session');
    check('load 返回 message 非空', back !== null, back);
    check('stageWrittenTurnIdx 经 load 往返不丢失', back?.stageWrittenTurnIdx === 7, {
      got: back?.stageWrittenTurnIdx,
    });
    check('pendingForget 经 load 往返不丢失', (back?.pendingForget ?? []).includes('ghost-id'), {
      got: back?.pendingForget,
    });
    // 旧版账本没有该字段 ⇒ 退化为 0，而不是 undefined
    store.save({
      sessionId: 'rt-session-b',
      turns: [],
      archivedTurns: 0,
      writtenAtArchived: -1,
      startedAt: now,
      writtenTurns: 0,
      memoryId: '',
      updatedAt: 0,
    });
    check(
      '旧版账本缺字段时 stageWrittenTurnIdx 退化为 0',
      store.load('rt-session-b')?.stageWrittenTurnIdx === 0,
      store.load('rt-session-b')?.stageWrittenTurnIdx,
    );
    // ## `memoryIdFromProbe` 必须经 load 往返（七轮审查 critical 1）
    //
    // 「探查来的 id 永不 forget」这条规则若只活在进程内 Set 里，
    // 重启后就失忆 ⇒ 下一次写入会把库里那段真实历史当「旧版本」删掉。
    store.save({
      sessionId: 'rt-session-c',
      turns: [],
      archivedTurns: 0,
      writtenAtArchived: -1,
      startedAt: now,
      writtenTurns: 0,
      memoryId: 'probed-id-xyz',
      memoryIdFromProbe: true,
      updatedAt: 0,
    });
    const backC = store.load('rt-session-c');
    check('memoryIdFromProbe 经 load 往返不丢失', backC?.memoryIdFromProbe === true, {
      got: backC?.memoryIdFromProbe,
    });
    // 旧版账本没有该字段 ⇒ 退化为 `undefined`（来源未知，保守不删）
    //
    // ## 不能退化成 `false`
    //
    // 折成 false 会让「旧版账本里本可能是探查来的 id」被当成自己写的，
    // 下一次新建写入就 `forget` 掉那段真实历史（九轮审查 M-1）。
    check(
      '旧版账本 memoryIdFromProbe 退化为 undefined（未知）',
      store.load('rt-session-b')?.memoryIdFromProbe === undefined,
      { got: store.load('rt-session-b')?.memoryIdFromProbe },
    );
  }

  // ── 14) 关窗（dispose）不得丢掉「进行中的那一轮」（十轮审查 C2）──
  //
  // ## 反例（十轮审查发现，比第 11 段更致命）
  //
  // 早先只有阶段稿带在飞轮，正式稿只带已归档轮次。而 dispose 走的是
  // `maybeWriteMinutes(..., force=true)`：
  // ```
  // 第 3 轮跑了 25 分钟，阶段稿已把「进行中的第 3 轮」写进库
  // 用户关窗 ⇒ dispose ⇒ 正式稿 = 前 2 轮（不含第 3 轮）且闸门放行
  // ⇒ LRC 新建第二条并 forget 掉阶段稿 ⇒ 第 3 轮永久丢失 ❌
  // ```
  // 这正是本功能要修的缺口本身，却出现在最容易发生的退出路径上。
  console.log('\n=== 14) dispose 不丢在飞轮 ===');
  {
    const sessionId = 'session-dispose-inflight';
    remembered.length = 0;
    const s = new FakeSession(sessionId);

    // 先归档一轮，让 `turnLedger` 非空（否则 `maybeWriteMinutes` 直接返回）
    driveTurn(s, 1, '第一轮：建立账本基线', '结论：先有一轮，因为要验证 dispose 不丢在飞轮。');
    await waitFor(() => readLedger(sessionId)?.turns.length === 1, 4000);

    // 第 2 轮：只开轮 + 有内容，**永不 turn/end**（模拟长任务中途关窗）
    onSessionEvent?.(s, s.append('turn/start', { turn: 2 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '第二轮：这一轮要跑到关窗为止都不结束' }],
        source: { kind: 'user' },
      }),
    );
    onSessionEvent?.(
      s,
      s.append('assistant/message', {
        message: {
          content: [{ type: 'text', text: '结论：关窗时这段中间结论必须还在，因为它是唯一记录。' }],
        },
      }),
    );

    // 触发一次 dispose（插件用 ctx.effect 注册清理函数；这里直接跑全部）
    check('dispose 清理函数已注册', effects.length > 0, effects.length);
    for (const fn of effects) fn();

    const keptInflight = await waitFor(
      () =>
        remembered
          .filter((r) => r.event_id === `session-minutes:${sessionId}`)
          .some((r) => r.content.includes('第二轮：这一轮要跑到关窗为止') || r.content.includes('关窗时这段中间结论')),
      4000,
    );
    check('dispose 写出的正式稿仍包含在飞的那一轮', keptInflight, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.slice(0, 200)),
      ledger: readLedger(sessionId),
    });
  }

  // ── 15) 首轮就是长任务时，dispose 也必须写出纪要（十一轮审查 C-2）──
  //
  // ## 反例
  //
  // `maybeWriteMinutes` 早先有 `if (turnLedger.length === 0) return;`，
  // 而它排在 `force` 判定之前。于是：
  // ```
  // 新会话的第一个轮次就是长任务（实测 30 分钟 / 72 步）
  // 阶段稿已把该轮写进库，turnLedger 仍为空（该轮还没归档）
  // 用户关窗 ⇒ dispose(force) ⇒ 守卫直接 return ⇒ 一次写入都不发
  // ```
  // 第 14 段自己就是靠「先归档一轮」绕开这个缺陷的，所以必须单独测。
  console.log('\n=== 15) 首轮长任务 + 关窗 ===');
  {
    const sessionId = 'session-first-turn-long';
    remembered.length = 0;
    const s = new FakeSession(sessionId);

    // 直接开第一轮，不预先归档任何轮次
    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '第一轮就是超长任务，从头跑到关窗' }],
        source: { kind: 'user' },
      }),
    );
    onSessionEvent?.(
      s,
      s.append('assistant/message', {
        message: {
          content: [{ type: 'text', text: '结论：首轮长任务的中间结论必须落库，因为它不会再有机会。' }],
        },
      }),
    );

    for (const fn of effects) fn();

    const wrote = await waitFor(
      () =>
        remembered
          .filter((r) => r.event_id === `session-minutes:${sessionId}`)
          .some(
            (r) =>
              r.content.includes('第一轮就是超长任务') ||
              r.content.includes('首轮长任务的中间结论'),
          ),
      4000,
    );
    check('零归档轮次时 dispose 仍写出含首轮的纪要', wrote, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.slice(0, 200)),
      ledger: readLedger(sessionId),
    });
  }

  // ── 16) turn/end 之后、finishTurn 未完成时关窗，仍不得丢该轮（C-1）──
  //
  // ## 反例
  //
  // `turn/end` 处理器同步把 `liveTurn` 清空、推入 `finishingTurns`，
  // 然后才 `void finishTurn(...)`（内部多次 HTTP，mock 的 migrate 就有
  // 120ms 延迟）。这个窗口里该轮**既不在 liveTurn 也不在 turnLedger**。
  // 若 `persistMinutes` 只看 `liveTurn`，dispose 会写出一份不含该轮的
  // 正式稿去覆盖阶段稿 —— 与 C2 同构。
  console.log('\n=== 16) 收尾窗口内关窗不丢轮 ===');
  {
    const sessionId = 'session-finishing-window';
    remembered.length = 0;
    const s = new FakeSession(sessionId);

    driveTurn(s, 1, '第一轮：建立账本', '结论：先有一轮，因为要制造收尾窗口。');
    await waitFor(() => readLedger(sessionId)?.turns.length === 1, 4000);

    // 第 2 轮：**同步**发出 turn/end（不 await finishTurn）
    onSessionEvent?.(s, s.append('turn/start', { turn: 2 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '第二轮：收尾窗口内不该被丢掉的那一轮' }],
        source: { kind: 'user' },
      }),
    );
    onSessionEvent?.(
      s,
      s.append('assistant/message', {
        message: {
          content: [{ type: 'text', text: '结论：收尾窗口里的这段结论必须保住，因为它只此一份。' }],
        },
      }),
    );
    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    // ## 立刻 dispose，且人为把 migrate 拖慢（十一轮证伪教训）
    //
    // 默认 120ms 的延迟太短：`finishTurn` 会在观察窗口内完成归档，
    // 于是回退修复后仍能写出「含该轮」的正式稿 —— 用例假绿。
    // 拉到 5 秒，确保 dispose 时该轮**确实只存在于 finishingTurns**。
    migrateDelayMs = 5000;
    for (const fn of effects) fn();

    // ## 只看 dispose 那次写入（在 finishTurn 归档完成之前）
    //
    // ⚠ 不能用固定 sleep（十一轮 minor-6）：这是纯 wall-clock 假设，
    // Windows CI 上磁盘/localhost 抖动就会假红。改成条件等待，
    // 上限 1500ms 仍远小于 5000ms 的 migrate 延迟 ⇒ 反向证伪照样变红。
    const atDispose: Remembered[] = [];
    await waitFor(
      () => {
        const fresh = remembered.filter(
          (r) =>
            r.event_id === `session-minutes:${sessionId}` &&
            (r.content.includes('收尾窗口内不该被丢掉的那一轮') ||
              r.content.includes('收尾窗口里的这段结论')),
        );
        if (fresh.length > 0) {
          atDispose.push(...fresh);
          return true;
        }
        return false;
      },
      1500,
    );
    check('finishingTurns 里的轮次未被 dispose 丢掉', atDispose.length > 0, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.slice(0, 240)),
      ledger: readLedger(sessionId),
    });
    migrateDelayMs = 120;
  }

  // ── 17) 阶段标记不得被「非阶段写入」清零（十一轮审查 M-1）──
  //
  // ## 反例
  //
  // 早先正式稿无条件写 `stageWrittenTurnIdx = 0`。清零后
  // 「阶段稿抢跑 ⇒ 该轮结束后放行正式稿」的收尾机制失效：
  // ```
  // 第 5 轮阶段稿成功 ⇒ marker=5
  // 一次 force 正式稿（重连补写 / dispose）⇒ marker=0
  // 第 5 轮 turn/end ⇒ 增量 1 < everyTurns ⇒ 正式稿被拦
  // ⇒ 库里永久停在带 (in-progress) 的那一行
  // ```
  //
  // ## 为什么用 `agent/pre-step` 触发而非 dispose
  //
  // 第 15/16 段已经调用过 `effects`（= dispose 全部清理函数），插件状态
  // 已被拆掉，不能再用。这里改用「只开轮不关轮」，让阶段稿自己写出去，
  // 然后验证 marker 在后续的正式写入后依然存活。
  console.log('\n=== 17) 阶段标记不被非阶段写入清零 ===');
  {
    const sessionId = 'session-stage-marker-survives';
    remembered.length = 0;
    const s = new FakeSession(sessionId);
    const preStep = handlers.get('agent/pre-step')?.[0] as
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;

    onSessionEvent?.(s, s.append('turn/start', { turn: 3 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '第三轮：先写一份阶段稿' }],
        source: { kind: 'user' },
      }),
    );
    await new Promise((r) => setTimeout(r, 90));
    await preStep?.({ agent: { session: s } }, async () => null);
    const staged = await waitFor(
      () => (readLedger(sessionId)?.stageWrittenTurnIdx ?? 0) === 3,
      3000,
    );
    check('阶段稿已写出（marker=3）', staged, readLedger(sessionId));

    // ## 关键一步：在该轮**仍未结束**时触发一次 force 正式稿
    //
    // 这是 M-1 的唯一触发条件。没有它，`turn/end` 走的是
    // `stageTurnStillActive=false` 的放行分支，标记是否被清零根本不影响结果
    // —— 用例会永远 PASS（已实测确认）。
    //
    // 用 dispose 是因为它是唯一「不依赖 backlog、不需要等 60 步」的
    // force 入口；`effects` 里的清理函数不会注销 handler，后续事件照常可用。
    // 记下 dispose 前的写入数，等它真的完成再断言（否则读到旧账本）
    const beforeForce = remembered.filter(
      (r) => r.event_id === `session-minutes:${sessionId}`,
    ).length;
    for (const fn of effects) fn();
    await waitFor(
      () => remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length > beforeForce,
      3000,
    );
    const markerAfterForce = readLedger(sessionId)?.stageWrittenTurnIdx ?? 0;
    check('force 正式稿后阶段标记仍保留（收尾机制未被自毁）', markerAfterForce === 3, {
      marker: markerAfterForce,
      ledger: readLedger(sessionId),
      allWrites: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.split('\n')[1]),
      tailLogs: logs.slice(-10),
    });

    // 该轮结束后，正式稿必须真的被写出来（不是靠空闲兜底）
    const before = remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length;
    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    const finalized = await waitFor(
      () =>
        remembered
          .filter((r) => r.event_id === `session-minutes:${sessionId}`)
          .slice(before)
          .some((r) => !r.content.includes('in-progress')),
      1200,
    );
    check('轮次结束后正式稿被写出（未被「满 N 轮」节流拦死）', finalized, {
      writes: remembered
        .filter((r) => r.event_id === `session-minutes:${sessionId}`)
        .map((r) => r.content.split('\n')[1]),
    });
    // 收尾完成后标记应清零（否则下一轮会被无谓放行）
    const cleared = await waitFor(
      () => (readLedger(sessionId)?.stageWrittenTurnIdx ?? 0) === 0,
      2000,
    );
    check('收尾完成后阶段标记被清零', cleared, readLedger(sessionId));
  }

  // ── 18) 只有阶段标记、零轮次的账本必须能被恢复（十一轮审查 M-3）──
  //
  // 首轮长任务的阶段稿写入时 `turnLedger` 为空 ⇒ 磁盘上是
  // `turns: []` + `stageWrittenTurnIdx: 1`。若 `bindMinutesSession`
  // 只判 `turns.length > 0`，这份账本被当作不存在 ⇒ 标记与
  // `writtenAtArchived` 一起归零 ⇒ 库里的 in-progress 稿失去收尾入口。
  console.log('\n=== 18) 零轮账本可被恢复 ===');
  {
    const dir = join(workDir, 'minutes-zero-turn');
    const store = new MinutesLedgerStore(dir);
    const now = Date.now();
    store.save({
      sessionId: 'zero-turn-session',
      turns: [],
      archivedTurns: 0,
      writtenAtArchived: 0,
      startedAt: now,
      writtenTurns: 0,
      memoryId: 'mem-zero',
      pendingForget: [],
      stageWrittenTurnIdx: 4,
      updatedAt: 0,
    });
    const back = store.load('zero-turn-session');
    check('零轮账本被 load 读回（不是 null）', back !== null, back);
    check('零轮账本保留了阶段标记', back?.stageWrittenTurnIdx === 4, back?.stageWrittenTurnIdx);
    // prune 也不该优先淘汰它（它还挂着未收尾的阶段稿）
    store.prune(1);
    check(
      '带阶段标记的零轮账本不被 prune 优先淘汰',
      existsSync(join(dir, 'minutes-zero-turn-session.json')),
      readdirSync(dir),
    );

    // ## 端到端：`bindMinutesSession` 必须恢复它，而不是当成新会话
    //
    // 只测 `store.load` 是不够的（第十轮 C1 就是「load 漏字段」，
    // 而测试直接读磁盘 JSON 完全无感）。这里写入真实账本文件，
    // 再驱动一次 `turn/start`（会触发 `bindMinutesSession`），
    // 断言「恢复」日志真的出现。
    //
    // ## 进度字段用非零初值（十一轮 minor-7）
    //
    // M-3 的真实危害是「`writtenAtArchived` 被 reset 成 -1 ⇒ 闸门变松」。
    // 用 0 做初值时，「被重置」与「没被重置」在断言上不可区分 ——
    // 必须用 7 这样的非零值，才能证明恢复真的保住了进度。
    const e2eSession = 'session-zero-turn-bind';
    const logMark = logs.length;
    new MinutesLedgerStore(minutesDir).save({
      sessionId: e2eSession,
      turns: [],
      archivedTurns: 7,
      writtenAtArchived: 7,
      startedAt: now,
      writtenTurns: 7,
      memoryId: 'mem-zero-e2e',
      pendingForget: [],
      stageWrittenTurnIdx: 5,
      updatedAt: 0,
    });
    const s2 = new FakeSession(e2eSession);
    onSessionEvent?.(s2, s2.append('turn/start', { turn: 6 }));
    const bound = await waitFor(
      () => logs.slice(logMark).some((l) => l.includes('纪要账本已恢复')),
      2000,
    );
    check('零轮但有阶段标记的账本会被 bindMinutesSession 恢复', bound, {
      logs: logs.slice(logMark).slice(-6),
      ledger: readLedger(e2eSession),
    });
    // 恢复后标记与进度都必须还在（否则收尾入口丢失、闸门变松）
    const restoredE2e = readLedger(e2eSession);
    check(
      '恢复后阶段标记仍为 5（未被当成新会话清零）',
      (restoredE2e?.stageWrittenTurnIdx ?? 0) === 5,
      restoredE2e,
    );
    check(
      '恢复后 writtenAtArchived 仍为 7（闸门不会因重置而变松）',
      (restoredE2e?.writtenAtArchived ?? -1) === 7,
      restoredE2e,
    );
  }
  // ── 19) `skipped` 不得回滚节流（十一轮审查 M-A）──
  //
  // ## 反例
  //
  // `persistLedgerInner` 在四类语义完全不同的情形下都返回 false：
  // 真失败 / 连接不可用 / **闸门拦住** / **无可写内容**。
  // 上一版把它们一律当失败回滚节流，而 `maybeWriteStageMinutes` 每步都跑
  // ⇒ 下一步立刻重试 ⇒ 长任务里每步一次全库相似度扫描。
  //
  // 现在只有 `failed` 回滚。本段用一个**永远被闸门拦住**的会话验证：
  // 连驱动多步后，写入尝试次数必须不随步数增长。
  console.log('\n=== 19) skipped 不回滚节流 ===');
  {
    const sessionId = 'session-stage-skip-no-retry';
    remembered.length = 0;
    const s = new FakeSession(sessionId);
    const preStep = handlers.get('agent/pre-step')?.[0] as
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;

    // 预置账本：库里已写到第 40 轮（饱和），而本次稿只有 1 轮 ⇒ 闸门拦住
    // （这里用 writtenAtArchived 远超 archivedTurns 制造「本稿更短」）
    new MinutesLedgerStore(minutesDir).save({
      sessionId,
      turns: [],
      archivedTurns: 0,
      writtenAtArchived: 30,
      startedAt: Date.now(),
      writtenTurns: 30,
      memoryId: 'mem-skip',
      pendingForget: [],
      stageWrittenTurnIdx: 0,
      updatedAt: 0,
    });

    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '这一轮会一直被闸门拦住' }],
        source: { kind: 'user' },
      }),
    );
    await new Promise((r) => setTimeout(r, 90));

    const logMark = logs.length;
    // ## 步数必须足够多，才能拉开「每步重试」与「按节流重试」的差距
    //
    // 配置 `minutesStageMs = 60`，每步间隔 30ms ⇒ 20 步 ≈ 600ms。
    // - 修复后：跳过次数受节流约束，约 600/60 = 10 次
    // - 回退后：节流被每步回滚，20 步全部重试 = 20 次
    // 差距足够大，`<= 14` 既能抓住回归又不与时序抖动冲突。
    const STEPS = 20;
    for (let i = 0; i < STEPS; i += 1) {
      await preStep?.({ agent: { session: s } }, async () => null);
      await new Promise((r) => setTimeout(r, 30));
    }
    const skipLogs = logs.slice(logMark).filter((l) => l.includes('跳过写入'));
    // 第一步被拦住后 `lastMinutesStageAt` 应保持推进 ⇒ 后续按节流间隔重试
    check(
      'skipped 不会触发每步重试（次数受节流约束，不随步数线性增长）',
      skipLogs.length <= 14 && skipLogs.length < STEPS,
      {
        skipCount: skipLogs.length,
        steps: STEPS,
        tailLogs: logs.slice(logMark).slice(-4),
        writes: remembered.filter((r) => r.event_id === `session-minutes:${sessionId}`).length,
      },
    );
  }
  // ── 20) 冷启动探查：账本丢失时从库里回填 memoryId（D 方案）──
  //
  // ## 反例
  //
  // 本地账本不存在（旧版本升级 / 被 prune / 换机器）：
  // ```
  // 库里已有 session-minutes:<sid>（22 轮 / 2776 字）
  // 本地账本 null ⇒ minutesMemoryId = '' ⇒ previousId.length === 0
  // ⇒ 下次写入不去 forget 旧的那条
  // ⇒ 新稿与旧稿 Jaccard ≈ 0.05 < 0.5 ⇒ LRC 新建第二条
  // ⇒ 库里两条同名 importance=9 纪要，且不会自愈
  // ```
  //
  // D 方案的边界：**只回填 memoryId，不伪造轮次**。
  // 旧纪要没有逐轮的 startedAt/reason，反推出来是编造的。
  console.log('\n=== 20) 冷启动探查回填 memoryId ===');
  {
    const sessionId = 'session-cold-start-probe';
    const eventId = `session-minutes:${sessionId}`;
    remembered.length = 0;
    forgot.length = 0;
    // 清掉可能的残留账本，确保走「账本不存在」的冷启动路径
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    rmSync(join(minutesDir, `minutes-${safe}.json`), { force: true });

    // 库里预置两段：旧段（长、时间早）+ 新段（短、时间晚）
    //
    // 这正是真实数据的形态（六钥匙裁决依据）：
    // ```
    // 87f7d090  11-14 11:28 → 11-17 05:10  22 轮 / 2776 字（旧段）
    // a9584d98  11-17 23:03 → 11-18 04:10   2 轮 / 1104 字（新段）
    // 两段**时间窗不重叠、主题不同**，新段还推翻了旧段的结论
    // ```
    seededMemories.length = 0;
    seededMemories.push({
      id: 'seeded-old-segment-0001',
      content:
        '【会话纪要】' +
        sessionId +
        '\n时间：2026-11-14 11:28 → 2026-11-17 05:10（65.7 小时 / 22 轮，本地时间）\n\n## 诉求演进\n' +
        Array.from(
          { length: 22 },
          (_, i) => `- 第 ${i + 1} 轮的旧段诉求文本，模拟较早阶段的完整记录并刻意写长以超过新段`,
        ).join('\n'),
      memory_type: 'conversation',
      score: 0.03,
      score_norm: 1,
      importance: 9,
      event_id: eventId,
      created_at: '2026-11-14T03:28:38.158Z',
      tags: [`session:${sessionId}`, 'session-minutes'],
    });
    seededMemories.push({
      id: 'seeded-new-segment-0002',
      // ## 字符数必须显著大于「本轮会写出的稿」
      //
      // 保护判据是「新稿比那段短 ⇒ 保留那段」。若这里只放 100 多字符，
      // 新稿（约 140 字符）反而更长 ⇒ 正常接管 ⇒ 删掉新段是**正确行为**，
      // 用例就测不出保护（本次实测踩过）。
      // 真实数据里新段是 1104 字符，这里按同量级构造。
      content:
        '【会话纪要】' +
        sessionId +
        '\n时间：2026-11-17 23:03 → 2026-11-18 04:10（5.1 小时 / 2 轮，本地时间）\n\n## 诉求演进\n' +
        Array.from({ length: 12 }, (_, i) => `- 新阶段第 ${i + 1} 段的诉求文本，需要足够长才能模拟真实规模`).join('\n') +
        '\n\n## 关键结论\n' +
        Array.from({ length: 12 }, (_, i) => `- 新阶段第 ${i + 1} 条结论，同样要占足字符数`).join('\n'),
      memory_type: 'conversation',
      score: 0.03,
      score_norm: 1,
      importance: 9,
      event_id: eventId,
      created_at: '2026-11-17T15:03:14.632Z',
      tags: [`session:${sessionId}`, 'session-minutes'],
    });

    const s = new FakeSession(sessionId);
    const logMark = logs.length;
    // 驱动一轮：turn/start 会触发 `bindMinutesSession` + `maybeProbeMinutesOnce`
    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    onSessionEvent?.(
      s,
      s.append('user/message', {
        content: [{ type: 'text', text: '冷启动后的第一轮' }],
        source: { kind: 'user' },
      }),
    );

    const probed = await waitFor(
      () => logs.slice(logMark).some((l) => l.includes('会话纪要已从库中回填')),
      4000,
    );
    check('冷启动时从库中回填了 memoryId', probed, logs.slice(logMark).slice(-6));

    const ledger = readLedger(sessionId);
    // ## 必须选「最新那段」，不是「最长那段」（十三轮 / 六钥匙裁决）
    //
    // 「最长」会锁定在 22 轮的旧段，导致：
    // (a) 会话再也无法追加新内容（新稿总是更短，被保护判据拦下）
    // (b) 新段的 20 多条结论被当作「重复」删掉
    check('账本采用库里「最新那段」（不是最长那段）', ledger?.memoryId === 'seeded-new-segment-0002', {
      memoryId: ledger?.memoryId,
      ledger,
    });
    // ## 历史段一律保留（六钥匙裁决的核心）
    //
    // 早先这里会把除 primary 外的记录全部 `queueForget`，隐含
    // 「同 event_id ⇒ 重复」。真实数据推翻了它：两段时间窗不重叠、
    // 主题不同，是两段真实历史，不是同一份内容的两个版本。
    check(
      '历史段未被记为待删（不同时间段不是重复）',
      !(ledger?.pendingForget ?? []).includes('seeded-old-segment-0001'),
      { pendingForget: ledger?.pendingForget },
    );
    // ## 边界：不得伪造轮次（D 方案的核心约束）
    //
    // 旧纪要正文里有 22 行诉求，但插件**不能**据此造出 22 条 TurnRecord
    // —— 那会把编造的时间线写进库。账本里的 turns 必须仍为空。
    check('未从旧纪要正文伪造轮次（turns 仍为空）', (ledger?.turns ?? []).length === 0, {
      turns: (ledger?.turns ?? []).length,
    });

    // ## 关键：走完这一轮后，库里两段都**不能**被删掉
    //
    // 危险路径：
    // ```
    // 探查回填 primary=seeded-new-segment-0002（1104 字符）
    // 本轮 turn/end ⇒ 新稿更短 ⇒ LRC 新建 newId
    // ⇒ 若不保护：forget(seeded-new-segment-0002) ❌
    // ```
    // 这里要同时验证「新段不被删」和「旧段也不被删」。
    onSessionEvent?.(
      s,
      s.append('assistant/message', {
        message: { content: [{ type: 'text', text: '结论：冷启动后的第一轮也要被记录。' }] },
      }),
    );
    onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
    // ## 本段是**跨段**场景，正确行为是「新建第二条并两段并存」
    //
    // 库内新段讲的是「新阶段第 N 段的诉求」，本轮讲的是「冷启动后的
    // 第一轮」⇒ Jaccard 很低 ⇒ LRC 新建 ⇒ 保护判据**不该**触发。
    //
    // 危险路径从来不是「新建」，而是**新建之后去 forget 旧的那条**：
    // ```
    // newId ≠ previousId(=seeded-new-segment-0002)
    // ⇒ 旧实现无条件 forget(previousId) ❌ 库里那段被删
    // ```
    // 所以要断言三件事：真的写了、新段没被删、旧段也没被删。
    const wroteCross = await waitFor(
      () => remembered.some((r) => r.event_id === eventId),
      4000,
    );
    check(
      '跨段内容被正常写入（LRC 新建第二条）',
      wroteCross,
      remembered.map((r) => r.event_id),
    );
    check(
      '新段未被残稿删掉（探查来的 id 永不 forget）',
      !forgot.includes('seeded-new-segment-0002'),
      { forgot: [...forgot], ledger: readLedger(sessionId) },
    );
    check(
      '旧段从未被删除（历史必须保留）',
      !forgot.includes('seeded-old-segment-0001'),
      { forgot: [...forgot] },
    );

    // ── 20b) 账本已指向「旧段」时，按最新切到新段（C2）──
    //
    // 真实案例：账本 memoryId 指向较早写下的那条，而库里已有一段更新的。
    // 旧实现的第一行 `if (minutesMemoryId.length > 0) return` 会直接返回。
    console.log('\n--- 20b) 账本指向旧段时切到最新段 ---');
    {
      const sid2 = 'session-cold-start-shortledger';
      const eid2 = `session-minutes:${sid2}`;
      seededMemories.length = 0;
      seededMemories.push({
        id: 'seeded-older-0101',
        content:
          '【会话纪要】' +
          sid2 +
          '\n时间：2026-11-14 11:28 → 2026-11-14 12:00（0.5 小时 / 20 轮，本地时间）\n## 诉求演进\n' +
          Array.from({ length: 20 }, (_, i) => `- 第 ${i + 1} 轮较早阶段的诉求文本内容`).join('\n'),
        memory_type: 'conversation',
        score: 0.03,
        score_norm: 1,
        importance: 9,
        event_id: eid2,
        created_at: '2026-11-14T03:28:38.158Z',
        tags: [`session:${sid2}`, 'session-minutes'],
      });
      seededMemories.push({
        id: 'seeded-newer-0102',
        content: `【会话纪要】${sid2}\n时间：2026-11-17 23:03 → 2026-11-18 04:10（5.1 小时 / 2 轮，本地时间）\n## 诉求演进\n- 更新但更短的一段`,
        memory_type: 'conversation',
        score: 0.03,
        score_norm: 1,
        importance: 9,
        event_id: eid2,
        created_at: '2026-11-17T15:03:14.632Z',
        tags: [`session:${sid2}`, 'session-minutes'],
      });
      // 预置账本：指向**旧段**（模拟早先写下的状态）
      //
      // ## 必须带一个真实轮次
      //
      // `bindMinutesSession` 的恢复判据是「有轮次 或 有阶段标记 或 有归档历史」。
      // 若三者全空，它会走 `resetMinutesState` 把 memoryId 清成 ''，
      // 于是 `shouldSwitch` 无论如何都为真 —— 用例就测不出判据差异
      // （回退后仍然 PASS，已实测确认）。
      const seedNow = Date.now();
      new MinutesLedgerStore(minutesDir).save({
        sessionId: sid2,
        turns: [
          {
            idx: 1,
            startedAt: seedNow,
            endedAt: seedNow + 1000,
            reason: 'completed',
            userText: '旧版插件写下的一轮',
            conclusions: ['结论：这条账本指向较早的那一段'],
          },
        ],
        archivedTurns: 1,
        writtenAtArchived: 1,
        startedAt: seedNow,
        writtenTurns: 1,
        memoryId: 'seeded-older-0101',
        pendingForget: [],
        stageWrittenTurnIdx: 0,
        updatedAt: 0,
      });

      const s2b = new FakeSession(sid2);
      const mark2 = logs.length;
      onSessionEvent?.(s2b, s2b.append('turn/start', { turn: 1 }));
      const switched = await waitFor(
        () => readLedger(sid2)?.memoryId === 'seeded-newer-0102',
        3000,
      );
      check('账本指向旧段时被切到库里最新的一段', switched, {
        memoryId: readLedger(sid2)?.memoryId,
        fullLedger: readLedger(sid2),
        logs: logs.slice(mark2).slice(-6),
      });
      // 旧段不得被记为待删
      check(
        '切换后旧段未被记为待删',
        !(readLedger(sid2)?.pendingForget ?? []).includes('seeded-older-0101'),
        { pendingForget: readLedger(sid2)?.pendingForget },
      );
      // ## 来源必须已落盘（七轮审查 critical 1）
      //
      // 「探查来的 id 永不 forget」只在进程内记时，重启就失忆 ⇒
      // 下一次写入会把库里那段真实历史当「旧版本」删掉。
      check(
        '探查回填后来源已落盘（memoryIdFromProbe=true）',
        readLedger(sid2)?.memoryIdFromProbe === true,
        { ledger: readLedger(sid2) },
      );

      // ── 20c) 模拟重启：账本沿用「探查来的 id」，不得被删 ──
      //
      // ## 反例
      //
      // ```
      // run1：探查选中新段 seeded-newer-0102 ⇒ 账本落盘（含来源标记）
      // run2（重启）：内存 Set 清空，账本仍指向它
      // 新段写入 ⇒ LRC 新建 mem-N ⇒ previousId 被当「本稿旧版本」
      // ⇒ forget(seeded-newer-0102) ❌
      // ```
      // 这里刻意**不动账本**（模拟重启后的状态），直接驱动一轮新内容，
      // 断言旧段没被删。
      console.log('\n--- 20c) 重启后仍不删探查来的 id ---');
      remembered.length = 0;
      forgot.length = 0;
      const s2c = new FakeSession(sid2);
      onSessionEvent?.(s2c, s2c.append('turn/start', { turn: 2 }));
      onSessionEvent?.(
        s2c,
        s2c.append('user/message', {
          content: [{ type: 'text', text: '重启之后的第二轮诉求' }],
          source: { kind: 'user' },
        }),
      );
      onSessionEvent?.(
        s2c,
        s2c.append('assistant/message', {
          message: { content: [{ type: 'text', text: '结论：重启之后的结论，因为要验证历史不被删。' }] },
        }),
      );
      onSessionEvent?.(s2c, s2c.append('turn/end', { reason: { kind: 'completed' } }));
      await waitFor(() => remembered.some((r) => r.event_id === eid2), 4000);
      check(
        '重启后仍未删除探查来的 id（历史只增不减）',
        !forgot.includes('seeded-newer-0102') && !forgot.includes('seeded-older-0101'),
        { forgot: [...forgot], ledger: readLedger(sid2) },
      );

      // ── 20d) 「来源未知」也不得删（九轮审查 M-1）──
      //
      // ## 反例
      //
      // 旧版账本 `memoryId=P`、**没有** `memoryIdFromProbe` 键 ⇒ load 得
      // `undefined`。若把它折成 `false`（「自己写的」），而此刻 enrich
      // 恰好 503（探查补不上标记），下一次新建写入就会 `forget(P)`。
      //
      // 这里把账本改成「有 id、无来源」并让该 id 不在库里（模拟 enrich
      // 探查不到它），再驱动一轮 ⇒ 断言 P 未被删。
      const sid3 = 'session-unknown-source';
      const eid3 = `session-minutes:${sid3}`;
      remembered.length = 0;
      forgot.length = 0;
      seededMemories.length = 0;
      rmSync(join(minutesDir, `minutes-${sid3}.json`), { force: true });
      const now3 = Date.now();
      new MinutesLedgerStore(minutesDir).save({
        sessionId: sid3,
        turns: [
          {
            idx: 1,
            startedAt: now3,
            endedAt: now3 + 1000,
            reason: 'completed',
            userText: '旧版账本里的一轮',
            conclusions: ['结论：这条账本的来源标记是未知的'],
          },
        ],
        archivedTurns: 1,
        writtenAtArchived: 1,
        startedAt: now3,
        writtenTurns: 1,
        // 来源标记**故意不写**（旧版账本形态）
        memoryId: 'legacy-probed-id',
        pendingForget: [],
        stageWrittenTurnIdx: 0,
        updatedAt: 0,
      });
      const s3 = new FakeSession(sid3);
      driveTurn(s3, 2, '新的一轮诉求，与旧版那段完全不同主题', '结论：新结论，因为要验证来源未知时不删。');
      await waitFor(
        () => remembered.some((r) => r.event_id === eid3) || logs.slice(-10).some((l) => l.includes('保留更完整的库内版本')),
        4000,
      );
      check(
        '来源未知（undefined）时未删除账本指向的 id',
        !forgot.includes('legacy-probed-id'),
        { forgot: [...forgot], ledger: readLedger(sid3), logs: logs.slice(-8) },
      );
    }
    seededMemories.length = 0;
  }
  // ── 21) 合并路径：基线拼接（grow-only）──
  //
  // ## 为什么要单独一段
  //
  // 第 20 段的新稿与库内段**几乎不相似**（Jaccard ≈ 0.05），走的是
  // 「LRC 新建第二条」那条分支。真实世界最常见的是**合并**分支：
  // ```
  // 库里 12 轮纪要
  // 本轮只观测到 1 轮
  // Jaccard ≥ 0.5 ⇒ apply_merge → update_content ⇒ **整体替换**
  // ```
  // 旧设计在这里「拦下」（本轮进不了库），六钥匙裁决后改成
  // **把库内那段拼成基线再写**（旧内容一行不丢 + 本轮照常入库）。
  console.log('\n=== 21) 合并路径：基线拼接 ===');
  {
    const sessionId = 'session-merge-protect';
    const eventId = `session-minutes:${sessionId}`;
    remembered.length = 0;
    forgot.length = 0;
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    rmSync(join(minutesDir, `minutes-${safe}.json`), { force: true });

    // ## 库里那份必须与「本轮会被写出的稿」高度相似
    //
    // 用真实 `buildMinutes` 生成，保证相似度判据真的命中（手写格式会
    // 让二元组交集低到 0.1 以下 ⇒ LRC 判「新建」⇒ 测的就变成了别的路径）。
    const t0 = Date.parse('2026-11-17T02:00:00Z');
    const mkTurns = (count: number, base: number): MinutesLedgerState['turns'] =>
      Array.from({ length: count }, (_, i) => ({
        idx: base + i + 1,
        startedAt: t0 + (base + i) * 60_000,
        endedAt: t0 + (base + i) * 60_000 + 30_000,
        reason: 'completed',
        userText: `第 ${base + i + 1} 轮：落地页要按 8pt 栅格重排，因为旧版间距是随手写的`,
        conclusions: [
          `第 ${base + i + 1} 条结论：间距统一取 8 的倍数，因为设计稿里出现过 10px 这种怪值`,
        ],
      }));
    const seededTurns = mkTurns(12, 0);
    const seededDraft = buildMinutes(sessionId, seededTurns);
    const seededContent = seededDraft?.content ?? '';
    const seededTurnsCount = seededDraft?.turns ?? 0;

    seededMemories.length = 0;
    seededMemories.push({
      id: 'seeded-merge-base-0201',
      content: seededContent,
      memory_type: 'conversation',
      score: 0.03,
      score_norm: 1,
      importance: 9,
      event_id: eventId,
      created_at: '2026-11-17T02:00:00.000Z',
      tags: [`session:${sessionId}`, 'session-minutes'],
    });

    const s = new FakeSession(sessionId);
    const mark = logs.length;
    onSessionEvent?.(s, s.append('turn/start', { turn: 1 }));
    const probed = await waitFor(
      () => logs.slice(mark).some((l) => l.includes('会话纪要已从库中回填')),
      4000,
    );
    check('合并用例：探查命中库里那段', probed, logs.slice(mark).slice(-5));

    /** 走完一轮：内容取自预置轮次（模拟「重放同一批轮次」）。 */
    const driveShortTurn = async (idx: number): Promise<void> => {
      const rec = seededTurns[idx - 1];
      // ## 超出预置范围时用**全新**内容（真正的新轮次）
      //
      // 不能退回 `第 N 轮` 这种模板文本：它既不像真实诉求，也会让
      // 「第 13 轮已进库」这类断言测不到真东西。
      const text =
        rec?.userText ?? `第 ${idx} 轮：新增的真实诉求，与前 12 轮内容完全不同`;
      const conclusion =
        rec?.conclusions[0] ?? `第 ${idx} 条新结论，因为要验证新增轮次能进库`;
      onSessionEvent?.(s, s.append('turn/start', { turn: idx }));
      onSessionEvent?.(
        s,
        s.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      );
      onSessionEvent?.(
        s,
        s.append('assistant/message', {
          // ## 助手正文必须与库内那条结论**逐字一致**
          //
          // 这是「重放」的准确模拟：同一段对话被重新观测到时，抽出的
          // 结论文本也应当相同。若这里加 `结论：` 前缀，抽出的结论会变成
          // 「结论：第 1 条结论：…」，与库里那行不同 ⇒ 被判为新内容
          // ⇒ 「无变化」永远不成立（已实测踩过）。
          message: { content: [{ type: 'text', text: conclusion }] },
        }),
      );
      onSessionEvent?.(s, s.append('turn/end', { reason: { kind: 'completed' } }));
      await new Promise((r) => setTimeout(r, 250));
    };

    const writesFor = (): number => remembered.filter((r) => r.event_id === eventId).length;
    check('预置那段覆盖 12 轮（拼接的基线）', seededTurnsCount === 12, seededTurnsCount);
    const firstProbeDraft = buildMinutes(sessionId, mkTurns(2, 0));
    const similarity =
      firstProbeDraft === null ? 0 : minutesSimilarity(seededContent, firstProbeDraft.content);
    check('前提：2 轮稿与库内 12 轮稿相似度 ≥ 0.5（会走合并）', similarity >= 0.5, {
      similarity,
    });

    // ① 重放第 1 轮（诉求行已在库里）⇒ 不得让库内内容变少
    //
    // ## 为什么不在这里断言「零写入」
    //
    // 「零写入」依赖「结论抽取完全幂等」——而抽取经过 `extractFacts` /
    // `validateFact` 多层处理，重放时可能产出细微不同的文本（如标点、
    // 截断）。那是抽取层的事，不是本段要验证的。
    //
    // 本段验证的是 grow-only 的**本质**：无论写不写，库内那段的诉求行
    // 一行都不能少。纯重放的「零写入」由 `e2e-minutes.ts` 第 17 段
    // 在纯函数层精确覆盖。
    await driveShortTurn(1);
    await new Promise((r) => setTimeout(r, 400));
    const afterReplay = remembered.filter((r) => r.event_id === eventId).pop();
    const replayContent = afterReplay?.content ?? seededContent;
    const replayMissing = seededContent
      .split('\n')
      .filter((l) => l.startsWith('- ') && l.includes('轮：落地页'))
      .filter((l) => !replayContent.includes(l));
    check('重放后库内诉求行一行不少', replayMissing.length === 0, {
      missing: replayMissing.slice(0, 2),
      writes: writesFor(),
    });

    // ② 库里那份的诉求行仍然一行不少（grow-only 的实质断言）
    const seededAfterReplay = seededMemories[0]?.content ?? '';
    const seededMissing = seededContent
      .split('\n')
      .filter((l) => l.startsWith('- ') && l.includes('轮：落地页'))
      .filter((l) => !seededAfterReplay.includes(l));
    check('库内那段的诉求行一行不少', seededMissing.length === 0, {
      missing: seededMissing.slice(0, 2),
      before: seededContent.length,
      after: seededAfterReplay.length,
    });

    // ③ 真正的新内容（第 13 轮）⇒ 写入，且**保留全部旧内容**
    //
    // ## 必须记录「重放阶段已经写过几次」
    //
    // 重放可能已经产生一次写入（结论抽取不幂等），所以 `writesFor() > 0`
    // 会立即成立 ⇒ 断言会拿到重放那次的内容，测不到第 13 轮。
    const beforeNew = writesFor();
    const mark3 = logs.length;
    await driveShortTurn(13);
    const wrote = await waitFor(() => writesFor() > beforeNew, 4000);
    check('新轮次正常写入（不再被拦）', wrote, {
      writes: writesFor(),
      logs: logs.slice(mark3).slice(-5),
    });
    // ## 这条是 grow-only 的实质断言：库里那份的每一行都必须还在
    const latest = remembered.filter((r) => r.event_id === eventId).pop();
    const oldLines = seededContent
      .split('\n')
      .filter((l) => l.startsWith('- ') && l.includes('轮：落地页'));
    const missing = oldLines.filter((l) => !(latest?.content ?? '').includes(l));
    check('库里那段的全部诉求行都被保留（一个字都没丢）', missing.length === 0, {
      missing: missing.slice(0, 2),
      total: oldLines.length,
    });
    check('第 13 轮已进库', (latest?.content ?? '').includes('第 13 轮'), latest?.content.slice(-160));
    check(
      '拼接后轮数为 13（12 基线 + 1 新增）',
      parseMinutesTurns(latest?.content ?? '') === 13,
      parseMinutesTurns(latest?.content ?? ''),
    );

    // ⑤ 跨段新主题**不该**拼基线（六轮 critical 2 的回归守卫）
    //
    // ## 反例
    //
    // 若对所有段都拼基线，跨主题的新段会被旧段的诉求行污染 ——
    // 新段里混进「落地页 8pt 栅格」这类与它无关的行，反而更难读。
    //
    // 正确行为：相似度 < 0.5 ⇒ LRC 会**新建** ⇒ 不拼基线，只写本稿。
    check(
      '前提：跨段主题与库内那份相似度 < 0.5（会新建）',
      minutesSimilarity(
        seededContent,
        '完全不同主题的诉求与结论，谈的是数据库迁移与回滚策略，与栅格毫无关系',
      ) < 0.5,
      { seeded: seededContent.slice(0, 40) },
    );
    seededMemories.length = 0;
    seededMemories.push({
      id: 'seeded-cross-segment-0301',
      content: seededContent,
      memory_type: 'conversation',
      score: 0.03,
      score_norm: 1,
      importance: 9,
      event_id: eventId,
      created_at: '2026-11-17T02:00:00.000Z',
      tags: [`session:${sessionId}`, 'session-minutes'],
    });
    const crossSession = 'session-cross-segment';
    const crossEventId = `session-minutes:${crossSession}`;
    const safeCross = crossSession.replace(/[^A-Za-z0-9._-]/g, '_');
    rmSync(join(minutesDir, `minutes-${safeCross}.json`), { force: true });
    // 同一 sessionId 的另一段（时间窗不同、主题完全不同）
    seededMemories[0].event_id = crossEventId;
    seededMemories[0].tags = [`session:${crossSession}`, 'session-minutes'];
    const crossS = new FakeSession(crossSession);
    const crossMark = logs.length;
    onSessionEvent?.(crossS, crossS.append('turn/start', { turn: 1 }));
    await waitFor(
      () => logs.slice(crossMark).some((l) => l.includes('会话纪要已从库中回填')),
      4000,
    );
    onSessionEvent?.(
      crossS,
      crossS.append('user/message', {
        content: [{ type: 'text', text: '换个话题：数据库迁移要先备份再回滚' }],
        source: { kind: 'user' },
      }),
    );
    onSessionEvent?.(
      crossS,
      crossS.append('assistant/message', {
        message: { content: [{ type: 'text', text: '结论：迁移前必须全量备份，因为回滚会丢数据。' }] },
      }),
    );
    onSessionEvent?.(crossS, crossS.append('turn/end', { reason: { kind: 'completed' } }));
    const crossWrote = await waitFor(
      () => remembered.some((r) => r.event_id === crossEventId),
      4000,
    );
    check('跨段新主题正常写入（LRC 会新建）', crossWrote, {
      writes: remembered.filter((r) => r.event_id === crossEventId).length,
      tailLogs: logs.slice(crossMark).slice(-6),
    });
    check(
      '跨段新主题未被拼进旧段内容（不污染新段）',
      !(remembered.filter((r) => r.event_id === crossEventId).pop()?.content ?? '').includes(
        '落地页要按 8pt 栅格',
      ),
      {
        tail: (remembered.filter((r) => r.event_id === crossEventId).pop()?.content ?? '').slice(-160),
      },
    );
    seededMemories.length = 0;
  }
} finally {
  // Windows 下的关闭顺序（见 e2e-minutes.ts 同名注释）
  server.closeAllConnections();
  // ## close 回调必须带超时兜底
  //
  // 插件侧还有在飞的 HTTP（`forget` 是不 await 的补偿动作，写队列也可能
  // 还有尾部）。只要有一条 keep-alive 连接没被 `closeAllConnections` 掐干净，
  // `server.close(cb)` 的回调就永远不触发 ⇒ 进程挂住（实测 45 秒未退出）。
  // 3 秒兜底让测试总能结束；失败与否由断言决定，不受这里影响。
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log('  （提示：server.close 超时，继续退出）');
      resolve();
    }, 3000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  server.unref();
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failed === 0) {
  console.log('全部通过');
  // ## 显式退出
  //
  // 插件内部还有若干 `void` 异步链（写队列、forget 重试），它们可能持有
  // 微任务/句柄。断言已全部完成，这里直接退出，避免测试进程挂住
  // （CI 会因「无输出超时」把它误判成失败）。
  process.exit(0);
}
console.log(`${failed} 项失败`);
process.exit(1);
