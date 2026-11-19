/**
 * 同批折叠的端到端验证（真实碎片数据驱动）。
 *
 * 用法：node scripts/e2e-fold.ts
 *
 * ## 本测试的验收对象
 *
 * 不是「折叠函数能跑」，而是**它治的病灶确实退化了**：
 * 实测 session-95eaf7e3 一个会话写入 1515 条、长度中位数 33 字、
 * 19.3% ≤ 20 字。这里用同样的碎片形态构造批次，断言：
 *   1. 折叠后**条数**从 N 降到 1
 *   2. 折叠后**信息不丢**（每条成员的关键取值都还在正文里）
 *   3. 略去条数**显式标注**（不静默丢弃）
 *   4. 小批 / 关闭开关时**行为零变更**
 */
import { extractFacts } from '../src/memory-extract.ts';
import { foldFacts, foldTags, FOLD_MAX_CHARS, FOLD_MIN_FACTS_DEFAULT } from '../src/fold.ts';
import { Offloader } from '../src/offloader.ts';
import { CursorStore } from '../src/cursor.ts';
import type { DistilledItem } from '../src/lrc-client.ts';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// 1. 真实碎片批次（取自 session-95eaf7e3 的 11-16T04 连续样本）
// ────────────────────────────────────────────────────────────
console.log('=== 1) 真实碎片批次折叠 ===');
{
  // 这一段是「字号层级排查」，原文是连续推理，抽取器把它切成多条碎片。
  const raw = [
    '[结论] 标签页那几个没跑出来，原因是选择器没匹配上',
    '[结论] 标签栏里用的是 `<a>` 元素，不是 `<button>`，所以选择器写错了',
    '[事实] 说明那里有本该是 12px 的正文被误抬到了 24px',
    '[事实] 真正的问题是左侧的排名序号 `01`、`02` 被抬到了 24px',
    '[决策] 榜单右侧的天数用 24px 是对的，它是这一行的主要信息',
    '[决策] 按层级规则，榜单昵称应该也提升一档',
    '[结论] 但发现一个新问题：榜单昵称是 12px，而右侧天数是 24px',
    '[结论] 两者差一倍，昵称显得太弱',
    '[决策] 昵称保持 12px 是合适的，因为榜单里数字才是主角',
    '[约束] 必须先看到全部代价',
  ];
  const facts = raw.map((line) => {
    const head = /^\[([^\]]+)\]\s*/.exec(line);
    const label = head === null ? '' : head[1];
    const statement = head === null ? line : line.slice(head[0].length);
    // 前缀 → 真实 kind（不能全用 conclusion，否则重要性先验失真）
    const kind =
      label === '决策' ? ('decision' as const)
      : label === '约束' ? ('constraint' as const)
      : label === '事实' ? ('fact' as const)
      : ('conclusion' as const);
    return {
      kind,
      subject: '',
      predicate: '',
      value: '',
      statement,
      scope: 'project' as const,
      origin: 'assistant' as const,
      confidence: 0.9,
      source: { sessionId: 'session-95eaf7e3', turn: 7 },
      status: 'active' as const,
      enriched: false,
    };
  });

  const batch = foldFacts(facts);
  check('10 条碎片折叠成 1 条', batch !== null, batch === null ? null : 'null');
  if (batch !== null) {
    check('覆盖条数 = 10', batch.covered === 10, batch.covered);
    check('无长度截断（omitted = 0）', batch.omitted === 0, batch.omitted);
    const body = batch.fact.statement;
    console.log(`  折叠结果（${body.length} 字）：\n    ${body}`);
    // 信息不丢：每条的关键取值都应在摘要里
    for (const key of ['选择器', '`<a>`', '12px', '24px', '昵称', '全部代价']) {
      check(`摘要保留「${key}」`, body.includes(key), key);
    }
    check('摘要正文包含条数说明', /本批 10 条/.test(body), body.slice(0, 40));
    check('摘要正文不只有计数（长度 > 200）', body.length > 200, body.length);
    // 重要性取成员最大值：批次里有一条 constraint（基准 7），
    // 所以汇总分不得低于 conclusion 的基准 6。
    check('重要性不低于 constraint 基准（≥7）', batch.importance >= 7, batch.importance);
    // kind 取众数：本批 5 条结论 / 3 条决策 / 1 条事实 / 1 条约束 ⇒ conclusion
    check('kind 取众数（conclusion）', batch.fact.kind === 'conclusion', batch.fact.kind);
    check('标签含 folded', foldTags(batch).includes('folded'), foldTags(batch));
    check('标签含 fold:10', foldTags(batch).includes('fold:10'), foldTags(batch));
  }
}

