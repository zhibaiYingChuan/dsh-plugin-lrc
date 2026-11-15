/**
 * schema 契约 + 单一提取器的端到端验证。
 *
 * 用法：node scripts/e2e-schema.ts
 *
 * 这套测试是「全局性修复」的验收依据：所有用例都走**同一个**
 * `extractFacts()`，没有任何路径特有的门槛。
 */
import { deriveClaim, deriveLocation, isSelfContained, validateFact, factKey, makeFact } from '../src/memory-schema.ts';
import { extractFacts, factsFromLlmLines } from '../src/memory-extract.ts';
import { buildSnapshot } from '../src/offloader.ts';
import { linesWithOrigin } from '../src/session-text.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const base = { origin: 'assistant' as const, sessionId: 's1' };
const user = { origin: 'user' as const, sessionId: 's1' };
const asAssistant = (text: string) => extractFacts({ text, ...base });
const asUser = (text: string) => extractFacts({ text, ...user });

// ────────────────────────────────────────────────────────────
// 1. 三元组拆分：这是「一条记忆」的定义
// ────────────────────────────────────────────────────────────
console.log('=== 1) 三元组拆分 ===');
{
  const c1 = deriveClaim('缓存必须放在工作区之外，否则沙箱会拦住');
  check('约束句拆出 (缓存, 必须, 放在工作区之外…)', c1 !== null && c1.kind === 'constraint', c1);
  check('约束句 subject = 缓存', c1?.subject === '缓存', c1?.subject);
  check('约束句 value 非空', (c1?.value.length ?? 0) >= 4, c1?.value);

  const c2 = deriveClaim('改用 --stdin 传入，因为 PowerShell 会吞引号');
  check('决策句拆出 (改用, --stdin…)', c2 !== null && c2.kind === 'decision', c2);

  const c3 = deriveClaim('根因是旧进程没有随会话退出');
  check('结论句拆出 (根因是, 旧进程…)', c3 !== null && c3.kind === 'conclusion', c3);

  const c4 = deriveClaim('延迟必须压到 200ms 以内');
  check('目标/阈值句可拆', c4 !== null, c4);

  // 这是此前 11 轮里最典型的两种残句
  check('残句「这必须用上」拆不出', deriveClaim('这必须用上') === null, deriveClaim('这必须用上'));
  check('残句「那我得确认两件事」拆不出', deriveClaim('那我得确认两件事') === null);
  check('纯叙述「我先看一下文件」拆不出', deriveClaim('我先看一下文件') === null);
  check('机器输出不能当陈述', deriveClaim('{"结论是":"ok"}') === null);
}

// ────────────────────────────────────────────────────────────
// 2. 位置三元组
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 位置三元组 ===');
{
  const loc = deriveLocation('音频在桌面');
  check('「音频在桌面」拆出 (音频, 位于, 桌面)', loc !== null && loc.value === '桌面', loc);
  // 原写法 `=== null || true` 恒真，属无效断言（★2026-11-16 发布前审查 P2）。
  // `音频在的位置` 的「在的位置」是残句，不该被当成位置陈述。
  check('「音频在的位置」不算位置陈述', deriveLocation('音频在的位置') === null, deriveLocation('音频在的位置'));
}

// ────────────────────────────────────────────────────────────
// 3. 自足性判据（替代长度门槛）
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 自足性 ===');
check('「这必须用上」不自足', isSelfContained('这必须用上') === false);
check('「必须用 pnpm」自足', isSelfContained('必须用 pnpm') === true);
check('「这些缓存必须放在工作区之外」自足', isSelfContained('这些缓存必须放在工作区之外') === true);

// ────────────────────────────────────────────────────────────
// 4. 校验闸门
// ────────────────────────────────────────────────────────────
console.log('\n=== 4) 校验闸门 ===');
{
  const good = makeFact({ statement: '缓存必须放在工作区之外', ...base });
  check('正常 Fact 通过校验', good !== null && validateFact(good).ok === true, good);
  const narration = makeFact({ statement: '那我得确认两件事，先看配置', ...base });
  check('过程叙述被拒', narration === null || !validateFact(narration).ok);

  // 低置信度
  const low = makeFact({ statement: '缓存必须放在工作区之外', ...base, confidence: 0.3 });
  check('低置信度被拒', low === null || !validateFact(low).ok);
}

// ────────────────────────────────────────────────────────────
// 5. 真实会话里的关键信息必须抽到
// ────────────────────────────────────────────────────────────
console.log('\n=== 5) 真实约束抽取 ===');
{
  const real = [
    '不要走下载链接，直接复制桌面上的文件。',
    '由于 PowerShell 会吞掉 JSON 内的引号，改用 --stdin 传入。',
    '缓存必须放在工作区之外，否则沙箱会拦住。',
    '根因是旧进程没有随会话退出，新连接被挡在握手阶段。',
    '延迟必须压到 200ms 以内。',
  ].join('\n');
  const got = extractFacts({ text: real, ...base });
  console.log(`  抽到 ${got.facts.length} 条：`);
  for (const f of got.facts) console.log(`    [${f.kind}] ${f.statement}`);
  check('抽到「不要走下载链接」', got.facts.some((f) => f.statement.includes('下载链接')));
  check('抽到「改用 --stdin」', got.facts.some((f) => f.statement.includes('--stdin')));
  check('抽到「必须放在工作区」', got.facts.some((f) => f.statement.includes('工作区')));
  check('抽到「根因是旧进程」', got.facts.some((f) => f.statement.includes('旧进程')));
  check('抽到「压到 200ms」', got.facts.some((f) => f.statement.includes('200ms')));
  check('每条都有谓词', got.facts.every((f) => f.predicate.length > 0));
  check('每条都有取值', got.facts.every((f) => f.value.length > 0));
}

