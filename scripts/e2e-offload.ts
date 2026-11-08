/**
 * 三条硬性验收标准的端到端测试。
 *
 * 用法：node scripts/e2e-offload.ts
 *
 * 不依赖真实 LRC：进程内起一个 mock，按 LRC 的**契约**实现 distill / migrate / stats。
 * 这样测的是插件逻辑（游标、去重、快照），而不是 LRC 内部实现。
 *
 * 验收标准（来自 docs/PLAN.md §4）：
 *   1. 增量游标：第 2、3 次送进 distill 的字符数 < 第 1 次的 50%
 *   2. 语义查重：连续 migrate 3 次，库内总数不增长
 *   3. 不线性膨胀：去重率 ≥ 80%
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LrcClient } from '../src/lrc-client.ts';
import { CursorStore, snapshotChanged } from '../src/cursor.ts';
import { buildSnapshot, itemsFromTag, Offloader } from '../src/offloader.ts';

// ────────────────────────────────────────────────────────────
// mock LRC：按契约实现，不做真实语义计算
// ────────────────────────────────────────────────────────────

interface StoredMemory {
  content: string;
  memory_type: string;
}

const memories: StoredMemory[] = [];
const calls: Array<{ path: string; chars: number }> = [];

/** 模拟 LRC 的提炼规则：只留含决策/约束/结论词的行。 */
const MARKERS = ['决定', '禁止', '不要', '结论', '改用', '统一用'];

function distill(text: string): { items: unknown[]; count: number; index_line: string } {
  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && MARKERS.some((m) => line.includes(m)))
    .map((line, index) => ({
      content: `[决策] ${line}`,
      memory_type: 'decision',
      tags: ['decision', 'distilled'],
      importance: 7,
      source_turns: [index, index] as [number, number],
    }));
  return {
    items,
    count: items.length,
    index_line: `前序对话已提炼 ${items.length} 条至 LRC（项目：demo）`,
  };
}

/** 字符级 Jaccard 相似度（与 LRC 的合并判据同口径）。 */
function jaccard(a: string, b: string): number {
  const setA = new Set(a.replace(/\s+/g, ''));
  const setB = new Set(b.replace(/\s+/g, ''));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 模拟 LRC 的相似合并：相似度 ≥ 0.85 即合并，不新增。 */
function migrate(items: StoredMemory[]): { written: number; merged: number; failed: number } {
  let written = 0;
  let merged = 0;
  for (const item of items) {
    const existing = memories.find((m) => jaccard(m.content, item.content) >= 0.85);
    if (existing) {
      merged += 1;
    } else {
      memories.push(item);
      written += 1;
    }
  }
  return { written, merged, failed: 0 };
}

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

  if (url.pathname === '/health') {
    send(res, 200, { status: 'running' });
    return;
  }
  if (url.pathname === '/v1/context/distill') {
    const body = JSON.parse(raw) as { text: string };
    calls.push({ path: 'distill', chars: body.text.length });
    send(res, 200, distill(body.text));
    return;
  }
  if (url.pathname === '/v1/context/migrate') {
    const body = JSON.parse(raw) as { items: StoredMemory[] };
    calls.push({ path: 'migrate', chars: body.items.length });
    send(res, 200, migrate(body.items));
    return;
  }
  if (url.pathname === '/v1/memories/stats') {
    send(res, 200, { total_memories: memories.length });
    return;
  }
  if (url.pathname === '/v1/memories/enrich') {
    const body = JSON.parse(raw) as { query: string; top_k?: number; project?: string };
    calls.push({ path: 'enrich', chars: body.query.length });
    const topK = body.top_k ?? 5;
    const items = memories.slice(0, topK).map((m, i) => ({
      id: `mem-${i}`,
      content: m.content,
      memory_type: m.memory_type,
      score_norm: i === 0 ? 1 : Math.max(0, 0.9 - i * 0.05),
      importance: 7,
    }));
    send(res, 200, { memories: items, total: memories.length });
    return;
  }
  if (url.pathname === '/v1/memories/forget') {
    const body = JSON.parse(raw) as { memory_id: string };
    calls.push({ path: 'forget', chars: body.memory_id.length });
    if (body.memory_id === 'missing-id') {
      send(res, 200, {
        success: true,
        memory_id: body.memory_id,
        deleted: false,
        already_deleted: true,
      });
    } else {
      send(res, 200, { success: true, memory_id: body.memory_id, deleted: true });
    }
    return;
  }
  send(res, 404, { error: 'not_found' });
});

// ────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;

const workDir = mkdtempSync(join(tmpdir(), 'lrc-e2e-'));
const cursorPath = join(workDir, 'cursor.json');

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