// ────────────────────────────────────────────────────────────
// 2. 长度上限：超额必须显式标注，不静默丢
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 长度上限截断 ===');
{
  const long = Array.from({ length: 40 }, (_, i) => ({
    kind: 'conclusion' as const,
    subject: '',
    predicate: '',
    value: '',
    // 每条 120 字，40 条 = 4800 字，必然超过上限
    statement: `第 ${i} 条结论：${'这一段用来撑长度，确保触发截断逻辑。'.repeat(6)}`,
    scope: 'project' as const,
    origin: 'assistant' as const,
    confidence: 0.9,
    source: { sessionId: 's1', turn: i },
    status: 'active' as const,
    enriched: false,
  }));
  const batch = foldFacts(long, { maxChars: 1000 });
  check('超长批次仍折叠成 1 条', batch !== null);
  if (batch !== null) {
    check('摘要不超上限太多（含标注 ≤ 1100）', batch.fact.statement.length <= 1100, batch.fact.statement.length);
    check('略去条数 > 0', batch.omitted > 0, batch.omitted);
    check('显式标注「另有 N 条」', /另有 \d+ 条因长度上限未列出/.test(batch.fact.statement), batch.fact.statement.slice(-60));
    check('覆盖条数不等于全量（omitted 计入未列出）', batch.covered === 40, batch.covered);
  }
}

// ────────────────────────────────────────────────────────────
// 3. 小批 / 关闭开关：行为零变更
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 边界：小批不折叠 ===');
{
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'fact' as const,
      subject: '',
      predicate: '',
      value: '',
      statement: `第 ${i} 条互不相同的陈述，长度足够通过自足性检查。`,
      scope: 'project' as const,
      origin: 'assistant' as const,
      confidence: 0.9,
      source: { sessionId: 's1', turn: i },
      status: 'active' as const,
      enriched: false,
    }));
  check('2 条不折叠（返回 null）', foldFacts(make(2)) === null);
  check('3 条不折叠（低于默认 4）', foldFacts(make(3)) === null);
  check('4 条开始折叠', foldFacts(make(4)) !== null);
  check('minFacts=2 时 2 条折叠', foldFacts(make(2), { minFacts: 2 }) !== null);
  check('空批次返回 null', foldFacts([]) === null);
}

console.log('\n=== 4) 批内重复先去重再折叠 ===');
{
  const dup = [
    '结论是：迁移必须分块，每块 20 条',
    '结论是：迁移必须分块，每块 20 条。',
    '禁止连 3099 做测试，一律用 3111',
    '禁止连 3099 做测试，测试一律用 3111',
    '不要用 unwrap，请求路径禁止 panic',
  ].map((statement, i) => ({
    kind: 'conclusion' as const,
    subject: '',
    predicate: '',
    value: '',
    statement,
    scope: 'project' as const,
    origin: 'assistant' as const,
    confidence: 0.9,
    source: { sessionId: 's1', turn: i },
    status: 'active' as const,
    enriched: false,
  }));
  const batch = foldFacts(dup);
  check('5 条含 2 组复述，去重后仍折叠', batch !== null);
  if (batch !== null) {
    console.log(`  去重后覆盖 ${batch.covered} 条（原 5 条）`);
    check('复述被合并（covered < 5）', batch.covered < 5, batch.covered);
    const occurrences = (batch.fact.statement.match(/迁移必须分块/g) ?? []).length;
    check('同一结论在摘要里只出现一次', occurrences === 1, occurrences);
  }
}

