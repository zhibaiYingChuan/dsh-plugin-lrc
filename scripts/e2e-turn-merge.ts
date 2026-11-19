/**
 * 轮末合并（turn-boundary accumulation）的端到端验证。
 *
 * 用法：node scripts/e2e-turn-merge.ts
 *
 * ## 本测试守的是什么
 *
 * 折叠的「一批」原本等于「一条消息」，实测 845/993 批不足 4 条
 * （448 批只有 1 条）⇒ 折叠只在约 36% 的事实上生效。
 *
 * 本测试断言：正文抽取改为**轮内暂存**后，
 *   1. 单条消息到达时**不写库**（只暂存）
 *   2. 轮末一次冲刷时**折叠成 1 条**写入
 *   3. `turn/start` 能补写上一轮被中止的残留（真实会话里 turn 常被 aborted）
 *   4. 切会话时按归属冲刷，不串会话
 *   5. 无暂存时冲刷是空操作
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorStore } from '../src/cursor.ts';
import { Offloader } from '../src/offloader.ts';
import { LrcClient, type DistilledItem } from '../src/lrc-client.ts';
import type { MemoryFact } from '../src/memory-schema.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/** 构造一条 Fact（模拟 extractFacts 的产物）。 */
function fact(statement: string, kind: MemoryFact['kind'], sessionId: string, turn = 1): MemoryFact {
  return {
    kind,
    subject: '',
    predicate: '',
    value: '',
    statement,
    scope: 'project',
    origin: 'assistant',
    confidence: 0.9,
    source: { sessionId, turn },
    status: 'active',
    enriched: false,
  };
}

// mock LRC：只记录 migrate 收到了什么
const received: DistilledItem[][] = [];
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

const client = new LrcClient({ baseUrl: `http://127.0.0.1:${port}` });
const workDir = mkdtempSync(join(tmpdir(), 'lrc-turn-'));

// ────────────────────────────────────────────────────────────
// 1. 轮内暂存：不写库
// ────────────────────────────────────────────────────────────
console.log('=== 1) 轮内暂存不写库 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c1.json')), { project: 'demo' });
  received.length = 0;

  // 模拟 3 条消息，每条抽 2 条 Fact —— 真实形态：逐条触发
  off.accumulate([
    fact('标签栏里用的是 `<a>` 元素，不是 `<button>`', 'conclusion', 's1', 1),
    fact('真正的问题是排名序号被抬到了 24px', 'fact', 's1', 2),
  ]);
  off.accumulate([
    fact('榜单右侧的天数用 24px 是对的', 'decision', 's1', 3),
    fact('按层级规则，榜单昵称应该也提升一档', 'decision', 's1', 4),
  ]);
  off.accumulate([
    fact('榜单昵称是 12px，而右侧天数是 24px', 'conclusion', 's1', 5),
    fact('昵称保持 12px 是合适的', 'decision', 's1', 6),
  ]);

  check('暂存 6 条但未发起任何 migrate', received.length === 0, received.length);
  check('turnPending 报 6 条', off.turnPending('s1') === 6, off.turnPending('s1'));
  check('不指定 owner 时统计全部', off.turnPending() === 6, off.turnPending());
}

// ────────────────────────────────────────────────────────────
// 2. 轮末冲刷：折叠成 1 条
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 轮末冲刷折叠成 1 条 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c2.json')), { project: 'demo' });
  received.length = 0;
  for (let i = 0; i < 6; i += 1) {
    off.accumulate([
      fact(`第 ${i} 条碎片陈述，内容足够长以通过自足性检查。`, 'conclusion', 's1', i),
    ]);
  }
  const before = received.length;
  const result = await off.flushTurn('s1');
  check('冲刷前没有写入', before === 0, before);
  check('冲刷发起 1 次 migrate', received.length === 1, received.length);
  check('migrate 收到 1 条（6 条折叠）', received[0]?.length === 1, received[0]?.length);
  check('folded 记录覆盖 6 条', result.folded === 6, result.folded);
  check('distilled 记录原始 6 条', result.distilled === 6, result.distilled);
  check('冲刷后暂存清空', off.turnPending('s1') === 0, off.turnPending('s1'));
  const content = received[0]?.[0]?.content ?? '';
  check('摘要含条数说明', /本批 6 条/.test(content), content.slice(0, 30));
  check('摘要含成员内容', content.includes('第 0 条碎片'), content.slice(0, 80));
  check('tags 含 folded', (received[0]?.[0]?.tags ?? []).includes('folded'), received[0]?.[0]?.tags);
}

