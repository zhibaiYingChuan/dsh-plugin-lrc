/**
 * 正文约束抽取的单元测试。
 *
 * 用法：node scripts/e2e-prose-extract.ts
 *
 * 为什么必须单独成一套：这层是「不依赖模型配合」的核心。
 * 实测模型只有 1.8% 的轮次输出 <lrc_memory>，所以约束抽取几乎全靠它。
 * 它抽错 = 沉淀垃圾；抽漏 = 约束丢失，下一轮模型重犯同样的错。
 */
import {
  areNearDuplicate,
  carriesResourceLocation,
  constraintsFromProse,
  constraintsFromUser,
  hardFilter,
  isKeyResourceLocation,
} from '../src/memory-filter.ts';
import { Offloader, buildSnapshot } from '../src/offloader.ts';
import { linesWithOrigin } from '../src/session-text.ts';
import { CursorStore } from '../src/cursor.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DistilledItem } from '../src/lrc-client.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ── 1) 真实会话里的约束必须被抽到 ──
console.log('=== 1) 真实约束抽取 ===');
{
  // 取自 session-e1419190 的真实正文
  const real = [
    '不会用 IDM 下载。音频已经在 assets/score.wav 了。',
    '不要走下载链接，直接复制桌面上的文件。',
    '由于 PowerShell 会吞掉 JSON 内的引号，改用 --stdin 传入。',
    '缓存必须放在工作区之外，否则沙箱会拦住。',
  ].join('\n');
  const got = constraintsFromProse(real);
  console.log(`  抽到 ${got.length} 条:`);
  for (const g of got) console.log(`    ${g}`);
  check('抽到了「不用 IDM」', got.some((g) => g.includes('IDM')), got);
  check('抽到了「不走下载链接」', got.some((g) => g.includes('下载链接')), got);
  check('抽到了「改用 --stdin」', got.some((g) => g.includes('--stdin')), got);
  check('抽到了「必须放在工作区」', got.some((g) => g.includes('工作区')), got);
  check('每条都带类别前缀', got.every((g) => /^(约束|决策)：/.test(g)), got);
}

// ── 1b) 状态陈述不得被当成约束（真实数据里抽到的噪声）──
console.log('=== 1b) 状态陈述应被排除 ===');
{
  const states = [
    '这个 CLI 现在能启动了，但它默认把缓存写到 AppData。',
    '开工前先定几件事，其余我按默认来。',
    '你上一轮的意图是「用 mh 创建工程」，所以我先确认可行性。',
    '刚刚安装完成，现在正在验证。',
  ].join('\n');
  const got = constraintsFromProse(states);
  check('状态陈述全部被排除', got.length === 0, got);
}

// ── 1c) 「通过/经过/跳过」类约束不得被误杀 ──
//
// ★独立审查发现的 P0：首版把 `过` 当裸字过去时标记，
// 结果「必须通过 --stdin」「禁止通过 IDM」「不要跳过校验」全部被丢掉（6/6）。
// 这类「执行方式约束」恰是最高价值的一类。
console.log('=== 1c) 通过/经过/跳过 类约束必须保留 ===');
{
  const cases = [
    '必须通过 --stdin 传入 JSON',
    '禁止通过 IDM 下载音频',
    '所有请求必须经过 3111 端口',
    '不要跳过 MD5 校验',
    '只能通过 serviceFor 拿引擎',
    '不要把缓存写到工作区，所以必须用外部目录',
  ];
  for (const c of cases) {
    check(`保留「${c.slice(0, 20)}」`, constraintsFromProse(c).length > 0, constraintsFromProse(c));
  }
}

// ── 1d) 标签内容不得被 prose 二次抽取 ──
console.log('=== 1d) 标签不被二次抽取 ===');
{
  const withTag = '已完成。\n<lrc_memory>\n- 决策：最终交付 55 秒无声 mp4\n</lrc_memory>';
  const got = constraintsFromProse(withTag);
  check('标签内决策不被 prose 重复抽', !got.some((g) => g.includes('55 秒')), got);
}

// ── 2) 过程叙述不得被当成约束 ──
console.log('=== 2) 过程叙述应被排除 ===');
{
  const narration = [
    '我先看一下文件内容。',
    '让我检查一下目录结构。',
    '接下来我去读取配置文件。',
    '正在运行测试，稍等。',
  ].join('\n');
  const got = constraintsFromProse(narration);
  check('过程叙述全部被排除', got.length === 0, got);
}

// ── 3) 系统提示与噪声不得混入 ──
console.log('=== 3) 噪声排除 ===');
{
  const noise = [
    'You are an AI agent powered by DeepSeek Harness. You must follow rules.',
    '```js',
    'const x = 1; // 必须用 const',
    '```',
    '我明白了，谢谢。',
  ].join('\n');
  const got = constraintsFromProse(noise);
  check('代码围栏内不抽', !got.some((g) => g.includes('const x')), got);
  check('寒暄不抽', !got.some((g) => g.includes('谢谢')), got);
}

// ── 4) 路径里的词不得误判 ──
console.log('=== 4) 路径词不误判 ===');
{
  const got = constraintsFromProse('参见 docs/禁止事项.md 里的说明。');
  check('路径里的「禁止」不算约束', got.length === 0, got);
}