try {
  const client = new LrcClient({ baseUrl });
  const cursors = new CursorStore(cursorPath);
  const offloader = new Offloader(client, cursors, { project: 'demo' });

  // 第 1 轮：40 行，含 6 条结论
  const round1: string[] = [];
  for (let i = 0; i < 34; i += 1) {
    round1.push(`第 ${i} 行：这是一段普通的讨论内容，用来把上下文撑大。`);
  }
  round1.push('决定用 pnpm 替代 npm，因为依赖解析更快。');
  round1.push('禁止连 3099 做测试，测试一律用 3111。');
  round1.push('结论是：迁移必须分块，每块 20 条。');
  round1.push('不要用 unwrap，请求路径上禁止 panic。');
  round1.push('决定把提炼引擎放在 Layer 1，零外部依赖。');
  round1.push('统一用 UTF-8 with BOM 保存 PowerShell 脚本。');

  // 第 2 轮：12 行，全部是第 1 轮结论的**换措辞复述**（模拟长会话里反复重申）
  const round2 = [
    '决定用 pnpm 替代 npm，依赖解析更快。',
    '决定用 pnpm 替代 npm，因为依赖解析更快',
    '禁止连 3099 做测试，一律用 3111。',
    '禁止连 3099 做测试，测试一律用 3111',
    '结论是：迁移必须分块，每块 20 条',
    '结论是：迁移必须分块，每块 20 条。',
    '不要用 unwrap，请求路径禁止 panic。',
    '不要用 unwrap，请求路径上禁止 panic',
    '决定把提炼引擎放在 Layer 1，零外部依赖',
    '决定把提炼引擎放在 Layer 1，零外部依赖。',
    '统一用 UTF-8 with BOM 保存 PowerShell 脚本',
    '统一用 UTF-8 with BOM 保存 PowerShell 脚本。',
  ];

  // 第 3 轮：12 行，再次换措辞复述
  const round3 = [
    '决定用 pnpm 替代 npm，依赖解析更快',
    '决定用 pnpm 替代 npm，因为依赖解析更快。',
    '禁止连 3099 做测试，一律用 3111',
    '禁止连 3099 做测试，测试一律用 3111。',
    '结论是：迁移必须分块，每块 20 条。',
    '结论是：迁移必须分块，每块 20 条',
    '不要用 unwrap，请求路径禁止 panic',
    '不要用 unwrap，请求路径上禁止 panic。',
    '决定把提炼引擎放在 Layer 1，零外部依赖。',
    '决定把提炼引擎放在 Layer 1，零外部依赖',
    '统一用 UTF-8 with BOM 保存 PowerShell 脚本。',
    '统一用 UTF-8 with BOM 保存 PowerShell 脚本',
  ];

  console.log('=== 第 1 次卸载 ===');
  const r1 = await offloader.offload('session-a', round1);
  if (r1 === null) throw new Error('第 1 次卸载不应返回 null');
  const totalAfter1 = await client.totalMemories();
  console.log(
    `  charsSent=${r1.charsSent} distilled=${r1.distilled} written=${r1.written} merged=${r1.merged} total=${totalAfter1}`,
  );
  console.log(`  快照: ${r1.snapshot}`);
  check('第 1 次有产出', r1.distilled > 0, r1);
  check('第 1 次全部新增', r1.merged === 0, r1);

  console.log('=== 第 2 次卸载 ===');
  const r2 = await offloader.offload('session-a', [...round1, ...round2]);
  if (r2 === null) throw new Error('第 2 次卸载不应返回 null');
  const totalAfter2 = await client.totalMemories();
  console.log(
    `  charsSent=${r2.charsSent} distilled=${r2.distilled} written=${r2.written} merged=${r2.merged} total=${totalAfter2}`,
  );

  console.log('=== 第 3 次卸载 ===');
  const r3 = await offloader.offload('session-a', [...round1, ...round2, ...round3]);
  if (r3 === null) throw new Error('第 3 次卸载不应返回 null');
  const totalAfter3 = await client.totalMemories();
  console.log(
    `  charsSent=${r3.charsSent} distilled=${r3.distilled} written=${r3.written} merged=${r3.merged} total=${totalAfter3}`,
  );

  console.log('\n=== 验收标准 1：增量游标 ===');
  const ratio2 = r2.charsSent / r1.charsSent;
  const ratio3 = r3.charsSent / r1.charsSent;
  console.log(`  第 2 次 / 第 1 次 = ${(ratio2 * 100).toFixed(1)}%`);
  console.log(`  第 3 次 / 第 1 次 = ${(ratio3 * 100).toFixed(1)}%`);
  check('第 2 次字符数 < 第 1 次的 50%', ratio2 < 0.5, { ratio2 });
  check('第 3 次字符数 < 第 1 次的 50%', ratio3 < 0.5, { ratio3 });

  console.log('\n=== 验收标准 2：语义查重 ===');
  console.log(`  第 1 次后总数 = ${totalAfter1}`);
  console.log(`  第 2 次后总数 = ${totalAfter2}`);
  console.log(`  第 3 次后总数 = ${totalAfter3}`);
  check('第 2 次后总数不增长', totalAfter2 === totalAfter1, { totalAfter1, totalAfter2 });
  check('第 3 次后总数不增长', totalAfter3 === totalAfter1, { totalAfter1, totalAfter3 });
  check('第 2 次全部走合并', r2.merged === r2.distilled, r2);
  check('第 3 次全部走合并', r3.merged === r3.distilled, r3);

  console.log('\n=== 验收标准 3：不线性膨胀 ===');
  const growth = totalAfter3 / totalAfter1;
  // 架构调整后，复述在插件端就被 Jaccard 拦下，不再送进 distill。
  // 所以"去重率"改看两处：库内不膨胀 + 本地查重确实拦到了东西。
  const localDeduped = r2.deduped + r3.deduped;
  console.log(`  库内 = ${totalAfter3} 条（第 1 次后 ${totalAfter1} 条）`);
  console.log(`  膨胀倍数 = ${growth.toFixed(2)}x（要求 ≤ 1.2x）`);
  console.log(`  本地查重拦下 = ${localDeduped} 块（要求 > 0）`);
  check('膨胀倍数 ≤ 1.2x', growth <= 1.2, { growth });
  check('本地查重生效', localDeduped > 0, { localDeduped });

  console.log('\n=== 附加：游标失效检测 ===');
  const rewritten = ['完全不同的第一行', '完全不同的第二行'];
  const r4 = await offloader.offload('session-a', rewritten);
  check('transcript 被重写时游标失效', r4 !== null && r4.reset === true, r4);

  console.log('\n=== 附加：无新增内容时返回 null ===');
  const r5 = await offloader.offload('session-a', rewritten);
  check('无新增时返回 null', r5 === null, r5);

  console.log('\n=== 附加：推理兜底 offloadItems（不走行游标） ===');
  const reasoningItems = itemsFromTag(
    '结论：推理兜底必须只抽带结论标记的句子\n决策：改用 offloadItems 直接入库',
  );
  const r6 = await offloader.offloadItems(reasoningItems);
  check('offloadItems 直接入库', r6.distilled === 2 && r6.written + r6.merged === 2, r6);
  const r7 = await offloader.offloadItems(reasoningItems);
  check('offloadItems 重复内容被本地查重拦下', r7.distilled === 0 && r7.deduped === 2, r7);

  console.log('\n=== 附加：沉淀累计统计（lrc_status 用） ===');
  const stats = offloader.stats();
  check('统计有沉淀次数', stats.flushCount > 0, stats);
  check('统计累计写入 + 合并 > 0', stats.totalWritten + stats.totalMerged > 0, stats);
  check('统计累计查重 > 0', stats.totalDeduped > 0, stats);
  check('统计记录了最近一次时间', stats.lastFlushAt > 0, stats);
  check('统计查重窗口非空', stats.recentWindow > 0, stats);

  console.log('\n=== 附加：召回客户端（lrc_recall 的底层） ===');
  const recallClient = new LrcClient({ baseUrl });
  const recalled = await recallClient.recall('测试查询', { topK: 3 });
  check('recall 返回结果', recalled.memories.length > 0, recalled.memories.length);
  check('recall 遵守 top_k', recalled.memories.length <= 3, recalled.memories.length);
  check('recall 首条相关度为 1', recalled.memories[0]?.score_norm === 1, recalled.memories[0]);
  check('recall 带候选总数', recalled.total >= recalled.memories.length, recalled.total);
  const emptyRecall = await recallClient.recall('不存在的查询', { topK: 0 });
  check('recall top_k 为 0 时返回空', emptyRecall.memories.length === 0, emptyRecall.memories.length);

  console.log('\n=== 附加：纠错客户端（lrc_forget 的底层） ===');
  const forgot = await recallClient.forget('mem-1');
  check('forget 删除成功', forgot.deleted === true, forgot);
  const forgotAgain = await recallClient.forget('missing-id');
  check(
    'forget 幂等（已不存在）',
    forgotAgain.deleted === false && forgotAgain.alreadyDeleted === true,
    forgotAgain,
  );

  console.log('\n=== 附加：快照不再截到 40 字符 ===');
  const longBody = '这是一条很长的结论'.repeat(10);
  const snap = buildSnapshot(
    [{ content: `[结论] ${longBody}`, memory_type: 'fact', tags: [], importance: 6, source_turns: [0, 0] }],
    3,
  );
  check('快照保留完整结论', snap.includes(longBody), snap.length);

  console.log('\n=== 附加：快照实质变化判定（缓存命中率） ===');
  check(
    '相同快照不触发更新',
    snapshotChanged('[LRC 状态] A；B。', '[LRC 状态] A；B。') === false,
  );
  check(
    '仅空白差异不触发更新',
    snapshotChanged('[LRC 状态] A；B。', '[LRC 状态]  A；B。\n') === false,
  );
  check(
    '内容变化触发更新',
    snapshotChanged('[LRC 状态] A；B。', '[LRC 状态] A；C。') === true,
  );
  check('空 → 非空触发更新', snapshotChanged('', '[LRC 状态] A。') === true);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