// ────────────────────────────────────────────────────────────
// 3. 无暂存时冲刷是空操作
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 无暂存时冲刷空操作 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c3.json')), { project: 'demo' });
  received.length = 0;
  const result = await off.flushTurn('no-such-session');
  check('不发 migrate', received.length === 0, received.length);
  check('返回零值结果', result.distilled === 0 && result.written === 0, result);
}

// ────────────────────────────────────────────────────────────
// 4. 按会话分桶，不串归属
// ────────────────────────────────────────────────────────────
console.log('\n=== 4) 按会话分桶 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c4.json')), { project: 'demo' });
  received.length = 0;
  off.accumulate([fact('A 会话的结论一，内容足够长。', 'conclusion', 'sessA', 1)]);
  off.accumulate([fact('A 会话的结论二，内容足够长。', 'conclusion', 'sessA', 2)]);
  off.accumulate([fact('B 会话的结论一，内容足够长。', 'conclusion', 'sessB', 1)]);
  off.accumulate([fact('B 会话的结论二，内容足够长。', 'conclusion', 'sessB', 2)]);

  check('两桶各 2 条', off.turnPending('sessA') === 2 && off.turnPending('sessB') === 2, {
    a: off.turnPending('sessA'),
    b: off.turnPending('sessB'),
  });

  await off.flushTurn('sessA');
  check('只冲刷 sessA：发出 1 次 migrate', received.length === 1, received.length);
  check('sessA 已清空', off.turnPending('sessA') === 0, off.turnPending('sessA'));
  check('sessB 仍然保留 2 条', off.turnPending('sessB') === 2, off.turnPending('sessB'));

  await off.flushTurn('sessB');
  check('再冲刷 sessB：共 2 次 migrate', received.length === 2, received.length);
  check('全部清空', off.turnPending() === 0, off.turnPending());
}

// ────────────────────────────────────────────────────────────
// 5. 不足 4 条不折叠（小批保持原样）
// ────────────────────────────────────────────────────────────
console.log('\n=== 5) 小批不折叠 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c5.json')), { project: 'demo' });
  received.length = 0;
  off.accumulate([fact('唯一一条结论，内容足够长以通过检查。', 'conclusion', 's1', 1)]);
  off.accumulate([fact('第二条结论，内容也足够长以通过检查。', 'decision', 's1', 2)]);
  const result = await off.flushTurn('s1');
  check('2 条：migrate 收到 2 条（不折叠）', received[0]?.length === 2, received[0]?.length);
  check('folded = 0', (result.folded ?? 0) === 0, result.folded);
}

// ────────────────────────────────────────────────────────────
// 6. 关闭折叠时轮末合并仍生效（只是不折叠）
// ────────────────────────────────────────────────────────────
console.log('\n=== 6) 关闭折叠时轮末合并仍生效 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c6.json')), {
    project: 'demo',
    foldEnabled: false,
  });
  received.length = 0;
  for (let i = 0; i < 6; i += 1) {
    off.accumulate([
      fact(`第 ${i} 条独立结论，内容足够长以通过自足性检查。`, 'conclusion', 's1', i),
    ]);
  }
  check('暂存期间不写库', received.length === 0, received.length);
  await off.flushTurn('s1');
  check('轮末一次 migrate', received.length === 1, received.length);
  check('foldEnabled=false 时逐条写入 6 条', received[0]?.length === 6, received[0]?.length);
}