// ── 4b) 「目前 / 刚刚」不得误杀真实决策 ──
//
// ★独立审查发现的 P2-1：`PAST_OR_PLANNING` 里含裸 `目前`/`刚刚`，
// 而「目前改用 X」是最典型的决策句（`DECISION_MARKERS` 的 `改用` 专为此设计）。
// 实测 4/6 真实决策被时态词杀掉。
console.log('=== 4b) 目前/刚刚 不误杀决策 ===');
{
  const decisions = [
    '目前改用 --stdin 传入，不再写临时文件',
    '目前采用 pnpm 作为包管理器',
    '刚刚决定改用 --file 传入音频',
    '目前定为 3113 端口',
  ];
  for (const d of decisions) {
    check(`保留决策「${d.slice(0, 14)}…」`, constraintsFromProse(d).length > 0, constraintsFromProse(d));
  }
  // 真正的状态陈述（「目前已完成」）仍须排除
  const states = ['目前已完成迁移', '刚刚安装完成', '现在正在验证'];
  for (const s of states) {
    check(`排除状态「${s}」`, constraintsFromProse(s).length === 0, constraintsFromProse(s));
  }
}

// ── 5) 数量上限 ──
console.log('=== 5) 数量上限 ===');
{
  const many = Array.from({ length: 20 }, (_, i) => `必须遵守第 ${i} 条规则。`).join('\n');
  const got = constraintsFromProse(many, 4);
  check('不超过 maxLines', got.length <= 4, got.length);
}

// ── 6) 空输入与异常形态 ──
console.log('=== 6) 边界 ===');
check('空串返回空数组', constraintsFromProse('').length === 0);
check('纯空白返回空数组', constraintsFromProse('   \n\n  ').length === 0);
check('极长句子被跳过', constraintsFromProse('必须' + '很'.repeat(300)).length === 0);

// ── 7) 快照排序：约束/决策优先于结论 ──
console.log('=== 7) 快照优先级 ===');
{
  const items: DistilledItem[] = [
    { content: '[结论] CLI 已安装', memory_type: 'fact', tags: ['conclusion'], importance: 6, source_turns: [0, 0] },
    { content: '[结论] 二进制被截断', memory_type: 'fact', tags: ['conclusion'], importance: 6, source_turns: [1, 1] },
    { content: '[约束] 不要用 IDM 下载', memory_type: 'preference', tags: ['constraint'], importance: 7, source_turns: [2, 2] },
    { content: '[决策] 改用 --stdin 传入', memory_type: 'decision', tags: ['decision'], importance: 7, source_turns: [3, 3] },
  ];
  const snap = buildSnapshot(items, 2);
  console.log(`  快照: ${snap}`);
  check('约束排在第一条', snap.includes('不要用 IDM'), snap);
  check('决策排在第二条', snap.includes('改用 --stdin'), snap);
  check('结论被挤掉（优先级最低）', !snap.includes('CLI 已安装'), snap);
}

// ── 7b) 跨批累积：约束不得被下一条过程记录顶掉 ──
//
// ★独立审查发现的 P0-3：`buildSnapshot` 只对**传入的那一批**排序，
// 而真实调用每次只传 1~2 条 —— 排序退化为原序，约束被逐条覆盖。
// 回放整场会话，5 条关键约束在最终注入里全部丢失。
// 修法是 `Offloader.snapshotPool` 跨批累积。
console.log('=== 7b) 跨批累积 ===');
{
  const off = new Offloader(null, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}.json`)), {
    snapshotItems: 3,
  });
  // buildPooledSnapshot 是私有方法，测试里按结构访问
  const pool = off as unknown as { buildPooledSnapshot: (i: DistilledItem[]) => string };
  const mk = (c: string, t: string, tags: string[]): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0],
  });

  const a = pool.buildPooledSnapshot([mk('[约束] 缓存必须放在工作区之外', 'preference', ['constraint'])]);
  const b = pool.buildPooledSnapshot([mk('[决策] 改用 --stdin', 'decision', ['decision'])]);
  const c2 = pool.buildPooledSnapshot([mk('[结论] MD5 一致', 'fact', ['conclusion'])]);
  console.log(`    批1: ${a}`);
  console.log(`    批2: ${b}`);
  console.log(`    批3: ${c2}`);
  check('第 2 批仍保留第 1 批的约束', b.includes('工作区'), b);
  check('第 3 批仍保留最早的约束', c2.includes('工作区'), c2);
  check('第 3 批仍保留决策', c2.includes('--stdin'), c2);

  // 再来一条约束：跨类轮转下**不会**把结论挤掉（那是刻意保留多样性），
  // 但约束本身必须进得去
  const d = pool.buildPooledSnapshot([mk('[约束] 不要走下载链接', 'preference', ['constraint'])]);
  console.log(`    批4: ${d}`);
  check('新约束能进快照', d.includes('下载链接'), d);

  // ★真实回放问题：同质约束会占满所有槽位，把不同类的决策挤掉
  // （三条都在说「缓存放工作区外」，而 --stdin 进不来）
  check('不同类别的决策仍能露脸', d.includes('--stdin') || d.includes('改用'), d);

  // 会话切换清空
  off.resetSnapshotPool();
  const e = pool.buildPooledSnapshot([mk('[结论] 新会话', 'fact', ['conclusion'])]);
  check('resetSnapshotPool 后不含旧约束', !e.includes('工作区'), e);
}

// ── 7c) 跨类轮转：同质条目不得占满槽位 ──
console.log('=== 7c) 跨类轮转 ===');
{
  const mk = (c: string, t: string, tags: string[]): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0],
  });
  // 三条同义约束（都在说「缓存放工作区外」）+ 一条决策
  const items: DistilledItem[] = [
    mk('[约束] 缓存必须放在工作区之外', 'preference', ['constraint']),
    mk('[约束] 所以缓存必须放在工作区外', 'preference', ['constraint']),
    mk('[约束] 缓存必须在工作区之外', 'preference', ['constraint']),
    mk('[决策] 改用 --stdin 传入', 'decision', ['decision']),
  ];
  const snap = buildSnapshot(items, 2);
  console.log(`    快照: ${snap}`);
  check('同义约束只保留一条', (snap.match(/工作区/g) ?? []).length === 1, snap);
  check('决策能进前两位', snap.includes('--stdin'), snap);
}

// ── 7d) 池代次：在飞的旧会话结果不得污染新会话 ──
//
// ★独立审查发现的 P1-2：`snapshotGeneration` 只拦了 `saveSnapshot`，
// 而 `offloadItems()` 内部已经 push 进池子 —— 闸门返回时池子早已被改脏。
// 修法是 `poolEpoch`：请求发起时取代次，写池前比对。
console.log('=== 7d) 池代次闸门 ===');
{
  const off = new Offloader(null, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-e.json`)), {
    snapshotItems: 3,
  });
  const pool = off as unknown as {
    buildPooledSnapshot: (i: DistilledItem[], epoch?: number) => string;
  };
  const mk = (c: string, t: string, tags: string[]): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0],
  });

  // 会话 A 发起请求时记下代次
  const epochA = off.epoch;
  off.resetSnapshotPool(); // 期间切到会话 B 并清池
  const epochB = off.epoch;
  check('reset 后代次递增', epochB > epochA, { epochA, epochB });

  // A 的迟到结果：必须被丢弃，且不得写进池子
  const stale = pool.buildPooledSnapshot([mk('[约束] A 的私有约束', 'preference', ['constraint'])], epochA);
  check('旧代次结果返回空串', stale === '', stale);
  const after = pool.buildPooledSnapshot([mk('[结论] B 的结论', 'fact', ['conclusion'])]);
  check('A 的约束未混入 B 的快照', !after.includes('A 的私有约束'), after);
  check('B 自己的内容正常产出', after.includes('B 的结论'), after);

  // 当前代次的结果必须正常写入（闸门不能误伤正常路径）
  const live = pool.buildPooledSnapshot([mk('[约束] B 的约束', 'preference', ['constraint'])], off.epoch);
  check('当前代次结果正常写入', live.includes('B 的约束'), live);
}