// ────────────────────────────────────────────────────────────
// 6. 噪声必须被拒（此前污染 47→24 条的那批）
// ────────────────────────────────────────────────────────────
console.log('\n=== 6) 噪声必须被拒 ===');
{
  const noise = [
    '我看了你当前的工作目录 `default-workspace`，它不是 git 仓库',
    '上游克隆缓存在 `D:\\Users\\.dsh\\cache\\mattpocock-skills`，0.8 MB',
    '另外，你这目录里堆了几十个 `.mjs` 探针脚本',
    '那我得确认两件事：git 本身的状态，以及 DSH 能不能起来',
    '这必须用上',
    '这个 CLI 现在能启动了，但它默认把缓存写到 AppData',
    '开工前先定几件事，其余我按默认来',
  ].join('\n');
  const got = extractFacts({ text: noise, ...base });
  console.log(`  抽出 ${got.facts.length} 条（应尽量少）：`);
  for (const f of got.facts) console.log(`    [${f.kind}] ${f.statement}`);
  check('过程记录基本被拒（≤1 条）', got.facts.length <= 1, got.facts.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 7. 用户消息：资源位置必须进
// ────────────────────────────────────────────────────────────
console.log('\n=== 7) 用户消息 ===');
{
  const r = extractFacts({
    text: 'D:\\Desktop，score-Dtle1HAU.wav，这是你要打音频。继续任务',
    ...user,
  });
  console.log(`  抽到 ${r.facts.length} 条：`);
  for (const f of r.facts) console.log(`    [${f.kind}] ${f.statement}`);
  check('资源位置被打成 location', r.facts.some((f) => f.kind === 'location'));

  // session-c8762e44 里三处同时失守的那条
  const r2 = extractFacts({
    text: '使用产品截图与 H:\\daoti\\out_work\\segs 的音频加 H:\\daoti\\out_work\\motion 的文案，生成视频',
    ...user,
  });
  console.log(`  多目录交代抽到 ${r2.facts.length} 条：`);
  for (const f of r2.facts) console.log(`    [${f.kind}] ${f.statement} (${f.subject} / ${f.value})`);
  check('多目录交代至少抽出 1 条位置', r2.facts.some((f) => f.kind === 'location'));

  const r3 = extractFacts({ text: '不是告诉你音频在的位置了吗？你一点击下载，就会调起 IDM', ...user });
  check('纠正句能拆出约束或位置', r3.facts.length > 0, r3.facts.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 8. 临时参数 → scope=session
// ────────────────────────────────────────────────────────────
console.log('\n=== 8) scope 判定 ===');
{
  const temp = extractFacts({ text: '帮我做一个不超过 5 秒的视频', ...user });
  const tempFact = temp.facts.find((f) => f.statement.includes('5 秒'));
  check('临时参数标为 session', tempFact === undefined || tempFact.scope === 'session', tempFact?.scope);

  const perm = extractFacts({ text: '以后都用 pnpm，别用 npm', ...user });
  const permFact = perm.facts[0];
  check('长期约定标为 project', permFact === undefined || permFact.scope === 'project', permFact?.scope);
}

// ────────────────────────────────────────────────────────────
// 9. LLM 候选走同一闸门
// ────────────────────────────────────────────────────────────
console.log('\n=== 9) LLM 候选 ===');
{
  const r = factsFromLlmLines(
    ['约束：缓存必须放在工作区之外', '结论：这必须用上', '结论：根因是旧进程未退出'],
    { origin: 'assistant', sessionId: 's1' },
  );
  check('LLM 的合法候选通过', r.facts.some((f) => f.statement.includes('工作区')));
  check('LLM 的残句被同一闸门拒绝', !r.facts.some((f) => f.statement === '这必须用上'), r.facts.map((f) => f.statement));
  check('被拒原因可审计', r.rejected.length > 0, r.rejected);
}

// ────────────────────────────────────────────────────────────
// 10. 冲突键
// ────────────────────────────────────────────────────────────
console.log('\n=== 10) 冲突键 ===');
{
  const a = makeFact({ statement: '端口必须用 3099', ...base });
  const b = makeFact({ statement: '端口必须用 3111', ...base });
  check('同 subject+predicate 不同 value → 同 key', a !== null && b !== null && factKey(a) === factKey(b), {
    a: a === null ? null : factKey(a),
    b: b === null ? null : factKey(b),
  });
}

// ────────────────────────────────────────────────────────────
// 11. 快照
// ────────────────────────────────────────────────────────────
console.log('\n=== 11) 快照 ===');
{
  const r = extractFacts({
    text: '缓存必须放在工作区之外。改用 --stdin 传入。根因是旧进程未退出。',
    ...base,
  });
  const snap = buildSnapshot(r.facts, 3);
  console.log(`  快照：${snap}`);
  check('快照非空', snap.length > 0);
  check('快照带 [LRC 状态] 前缀', snap.startsWith('[LRC 状态]'));
  check('约束优先于结论', snap.includes('工作区') || snap.includes('--stdin'));
}

// ────────────────────────────────────────────────────────────
// 12. 收集阶段不再做语义筛选
// ────────────────────────────────────────────────────────────
console.log('\n=== 12) 收集阶段 ===');
{
  // 旧实现在这里用 hasConstraintMarker 过滤，导致「音频在桌面」进不了沉淀源
  const session = {
    log: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '音频在桌面' }] } },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '缓存必须放在工作区之外。' }] } },
      },
    ],
  };
  const lines = linesWithOrigin(session);
  check('用户口语「音频在桌面」进入沉淀源', lines.some((l) => l.origin === 'user' && l.text === '音频在桌面'), lines);
  check('助手正文进入沉淀源', lines.some((l) => l.origin === 'assistant'));
}

