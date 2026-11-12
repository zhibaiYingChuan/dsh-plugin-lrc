/**
 * 正文约束抽取的单元测试。
 *
 * 用法：node scripts/e2e-prose-extract.ts
 *
 * 为什么必须单独成一套：这层是「不依赖模型配合」的核心。
 * 实测模型只有 1.8% 的轮次输出 <lrc_memory>，所以约束抽取几乎全靠它。
 * 它抽错 = 沉淀垃圾；抽漏 = 约束丢失，下一轮模型重犯同样的错。
 */
import { constraintsFromProse } from '../src/memory-filter.ts';
import { Offloader, buildSnapshot } from '../src/offloader.ts';
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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