// ── 1e) 用户纠正型约束必须入库 ──
//
// ★独立审查发现的 P0-3：`linesFromSession` 的门槛是 `hasConstraintMarker`
// （必须/不要/禁止），而用户最关键的约束常用反问句表达。
//
// ★★第二次独立审查指出：上一版的 fixture 是**改写自证** ——
// 注释称「取自 session-e1419190 的真实正文」，但逐句在真实日志里搜索 0 次命中。
// 现在改成**从 session.v4.jsonl.zstd 解码出来的逐字原文**（seq 已标注）。
console.log('=== 1e) 用户纠正型约束 ===');
{
  // ↓↓↓ 以下三条是从 session-e1419190 解码的逐字原文，未做任何改写 ↓↓↓
  //     seq=1682 len=50（用户唯一提到 IDM 的消息）
  const REAL_IDM =
    '不是告诉你音频在的位置了吗？你一点击下载，就会调取桌面的IDM的下载软件，然后你就不知道下载到哪了。';
  //     seq=1761 len=23
  const REAL_NO_DUB = '你这个视频不用你配音了，直接执执行其他的任务。';
  //     seq=1539 len=42
  const REAL_AUDIO = 'D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务';

  check('真实 IDM 消息能被抽到', constraintsFromUser(REAL_IDM).length > 0, constraintsFromUser(REAL_IDM));
  check('抽出内容含 IDM', constraintsFromUser(REAL_IDM).some((g) => g.includes('IDM')), constraintsFromUser(REAL_IDM));
  check(
    '抽出内容含「下载到哪」的风险说明',
    constraintsFromUser(REAL_IDM).some((g) => g.includes('下载到哪')),
    constraintsFromUser(REAL_IDM),
  );
  check('普通任务消息不被误收', constraintsFromUser(REAL_NO_DUB).length === 0, constraintsFromUser(REAL_NO_DUB));
  check('含路径的指令不被误收', constraintsFromUser(REAL_AUDIO).length === 0, constraintsFromUser(REAL_AUDIO));

  // ★独立审查 P0-2：「不是 X，是 Y」解释句被 4/4 误收，现必须全部排除
  const explanations = [
    '这个不是说明书的写法，你去看一下第三章。',
    '这两个文件不是说明关系，是引用关系。',
    '不是说这个方案不行，是成本太高。',
    '我不是说我不同意，是说要先确认。',
  ];
  for (const e of explanations) {
    check(`解释句不误收「${e.slice(0, 12)}…」`, constraintsFromUser(e).length === 0, constraintsFromUser(e));
  }

  // ★第三次独立审查 P1-4：`我跟你说` 类开场白 4/4 误收，现必须排除
  const plainTalk = [
    '我跟你说一下，这个视频还要改。',
    '我跟你说，这个音频就在桌面。',
    '你再说一次刚才那个命令。',
    '我说过两次了，你怎么还这样。',
  ];
  for (const p of plainTalk) {
    check(`开场白不误收「${p.slice(0, 12)}…」`, constraintsFromUser(p).length === 0, constraintsFromUser(p));
  }

  // 带强情态词的纠正句仍是约束（不能因为「不是…是…」就一刀切掉）
  const real = constraintsFromUser('不是告诉过你不要用 IDM 吗，必须改用 --file 传入。');
  check('含「必须」的纠正句仍被收录', real.length > 0, real);

  check('每条都带约束前缀', constraintsFromUser(REAL_IDM).every((g) => g.startsWith('约束：')), constraintsFromUser(REAL_IDM));
  check('空串返回空数组', constraintsFromUser('').length === 0);
}