// ────────────────────────────────────────────────────────────
// 13. 陈述性谓词：定义句（★2026-11-14 真实测试暴露的整类漏抽）
// ────────────────────────────────────────────────────────────
//
// 用户问「这个仓库是什么」，模型的答案此前 4/4 全漏 —— 因为词表里只有
// 规范性谓词（必须/不要/改用），没有陈述性谓词（是/属于/收录了）。
console.log('\n=== 13) 陈述性谓词 ===');
{
  const shouldHit = [
    'awesome-code-animation 是一个收录代码动画项目的聚合仓库。',
    '这个仓库收录了 443 个代码动画项目。',
    '这个仓库不需要安装，克隆下来直接看 examples 目录。',
    'Manim 是一个用 Python 做数学动画的引擎。',
  ];
  for (const src of shouldHit) {
    const got = asAssistant(src);
    check(`定义句被抽到：${src.slice(0, 20)}…`, got.facts.length > 0, got.facts.map((f) => f.statement));
  }

  // 误收代价比漏收高：statement 会被当「用户问题的答案」注入快照
  const shouldMiss = [
    '是的，我明白了。',
    '这个是刚才那个文件。',
    '问题是我还不知道它到底能不能跑。',
    '是这个意思吗？',
    '这是一个问题。',
    '可能是我弄错了。',
    '是我做的。',
    '这样的话就只能重写了。',
    '这就是问题所在。',
    // 名词短语里的谓词词形（真实碎片）
    '看过决定不收的，写进 excluded.json',
    '这一点已经决定过了',
  ];
  for (const src of shouldMiss) {
    const got = asAssistant(src);
    check(`陈述误收被拒：${src.slice(0, 18)}…`, got.facts.length === 0, got.facts.map((f) => f.statement));
  }
}

// ────────────────────────────────────────────────────────────
// 15. 引用片段里的谓词不得被当谓语（★2026-11-14 真实碎片）
// ────────────────────────────────────────────────────────────
//
// 实测 session-d08bcd4c：从一份 7258 字符的架构分析里抽出 4 条「约束」，
// **全部**是谓词落在反引号/引号内部的碎片。引用内容是被谈论的对象，
// 不是作者的主张，切出的三元组主语必然带半截引号。
console.log('\n=== 15) 引用片段里的谓词不算谓语 ===');
{
  const fragments = [
    'TraeAgent 覆盖成"必须调用 `task_done` 工具"',
    '`server/` 只有一份 Readme 写着"不要用于生产"',
    '`project_path / must _patch / patch_path` 全是可变实例属性',
    // 首个谓词之后的词是取值内部成分，不是本句谓语
    '后果是 `asyncio.gather` 的并行工具调用只能并行到第一个真 I/O 就串行化',
    // 主语不是完整名词短语：「的」字结构 / 冒号粘连两句
    '它想干的是 Aider repo-map 那件事',
    '定位窄：这是 SWE-bench issue 修复 agent',
  ];
  for (const src of fragments) {
    const got = asAssistant(src);
    check(`碎片被拒：${src.slice(0, 22)}…`, got.facts.length === 0, got.facts.map((f) => f.statement));
  }

  // 但正常引用旁边的真主张仍要保留：谓词在引用**之外**
  const stillHit = [
    '以后都用 pnpm，别用 npm',
    '缓存必须放在工作区之外，否则版本一升就被清掉',
    'TODO: 不要用 IDM 下载',
  ];
  for (const src of stillHit) {
    const got = asAssistant(src);
    check(`引用外的真主张仍保留：${src.slice(0, 18)}…`, got.facts.length === 1, got.facts.map((f) => f.statement));
  }
}

// ────────────────────────────────────────────────────────────
// 17. 用户粘贴长文档时的 4 类误抽（★2026-11-14 真实会话）
// ────────────────────────────────────────────────────────────
//
// session-95eaf7e3（新项目开工）用户粘贴 16882 字符产品文档，抽出 6 条
// Fact 中有 4 条是错的。这些都是「用户输入是长文档」才暴露的形态 ——
// 之前所有测试只用短句，所以一直没被发现。
console.log('\n=== 17) 长文档误抽 ===');
{
  // ① 位置句的取值必须是地点，不能是动作描述
  check(
    '「位于+动作」被拒（位于不是地点介词）',
    deriveLocation('用户点击后立即退出：数据已位于点击时写入本地，下次启动时同步') === null,
  );
  check(
    '「位于+真地点」保留',
    deriveLocation('音频位于 D:\\Desktop') !== null,
  );
  check(
    '「在+桌面」保留（原有能力不退）',
    deriveLocation('音频在桌面') !== null,
  );
  // ② 多目录交代：逗号后是另一条位置，应保留第一条而不是整句丢
  const multi = deriveLocation('音频在桌面，文案在下载目录');
  check('多位置句保留第一条', multi !== null && multi.value === '桌面', multi);

  // ③ 主语只有量词没有中心名词 ⇒ 不是主语
  const quantifier = asUser('一款基于“反向德西效应”心理学原理');
  check('「一款基于…」被拒（主语缺中心名词）', quantifier.facts.length === 0, quantifier.facts.map((f) => f.statement));

  // ④ 主语带半截括号 ⇒ 取值从括注里切出
  const bracket = asUser('系统生成认罪帖文案（基于用户身份设定）');
  check('「…（基于…）」被拒（主语括号未闭合）', bracket.facts.length === 0, bracket.facts.map((f) => f.statement));

  // ⑤ 动词+裸量词 ⇒ 缺宾语
  const bareQuantifier = asUser('必须选择一个');
  check('「必须选择一个」被拒（裸量词缺宾语）', bareQuantifier.facts.length === 0, bareQuantifier.facts.map((f) => f.statement));
  // 但完整祈使句仍要保留
  const realRule = asUser('必须完整经历五屏引导');
  check('「必须完整经历五屏引导」保留', realRule.facts.length === 1, realRule.facts.map((f) => f.statement));

  // ⑥ 资源名词必须就近：长文档里「视频」出现在别处时不得张冠李戴
  const longDoc = [
    '本产品帮助用户戒掉刷短视频的习惯，定位是社交共修。',
    ''.padEnd(200, ' '),
    '底部："入戒门"按钮（草鞋图标`straw_sandal.png`）',
  ].join('\n');
  const got = asUser(longDoc);
  const wrong = got.facts.filter((f) => f.kind === 'location' && f.statement.includes('straw_sandal'));
  check('长文档不产生错位的位置 Fact', wrong.length === 0, wrong.map((f) => f.statement));
}