// ────────────────────────────────────────────────────────────
// 7. ★critical 回归：flushTurn 必须先于 flush（否则折叠恒被去重清空）
//
// 这正是独立审查发现的 critical：`flush()` 会立即写碎片并把 statement
// 推进 `recent`，随后 `flushTurn` 的同批 statement 全部命中 isDuplicate，
// `distilled=0 / folded=0`，折叠**从未生效**且无任何报错。
//
// 此处不 mock index.ts 的事件时序，而是**直接复现那个顺序**来锁定机制：
// 先调用「碎片直写」（模拟旧顺序的 flush），再调 flushTurn，断言折叠失效。
// 反过来（先 flushTurn 再碎片直写）应看到折叠生效、碎片被去重。
// ────────────────────────────────────────────────────────────
console.log('\n=== 7) critical 回归：冲刷顺序 ===');
{
  const stmts = [
    '尺寸必须从 24 格画布搬到 16 格网格',
    '字号只能是 12 的倍数',
    '点阵字一旦被设成 13px 就不清晰',
    '阴影换成无偏移的硬投影',
  ];
  const makeAll = (sessionId: string) =>
    stmts.map((s, i) => fact(s, 'conclusion', sessionId, i));

  // ── 错误顺序：先碎片直写（模拟先 flush），再 flushTurn ──
  {
    const off = new Offloader(client, new CursorStore(join(workDir, 'c7a.json')), {
      project: 'demo',
    });
    received.length = 0;
    // 模拟 flush()：把同一批碎片直写（同时 recent 记住它们）
    // 注意 `offloadFacts` 自身也会折叠（4 条 → 1 条），所以直写也是 1 条
    await off.offloadFacts(makeAll('sA'));
    const directCount = received[0]?.length ?? 0;
    // 再冲刷暂存桶（桶里是同样的 statement）
    off.accumulate(makeAll('sA'));
    const after = await off.flushTurn('sA');
    check('错误顺序：碎片已入库', directCount >= 1, directCount);
    check(
      '错误顺序：flushTurn 被去重清空（folded=0，正是 critical 的症状）',
      (after.folded ?? 0) === 0 && after.distilled === 0,
      { folded: after.folded, distilled: after.distilled },
    );
    check('错误顺序：没有产生折叠摘要', received.length === 1, received.length);
  }

  // ── 正确顺序：先 flushTurn（折叠），再碎片直写 ──
  {
    const off = new Offloader(client, new CursorStore(join(workDir, 'c7b.json')), {
      project: 'demo',
    });
    received.length = 0;
    off.accumulate(makeAll('sB'));
    const folded = await off.flushTurn('sB');
    check('正确顺序：折叠生效', (folded.folded ?? 0) === 4, folded.folded);
    check('正确顺序：migrate 只收到 1 条摘要', received[0]?.length === 1, received[0]?.length);
    // 随后 flush() 再抽出的碎片应被去重拦下
    const before = received.length;
    const dup = await off.offloadFacts(makeAll('sB'));
    check('正确顺序：后续碎片全部被去重', dup.distilled === 0 && dup.deduped > 0, {
      distilled: dup.distilled,
      deduped: dup.deduped,
    });
    check('正确顺序：没有再写库', received.length === before, received.length - before);
  }
}

// ────────────────────────────────────────────────────────────
// 8. ★critical 回归：写库失败必须回桶（不得丢数据）
// ────────────────────────────────────────────────────────────
console.log('\n=== 8) critical 回归：写失败回桶 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c8.json')), {
    project: 'demo',
  });
  received.length = 0;
  // 四条陈述的**字符集必须互不重叠**，否则会被 `dedupeFacts` 判为近似重复
  // 而合并成 1 条（这一步发生在写库之前，与「写失败回桶」无关）。
  off.accumulate([
    fact('存储锁从互斥量换成读写锁以提升并发读性能', 'decision', 's1', 1),
    fact('侧车端口被外部进程占用导致启动长时间挂起', 'conclusion', 's1', 2),
    fact('嵌入模型默认值改为中文小模型以节省内存', 'decision', 's1', 3),
    fact('发布门禁要求全量测试通过才允许合并分支', 'constraint', 's1', 4),
  ]);
  // 让 migrate 失败：把 client 指向一个不存在的端口
  const broken = new LrcClient({ baseUrl: 'http://127.0.0.1:1' });
  off.bind(broken);
  const before = off.turnPending('s1');
  await off.flushTurn('s1');
  const after = off.turnPending('s1');
  check('写失败前暂存 4 条', before === 4, before);
  check('写失败后数据回到桶里（不丢）', after === 4, after);
  // 恢复连接后可正常写入
  off.bind(client);
  const retry = await off.flushTurn('s1');
  // 4 条折叠成 1 条摘要 ⇒ distilled 报的是原始 4 条
  check('恢复连接后重试成功（覆盖 4 条原始）', retry.distilled === 4, retry.distilled);
  check('重试后桶已清空', off.turnPending('s1') === 0, off.turnPending('s1'));
  check('重试产出 1 条摘要', retry.folded === 4, retry.folded);
}

// ────────────────────────────────────────────────────────────
// 9. 跨主题同轮：折叠成 1 条，但逐条保留各自 topic
// ────────────────────────────────────────────────────────────
console.log('\n=== 9) 跨主题同轮折叠 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c9.json')), {
    project: 'demo',
  });
  received.length = 0;
  // 两个主题各 4 条，字符集不重叠
  const jiaStmts = [
    '图标网格必须对齐到 16 的整数倍',
    '点阵字渲染需要关闭抗锯齿选项',
    '像素画布尺寸固定在 24 格',
    '描边宽度统一设定为一像素',
  ];
  const yiStmts = [
    '数据库迁移脚本需要支持回滚',
    '连接池上限配置为五十条',
    '慢查询阈值调整为两百毫秒',
    '备份任务每天凌晨执行一次',
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = fact(jiaStmts[i] as string, 'conclusion', 's1', i);
    a.topic = '图标像素排查';
    const b = fact(yiStmts[i] as string, 'decision', 's1', i);
    b.topic = '数据库运维';
    off.accumulate([a, b]);
  }
  check('同一会话桶共存 8 条', off.turnPending('s1') === 8, off.turnPending('s1'));
  await off.flushTurn('s1');
  check('折叠成 1 条摘要（按轮不按 topic）', received.length === 1, received.length);
  const content = received.flat()[0]?.content ?? '';
  check('两个主题的内容都在摘要里', content.includes('图标网格') && content.includes('连接池'), content.slice(0, 80));
  const tags = received.flat()[0]?.tags ?? [];
  check(
    '两个主题都落成标签',
    tags.includes('topic:图标像素排查') && tags.includes('topic:数据库运维'),
    tags,
  );
}