// ────────────────────────────────────────────────────────────
// 5. 走真实 Offloader：migrate 入参条数确实下降
// ────────────────────────────────────────────────────────────
console.log('\n=== 5) Offloader 写库条数下降（端到端） ===');
{
  let received: DistilledItem[][] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/context/migrate') {
        const parsed = JSON.parse(body) as { items: DistilledItem[] };
        received.push(parsed.items);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ written: parsed.items.length, merged: 0, failed: 0 }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const { LrcClient } = await import('../src/lrc-client.ts');
  const client = new LrcClient({ baseUrl: `http://127.0.0.1:${port}` });
  const workDir = mkdtempSync(join(tmpdir(), 'lrc-fold-'));

  // 10 条真实多句消息 → 抽取器产出多条 Fact
  const lines = [
    '结论是：迁移必须分块，每块 20 条。不要用 unwrap，请求路径上禁止 panic。',
    '禁止连 3099 做测试，测试一律用 3111。决定用 pnpm 替代 npm，因为依赖解析更快。',
    '决定把提炼引擎放在 Layer 1，零外部依赖。统一用 UTF-8 with BOM 保存脚本。',
    '结论是：长任务必须按步数兜底，不能只按正文消息数。约束是必须先看到全部代价。',
    '决定改用显式 UTF-8 读取，避免默认编码吞字符。禁止在 3099 上跑测试数据。',
  ];

  // 折叠开启（默认）
  //
  // ## 语义已变（2026-11-17）：`offload()` 只转交，折叠发生在 `flushTurn`
  //
  // 实测缺陷：`offload()` 每次只处理游标之后的一小段，往往 1~2 条，
  // 凑不满 foldMinFacts ⇒ 退化为逐条碎片入库。改为转交轮末桶后，
  // 折叠由 `flushTurn` 统一执行（这也让跨 `offload` 调用的一轮能合成一批）。
  const on = new Offloader(client, new CursorStore(join(workDir, 'c1.json')), { project: 'demo' });
  received = [];
  const rOn = await on.offload('s-on', lines);
  const itemsDeferred = received.flat();
  check('折叠开启：offload 不写库（转交轮末）', itemsDeferred.length === 0, itemsDeferred.length);
  check('折叠开启：distilled 记录原始条数（>1）', (rOn?.distilled ?? 0) > 1, rOn?.distilled);
  check(
    '折叠开启：deferred 记录转交条数',
    (rOn?.deferred ?? 0) === (rOn?.distilled ?? -1),
    rOn?.deferred,
  );
  // 轮末收口 ⇒ 折叠成 1 条
  received = [];
  const rFlush = await on.flushTurn('s-on');
  const itemsOn = received.flat();
  check('轮末收口：migrate 收到 1 条', itemsOn.length === 1, itemsOn.length);
  check(
    '轮末收口：folded 字段 = 覆盖条数',
    (rFlush.folded ?? 0) === (rOn?.distilled ?? -1),
    rFlush.folded,
  );

  // 折叠关闭（对照）
  const off = new Offloader(client, new CursorStore(join(workDir, 'c2.json')), {
    project: 'demo',
    foldEnabled: false,
  });
  received = [];
  const rOff = await off.offload('s-off', lines);
  const itemsOff = received.flat();
  console.log(`  折叠开：distilled=${rOn?.distilled} → migrate 收到 ${itemsOn.length} 条`);
  console.log(`  折叠关：distilled=${rOff?.distilled} → migrate 收到 ${itemsOff.length} 条`);
  check('折叠关闭：migrate 收到多条（与原行为一致）', itemsOff.length > 1, itemsOff.length);
  check('折叠关闭：条数 = distilled', itemsOff.length === (rOff?.distilled ?? -1), {
    items: itemsOff.length,
    distilled: rOff?.distilled,
  });
  check('折叠确实减少了写入条数', itemsOn.length < itemsOff.length, {
    on: itemsOn.length,
    off: itemsOff.length,
  });

  // 折叠后内容带审计标签
  if (itemsOn.length === 1) {
    const tags = itemsOn[0]?.tags ?? [];
    check('写入条目带 folded 标签', tags.includes('folded'), tags);
    check('写入条目带 fold:N 标签', tags.some((t) => /^fold:\d+$/.test(t)), tags);
    // 空壳判据：LRC 现有合成层的空壳是「只写计数不写内容」（17~46 字）。
    // 这里要求摘要必须显著长于那个形态，且含成员陈述。
    const content = itemsOn[0]?.content ?? '';
    check('写入内容非空壳（含成员陈述）', content.length > 100 && content.includes('；'), content.length);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ────────────────────────────────────────────────────────────
// 6. 默认值守卫
// ────────────────────────────────────────────────────────────
console.log('\n=== 6) 常量守卫 ===');
{
  check('FOLD_MIN_FACTS_DEFAULT = 4', FOLD_MIN_FACTS_DEFAULT === 4, FOLD_MIN_FACTS_DEFAULT);
  check('FOLD_MAX_CHARS = 2000', FOLD_MAX_CHARS === 2000, FOLD_MAX_CHARS);
}

console.log('');
if (failed === 0) console.log('全部通过');
else {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