// ────────────────────────────────────────────────────────────
// 19. 过程叙述必须按**来源**判（★2026-11-14 真实会话）
// ────────────────────────────────────────────────────────────
//
// session-95eaf7e3（长任务）暴露：模型每步都用「接下来把…」叙述自己的
// 动作，规则层把它们当决策入库（实测 4 条里 3 条是过程）。
// 但同一个开头在用户消息里是**下达要求**，正是该记的内容。
console.log('\n=== 19) 过程叙述按来源判 ===');
{
  const assistantProcess = [
    '接下来把遮罩颜色改成可继承的变量',
    '现在把两个纸色底页面改用新变体',
    '下一步把依赖装好再跑',
    // 执行叙述的其余三类形态
    '同时把 `base.css` 里那段改成作用于组件',
    '我把它们都改成绘制出来的图形',
    '换到一个全新的空数据库重跑',
    // 单数「我」+ 任意动作（动词是开放集合，不能靠枚举）
    '我会补上"守"和"破"两个图标用来替换字符符号',
    '我改用点击「下一步」并按步号截图',
    // 征询/自荐句
    '需要我把它改成方印的形状',
  ];
  for (const src of assistantProcess) {
    const got = asAssistant(src);
    check(`助手过程叙述被拒：${src.slice(0, 18)}…`, got.facts.length === 0, got.facts.map((f) => f.statement));
  }

  // 用户说「接下来要…」是在下要求，不能被当成过程叙述丢掉
  // （它拆不出三元组，所以进 pending 等 LLM 裁决 —— 关键是**没被过程判据杀**）
  const userIntent = asUser('接下来要保证用户能持续用下去');
  check(
    '用户意图「接下来要…」不被过程判据杀',
    userIntent.pending.some((p) => p.includes('持续用下去')),
    userIntent.rejected,
  );
  check(
    '同一句在助手侧被杀（来源区分）',
    asAssistant('接下来要保证用户能持续用下去').pending.length === 0,
  );

  // 真约束/决策不受影响
  const stillHit = [
    '必须完整经历五屏引导',
    '缓存必须放在工作区之外',
    '改用 --stdin 传入 JSON',
  ];
  for (const src of stillHit) {
    const got = asAssistant(src);
    check(`真约束仍保留：${src.slice(0, 16)}…`, got.facts.length === 1, got.facts.map((f) => f.statement));
  }

  // 「把」开头的祈使交付指令：不被过程判据杀（拆不出三元组时进 pending 也可）
  // 注意用例长度需 ≥ MIN_STATEMENT(6)，否则会先被长度判据拦下
  for (const src of ['把音频放到桌面', '把依赖装到工作区里']) {
    const got = asAssistant(src);
    const kept = got.facts.length + got.pending.length > 0;
    check(`「${src}」不被过程判据杀`, kept, { facts: got.facts.length, pending: got.pending, rejected: got.rejected });
  }

  // 「我」开头的**判断句**必须保留（不能一刀切拒掉所有「我」）
  for (const src of ['我们必须完整经历五屏引导', '我建议用 pnpm 替代 npm']) {
    const got = asAssistant(src);
    const kept = got.facts.length + got.pending.length > 0;
    check(`「${src}」不被过程判据杀`, kept, { facts: got.facts.length, pending: got.pending, rejected: got.rejected });
  }

  // 时间词作主语 ⇒ 不是主语（「现在」只是状语，真主语被省略成「我」）
  const timeSubject = asAssistant('现在换成真正的方印：石质方身、篆意的「志」字');
  check(
    '时间词作主语被执行判据拒',
    timeSubject.facts.length === 0,
    timeSubject.facts.map((f) => f.statement),
  );
  // 但情态句不能误杀：`目前只支持 Windows` 是事实约束
  const modal = asAssistant('目前只支持 Windows');
  check('时间词 + 情态谓词仍入库', modal.facts.length === 1, modal.facts.map((f) => f.statement));

  // 完成时态「全部/都/已 + 换成/改成」⇒ 刚做完的动作
  for (const src of ['全部换成了真正绘制的线条', '都已改成 SVG 了']) {
    const got = asAssistant(src);
    check(`完成态变更被拒：${src.slice(0, 14)}…`, got.facts.length === 0, got.facts.map((f) => f.statement));
  }
  // 但「全部依赖都必须…」是范围限定，不是完成态动作
  const scopeLimit = asAssistant('全部依赖都必须从工作区安装');
  check('范围限定不误杀', scopeLimit.facts.length === 1, scopeLimit.facts.map((f) => f.statement));

  // 建议 + 变更动词 ⇒ 待定方案；一般性建议要保留
  check('「建议改成…」被拒', asAssistant('建议改成墨底加朱边').facts.length === 0);
  const advisory = asAssistant('建议收集用户反馈');
  check('一般性建议保留', advisory.facts.length + advisory.pending.length > 0, advisory.rejected);
}