// ── 1f) 「不要再 / 别再」与短约束不得被漏抽 ──
//
// ★第三次独立审查 P1-3：`STRONG_CONSTRAINT` 的第二组要求「不要」紧跟单字动词，
// 于是「不要**再**走下载链接」整类漏抽；而 `length < 8` 门槛把
// 「不要走 IDM」（7 字）、「不要跳过校验」（6 字）这些**最典型的短约束**直接吞掉。
console.log('=== 1f) 不要再/别再 + 短约束 ===');
{
  const cases = [
    '不要再走下载链接了，直接用桌面上的音频文件',
    '别再去点那个下载按钮，会调起 IDM',
    '不要再使用 IDM 下载音频，直接用 --file 传入',
    '不要再次下载这个文件，源文件在桌面',
    '不要用 IDM',
    '不要走 IDM',
    '不要跳过校验',
    // ★第四次审查：词表遗漏的同义形态
    '不要通过 IDM 下载音频',
    '请勿使用 IDM 下载',
    '不要直接用下载链接',
  ];
  for (const c of cases) {
    check(`保留「${c.slice(0, 16)}」`, constraintsFromProse(c).length > 0, constraintsFromProse(c));
  }
}

// ── 1g) 「音频在桌面」这类资源位置必须进沉淀源 ──
//
// ★第四次独立审查：事故的另一半从未修复 —— 用户交代音频位置的那条消息
// （seq=1539）既没有约束词也不是纠正句式，两条门槛双双漏过，
// 「音频在桌面」从未入库，模型只能去点下载链接。
console.log('=== 1g) 资源位置进沉淀源 ===');
{
  const REAL_AUDIO_LOC = 'D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务';
  check('真实音频位置消息能进沉淀源', carriesResourceLocation(REAL_AUDIO_LOC), REAL_AUDIO_LOC);
  check('口语「音频在桌面」能进', carriesResourceLocation('音频就在桌面，你自己去找'), '音频就在桌面');
  check('普通任务描述不进（无资源）', !carriesResourceLocation('帮我做个一分钟的视频'), '帮我做个一分钟的视频');
  check('纯代码路径不算资源位置', !carriesResourceLocation('检查 src/index.ts 里的逻辑'), 'src/index.ts');
  check('文档任务不算资源位置', !carriesResourceLocation('帮我排版 docs/禁止事项.md'), 'docs/禁止事项.md');
  // ★第五次审查 P2-1：URL 里的 `s:/` 曾被误判成盘符路径
  check(
    'URL 不算资源位置',
    !carriesResourceLocation('https://github.com/zhibaiYingChuan/LRC 为这个仓库的产品做一个一分钟以内的视频。'),
    'https://github.com/...',
  );
}

