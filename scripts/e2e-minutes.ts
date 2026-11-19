/**
 * 会话纪要端到端测试。
 *
 * 覆盖：
 *   1. 纪要生成：轮次/时间线/诉求演进/关键结论
 *   2. 时序：写入带 source_timestamp_ms（真实发生时间，不是写入时刻）
 *   3. 覆盖：同 event_id 重复写入 → mock 按 event_id 覆盖
 *      （⚠ 这是**简化 mock**：真实 LRC 是「Jaccard ≥ 0.5 才合并」，
 *        合并/新建两条路径的覆盖见 `e2e-minutes-integration.ts` 第 20/21 段）
 *   4. 中断轮次：aborted / error 也进纪要
 *   5. 边界：无轮次 / 全空轮 / 过短结论
 *
 * 用 mock LRC（进程内 http server），测的是插件逻辑而非 LRC 实现。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LrcClient } from '../src/lrc-client.ts';
import {
  buildMinutes,
  canOverwriteMinutes,
  isUsableConclusion,
  MinutesLedgerStore,
  minutesEventId,
  minutesSimilarity,
  minutesTags,
  parseMinutesEndedAt,
  parseMinutesStartedAt,
  parseMinutesTurns,
  shouldRewriteMinutes,
  writeMinutes,
  type MinutesLedgerState,
  type TurnRecord,
} from '../src/session-minutes.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name} -> ${JSON.stringify(detail)}`);
  }
}

// ── mock LRC：实现 /v1/memories/remember，按 event_id 覆盖 ──
interface Stored {
  memory_id: string;
  content: string;
  tags: string[];
  importance: number;
  event_id: string | null;
  created_at_ms: number;
  memory_type: string;
  project: string | null;
}
const store = new Map<string, Stored>(); // event_id → 记录
let rememberCalls = 0;
// 初始值写成 `undefined as …` 而不是 `null`：TS 的控制流分析看不到
// 「回调里赋值」，若初值是 `null` 字面量会把变量窄化成 `null` 类型，
// 下面所有 `lastBody?.x` 都会变成「在 never 上取属性」。
let lastBody: Record<string, unknown> | null = undefined as unknown as Record<
  string,
  unknown
> | null;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/memories/remember') {
      rememberCalls += 1;
      const b = JSON.parse(body) as {
        content: string; memory_type: string; tags?: string[]; importance?: number;
        event_id?: string; source_timestamp_ms?: number; project?: string;
      };
      lastBody = b as unknown as Record<string, unknown>;
      const key = b.event_id ?? `nokey-${rememberCalls}`;
      const existing = store.get(key);
      // 与 LRC 实测语义一致：同 event_id 覆盖，memory_id 不变
      const memoryId = existing?.memory_id ?? `mem-${store.size + 1}`;
      store.set(key, {
        memory_id: memoryId,
        content: b.content,
        tags: b.tags ?? [],
        importance: b.importance ?? 5,
        event_id: b.event_id ?? null,
        // 关键：mock 也遵守 source_timestamp_ms（LRC 实测行为）
        created_at_ms: b.source_timestamp_ms ?? Date.now(),
        memory_type: b.memory_type,
        project: b.project ?? null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, memory_id: memoryId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
const client = new LrcClient({ baseUrl: `http://127.0.0.1:${port}` });
const workDir = mkdtempSync(join(tmpdir(), 'lrc-minutes-'));

const SESSION = 'session-abc12345';

function turn(
  idx: number,
  startedAt: number,
  userText: string,
  conclusions: string[],
  reason = 'completed',
): TurnRecord {
  return { idx, startedAt, endedAt: startedAt + 600_000, reason, userText, conclusions };
}

try {
  // ── 1. 纪要生成 ──
  console.log('=== 1) 纪要生成 ===');
  {
    const t0 = Date.parse('2026-11-14T03:27:35Z');
    const turns: TurnRecord[] = [
      turn(1, t0, '产品完整文档：反向德西效应、水墨像素、强社交共修戒瘾系统', [
        '服务端选了零额外依赖方案，因为部署只需 Node 一个程序',
      ]),
      turn(2, t0 + 3600_000, '所有图标要用 SVG 绘制出来，不要简单文字', [
        '每个图标盒子都用 color 着色，再通过状态类切换',
      ]),
      turn(3, t0 + 7200_000, '整体上你画的还是太抽象了', [
        '兽的入场用 CSS 缩放淡入是错的，因为平滑过渡会让像素画糊成一团',
      ], 'aborted'),
    ];
    const draft = buildMinutes(SESSION, turns);
    check('生成了纪要', draft !== null, draft);
    if (draft !== null) {
      check('纪要含标题', draft.content.includes(`【会话纪要】${SESSION}`), draft.content.slice(0, 80));
      check('纪要含时间线范围', draft.content.includes('本地时间'), draft.content.slice(0, 160));
      check('纪要含诉求演进段', draft.content.includes('## 诉求演进'), '');
      check('纪要含关键结论段', draft.content.includes('## 关键结论'), '');
      check('诉求逐轮保留（含改写需求）', draft.content.includes('所有图标要用 SVG'), '');
      check('中止轮次被标注', draft.content.includes('（aborted）'), '');
      check('起点时间 = 首轮开始', draft.startedAt === t0, { got: draft.startedAt, want: t0 });
      check('轮数正确', draft.turns === 3, draft.turns);
      check('结论数 > 0', draft.conclusions > 0, draft.conclusions);
      check('含因果的结论优先排在前', draft.content.includes('因为平滑过渡'), '');
    }
  }

  // ── 2. 结论筛选 ──
  console.log('\n=== 2) 结论筛选判据 ===');
  {
    check('英文自述被拒', isUsableConclusion('Let me read those specific spots and check') === false);
    check('过短被拒', isUsableConclusion('改成了两种实色') === false);
    check('中文占比过低的被拒', isUsableConclusion('hover state var iron ok but need check twice') === false);
    check('含因果的中文结论被收', isUsableConclusion('兽的入场用 CSS 缩放是错的，因为平滑过渡会让像素画糊成一团') === true);
    check('含决策的中文结论被收', isUsableConclusion('图标改成真正的逐帧动画，先看清现有结构再动手') === true);
    // ## 过程叙述不归这一层管
    //
    // `isUsableConclusion` 的输入是**已经过上游提取器裁决的 Fact**，
    // 过程叙述（「我先看一下…」）在 `extractFacts` 里就被拒了。
    // 本层只做「英文自述 / 机器输出 / 超长超短」这类**形态**过滤，
    // 若在这一层再判一次语义，就形成「同一判据两处各判一次」的双裁判。
    check(
      '过程叙述不在本层判（交给上游提取器）',
      isUsableConclusion('我先看一下现有的代码结构是什么样的再决定') === true,
    );
  }

  // ── 3. 边界：空轮 / 无内容 ──
  console.log('\n=== 3) 边界情况 ===');
  {
    check('无轮次返回 null', buildMinutes(SESSION, []) === null);
    const empty = buildMinutes(SESSION, [turn(1, Date.now(), '', [])]);
    check('全空轮返回 null', empty === null, empty);
    const noConclusion = buildMinutes(SESSION, [turn(1, Date.parse('2026-01-01T00:00:00Z'), '继续推进', [])]);
    check('只有诉求也能生成纪要', noConclusion !== null, noConclusion);
    if (noConclusion !== null) {
      check('无结论时不输出空结论段', !noConclusion.content.includes('## 关键结论'), '');
    }
  }

  // ── 4. 写入时序 ──
  console.log('\n=== 4) 写入带真实发生时间 ===');
  {
    store.clear();
    rememberCalls = 0;
    const t0 = Date.parse('2026-11-14T03:27:35Z');
    const turns = [turn(1, t0, '所有图标要用 SVG 绘制', ['图标改用像素点阵，因为 SVG 路径在 16px 下会糊'])];
    const result = await writeMinutes(client, SESSION, turns, { project: 'dsh' });
    check('写入成功', result.written === true, result);
    check('发起了 1 次 remember', rememberCalls === 1, rememberCalls);
    check('请求体带 source_timestamp_ms', lastBody?.source_timestamp_ms === t0, lastBody?.source_timestamp_ms);
    check('请求体 event_id 是会话级', lastBody?.event_id === minutesEventId(SESSION), lastBody?.event_id);
    check('请求体 memory_type=conversation', lastBody?.memory_type === 'conversation', lastBody?.memory_type);
    check('请求体 importance=9', lastBody?.importance === 9, lastBody?.importance);
    check('标签含 session-minutes', (lastBody?.tags as string[] | undefined)?.includes('session-minutes') === true, lastBody?.tags);

    const stored = store.get(minutesEventId(SESSION));
    check('落库时间 = 真实发生时间（非写入时刻）', stored?.created_at_ms === t0, {
      got: stored?.created_at_ms,
      want: t0,
      now: Date.now(),
    });
  }

  // ── 5. 同会话覆盖 ──
  //
  // ⚠ 本 mock 按 `event_id` 覆盖（简化）。真实 LRC 是「内容 Jaccard ≥ 0.5
  // 才合并、否则新建」，两条路径的行为差异由集成测试第 20/21 段验证。
  console.log('\n=== 5) 同会话写入（mock 覆盖语义）===');
  {
    const before = store.size;
    const t0 = Date.parse('2026-11-14T03:27:35Z');
    const more = [
      turn(1, t0, '所有图标要用 SVG 绘制', ['图标改用像素点阵，因为 SVG 路径在 16px 下会糊']),
      turn(2, t0 + 3600_000, '兽画的太难看', ['兽的呼吸必须让头部单独移动，因为整体平移读不出呼吸']),
    ];
    const result = await writeMinutes(client, SESSION, more, { project: 'dsh' });
    check('第二次写入成功（mock 覆盖语义）', result.written === true, result);
    check('库内条数不变（mock 按 event_id 覆盖）', store.size === before, { before, after: store.size });
    const stored = store.get(minutesEventId(SESSION));
    check('内容已更新为 2 轮', stored?.content.includes('2 轮') === true, stored?.content.slice(0, 100));
    check('新增结论已包含', stored?.content.includes('呼吸') === true, '');
  }

  // ── 6. 会话隔离 ──
  console.log('\n=== 6) 不同会话不互相覆盖 ===');
  {
    const before = store.size;
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    const other = [turn(1, t0, '另一个会话的任务', ['另一个会话的结论，因为原因不同'])];
    await writeMinutes(client, 'session-other999', other, { project: 'dsh' });
    check('新会话新增一条（不覆盖旧会话）', store.size === before + 1, { before, after: store.size });
    check('两个会话的 event_id 不同', minutesEventId(SESSION) !== minutesEventId('session-other999'), '');
  }

  // ── 7. 标签 ──
  console.log('\n=== 7) 标签 ===');
  {
    const tags = minutesTags(SESSION);
    check('含 session-minutes', tags.includes('session-minutes'), tags);
    check('含 session:<id>', tags.includes(`session:${SESSION}`), tags);
    check('含 timeline', tags.includes('timeline'), tags);
  }

  // ── 8. 上限保护 ──
  console.log('\n=== 8) 上限保护 ===');
  {
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    const many: TurnRecord[] = [];
    for (let i = 0; i < 60; i += 1) {
      many.push(turn(i + 1, t0 + i * 60_000, `第 ${i + 1} 轮的需求描述内容`, [`第 ${i + 1} 轮的结论，因为要验证上限`]));
    }
    const draft = buildMinutes(SESSION, many);
    check('轮次行数被限制', draft !== null && draft.content.split('\n').filter((l) => l.startsWith('- ') && l.includes('轮的需求')).length <= 40, '');
    check('结论条数被限制', draft !== null && draft.conclusions <= 24, draft?.conclusions);
  }

  // ── 9. 回归 C1：账本饱和后触发仍生效 ──
  //
  // 独立审查 C1 实测：用 `turnLedger.length` 判增量时，账本在 40 轮饱和，
  // `40 - 40 = 0 < every` ⇒ 第 41 轮起永久不再写（120 轮会话 67% 缺失）。
  // 修法是改单调计数器 `archivedTurns`。这里锁住判定逻辑本身。
  console.log('\n=== 9) 回归 C1：饱和后仍能触发 ===');
  {
    const EVERY = 20;
    const MAX = 40;
    let ledger = 0;
    let archived = 0;
    let writtenAt = -1;
    const writes: number[] = [];
    for (let t = 1; t <= 120; t += 1) {
      ledger = Math.min(ledger + 1, MAX);
      archived += 1;
      const delta = archived - writtenAt;
      const shouldWrite = writtenAt < 0 ? ledger >= EVERY : delta >= EVERY;
      if (!shouldWrite) continue;
      writes.push(t);
      writtenAt = archived;
    }
    check('120 轮会话写入次数 > 2（旧实现只有 2 次）', writes.length > 2, writes);
    check('第 40 轮之后仍有写入', writes.some((w) => w > 40), writes);
    check('写入间隔稳定为 20 轮', writes.length >= 2 && (writes[1] as number) - (writes[0] as number) === EVERY, writes);
    check('最后一次写入接近末轮（损失 ≤ every 轮）', 120 - Math.max(...writes) < EVERY, {
      last: Math.max(...writes),
    });
  }

  // ── 10. 回归 M1：不再用「因为/决定」做准入 ──
  //
  // 首版用 WHY_SIGNAL || DECISION_SIGNAL 做门槛，实测误杀这些真结论：
  //   「数据库连接池上限是 20，当前峰值 18」
  //   「端口 3099 被旧进程占用，新实例起不来」
  console.log('\n=== 10) 回归 M1：无误杀 / 无误放行 ===');
  {
    check(
      '不含因果词的量化结论被收',
      isUsableConclusion('数据库连接池上限是 20，当前峰值 18') === true,
    );
    check(
      '不含因果词的根因被收',
      isUsableConclusion('端口 3099 被旧进程占用，新实例起不来') === true,
    );
    check(
      '中英混排技术句被收（旧版 0.4 阈值会误杀）',
      isUsableConclusion('构建产物写入 dist/index.js，体积 1.2MB') === true,
    );
    check('工具回显被拒', isUsableConclusion('结果：The file has been updated successfully') === false);
    check('JSON 片段被拒', isUsableConclusion('{"error":"not_found","code":404,"detail":"missing"}') === false);
    check('错误堆栈被拒', isUsableConclusion('Error: old_string was not found in break.css') === false);
    check('纯英文自述被拒', isUsableConclusion('Let me check the current state of that file') === false);
  }

  // ── 11. 回归 M7：时间渲染统一（不混 UTC 与本地）──
  console.log('\n=== 11) 回归 M7：时间不混时区 ===');
  {
    const t0 = Date.parse('2026-11-14T03:27:35Z');
    const draft = buildMinutes(SESSION, [turn(1, t0, '测试诉求', ['测试结论，因为要验证时区'])]);
    check('头部不含 UTC 的 Z 后缀', draft !== null && !draft.content.includes('T03:27:35Z'), draft?.content.slice(0, 120));
    check('头部标注本地时间', draft !== null && draft.content.includes('本地时间'), '');
    check('时间行与诉求行时区一致（同一时刻渲染相同）', draft !== null && draft.content.split('\n').filter((l) => l.includes('2026-11-14')).length >= 1, '');
  }

  // ── 12. 回归 m6/M1：去重键不被截断误合并 ──
  console.log('\n=== 12) 回归 m6/M1：尾部差异不被误合并 ===');
  {
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    const prefix = '图标尺寸必须严格遵守这条规则：固定为';
    const t: TurnRecord[] = [
      turn(1, t0, '图标规格', [`${prefix}十六像素整`]),
      turn(2, t0 + 60_000, '图标规格', [`${prefix}二十四像素`]),
    ];
    const draft = buildMinutes(SESSION, t);
    const count = draft === null ? 0 : draft.content.split('\n').filter((l) => l.startsWith('- ') && l.includes('图标尺寸')).length;
    check('同前缀不同尾部保留为两条', count === 2, count);

    // M1 的反向证伪：两条陈述**超过 120 字**且差异只在尾部。
    // 首版把去重键算在 `oneLine(raw,120)` 上，`norm.length > 120` 永不成立，
    // 长句会被按「前 119 字 + 省略号」判成同一条 → 只剩 1 条。
    const longA = `${'这说明该方案在当前代码结构下是可行的，'.repeat(6)}结论甲：缓存键用 hash`;
    const longB = `${'这说明该方案在当前代码结构下是可行的，'.repeat(6)}结论甲：缓存键用 mtime`;
    const longDraft = buildMinutes(SESSION, [
      turn(1, t0, '长句去重', [longA]),
      turn(2, t0 + 60_000, '长句去重', [longB]),
    ]);
    const longCount =
      longDraft === null
        ? 0
        : longDraft.content.split('\n').filter((l) => l.startsWith('- ') && l.includes('结论甲')).length;
    check('超 120 字且尾部不同的结论保留为两条（旧实现只剩一条）', longCount === 2, {
      count: longCount,
      lenA: longA.length,
      excerpt: longDraft?.content.slice(-260),
    });
  }

  // ── 13. 回归 M2：更多机器输出形态被拒 ──
  console.log('\n=== 13) 回归 M2：机器输出形态 ===');
  {
    check('已读取文件：被拒', isUsableConclusion('已读取文件：src/index.ts') === false);
    check('共修改 N 个文件被拒', isUsableConclusion('共修改 3 个文件，涉及图标与配色') === false);
    check('执行结果：被拒', isUsableConclusion('执行结果：构建成功，产物 251.9kb') === false);
    // 反向：正常结论不能被这些规则误杀
    check(
      '正常结论不被误杀',
      isUsableConclusion('端口 3099 被旧进程占用，新实例起不来') === true,
    );
  }

  // ── 14. 回归 C2：账本落盘 + 只增不减闸门 ──
  //
  // 独立审查 C2 的核心：内存账本一重启就归零，导致「1 轮纪要覆盖 22 轮纪要」。
  // 这里同时验证落盘/恢复与写入闸门两个机制。
  console.log('\n=== 14) 回归 C2：账本落盘 + 只增不减 ===');
  {
    const ledgerDir = join(workDir, 'minutes');
    const ledgerStore = new MinutesLedgerStore(ledgerDir);
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    const turns: TurnRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      turns.push(turn(i + 1, t0 + i * 60_000, `第 ${i + 1} 轮诉求`, [`第 ${i + 1} 轮的结论，因为要验证落盘`]));
    }
    const state: MinutesLedgerState = {
      sessionId: SESSION,
      turns,
      archivedTurns: 8,
      writtenAtArchived: 5,
      startedAt: t0,
      writtenTurns: 5,
      memoryId: 'mem-previous',
      updatedAt: 0,
    };
    ledgerStore.save(state);
    const restored = ledgerStore.load(SESSION);
    check('账本可落盘并恢复', restored !== null, restored === null);
    check('恢复的轮次完整（8 轮）', restored?.turns.length === 8, restored?.turns.length);
    check('恢复的归档计数正确', restored?.archivedTurns === 8, restored?.archivedTurns);
    check('恢复的已写入轮数正确', restored?.writtenTurns === 5, restored?.writtenTurns);
    check(
      '恢复的首轮时间正确（source_timestamp 不变）',
      restored?.startedAt === t0,
      restored?.startedAt,
    );
    // memoryId 必须往返（六轮 M-A 的修复依据：用它删掉过时重复纪要）
    check('恢复的记忆 ID 正确', restored?.memoryId === 'mem-previous', restored?.memoryId);

    // 归属校验：把 A 的文件内容当成 B 读，必须返回 null（不能串会话）
    check('归属不符时拒绝恢复', ledgerStore.load('session-other999') === null);

    // 闸门（参数是**单调的归档轮数**，不是账本长度；第三参必填）
    const MAX = 40;
    check('更短的稿被闸门拦下（8 → 3）', canOverwriteMinutes(8, 3, MAX) === false);
    check('等长的稿允许覆盖', canOverwriteMinutes(8, 8, MAX) === true);
    check('更长的稿允许覆盖', canOverwriteMinutes(8, 12, MAX) === true);
    check('从未写过（-1）时放行', canOverwriteMinutes(-1, 1, MAX) === true);
    // 饱和：轮数不再可比，必须放行（否则第 41 轮起永不写）
    check('饱和（40/40）时放行', canOverwriteMinutes(MAX, MAX, MAX) === true);
    check('饱和后继续增长仍放行', canOverwriteMinutes(MAX, MAX + 1, MAX) === true);

    // 单调进度判据（二轮审查 X1 的根治）：与账本长度无关
    check('从未写过且有轮次 ⇒ 值得写', shouldRewriteMinutes(3, -1) === true);
    check('无轮次且从未写过 ⇒ 不写', shouldRewriteMinutes(0, -1) === false);
    check('新增归档轮次 ⇒ 值得写', shouldRewriteMinutes(6, 5) === true);
    check('没有新增 ⇒ 不写', shouldRewriteMinutes(5, 5) === false);
    // 反向证伪：饱和场景下 archivedTurns 继续增长，判据仍然有效
    check('饱和后 archivedTurns 增长仍值得写', shouldRewriteMinutes(120, 119) === true);

    // 清理与裁剪
    ledgerStore.clear(SESSION);
    check('清理后不再能恢复', ledgerStore.load(SESSION) === null);
  }

  // ── 15. 回归 M6：endedAt 取最后一次活动，不是归档时刻 ──
  //
  // `turn/end` 丢失时按 `turn/start` 兜底归档。若 `endedAt = Date.now()`，
  // 会记成「下一轮开始时刻」，时间线出现跨轮重叠。这里用 `startedAtOverride`
  // 之外的另一条入口验证：`buildMinutes` 的头部范围由各轮 endedAt 决定。
  console.log('\n=== 15) 回归 M6：时间线不自相矛盾 ===');
  {
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    const draft = buildMinutes(
      SESSION,
      [
        { idx: 1, startedAt: t0, endedAt: t0 + 60_000, reason: 'no-end', userText: '第一轮', conclusions: [] },
        { idx: 2, startedAt: t0 + 120_000, endedAt: t0 + 180_000, reason: 'completed', userText: '第二轮', conclusions: [] },
      ],
      undefined,
      t0,
    );
    check('结束时间不早于开始时间', draft !== null && draft.endedAt > draft.startedAt, {
      startedAt: draft?.startedAt,
      endedAt: draft?.endedAt,
    });
    // 反向证伪：若 endedAt 被记成下一轮开始时刻（t0+120000），
    // 总时长会变成 3 分钟而不是 1 分钟
    check('总时长取自各轮真实结束（1 分钟窗口 + 间隔）', draft !== null && draft.endedAt === t0 + 180_000, draft?.endedAt);
  }

  // ── 16. C2 补充：startedAt 恒取首次观测时间 ──
  //
  // 账本有 40 轮上限，早期轮次会被淘汰。若 `startedAt` 取 `turns[0]`，
  // 长会话写入的 `source_timestamp_ms` 会随时间**向后漂移** ——
  // 同一份纪要每次写入的时间戳都不同，时序彻底失真。
  console.log('\n=== 16) C2 补充：source_timestamp 不漂移 ===');
  {
    const realStart = Date.parse('2026-11-14T00:00:00Z');
    const keptFirst = realStart + 3600_000; // 前 1 小时的轮次已被淘汰
    const draft = buildMinutes(
      SESSION,
      [turn(20, keptFirst, '晚期诉求', ['晚期结论，因为要验证不漂移'])],
      undefined,
      realStart,
    );
    check(
      '首次观测时间被尊重（不取账本首轮）',
      draft?.startedAt === realStart,
      { got: draft?.startedAt, want: realStart },
    );
    const noOverride = buildMinutes(
      SESSION,
      [turn(20, keptFirst, '晚期诉求', ['晚期结论，因为要验证不漂移'])],
    );
    check(
      '未传 override 时退回账本首轮',
      noOverride?.startedAt === keptFirst,
      noOverride?.startedAt,
    );
  }
  // ── 17. 基线合并（grow-only）──
  //
  // ## 为什么必须是「合并」而不是「拦下」（六钥匙裁决）
  //
  // LRC 合并走 `apply_merge` → `update_content`（**整体替换**）。所以：
  // ```
  // 库里 12 轮；本轮只观测到 1 轮（回到旧主题 / 账本丢失后重放）
  // 拦下 ⇒ 本轮真实对话永远进不了库（违背「持续性」）
  // 放行 ⇒ 库里 12 轮被换成 1 轮（不可逆）
  // ```
  // 拼接让两者同时成立：发出的 content 一定是基线那段内容的**超集**。
  console.log('\n=== 17) 基线合并（grow-only）===');
  {
    store.clear();
    rememberCalls = 0;
    const t0 = Date.parse('2026-11-16T00:00:00Z');
    const longTurns: TurnRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      longTurns.push(
        turn(
          i + 1,
          t0 + i * 60_000,
          `第 ${i + 1} 轮的长篇诉求陈述，用于把纪要撑到足够长`,
          [`第 ${i + 1} 条结论，因为要撑足字符数才能测出覆盖风险`],
        ),
      );
    }
    const longDraft = buildMinutes(SESSION, longTurns);
    const longTurnsCount = longDraft?.turns ?? 0;
    const longContent = longDraft?.content ?? '';
    check('长稿已生成（12 轮）', longTurnsCount === 12, longTurnsCount);

    // ── 场景 A：回到旧主题，只观测到 1 轮 ──
    //
    // 这是最关键的一条：以前会「拦下」导致这 1 轮进不了库。
    // 现在应该写出一份 **12 + 1 = 13 行**的稿，且保留全部旧行。
    const extraTurn = turn(13, t0 + 30 * 60_000, '回到旧话题：补充第 13 轮的诉求', [
      '第 13 条结论，因为要验证追加不丢旧内容',
    ]);
    const sim = minutesSimilarity(
      longContent,
      buildMinutes(SESSION, [extraTurn])?.content ?? '',
    );
    check('前提：新稿与库内那段相似度 ≥ 0.5（LRC 会合并）', sim >= 0.5, sim);

    const merged = await writeMinutes(client, SESSION, [extraTurn], {
      project: 'dsh',
      existingSegments: [{ turns: longTurnsCount, content: longContent }],
    });
    check('回到旧主题时**写入**（不再拦下）', merged.written === true, merged);
    check('确实发起了 remember', rememberCalls === 1, rememberCalls);
    // 库内那段的所有诉求行都必须在
    const oldLines = longContent.split('\n').filter((l) => l.startsWith('- ') && l.includes('轮的'));
    const missingOld = oldLines.filter((l) => !merged.content.includes(l));
    check('库内那段的诉求行全部保留（一个字都没丢）', missingOld.length === 0, {
      missing: missingOld.slice(0, 3),
      total: oldLines.length,
    });
    check('本轮新增行也在', merged.content.includes('回到旧话题'), merged.content.slice(-200));
    check('轮数已增长（12 → 13）', merged.turns === 13, merged.turns);
    check(
      '头部轮数与行数一致（parseMinutesTurns 可反解）',
      parseMinutesTurns(merged.content) === 13,
      parseMinutesTurns(merged.content),
    );

    // ── 场景 B：账本丢失后重放，内容与库里完全一致 ──
    //
    // 拼接去重后一字不差 ⇒ 判定 unchanged，不发 HTTP、不白推进。
    store.clear();
    rememberCalls = 0;
    const replay = await writeMinutes(client, SESSION, longTurns, {
      project: 'dsh',
      existingSegments: [{ turns: longTurnsCount, content: longContent }],
    });
    check('重放旧内容时判定为「无变化」', replay.unchanged === true, replay);
    check('无变化时不发起 remember', rememberCalls === 0, rememberCalls);

    // ── 场景 C：不传 existingSegments（未探查到）⇒ 照常写 ──
    store.clear();
    rememberCalls = 0;
    const allowed = await writeMinutes(client, SESSION, [extraTurn], { project: 'dsh' });
    check('未探查到库内情况时照常写入', allowed.written === true, allowed);
    check('此时发起 remember', rememberCalls === 1, rememberCalls);

    // ── 场景 D：跨段新主题（相似度低）⇒ 不拼基线，避免污染新段 ──
    store.clear();
    rememberCalls = 0;
    const cross = await writeMinutes(
      client,
      SESSION,
      [turn(14, t0 + 60 * 60_000, '换话题：数据库迁移要先备份', ['结论：迁移前必须全量备份，因为回滚会丢数据'])],
      {
        project: 'dsh',
        existingSegments: [{ turns: longTurnsCount, content: longContent }],
      },
    );
    check('跨段新主题正常写入（LRC 会新建）', cross.written === true, cross);
    check(
      '跨段新主题**没有**被拼进旧段内容（不污染新段）',
      !cross.content.includes('第 1 轮的长篇诉求'),
      cross.content.slice(0, 300),
    );

    // ── 场景 E：多段并存时选相似度最高的那段当基线 ──
    //
    // 库里 P1(12 轮，旧主题) + P2(2 轮，另一主题)。本稿重放 P1 的前 7 轮
    // ⇒ 必须选 P1 当基线（否则只与 P2 比会误判「新建」）。
    store.clear();
    rememberCalls = 0;
    const otherContent =
      buildMinutes(SESSION, [
        turn(1, t0, '换话题：数据库迁移要先备份', ['结论：迁移前必须全量备份，因为回滚会丢数据']),
        turn(2, t0 + 60_000, '再补一条迁移约束', ['结论：迁移只在低峰期做，因为要锁表']),
      ])?.content ?? '';
    const multi = await writeMinutes(client, SESSION, longTurns.slice(0, 7), {
      project: 'dsh',
      existingSegments: [
        { turns: 2, content: otherContent },
        { turns: longTurnsCount, content: longContent },
      ],
    });
    check('多段并存时选最相似那段当基线（判定无变化）', multi.unchanged === true, multi);

    // ── 场景 F：阶段稿收尾（同轮数、少 in-progress 标记）必须能落地 ──
    store.clear();
    rememberCalls = 0;
    const stageTurns = [
      turn(13, t0 + 20 * 60_000, '第十三轮的新诉求', ['第十三轮的结论，因为要验证收尾'], 'in-progress'),
    ];
    const finalTurns = [
      turn(13, t0 + 20 * 60_000, '第十三轮的新诉求', ['第十三轮的结论，因为要验证收尾']),
    ];
    const stageDraft = buildMinutes(SESSION, stageTurns);
    const finalized = await writeMinutes(client, SESSION, finalTurns, {
      project: 'dsh',
      existingSegments: [{ turns: stageDraft?.turns ?? 0, content: stageDraft?.content ?? '' }],
    });
    check('阶段稿收尾能落地（不被误判为无变化）', finalized.written === true, finalized);
    check('收尾后不再含 in-progress', !finalized.content.includes('in-progress'), finalized.content);

    // ── 场景 G：同一轮 userText 中途增长（十一轮审查 major 1 的守卫）──
    //
    // 阶段稿写的是「做重构」，用户中途补充后正式稿变成「做重构 顺便补测试」。
    // 纯文本匹配不到，但 `startedAt` 是**轮开始时刻**、不会变 ⇒ 必须靠
    // 「同分钟 + 基线行带标记」覆盖，而不是留下两行。
    store.clear();
    rememberCalls = 0;
    const growAt = t0 + 90 * 60_000;
    const stageGrow = buildMinutes(SESSION, [
      turn(20, growAt, '做重构', ['结论：先重构，因为旧结构撑不住'], 'in-progress'),
    ]);
    const grownFinal = await writeMinutes(
      client,
      SESSION,
      [turn(20, growAt, '做重构 顺便补测试', ['结论：先重构，因为旧结构撑不住'])],
      {
        project: 'dsh',
        existingSegments: [{ turns: stageGrow?.turns ?? 0, content: stageGrow?.content ?? '' }],
      },
    );
    check('userText 增长后写入成功', grownFinal.written === true, grownFinal);
    check(
      '同一轮只留一行（不出现「做重构」与「做重构 顺便补测试」并存）',
      grownFinal.content.split('\n').filter((l) => l.includes('做重构')).length === 1,
      grownFinal.content.split('\n').filter((l) => l.includes('做重构')),
    );
    check('增长后的文本已生效', grownFinal.content.includes('顺便补测试'), '');
    check('in-progress 标记已被抹掉', !grownFinal.content.includes('in-progress'), '');

    // ── 场景 H：不同轮的前缀文本**不能**被误合并（major 1 的反例）──
    //
    // 基线是 11-14 的 `做重构（aborted）`；本稿是 11-19 的全新轮
    // `做重构 顺便补测试`。时间不同 ⇒ 必须当成两行，且新轮保留自己的时间。
    store.clear();
    rememberCalls = 0;
    const oldAborted = buildMinutes(SESSION, [
      turn(1, t0, '做重构', ['结论：旧轮被中止，因为需求变了'], 'aborted'),
    ]);
    const newRound = await writeMinutes(
      client,
      SESSION,
      [turn(2, t0 + 5 * 24 * 3600_000, '做重构 顺便补测试', ['结论：新轮独立，因为时间窗不同'])],
      {
        project: 'dsh',
        existingSegments: [{ turns: oldAborted?.turns ?? 0, content: oldAborted?.content ?? '' }],
      },
    );
    check('不同轮的前缀文本不被误合并（两行并存）', newRound.written === true, newRound);
    check(
      '旧轮的 aborted 信号保留',
      newRound.content.includes('（aborted）'),
      newRound.content.split('\n').filter((l) => l.includes('做重构')),
    );
    check(
      '新轮保留自己的时间（未被改成旧轮时刻）',
      newRound.content.split('\n').filter((l) => l.includes('顺便补测试')).length === 1,
      newRound.content.split('\n').filter((l) => l.includes('顺便补测试')),
    );

    // ── 场景 I：同分钟、非前缀、不同轮 ⇒ 必须两行并存（十二轮 minor 3 反例）──
    //
    // 基线 `- 15:00 做重构（in-progress）`，本稿 `- 15:00 补测试`。
    // 只按分钟匹配会把「补测试」覆盖掉「做重构」；加了前缀约束后
    // 不匹配 ⇒ 新增行 ⇒ 两行都在。
    store.clear();
    rememberCalls = 0;
    const sameMinute = t0 + 120 * 60_000;
    const stageSame = buildMinutes(SESSION, [
      turn(30, sameMinute, '做重构', ['结论：先重构，因为旧结构撑不住'], 'in-progress'),
    ]);
    const twoRows = await writeMinutes(
      client,
      SESSION,
      [turn(31, sameMinute, '补测试', ['结论：补测试，因为重构后要防回归'])],
      {
        project: 'dsh',
        existingSegments: [{ turns: stageSame?.turns ?? 0, content: stageSame?.content ?? '' }],
      },
    );
    check('同分钟不同轮写入成功', twoRows.written === true, twoRows);
    check(
      '同分钟的两轮都保留（不互相覆盖）',
      twoRows.content.includes('做重构') && twoRows.content.includes('补测试'),
      twoRows.content.split('\n').filter((l) => l.startsWith('- ')),
    );
  }

  // ── 18. 截断保留**最近**的（六钥匙：保留最早会让正文永久冻结）──
  //
  // 反例：账本是「最近 40 轮」滑窗 ⇒ 第 41 轮起本稿行集合变成第 2..41 轮。
  // 若取「最早 40 行」，结果仍是第 1..40 ⇒ 正文永不变化
  // ⇒ LRC 合并后内容不变 ⇒ 纪要永久冻结在第 40 轮。
  console.log('\n=== 18) 超限截断保留最近的 ===');
  {
    const t0 = Date.parse('2026-11-16T00:00:00Z');
    const many: TurnRecord[] = [];
    for (let i = 0; i < 50; i += 1) {
      many.push(turn(i + 1, t0 + i * 60_000, `第 ${i + 1} 轮诉求`, []));
    }
    const draft = buildMinutes(SESSION, many);
    const lines = draft === null ? [] : draft.content.split('\n').filter((l) => l.startsWith('- '));
    check('行数被限制在 40', lines.length === 40, lines.length);
    check(
      '保留的是**最近**的 40 轮（第 11..50）',
      (lines[0] ?? '').includes('第 11 轮') && (lines[lines.length - 1] ?? '').includes('第 50 轮'),
      { first: lines[0], last: lines[lines.length - 1] },
    );
    check('最早的轮次已被淘汰', !lines.some((l) => l.includes('第 1 轮诉求')), '');
  }

  // ── 19. 头部时间解析必须能跨行匹配（十二轮审查 major 1）──
  //
  // 反例：`/^时间…/` 不带 `m` 时只锚定字符串开头，而正文首行是
  // `【会话纪要】…`、时间行在第二行 ⇒ 恒返回 null ⇒ 基线起点合并、
  // `unchanged` 分支、`Math.min(override, baselineStart)` 全部失效，
  // 且 `source_timestamp_ms` 会写成「现在」（时序偏差数天）。
  console.log('\n=== 19) 头部时间解析跨行匹配 ===');
  {
    const t0 = Date.parse('2026-11-14T03:27:35Z');
    const draft = buildMinutes(SESSION, [turn(1, t0, '测试诉求', ['测试结论，因为要验证时间解析'])]);
    const content = draft?.content ?? '';
    check('正文首行不是时间行（前提）', !content.startsWith('时间'), content.slice(0, 20));
    check(
      'parseMinutesStartedAt 能解析出起点（跨行）',
      parseMinutesStartedAt(content) !== null,
      parseMinutesStartedAt(content),
    );
    check(
      'parseMinutesEndedAt 能解析出终点（跨行）',
      parseMinutesEndedAt(content) !== null,
      parseMinutesEndedAt(content),
    );
    // 起点必须落在同一分钟内（`formatWhen` 只到分钟）
    const parsedStart = parseMinutesStartedAt(content);
    check(
      '解析出的起点与真实起点同分钟',
      parsedStart !== null && Math.abs(parsedStart - t0) < 60_000,
      { parsedStart, t0 },
    );
  }

} finally {
  // ## Windows 下的关闭顺序（实测 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）
  //
  // 直接用 `server.close(cb)` 时，若有 keep-alive 连接仍在，libuv 会在
  // 句柄尚未收尾时被要求关闭 ⇒ 进程 abort（exit code -1073740791）。
  // 先 `closeAllConnections()` 掐断空闲连接，再等 close 回调；
  // 最后 `unref()` 让残留句柄不阻塞进程退出。
  server.closeAllConnections();
  await new Promise<void>((r) => {
    server.close(() => r());
  });
  server.unref();
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failed === 0) console.log('全部通过');
else {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