// ────────────────────────────────────────────────────────────
// 21. 正反问句（A-not-A）必须判为提问（★2026-11-15 真实误收）
// ────────────────────────────────────────────────────────────
//
// 真实审计（session-95eaf7e3，4787 事件）发现：`要不要横向再收窄一点`
// 被判为 constraint 入库。后果不是「多收一条」而是**挤占** ——
// `keepPriority` 给 constraint 排 rank 0，快照只有 3 槽，它会挤掉
// `必须完整经历五屏引导`。
//
// 根因是 `QUESTION_WORD` 用枚举（12 个疑问词），汉语正反问的形态
// 是封闭的 `X不X`，枚举疑问**词**必然漏，判疑问**形态**才收敛。
console.log('\n=== 21) 正反问句判据 ===');
{
  const { isQuestion, makeFact } = await import('../src/memory-schema.ts');

  const asks = [
    '要不要横向再收窄一点',
    '要不要改成 SVG',
    '能否改成 SVG',
    '该不该改',
    '是不是应该收窄',
    '会不会有问题',
    '可否改成方印',
    '有无更优解',
  ];
  for (const a of asks) {
    check(`正反问判为提问：${a}`, isQuestion(a) === true, { isQuestion: isQuestion(a) });
  }

  // 独立审查补充：`可不` / `要不` 曾被误判成提问
  check('「可不要再碰 3099」不算提问（祈使）', isQuestion('可不要再碰 3099') === false, {
    isQuestion: isQuestion('可不要再碰 3099'),
  });

  // ★2026-11-15 P2-9：条件连词「要不是」曾被通配判成提问
  //
  // 通配 `[能要是该会应][不否]` 只看前两字，`要不` 命中而 `要` + `是`
  // 才是完整形态。误判后果比「少收一条」严重：`isQuestion` 是**硬拒**，
  // 不进 pending，整句直接消失。
  // ## 必须与「要不」区分的边界
  //
  // 这两个是**真**条件/祈使句，区别在第三字：
  // ```
  // 要不是先跑测试…   ← 「要是」→ 条件连词
  // 可不要再碰 3099   ← 「可」+「不要」→ 祈使
  // 要不要改          ← 「要」+「不要」→ 正反问
  // ```
  const notQuestions = ['要不是先跑测试，这次就挂了', '可不要再碰 3099 端口'];
  for (const nq of notQuestions) {
    check(`条件句/祈使不算提问：${nq}`, isQuestion(nq) === false, { isQuestion: isQuestion(nq) });
  }
  // ## `有无` 必须带词边界（第二轮审查 P0-3）
  //
  // `有` + 否定词修饰名词 极常见，与正反问 `有无` 同形。实测 3/6 误杀。
  const hasNotQuestions = ['有无线网络必须先关掉', '有无效的字段要先过滤', '有无法访问的路径要跳过'];
  for (const hq of hasNotQuestions) {
    check(`「有+否定词名词」不算提问：${hq}`, isQuestion(hq) === false, { isQuestion: isQuestion(hq) });
  }
  check('「有无更优解」仍算提问', isQuestion('有无更优解') === true, { isQuestion: isQuestion('有无更优解') });

  // ## 句中正反问：最常见的真实位置（第二轮审查 P0-2）
  //
  // 首版只锚定句首/分句首，漏掉 `这个 X 要不要 Y` —— 后果是**语义反转**：
  // 提问被切成 `(遮罩要|不要|改成变量)` 存成 constraint（禁令）。
  const midSentences = ['遮罩要不要改成变量', '端口要不要换成 3099', '缓存要不要放在工作区外'];
  for (const ms of midSentences) {
    check(`句中正反问判为提问：${ms}`, isQuestion(ms) === true, { isQuestion: isQuestion(ms) });
  }
  // 且必须真的**不入库**（不只 isQuestion 为真）
  {
    const { extractFacts } = await import('../src/memory-extract.ts');
    for (const ms of midSentences) {
      const r = extractFacts({ text: ms, origin: 'assistant', sessionId: 'audit' });
      check(
        `句中正反问不入库：${ms}`,
        r.facts.length === 0,
        { facts: r.facts.map((f) => `${f.subject}/${f.predicate}/${f.value}`), rejected: r.rejected.map((x) => x.reason) },
      );
    }
  }

  // ## 解释类豁免必须先于疑问判据（第二轮审查 P1-1）
  check('「说明为什么…」不算提问', isQuestion('说明为什么必须用 pnpm') === false, {
    isQuestion: isQuestion('说明为什么必须用 pnpm'),
  });
  check('「能否说明为什么…」也不算提问', isQuestion('能否说明为什么必须用 pnpm') === false, {
    isQuestion: isQuestion('能否说明为什么必须用 pnpm'),
  });

  // ## 反问句「跟你说多少遍」（第二轮审查 P1-2）
  //
  // `QUESTION_WORD` 里有「多少」，会把它**反向硬拒**成 question ——
  // 而 question 不进 pending，整场最强的约束直接消失。
  check('「跟你说多少遍了」不算提问', isQuestion('跟你说多少遍了别用 IDM') === false, {
    isQuestion: isQuestion('跟你说多少遍了别用 IDM'),
  });
  check('「跟你说过多少次」不算提问', isQuestion('跟你说过多少次不要碰 3099') === false, {
    isQuestion: isQuestion('跟你说过多少次不要碰 3099'),
  });
  // ## 因果连词后必须是**真主体**或空主语，不能是单字残余（第二轮审查 P1-3）
  //
  // `从而必须重启服务` 若先剥结尾连词，`而` 被吃掉、剩「从」当主语 ——
  // `factKey` 会变成 `constraint|从|必须`，与任何「从 X 必须 Y」撞键。
  {
    const { extractFacts } = await import('../src/memory-extract.ts');
    for (const causal of ['因而改用 pnpm', '因此改用 compactRegion']) {
      const r = extractFacts({ text: causal, origin: 'assistant', sessionId: 'audit' });
      const dirty = r.facts.filter((f) => f.subject.length === 1);
      check(
        `因果连词不产生单字脏主语：${causal}`,
        dirty.length === 0,
        { facts: r.facts.map((f) => `${f.subject || '∅'}/${f.predicate}/${f.value}`) },
      );
    }
  }

  // ## 承接连词 / 条件连词的漏词（第二轮审查 P1-4）
  //
  // 实测漏词会产出脏主语并直接进 rank0：
  // ```
  // 此外必须用 pnpm    → constraint:{此外|必须|用 pnpm}
  // 即便图标固定为 16px → decision:{即便图标固|定为|16px}
  // ```
  {
    const { extractFacts } = await import('../src/memory-extract.ts');
    const dirtySources = [
      '此外必须用 pnpm',
      '再者只能本地访问',
      '反之改用缓存',
      '倘若缓存放在工作区外',
      '即便图标固定为 16px',
      '纵使必须经历五屏',
    ];
    for (const src of dirtySources) {
      const r = extractFacts({ text: src, origin: 'assistant', sessionId: 'audit' });
      // 要么不入库，要么主语不含连词残余
      const hasDirty = r.facts.some(
        (f) => /^(?:此外|再者|反之|倘若|即便|纵使|且|并|而)$/.test(f.subject) || f.subject.length === 1,
      );
      check(
        `连词不产生脏主语：${src}`,
        !hasDirty,
        { facts: r.facts.map((f) => `${f.subject || '∅'}/${f.predicate}/${f.value}`) },
      );
    }
  }

  // 真提问仍须命中（含省略问号的形态 —— 这类**应该**判为提问）
  const realQuestions = ['要不要横向收窄', '是不是该收窄', '能不能改成方印', '能否改成 SVG', '应不应该重画'];
  for (const rq of realQuestions) {
    check(`真提问仍命中：${rq}`, isQuestion(rq) === true, { isQuestion: isQuestion(rq) });
  }

  // 关键反例：`不要碰 3099` 与 `要不要…` 只差一个「要」，必须分开
  const keeps = [
    '不要碰 3099 端口',
    '必须用 pnpm',
    '别用 npm',
    '缓存必须放在工作区之外',
    '务必先跑测试',
    '把音频放到桌面',
    '改用 --stdin 传入 JSON',
  ];
  for (const k of keeps) {
    check(`真约束不误判：${k}`, isQuestion(k) === false, { isQuestion: isQuestion(k) });
    const f = makeFact({ statement: k, origin: 'user', sessionId: 'audit' });
    check(`真约束仍入库：${k}`, f !== null, f);
  }
}

