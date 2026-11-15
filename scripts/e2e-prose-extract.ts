/**
 * **单一提取器**的回归测试（替代原 `e2e-prose-extract.ts`）。
 *
 * 用法：node scripts/e2e-prose-extract.ts
 *
 * ## 为什么整体重写而不是逐条改
 *
 * 原文件 1266 行，全部围绕 `constraintsFromProse` / `constraintsFromUser` /
 * `isKeyResourceLocation` 三套正则判据写断言。这三套判据已被
 * `memory-schema.ts` 的三元组契约取代 —— 保留旧断言等于同时维护两套语义，
 * 一改就漂移。
 *
 * 现在的测试只对准**一个**入口：`extractFacts()`。所有真实会话里出现过的
 * 关键信息与噪声都作为用例，判据变化时这里会直接失败。
 */
import { extractFacts } from '../src/memory-extract.ts';
import { extractFactsFromReasoning } from '../src/memory-extract.ts';
import { linesWithOrigin } from '../src/session-text.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const asAssistant = (text: string) => extractFacts({ text, origin: 'assistant', sessionId: 's1' });
const asUser = (text: string) => extractFacts({ text, origin: 'user', sessionId: 's1' });

// ────────────────────────────────────────────────────────────
// 1. 真实会话里的关键信息必须被抽到
// ────────────────────────────────────────────────────────────
console.log('=== 1) 真实关键信息 ===');
{
  const cases: Array<[string, string]> = [
    ['不要走下载链接，直接复制桌面上的文件。', '下载链接'],
    ['由于 PowerShell 会吞掉 JSON 内的引号，改用 --stdin 传入。', '--stdin'],
    ['缓存必须放在工作区之外，否则沙箱会拦住。', '工作区'],
    ['根因是旧进程没有随会话退出，新连接被挡在握手阶段。', '旧进程'],
    ['排查结论：LRC 的 3099 端口被旧进程占用，导致连接超时。', '3099'],
    ['定位到 offloadExtracted 里的代次判断有问题。', '代次'],
    ['延迟必须压到 200ms 以内。', '200ms'],
    ['只支持 Windows，macOS 不兼容。', 'Windows'],
    ['以后都改用 pnpm，别用 npm。', 'pnpm'],
    ['决定不再使用 IDM 下载音频。', 'IDM'],
  ];
  for (const [src, needle] of cases) {
    const got = asAssistant(src);
    check(
      `抽到「${src.slice(0, 18)}…」`,
      got.facts.some((f) => f.statement.includes(needle)),
      got.facts.map((f) => f.statement),
    );
  }
}