// ── 7e) 池上限：高价值超额时不得无界增长 ──
//
// ★独立审查发现的 P0-1：上一版 `room = max(0, 20 - min(high.length, 20))`，
// 当 `high.length >= 20` 时 room=0，而 `low.slice(-0)` 返回**整个数组**
// （JS 规范：`arr.slice(-0) === arr`），低价值条目一条都没被删。
// 实测 25 条高价值后每轮 +10 条低价值，池 30→40→…→80 无界增长。
console.log('=== 7e) 池上限与淘汰端 ===');
{
  const off = new Offloader(null, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-f.json`)), {
    snapshotItems: 3,
  });
  const pool = off as unknown as {
    buildPooledSnapshot: (i: DistilledItem[]) => string;
    snapshotPool: DistilledItem[];
  };
  const mk = (c: string, t: string, tags: string[]): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0],
  });

  // 先灌 25 条高价值（超过池上限 20）
  const many: DistilledItem[] = [];
  for (let i = 0; i < 25; i += 1) {
    many.push(mk(`[约束] 约束${i}`, 'preference', ['constraint']));
  }
  pool.buildPooledSnapshot(many);
  check('高价值超额后池被裁到上限', pool.snapshotPool.length <= 20, pool.snapshotPool.length);

  // 再连灌多轮低价值，池必须始终不超上限
  let maxSeen = pool.snapshotPool.length;
  for (let round = 0; round < 6; round += 1) {
    const lows: DistilledItem[] = [];
    for (let i = 0; i < 10; i += 1) {
      lows.push(mk(`[结论] 过程${round}-${i}`, 'fact', ['conclusion']));
    }
    pool.buildPooledSnapshot(lows);
    maxSeen = Math.max(maxSeen, pool.snapshotPool.length);
  }
  check('多轮灌低价值后池仍不超上限', maxSeen <= 20, maxSeen);

  // 保留端：追加式池子应保留**最新**的高价值，而不是最旧的
  const kept = pool.snapshotPool.map((i) => i.content).join('|');
  check('保留的是最新约束（约束24）', kept.includes('约束24'), kept.slice(0, 200));
  check('最旧约束（约束0）被淘汰', !kept.includes('约束0'), kept.slice(0, 200));
}

// ── 7f) 资源位置必须真的出现在注入内容里 ──
//
// ★第六次独立审查的 P0：用户说「音频在桌面」（seq=1539）终于进了库，
// 但 LRC distill 把它归成 `code_context` ⇒ 快照 rank 最后。
// 真实池里 rank 0/1 有 15 条，`snapshotItems=3` 时它**永远进不了注入**。
//
// ★★第七次审查又发现两个反向回归，这里全部锁住：
//   (a) 用宽松的 `carriesResourceLocation` 提权，把 `G:\loong 是仓库`
//       这类过程结论也提到 rank0 ⇒ IDM 约束注入次数 4 → **0**。
//   (b) 淘汰判据不认资源位置 ⇒ 池满 20 时先删掉它，提权等于没做。
console.log('=== 7f) 资源位置必须被注入 ===');
{
  const mk = (c: string, t: string, tags: string[], origin?: 'user' | 'assistant'): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0], origin,
  });
  // 模拟真实池：高价值约束/决策 + 资源位置（用户说的）
  // + 助手正文里的路径类过程结论（第七轮指出的污染源）
  const pool: DistilledItem[] = [
    mk('[约束] 不要走 IDM 下载音频，直接用桌面文件', 'preference', ['constraint']),
    mk('[约束] 缓存必须放在工作区之外', 'preference', ['constraint']),
    mk('[结论] G:\\loong 是 LRC 的源码仓库', 'fact', ['conclusion'], 'assistant'),
    mk('[结论] 在 C:\\Users\\Administrator\\.dsh 下确认配置', 'fact', ['conclusion'], 'assistant'),
    mk('[结论] 工程里的 assets/score.wav 的 MD5 一致', 'fact', ['conclusion'], 'assistant'),
    mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource', 'user'], 'user'),
    mk('[决策] 改用 --stdin 传入', 'decision', ['decision'], 'assistant'),
  ];

  const snap3 = buildSnapshot(pool, 3);
  console.log(`    snapshotItems=3 → ${snap3}`);
  check('资源位置出现在注入内容里（snapshotItems=3）', snap3.includes('score-Dtle1HAU'), snap3);
  check('真约束没有被资源位置挤掉', snap3.includes('IDM'), snap3);
  check('过程结论未被提权（G:\\loong 不在）', !snap3.includes('loong'), snap3);
  check('MD5 类过程结论未被提权', !snap3.includes('MD5'), snap3);

  const snap2 = buildSnapshot(pool, 2);
  console.log(`    snapshotItems=2 → ${snap2}`);
  check('资源位置在 snapshotItems=2 时仍露脸', snap2.includes('score-Dtle1HAU'), snap2);
  check('snapshotItems=2 时真约束也在', snap2.includes('IDM'), snap2);

  // 池里没有资源位置时，行为不得改变
  const noRes = pool.filter((i) => !i.content.includes('score-Dtle1HAU'));
  const snapNoRes = buildSnapshot(noRes, 3);
  check('无资源位置时仍注入约束', snapNoRes.includes('IDM'), snapNoRes);
}

// ── 7f-1) 提权判据必须看「谁在说」，不能只看文本形态 ──
//
// ★八轮/九轮审查的核心结论：靠词表永远追不上。
//
// | 版本 | 判据 | 结果 |
// |---|---|---|
// | v1 | 宽松 `carriesResourceLocation` | 助手正文 `G:\loong 是仓库` 也提权，IDM 注入 4→0 |
// | v2 | 媒体扩展名 + 过程词黑名单 | 英文推理句 `score.wav is 10MB` 冒充，真位置 1/17 |
// | v3 | 位置词白名单 | 英文假货消失，**中文助手结论**顶上来
//       （`桌面上的文件与 assets/score.wav 的 MD5 一致`），真位置 **1/16** |
//
// 根因不在词表，在**没有来源维度**：助手陈述与用户交代在文本上无法区分。
// 所以 `isKeyResourceLocation(text, fromUser)` 只对用户来源返回 true。
console.log('=== 7f-1) 提权判据看来源 ===');
{
  // 用户说的话 —— 必须提权
  const fromUser = [
    '[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频',
    '音频在桌面',
    '文件放在下载目录了',
    '音频文件在 assets/bgm.mp3',
  ];
  for (const s of fromUser) check(`用户来源提权「${s.slice(0, 26)}」`, isKeyResourceLocation(s, true), s);

  // 助手说的话 —— 一律不提权（这是三轮反复踩的坑）
  const fromAssistant = [
    '[结论] 桌面上的文件与工程里的 assets/score.wav 的 MD5 一致',
    '[结论] 成片位于 build/LRC-intro.mp4',
    '[结论] 音频已放在 assets/bgm.mp3',
    '[结论] 我把图片放到 public/cover.png 了',
    'With existing file, the bundler fails with "unsupported format". score.wav is 10MB',
    'G:\\loong 是 LRC 的源码仓库',
  ];
  for (const s of fromAssistant) {
    check(`助手来源不提权「${s.slice(0, 26)}」`, !isKeyResourceLocation(s, false), s);
  }

  // 关键竞争场景：中文助手结论不得抢走用户资源位置的预留槽位
  const mk = (c: string, t: string, tags: string[], origin?: 'user' | 'assistant'): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0], origin,
  });
  const rank0Pool: DistilledItem[] = [];
  for (let i = 0; i < 10; i += 1) {
    rank0Pool.push(mk(`[约束] 约束${i}：必须遵守第 ${i} 条规范`, 'preference', ['constraint'], 'assistant'));
  }
  rank0Pool.push(mk('[结论] 桌面上的文件与工程里的 assets/score.wav 的 MD5 一致', 'fact', ['conclusion'], 'assistant'));
  rank0Pool.push(mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource', 'user'], 'user'));

  const snapRank0 = buildSnapshot(rank0Pool, 3);
  console.log(`    rank0 竞争 → ${snapRank0}`);
  check('用户资源位置抢到预留槽位', snapRank0.includes('score-Dtle1HAU'), snapRank0);
  check('中文助手结论未抢到槽位', !snapRank0.includes('MD5'), snapRank0);

  // ★第九轮 P0-1：**用户自己的纠正句**不得冒充资源位置抢槽。
  // 原文：`不是告诉你音频在的位置了吗？你一点击下载，就会调取桌面的IDM…`
  // 它同时有「音频」和「在」，旧判据误判 isKey=true，把真位置挤掉。
  check(
    'IDM 纠正句不算资源位置',
    !isKeyResourceLocation(
      '不是告诉你音频在的位置了吗？你一点击下载，就会调取桌面的IDM的下载软件，然后你就不知道下载到哪了。',
      true,
    ),
  );

  // 真实竞争组合：IDM 约束 + 真资源位置共存（这正是本轮 bug 的现场）
  const realCombo: DistilledItem[] = [
    mk('[约束] 不要走 IDM 下载音频，直接用桌面文件', 'preference', ['constraint'], 'assistant'),
    mk('[约束] 不是告诉你音频在的位置了吗；你一点击下载，就会调取IDM', 'preference', ['constraint'], 'user'),
    mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource', 'user'], 'user'),
  ];
  const snapCombo = buildSnapshot(realCombo, 3);
  console.log(`    IDM+资源位置组合 → ${snapCombo}`);
  check('组合场景：资源位置出现', snapCombo.includes('score-Dtle1HAU'), snapCombo);
  check('组合场景：IDM 约束也出现', snapCombo.includes('IDM'), snapCombo);

  // ★第十轮 P1-1：真实压力场景 —— 12 条助手约束 + 用户纠正 + 用户资源位置。
  // 只给资源位置预留槽位时，IDM 纠正从 3/16 **回退到 1/15**（被助手约束挤掉）。
  // 修法是给「用户亲口说的两类事实」各预留一槽。
  const pressure: DistilledItem[] = [];
  for (let i = 0; i < 12; i += 1) {
    pressure.push(mk(`[约束] 助手约束${i}：必须遵守第 ${i} 条规范`, 'preference', ['constraint'], 'assistant'));
  }
  pressure.push(mk('[约束] 不是告诉你音频在的位置了吗；你一点击下载，就会调取IDM', 'preference', ['constraint'], 'user'));
  pressure.push(mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource', 'user'], 'user'));

  const snapPressure = buildSnapshot(pressure, 3);
  console.log(`    压力场景 → ${snapPressure}`);
  check('压力下资源位置仍出现', snapPressure.includes('score-Dtle1HAU'), snapPressure);
  check('压力下用户纠正仍出现（不回退）', snapPressure.includes('IDM'), snapPressure);
}

// ── 7f-2) 池淘汰必须与取词同源（资源位置要钉住） ──
//
// ★第七次审查 P0-2：资源位置天然最早确立，而淘汰逻辑是
// 「高价值按新到旧保留」⇒ 它第一个被丢。实测「池=20 但资源位置在池=false」。
console.log('=== 7f-2) 池满后资源位置仍在池 ===');
{
  const off = new Offloader(null, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-pin.json`)), {
    snapshotItems: 3,
  });
  const pool = off as unknown as {
    buildPooledSnapshot: (i: DistilledItem[]) => string;
    snapshotPool: DistilledItem[];
  };
  const mk = (c: string, t: string, tags: string[], origin?: 'user' | 'assistant'): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0], origin,
  });
  // 先放资源位置（用户一开始就交代文件在哪）
  pool.buildPooledSnapshot([
    mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource', 'user'], 'user'),
  ]);
  // 再灌 30 条约束把池撑满
  for (let round = 0; round < 6; round += 1) {
    const batch: DistilledItem[] = [];
    for (let i = 0; i < 5; i += 1) {
      batch.push(mk(`[约束] 约束${round}-${i}：必须遵守第 ${i} 条规范`, 'preference', ['constraint']));
    }
    pool.buildPooledSnapshot(batch);
  }
  console.log(`    池=${pool.snapshotPool.length} 资源位置仍在池=${pool.snapshotPool.some((i) => i.content.includes('score-Dtle1HAU'))}`);
  check('池满后资源位置仍在池里', pool.snapshotPool.some((i) => i.content.includes('score-Dtle1HAU')), pool.snapshotPool.length);
  check('池仍不超上限', pool.snapshotPool.length <= 20, pool.snapshotPool.length);
}