// ────────────────────────────────────────────────────────────
// 22. 位置短语作主语 ⇒ 不自足（★2026-11-15 真实误收）
// ────────────────────────────────────────────────────────────
//
// 真实召回巡检发现：`它的旁边是一个空洞的虚线框` 已入库（tag=statement,
// importance=6）。它过了 `isSelfContained` 的长度闸门（剥剩 14 字），
// 但「它」指什么无人知道 —— 与承接代词同一种缺陷，只是残句更长。
console.log('\n=== 22) 位置短语不自足 ===');
{
  const { isSelfContained } = await import('../src/memory-schema.ts');

  // 方位短语 + 参照物是**纯代词** ⇒ 参照物不在句内
  //
  // ★2026-11-15 独立审查修正：`这个按钮的右边是图标` **不该**拒 ——
  // 「按钮」就在句内，完全自足。首版把它列进应拒名单，是断言本身错了。
  // 判据只在剥掉指代后生效，所以 `rest` 以方位词开头才算「参照物是代词」。
  const positions = [
    '它的旁边是一个空洞的虚线框',
    '它的左侧是工具栏',
    '它周围是朱砂边框',
    '它的上方是导航栏',
  ];
  for (const p of positions) {
    check(`位置短语判为不自足：${p}`, isSelfContained(p) === false, { isSelfContained: isSelfContained(p) });
  }

  // 关键反例：参照物（具体名词）在句内 ⇒ 仍自足
  const concrete = [
    '这个仓库的中间层有 443 个项目',
    '这个仓库的中间有 443 个项目',
    '这个文件的下方有一条注释',
    '这个面板的右侧是工具栏',
    '这个按钮的右边是图标',
    '这个页面的顶部是导航栏',
    '这些项目的许可证各不相同',
    '这个仓库收录了 443 个代码动画项目',
    '这个仓库是一个聚合仓库',
    '它的许可证是 MIT',
    '锁孔旁边是锁梁',
  ];
  for (const c of concrete) {
    check(`具体主体仍自足：${c}`, isSelfContained(c) === true, { isSelfContained: isSelfContained(c) });
  }
}