// ────────────────────────────────────────────────────────────
// 10. 回归：offload() 在折叠开启时**只转交**，不直接写库
// ────────────────────────────────────────────────────────────
//
// 实测缺陷（2026-11-17，DSH 新会话 20:37~20:40）：`flush()` 在 turn/end 调
// `offload()`，它每次只处理游标之后的一小段，往往只有 1~2 条 Fact，
// 凑不满 `foldMinFacts` ⇒ `toItems` 退化为逐条写入，绕过折叠。
// 症状：库里出现 18 字的孤立碎片（`像素画的动感只能靠逐帧切换`）。
console.log('\n=== 10) offload 折叠开启时只转交不写库 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c10.json')), {
    project: 'demo',
  });
  received.length = 0;
  // 两条短句（不足 foldMinFacts=4），模拟一次 flush 的实际产出
  const lines = [
    '像素画的动感只能靠逐帧切换',
    'CSS 缩放淡入不属于像素画的表现方式',
  ];
  const result = await off.offload('s10', lines);
  check('未直接写库', received.length === 0, received.length);
  check('已转交到本轮桶', (result?.deferred ?? 0) > 0 && off.turnPending('s10') > 0, {
    deferred: result?.deferred,
    pending: off.turnPending('s10'),
  });
  check('written 为 0（延后不是丢失）', result?.written === 0, result?.written);

  // 补足到 4 条后收口 ⇒ 应折叠成 1 条
  // 注意：上面的 `off.load` 经规则抽取器只产出 1 条 Fact（第一条措辞未命中谓词表，
  //       进 pending 而非 Fact），因此这里补 3 条凑满 foldMinFacts=4。
  const afterOffload = off.turnPending('s10');
  off.accumulate([
    fact('描边宽度统一为一像素', 'conclusion', 's10', 2),
    fact('兽的入场动画改用离散跳格', 'conclusion', 's10', 3),
    fact('缓存目录必须放在数据盘', 'constraint', 's10', 4),
  ]);
  check(
    `offload 产出 ${afterOffload} 条，补足后刚好 4 条`,
    off.turnPending('s10') === 4,
    off.turnPending('s10'),
  );
  await off.flushTurn('s10');
  check('收口时发 1 次 migrate', received.length === 1, received.length);
  check('收口后折叠成 1 条摘要', received[0]?.length === 1, received[0]?.length);
  check('全部暂存已清空', off.turnPending('s10') === 0, off.turnPending('s10'));
}

// ────────────────────────────────────────────────────────────
// 11. 回归：offloadFacts(deferToTurn) 不直接写库
// ────────────────────────────────────────────────────────────
//
// 覆盖推理兜底 / LLM 兜底这两条**不在 transcript 行流里**的路径。
// 实测新会话里 LLM 兜底一次写入 5 条互不相关的短句，正是这条绕过折叠。
console.log('\n=== 11) offloadFacts 支持延后到轮末 ===');
{
  const off = new Offloader(client, new CursorStore(join(workDir, 'c11.json')), {
    project: 'demo',
  });
  received.length = 0;
  const batch = [
    fact('现在的兽只有一个静止的点阵', 'statement', 's11', 1),
    fact('像素画的动感靠逐帧切换', 'conclusion', 's11', 1),
  ];
  const deferred = await off.offloadFacts(batch, { deferToTurn: true });
  check('延后：不发 migrate', received.length === 0, received.length);
  check('延后：distilled 记录条数', deferred.distilled === 2, deferred.distilled);
  check('延后：written 为 0', deferred.written === 0, deferred.written);
  check('延后：已进入本轮桶', off.turnPending('s11') === 2, off.turnPending('s11'));

  // 不传 deferToTurn ⇒ 保持立即写库（用户消息 / 补写路径依赖此行为）
  const immediate = await off.offloadFacts([
    fact('不要使用 3099 端口做实验', 'constraint', 's11', 2),
  ]);
  check('不延后：立即写库', received.length === 1, received.length);
  check('不延后：written > 0', immediate.written > 0, immediate.written);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

console.log('');
if (failed === 0) console.log('全部通过');
else {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