// ── 7f-3) flush 路径也必须带来源（否则池满后资源位置被挤掉） ──
//
// ★第九轮 P0-2：`linesFromSession` 只返回字符串，`offload → distill`
// 拿到的条目没有来源 ⇒ `origin=undefined` ⇒ 不提权。
// 实测：真位置经 flush 入池后灌 18 条助手约束，注入里**音频完全消失**。
console.log('=== 7f-3) flush 路径带来源 ===');
{
  const session = {
    log: [
      { type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务' }] },
      },
      {
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: '桌面上的文件与工程里的 assets/score.wav 的 MD5 一致' }] },
        },
      },
    ],
  };
  const lines = linesWithOrigin(session);
  check('用户消息标 origin=user', lines.some((l) => l.origin === 'user' && l.text.includes('score-Dtle1HAU')), lines);
  check('助手消息标 origin=assistant', lines.some((l) => l.origin === 'assistant'), lines);

  // ★第十轮 P1-3：短口语资源位置不得被 `hardFilter` 的 20 字门槛吞掉
  check('「音频在桌面」能过 hardFilter', hardFilter('音频在桌面').length > 0, hardFilter('音频在桌面'));
  check('「文件放在下载目录了」能过', hardFilter('文件放在下载目录了').length > 0, hardFilter('文件放在下载目录了'));
  // 但纯指针行仍须拦掉（不能因为放宽短行而放进一堆路径）
  check('纯路径行仍被拦', hardFilter('materials/架构图.png') === '', hardFilter('materials/架构图.png'));

  // 池满 19/20 时，用户资源位置仍必须能注入
  const off = new Offloader(null, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-flush.json`)), {
    snapshotItems: 3,
  });
  const pool = off as unknown as {
    buildPooledSnapshot: (i: DistilledItem[]) => string;
    snapshotPool: DistilledItem[];
  };
  const mk = (c: string, t: string, tags: string[], origin?: 'user' | 'assistant'): DistilledItem => ({
    content: c, memory_type: t, tags, importance: 7, source_turns: [0, 0], origin,
  });
  pool.buildPooledSnapshot([mk('[事实] D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频', 'fact', ['resource'], 'user')]);
  const batch: DistilledItem[] = [];
  for (let i = 0; i < 18; i += 1) {
    batch.push(mk(`[约束] 助手约束${i}：必须遵守规范`, 'preference', ['constraint'], 'assistant'));
  }
  const snapFlush = pool.buildPooledSnapshot(batch);
  console.log(`    池=${pool.snapshotPool.length} 注入=${snapFlush}`);
  check('池满后资源位置仍能注入', snapFlush.includes('score-Dtle1HAU'), snapFlush);
}

// ── 7f-4) 混合批来源：助手不得被标成 user ──
//
// ★第十轮 P0-1：上一版 `batchOrigin` 是**批级并集** ——「只要批内有 user 块就整批标 user」。
// 实测混合批 `user「帮我配一段音乐」+ assistant「音频已放到 assets/bgm.mp3 了」`
// 蒸馏出的条目拿到 `origin=user` ⇒ `isKey=true` ⇒ 抢 rank0。
// 与前三轮修掉的假货是同一机制，入口从「文本形态」换成了「来源误标」。
//
// 修法：**取交集**，全部块都是 user 才标 user（保守处理最多漏提权，误标会让助手长期占槽）。
console.log('=== 7f-4) 混合批来源 ===');
{
  let captured: DistilledItem[] = [];
  const makeClient = (itemContent: string): unknown =>
    ({
      baseUrl: 'http://127.0.0.1:0',
      distill: async () => ({
        items: [{ content: itemContent, memory_type: 'fact', tags: ['conclusion'], importance: 6, source_turns: [0, 0] }],
        count: 1,
        indexLine: '',
      }),
      migrate: async (items: DistilledItem[]) => {
        captured = items;
        return { written: items.length, merged: 0 };
      },
    }) as unknown as Parameters<typeof Offloader.prototype.bind>[0];

  // 混合批（用户任务 + 助手陈述）
  const mixedOff = new Offloader(
    makeClient('[结论] 音频已放到 assets/bgm.mp3 了'),
    new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-mixed.json`)),
    { snapshotItems: 3 },
  );
  await mixedOff.offload('s-mixed', [
    { text: '帮我给这个视频配一段音乐，文件我稍后给你', origin: 'user' as const },
    { text: '音频已放到 assets/bgm.mp3 了，接下来渲染', origin: 'assistant' as const },
  ]);
  console.log(`    混合批 origin=${JSON.stringify(captured.map((i) => i.origin))}`);
  check('混合批不把条目标成 user', captured.every((i) => i.origin !== 'user'), captured.map((i) => i.origin));

  // 纯用户批仍须标 user（不能因为收紧而漏提权）
  captured = [];
  const userOff = new Offloader(
    makeClient('[结论] 音频在桌面'),
    new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-pureuser.json`)),
    { snapshotItems: 3 },
  );
  await userOff.offload('s-user', [
    { text: '音频就在桌面上放着，你直接用那个文件就行，不要再下载了', origin: 'user' as const },
  ]);
  console.log(`    纯用户批 origin=${JSON.stringify(captured.map((i) => i.origin))}`);
  check('纯用户批标为 user', captured.length > 0 && captured.every((i) => i.origin === 'user'), captured.map((i) => i.origin));
}

// ── 7g) 表格行 / 计数句不得冒充决策 ──
//
// ★第六次审查 P1-1：`决策：| 0–8s | 一次对话…` 与 `决策：这次有 3 条关键决策`
// 都因裸词「决策」命中而进了注入，挤掉真正有用的条目。
console.log('=== 7g) 表格行/名词化决策不冒充 ===');
{
  const noise = [
    '| 0–8s | 一次对话，光点起势，再以"40 轮对话 / 上下文 100%"展示 |',
    '这次有 3 条关键决策。',
    '| 8–16s | 第二次对话，展示上下文压缩 |',
  ];
  for (const n of noise) {
    const got = constraintsFromProse(n);
    check(`不抽「${n.slice(0, 16)}…」`, got.length === 0, got);
  }
  // 真正的决策句仍要抽到
  for (const d of ['决定采用 --stdin 传入', '决策是改用 --file', '改用 --file 传入音频']) {
    check(`仍抽「${d}」`, constraintsFromProse(d).length > 0, constraintsFromProse(d));
  }
  // ★第七次审查 P1-3：收紧「决策/决定」曾漏掉 8 条真决策（决定 + 任意动词）
  for (const d of [
    '决定不再使用 IDM',
    '决定放弃 IDM',
    '决定取消 --json 方案',
    '决定停止使用临时目录',
    '决定去掉 BOM',
    '决定保留 8 个节点',
    '决定重写整个场景',
    '决定使用 --stdin',
  ]) {
    check(`「决定+动词」不漏「${d}」`, constraintsFromProse(d).length > 0, constraintsFromProse(d));
  }
  // 名词化/未定用法仍要排除
  for (const n of ['关于这个功能的决策的细节。', '我需要决定要不要这么做。']) {
    check(`名词化不抽「${n}」`, constraintsFromProse(n).length === 0, constraintsFromProse(n));
  }
  // ★第八次审查 P1-1：引号内引用的「决策」/英文画面描述/参数行不得冒充
  const quotedNoise = [
    'Deleted item: below-left, a block "决策 · 端口纪律 3099/3111" with strike, at y 750, big type 44',
    'The dropped decision text appears where the cut was: "决策 · 端口纪律 3099/3111" struck through',
    'Scene 2 at 6.9s: "压缩" verdict COLLIDES with the struck-through "决策 · 端口纪律 3099/3111"',
    'hop=5 "吃完洗碗，洗碗布该换了"',
  ];
  for (const n of quotedNoise) check(`引用/参数行不抽「${n.slice(0, 24)}」`, constraintsFromProse(n).length === 0, constraintsFromProse(n));
  // 但含 ASCII 参数的真决策不能被「中文占比」误杀
  for (const d of ['决定使用 --stdin', '目前改用 --stdin 传入', '决策是改用 --file']) {
    check(`含 ASCII 参数的真决策「${d}」`, constraintsFromProse(d).length > 0, constraintsFromProse(d));
  }
}

// ── 7h) 同批重复不得全部发给 LRC ──
//
// ★第六次审查 P1-3：`offloadItems([同一内容 ×3])` → `distilled=3, deduped=0`。
console.log('=== 7h) 同批去重 ===');
{
  // 需要一个能连上的假 client，否则会在 requireClient 处抛错、拿不到 deduped 计数
  let migrateCalls = 0;
  let lastBatchSize = 0;
  const fakeClient = {
    baseUrl: 'http://127.0.0.1:0',
    distill: async () => ({ items: [], count: 0, indexLine: '' }),
    migrate: async (items: DistilledItem[]) => {
      migrateCalls += 1;
      lastBatchSize = items.length;
      return { written: items.length, merged: 0 };
    },
  } as unknown as Parameters<typeof Offloader.prototype.bind>[0];

  const off = new Offloader(fakeClient, new CursorStore(join(tmpdir(), `lrc-test-${Date.now()}-g.json`)), {
    snapshotItems: 3,
  });
  const dup: DistilledItem = {
    content: '[约束] 不要用 IDM 下载', memory_type: 'preference', tags: ['constraint'],
    importance: 7, source_turns: [0, 0],
  };
  const r = await off.offloadItems([dup, { ...dup }, { ...dup }]);
  console.log(`    结果: distilled=${r.distilled} deduped=${r.deduped} migrate 收到 ${lastBatchSize} 条`);
  check('同批三条重复被压成 1 条（deduped=2）', r.deduped === 2, r.deduped);
  check('只有 1 条进入 migrate', lastBatchSize === 1 && migrateCalls === 1, { lastBatchSize, migrateCalls });
}

// ── 8) 快照：只有结论时仍能输出 ──
console.log('=== 8) 快照退化情形 ===');
{
  const onlyConclusions: DistilledItem[] = [
    { content: '[结论] 某结论', memory_type: 'fact', tags: ['conclusion'], importance: 6, source_turns: [0, 0] },
  ];
  const snap = buildSnapshot(onlyConclusions, 3);
  check('只有结论时仍产出快照', snap.includes('某结论'), snap);
  check('空数组返回空串', buildSnapshot([], 3) === '');
}

console.log('\n=== P1-5 中文对立词不得判重复 ===');
{
  const pairs: Array<[string, string, boolean]> = [
    ['必须放在工作区之外的目录，不能放在 AppData 里', '必须放在工作区之内的目录，不能放在 AppData 里', false],
    ['必须用中文回答所有问题并写中文注释', '必须用英文回答所有问题并写英文注释', false],
  ];
  for (const [a, b, wantDup] of pairs) {
    const got = areNearDuplicate(a, b, 0.85);
    check(`对立词「${a.slice(0, 12)}…」判为不重复`, got === wantDup, { got, want: wantDup });
  }
  // 同一侧的改写仍应判重（不能因为加了反义表就放过真复述）
  check(
    '「工作区外」vs「工作区之外」仍判重复',
    areNearDuplicate('缓存必须放在工作区外', '缓存必须放在工作区之外', 0.85),
  );
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