// ────────────────────────────────────────────────────────────
// 23. lrc-prune 是助手正文：不进用户请求，但要进助手结论（★2026-11-15）
// ────────────────────────────────────────────────────────────
//
// 实测 session-95eaf7e3：7 次压缩里 6 次「请求 真实 0」。
//
// ★2026-11-15 更正：后续用 `shadowedSeqs` 回查被遮蔽区间，确认那些
// 「真实 0」是**准确**的 —— 被裁区间里确实没有真实用户发言，条目全部
// 继承自上游摘要。真正的问题是日志措辞容易被读成「统计坏了」，
// 已在 `summaryStats` 改成 `N(=0新+M旧)`。
// `appendReplace` 用 `surfaceOp: replace` 遮蔽原始 assistant/message，
// 所以 lrc-prune 是该内容**唯一载体**，`role` 被强制成 'user'。
//
// 首版写成 `continue` 直接丢弃 —— 那是**有损过滤**，把本轮任务产出
// （「十六枚都已经画好…一眼能认出 1A 锁、2A 窗、4B 镜」）整段抹掉。
// 正确做法是**重分类**：不进用户请求，按 assistant 身份进结论段。
console.log('\n=== 23) lrc-prune 重分类 ===');
{
  const { buildDeterministicSummary } = await import('../src/context-trim.ts');
  const mk = (role: string, text: string, kind?: string) => ({
    role,
    content: [{ type: 'text', text }],
    ...(kind === undefined ? {} : { source: { kind } }),
  });

  const contaminated = [
    mk('user', '所有的图标要用 SVG 绘制出来', 'user'),
    mk('user', '十六枚都已经画好，一眼能认出 1A 锁、2A 窗、4B 镜', 'lrc-prune'),
    mk('user', '你应该多画几个版本，让我来选', 'user'),
  ];
  // 无 facts：降级路径
  const out = buildDeterministicSummary(contaminated, 4000);
  const req = (out.split('### 用户请求')[1] ?? '').split('###')[0];
  const con = (out.split('### 助手结论')[1] ?? '').split('###')[0];
  check('lrc-prune 不进用户请求', !req.includes('十六枚都已经画好'), req.trim());
  check('lrc-prune 进助手结论', con.includes('十六枚都已经画好'), con.trim());
  check('真实用户请求仍在', req.includes('所有的图标要用 SVG'), req.trim());
  check('后一条真实请求仍在', req.includes('多画几个版本'), req.trim());

  // 有 facts：账本投影路径。lrc-prune 的正文是**尚未入库的原始素材**，
  // 若因有 facts 就跳过，这段在摘要里会完全消失。
  const withFacts = buildDeterministicSummary(contaminated, 4000, undefined, [
    { kind: 'decision', statement: '每样各画一版，一共十六枚' },
  ]);
  const con2 = (withFacts.split('### 助手结论')[1] ?? '').split('###')[0];
  check('有 facts 时 lrc-prune 仍进结论', con2.includes('十六枚都已经画好'), con2.trim());
  check('有 facts 时账本条目也在', con2.includes('每样各画一版'), con2.trim());

  // 关键反例：普通 user 消息（无 source）不能被误杀
  const plain = [
    { role: 'user', content: [{ type: 'text', text: '把插件改成 external 模式' }] },
    { role: 'user', content: [{ type: 'text', text: '再补一个测试' }] },
  ];
  const plainOut = buildDeterministicSummary(plain, 4000);
  check('无 source 的用户消息不被误杀', plainOut.includes('external 模式') && plainOut.includes('再补一个测试'), plainOut);

  // 后台任务结束通知是宿主插管，不属于任何参与者 ⇒ 丢弃
  const withJobs = [
    mk('user', '开始改图标', 'user'),
    mk('user', 'background job pwsh-2b002cc2420941a9 (pwsh: cd H:\\xjz; node server/src/index.js) finished', 'tool-jobs'),
    mk('user', 'background job pwsh-41e9ad476fd64f23 (pwsh: cd H:\\xjz; node scripts/dev.mjs) finished', undefined),
  ];
  const jobsOut = buildDeterministicSummary(withJobs, 4000);
  check('tool-jobs 不进用户请求', !jobsOut.includes('pwsh-2b002cc2420941a9'), jobsOut);
  // kind 丢失时靠内容前缀兜底
  check('kind 丢失时仍按前缀拦住', !jobsOut.includes('pwsh-41e9ad476fd64f23'), jobsOut);
  check('真实请求仍在（jobs 场景）', jobsOut.includes('开始改图标'), jobsOut);

  // ── 以下三条来自独立审查指出的覆盖缺口 ──

  // (1) 账本顺序：必须取**最新** 15 条，不是最旧的
  const manyFacts = Array.from({ length: 30 }, (_, i) => ({
    kind: 'decision',
    statement: `账本第 ${i + 1} 条（越靠后越新）`,
  }));
  const orderOut = buildDeterministicSummary([mk('user', '请求', 'user')], 30000, undefined, manyFacts);
  const orderCon = (orderOut.split('### 助手结论')[1] ?? '').split('###')[0];
  check('账本投影取最新而非最旧', orderCon.includes('账本第 30 条'), orderCon.trim());
  check('账本投影不含最旧条目', !orderCon.includes('账本第 1 条'), orderCon.trim());

  // (2) prune 首句是过程叙述时，后续真实产出仍要进结论段
  const mixed = [
    mk(
      'user',
      '我先看一下现有结构。\n十六枚都已经画好，一眼能认出 1A 锁、2A 窗、4B 镜。\n四枚图标已按你选定的原样恢复。',
      'lrc-prune',
    ),
  ];
  const mixedOut = buildDeterministicSummary(mixed, 4000);
  const mixedCon = (mixedOut.split('### 助手结论')[1] ?? '').split('###')[0];
  check('prune 逐句判：过程句不占槽', !mixedCon.includes('我先看一下现有结构'), mixedCon.trim());
  check('prune 逐句判：真实产出存活', mixedCon.includes('十六枚都已经画好'), mixedCon.trim());
  check('prune 逐句判：第二句真实产出也存活', mixedCon.includes('原样恢复'), mixedCon.trim());

  // (3) 账本顶满 15 槽时，prune 不得把账本挤掉
  const fullFacts = Array.from({ length: 15 }, (_, i) => ({ kind: 'decision', statement: `账本满额 ${i + 1}` }));
  const fullOut = buildDeterministicSummary(
    [mk('user', '请求', 'user'), ...Array.from({ length: 10 }, (_, i) => mk('user', `素材产出 ${i + 1}`, 'lrc-prune'))],
    30000,
    undefined,
    fullFacts,
  );
  // ## 断言必须带词边界（第二轮审查 P2-2）
  //
  // 原写法 `fullCon.includes('账本满额 1')` 在 15 条满额时恒为真 ——
  // `账本满额 15/14/…/10` 全都含子串 `账本满额 1`。实测把投影改成
  // 取最旧也照样 PASS，该断言零区分力。
  const fullCon = (fullOut.split('### 助手结论')[1] ?? '').split('###')[0];
  check('账本顶满时不被 prune 挤占', /账本满额 1(?![0-9])/.test(fullCon), fullCon.trim());
  check('账本顶满时 prun 让位', !fullCon.includes('素材产出'), fullCon.trim());

  // (4) prune **收集端**也不能取最旧（★2026-11-15 独立审查 P0-3 复查）
  //
  // 上一轮只改了投影端倒序，没注意 `collect` 在达到 limit 时直接 return ——
  // 20 条素材、上限 10 时只收进 1–10 条，投影端再倒序也救不回来。
  const manyPrune = Array.from({ length: 20 }, (_, i) => mk('user', `素材条目 ${i + 1} 号`, 'lrc-prune'));
  const manyOut = buildDeterministicSummary(manyPrune, 30000);
  const manyCon = (manyOut.split('### 助手结论')[1] ?? '').split('###')[0];
  check('prune 收集端保留最新', manyCon.includes('素材条目 20 号'), manyCon.trim());
  check('prune 收集端淘汰最旧', !manyCon.includes('素材条目 1 号'), manyCon.trim());

  // (5) 存量污染清理：助手正文不该从旧摘要吸收进「用户请求」（★2026-11-15）
  //
  // 旧版插件把 lrc-prune 的助手正文错记进摘要「用户请求」段，该摘要被宿主
  // 包成 compact-checkpoint 后，每次裁剪都被 `absorbPriorSummary` 原样吸收，
  // 污染在 69 个 checkpoint 里层层复制。判据是纯形态的 Markdown 图片语法。
  const prior = [
    '## 已裁剪的历史（确定性摘要，无 LLM）',
    '### 用户请求',
    '- 还是没有像素视觉的效果啊',
    '- 十六枚都已经画好，全在下面这张图里 ![十六枚候选](H:\\xjz\\.shots\\95-候选.png)',
    '- 提交了（`c1cf3be`）。这是画押屏的样板 ![未蘸](H:\\xjz\\.shots\\70-未蘸.png)',
    '### 助手结论',
    '- 像素感已经出来了',
  ].join('\n');
  const absorbed = buildDeterministicSummary([mk('user', prior, 'compact-checkpoint')], 30000);
  const absorbedReq = (absorbed.split('### 用户请求')[1] ?? '').split('###')[0];
  check('存量污染被清理：含图片语法的助手正文', !absorbedReq.includes('十六枚都已经画好'), absorbedReq.trim());
  check('存量污染被清理：第二条', !absorbedReq.includes('c1cf3be'), absorbedReq.trim());
  check('真实用户请求仍被吸收', absorbedReq.includes('还是没有像素视觉的效果啊'), absorbedReq.trim());
  check('结论段不受影响', absorbed.includes('像素感已经出来了'), absorbed.trim());
}