// ────────────────────────────────────────────────────────────
// 2. 噪声必须被拒
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 噪声必须被拒 ===');
{
  const noise = [
    '我先看一下这个文件的结构，然后从入口开始读。',
    '让我确认一下配置在哪里。',
    '这个 CLI 现在能启动了，但它默认把缓存写到 AppData。',
    '开工前先定几件事，其余我按默认来。',
    '刚刚安装完成，现在正在验证。',
    '那我得确认两件事：git 本身的状态，以及 DSH 能不能起来。',
    '这必须用上。',
    '这个得改。',
    '好的，我来看看。',
    '我看了你当前的工作目录 `default-workspace`，它不是 git 仓库。',
    '上游克隆缓存在 `D:\\Users\\.dsh\\cache\\mattpocock-skills`，0.8 MB。',
    '另外，你这目录里堆了几十个 `.mjs` 探针脚本。',
    '结论：接下来我要确认工具参数和推理内容究竟存放在哪里。',
    '下一步目标是先把依赖装好。',
    '目标是降低成本。',
    '这个结论不一定对。',
  ];
  const got = asAssistant(noise.join('\n'));
  console.log(`  抽出 ${got.facts.length} 条：`);
  for (const f of got.facts) console.log(`    [${f.kind}] ${f.statement}`);
  check('过程叙述 / 状态陈述 / 残句全部被拒', got.facts.length === 0, got.facts.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 3. 用户消息：资源位置
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 用户消息资源位置 ===');
{
  const r1 = asUser('D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务');
  check('盘符路径 + 媒体文件 → location', r1.facts.some((f) => f.kind === 'location'), r1.facts.map((f) => f.statement));

  const r2 = asUser('使用产品截图与 H:\\daoti\\out_work\\segs 的音频加 H:\\daoti\\out_work\\motion 的文案，生成视频');
  const locs = r2.facts.filter((f) => f.kind === 'location');
  check('多目录交代抽出 2 条位置', locs.length === 2, locs.map((f) => `${f.subject} → ${f.value}`));
  check('两个目录都保住（不被去重吞掉）', new Set(locs.map((f) => f.value)).size === 2, locs.map((f) => f.value));

  const r3 = asUser('音频在桌面，你处理一下');
  check('口语「音频在桌面」→ location', r3.facts.some((f) => f.kind === 'location'), r3.facts.map((f) => f.statement));

  const r4 = asUser('不是告诉你音频在的位置了吗？你一点击下载，就会调起 IDM');
  check('纠正句能抽出内容', r4.facts.length > 0, r4.facts.map((f) => f.statement));

  // 助手正文里的路径**不该**被当成资源位置（这是三代词表失败的根因）
  const a1 = asAssistant('G:\\loong 是仓库，缓存在 C:\\Users\\.dsh 下');
  check(
    '助手正文的路径不当资源位置',
    !a1.facts.some((f) => f.kind === 'location'),
    a1.facts.map((f) => `${f.kind}:${f.statement}`),
  );
}

// ────────────────────────────────────────────────────────────
// 4. 状态陈述 vs 约束
// ────────────────────────────────────────────────────────────
console.log('\n=== 4) 状态陈述不得当约束 ===');
{
  const states = [
    '系统提示占比从 6% 降到 3%，只是被总量稀释。',
    '缓存命中率降到 61.4%，之后逐步恢复到 96.1%。',
    '与上一轮相比，toolResult 从 43.8% 微降到 43.1%。',
  ];
  const got = asAssistant(states.join('\n'));
  check('观测数据不当目标', got.facts.length === 0, got.facts.map((f) => f.statement));

  const goal = asAssistant('延迟必须压到 200ms 以内。');
  check('主动施为的目标能抽到', goal.facts.length === 1, goal.facts.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 5. 情态词优先于时态词
// ────────────────────────────────────────────────────────────
console.log('\n=== 5) 情态词优先 ===');
{
  const cases = [
    '必须先把音频放到 assets，然后用 --file 传入。',
    '不要走 IDM 下载，已经说过两次了。',
    '必须用 --stdin 传入，然后再验证一次。',
  ];
  for (const src of cases) {
    const got = asAssistant(src);
    check(`含情态词的句子不被时态词误杀：${src.slice(0, 14)}…`, got.facts.length === 1, got.facts.map((f) => f.statement));
  }
}

// ────────────────────────────────────────────────────────────
// 6. 「通过/经过/跳过」类约束不得误杀
// ────────────────────────────────────────────────────────────
console.log('\n=== 6) 构词不误杀 ===');
{
  const cases = ['必须通过 --stdin 传参。', '禁止通过 IDM 下载。', '不要跳过校验步骤。'];
  for (const src of cases) {
    const got = asAssistant(src);
    check(`构词不误杀：${src}`, got.facts.length === 1, got.facts.map((f) => f.statement));
  }
}

// ────────────────────────────────────────────────────────────
// 7. 标签路径与正文路径共用 schema
// ────────────────────────────────────────────────────────────
console.log('\n=== 7) 标签路径 ===');
{
  const src = [
    '<lrc_memory>',
    '- 决策：改用 pnpm 替代 npm',
    '- 约束：禁止连 3099 做测试',
    '- 结论：粒度按轮次归属，不按段落',
    '- 结论：接下来我要确认工具参数存放在哪里',
    '</lrc_memory>',
  ].join('\n');
  const got = asAssistant(src);
  console.log(`  抽出 ${got.facts.length} 条：`);
  for (const f of got.facts) console.log(`    [${f.kind}] ${f.statement}`);
  check('标签里的决策被抽出', got.facts.some((f) => f.kind === 'decision'), got.facts.map((f) => f.statement));
  check('标签里的约束被抽出', got.facts.some((f) => f.kind === 'constraint'), got.facts.map((f) => f.statement));
  check('标签被剥掉，不进正文二次抽取', !got.facts.some((f) => f.statement.includes('<lrc_memory>')));
}

// ────────────────────────────────────────────────────────────
// 8. 机器输出不得入库
// ────────────────────────────────────────────────────────────
console.log('\n=== 8) 机器输出 ===');
{
  const src = [
    '{"结论是":"ok"}',
    '"定位到":1',
    'err=定位到',
    'root:根因是',
    '| 0–8s | 一次对话，光点起势 |',
  ].join('\n');
  const got = asAssistant(src);
  check('机器输出全部被拒', got.facts.length === 0, got.facts.map((f) => f.statement));
  // 但注释型约束必须留下
  const comment = asAssistant('TODO: 不要用 IDM 下载');
  check('注释型约束保留', comment.facts.length === 1, comment.facts.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 9. 推理流兜底走同一提取器
// ────────────────────────────────────────────────────────────
console.log('\n=== 9) 推理兜底 ===');
{
  const reasoning = [
    '我先看看这个文件的结构，然后从入口开始读。',
    '结论是：路径 1 必须走 serviceFor 拿引擎，不能直接 ctx.get。',
    '这里有个细节，config 是 deepFreeze 的。',
    '因此改用 compactRegion 自选范围。',
    '好的',
  ].join('\n');
  const got = extractFactsFromReasoning({ text: reasoning, origin: 'assistant', sessionId: 's1' });
  check('推理里抽到结论', got.facts.some((f) => f.statement.includes('serviceFor')), got.facts.map((f) => f.statement));
  check('推理里抽到决策', got.facts.some((f) => f.statement.includes('compactRegion')), got.facts.map((f) => f.statement));
  check('过程句被拒', !got.facts.some((f) => f.statement.includes('先看看这个文件')), got.facts.map((f) => f.statement));
  check('寒暄被拒', !got.facts.some((f) => f.statement === '好的'), got.facts.map((f) => f.statement));
  check('推理来源置信度 ≤ 0.8', got.facts.every((f) => f.confidence <= 0.8), got.facts.map((f) => f.confidence));
}

// ────────────────────────────────────────────────────────────
// 10. 收集阶段：用户口语必须进入沉淀源
// ────────────────────────────────────────────────────────────
console.log('\n=== 10) 收集阶段 ===');
{
  const session = {
    log: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '音频在桌面' }] } },
      // 技能目录不是用户说的话，必须排除
      {
        type: 'user/message',
        data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '技能目录：…' }] },
      },
    ],
  };
  const lines = linesWithOrigin(session);
  check('用户口语进入沉淀源', lines.some((l) => l.text === '音频在桌面'), lines);
  check('技能目录被排除', !lines.some((l) => l.text.startsWith('技能目录')), lines);
}

// ────────────────────────────────────────────────────────────
// 11. 幂等：同一输入重复调用结果稳定
// ────────────────────────────────────────────────────────────
console.log('\n=== 11) 幂等 ===');
{
  const src = '缓存必须放在工作区之外。改用 --stdin 传入。根因是旧进程未退出。';
  const a = asAssistant(src).facts.map((f) => f.statement);
  const b = asAssistant(src).facts.map((f) => f.statement);
  check('重复调用结果一致', JSON.stringify(a) === JSON.stringify(b), { a, b });
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
