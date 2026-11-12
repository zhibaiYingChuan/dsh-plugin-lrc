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
import { buildSnapshot } from '../src/offloader.ts';
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