// ────────────────────────────────────────────────────────────
// 20. 压缩摘要必须消费 Fact 账本（★2026-11-14 双裁判问题）
// ────────────────────────────────────────────────────────────
//
// 真实测试发现：同一个系统里有两套语义判定，判同一件事结论相反 ——
// 提取器说「这是过程叙述」，压缩摘要说「这是助手结论」。
console.log('\n=== 20) 摘要消费 Fact 账本 ===');
{
  const { buildDeterministicSummary } = await import('../src/context-trim.ts');
  const mk = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] });
  const msgs = [
    mk('user', '帮我分析这个仓库以及如何使用'),
    mk('assistant', '我先去仓库看看它到底是什么。'),
    mk('assistant', '两个联网工具都报错了，我换一种方式直接访问。'),
    mk('assistant', '仓库本身可以访问，于是直接把它克隆到本地来读。'),
    mk('assistant', '克隆成功，仓库比预期大，开始读它的结构。'),
  ];

  // 不传 facts：走 role 降级路径，但**过程叙述仍须被拦**
  //
  // ★2026-11-15：这里原本断言「旧行为会把过程叙述当结论」（即记录缺陷），
  // 本轮把 `context-trim.ts` 自己那份弱判据换成 `memory-schema` 的统一
  // 判据后，降级路径也不再收过程叙述 —— 缺陷已修，断言随之改为正向。
  const legacy = buildDeterministicSummary(msgs, 4000);
  const legacyConclusions = legacy.includes('### 助手结论')
    ? legacy.split('### 助手结论')[1]?.split('###')[0] ?? ''
    : '';
  check(
    '降级路径也不收过程叙述（双裁判已统一）',
    !legacyConclusions.includes('我先去仓库看看'),
    legacyConclusions.trim(),
  );
  check(
    '降级路径结论为空时给出显式标注',
    legacyConclusions.includes('本段无可用结论'),
    legacyConclusions.trim(),
  );

  // 传 facts：结论段改为从账本投影
  const facts = [
    { kind: 'statement', statement: 'awesome-code-animation 是一个收录代码动画项目的聚合仓库' },
    { kind: 'decision', statement: '决定先只装 code-review 和 tdd 两个 skill' },
    { kind: 'constraint', statement: '不要直接改 README' },
    // 不应进结论段的类别
    { kind: 'location', statement: '仓库位于 D:\\proj' },
  ];
  const next = buildDeterministicSummary(msgs, 4000, undefined, facts);
  const nextConclusions = next.split('### 助手结论')[1]?.split('###')[0] ?? '';
  check('新行为：结论段含真实定义', nextConclusions.includes('聚合仓库'), nextConclusions.trim());
  check('新行为：结论段含决策', nextConclusions.includes('code-review'), nextConclusions.trim());
  check('新行为：过程叙述不再进结论段', !nextConclusions.includes('我先去仓库看看'), nextConclusions.trim());
  check('location 类不占结论槽', !nextConclusions.includes('D:\\proj'), nextConclusions.trim());
  check('用户请求段仍保留', next.includes('帮我分析这个仓库'), next);
}

if (failed > 0) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
