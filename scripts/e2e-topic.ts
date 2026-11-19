/**
 * 上下文附加（topic）的端到端验证。
 *
 * 用法：node scripts/e2e-topic.ts
 *
 * ## 本测试守的是什么
 *
 * 实测 session-95eaf7e3（1578 条助手消息 / 266 条 Fact）：
 *   - 67.3% 的 Fact ≤ 20 字，69.5% 有上下文依赖特征
 *   - 段落/标题锚点几乎不存在（5.6% / 0.7%），但首句覆盖 99.2%
 *
 * 因此给每条 Fact 附加「所在消息的主题」，让它脱离原文也能定位。
 * 断言四件事：
 *   1. topic 提取对各类正文形态都能给出合理结果
 *   2. topic 不改 statement（去重/冲突判定/自足性不受影响）
 *   3. topic 落成 `topic:xxx` 标签
 *   4. 折叠摘要用 topic 作标题（而非「本批 N 条」）
 */
import { extractFacts } from '../src/memory-extract.ts';
import { extractTopic, topicTags, factsToItems, TOPIC_MAX_CHARS } from '../src/memory-schema.ts';
import { foldFacts } from '../src/fold.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// 1. topic 提取：真实会话里出现过的形态
// ────────────────────────────────────────────────────────────
console.log('=== 1) topic 提取 ===');
{
  // 真实样例（取自 session-95eaf7e3）
  check(
    '普通首句',
    extractTopic('像素感这次是真的出来了。之前那几轮改的是**颜色**。') === '像素感这次是真的出来了',
    extractTopic('像素感这次是真的出来了。之前那几轮改的是**颜色**。'),
  );
  check(
    'markdown 标题优先',
    extractTopic('## 像素感这次是真的出来了\n\n之前那几轮改的是颜色。') === '像素感这次是真的出来了',
    extractTopic('## 像素感这次是真的出来了\n\n之前那几轮改的是颜色。'),
  );
  check(
    '剥掉行内 code 反引号',
    extractTopic('中心那条线是等宽字体渲染的 `0` 带斜线。') === '中心那条线是等宽字体渲染的 0 带斜线',
    extractTopic('中心那条线是等宽字体渲染的 `0` 带斜线。'),
  );
  check(
    '跳过代码围栏',
    extractTopic('```\nconst x = 1;\n```\n真正的主题在这里。') === '真正的主题在这里',
    extractTopic('```\nconst x = 1;\n```\n真正的主题在这里。'),
  );
  check('空文本返回 undefined', extractTopic('') === undefined, extractTopic(''));
  check('纯空白返回 undefined', extractTopic('   \n  ') === undefined, extractTopic('   \n  '));
  check('过短返回 undefined', extractTopic('好') === undefined, extractTopic('好'));

  const longTopic = extractTopic(`${'很长的主题'.repeat(20)}。后续内容`);
  check(
    `超长 topic 截断到 ${TOPIC_MAX_CHARS} 字 + 省略号`,
    longTopic !== undefined && Array.from(longTopic).length === TOPIC_MAX_CHARS + 1,
    longTopic === undefined ? null : Array.from(longTopic).length,
  );
}

// ────────────────────────────────────────────────────────────
// 2. extractFacts 附加 topic，且**不改 statement**
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) extractFacts 附加 topic ===');
{
  // 用真实会话里能抽出 Fact 的句式（`约束：xxx` 会被 TAG_KIND 剥成标签，
  // 单独测试；这里用普通陈述句）
  const text =
    '图标尺寸排查这次是真的查清了。字号只能是 12 的倍数。' +
    '尺寸必须从 24 格画布搬到 16 格网格。图标盒的尺寸是 40×40。';
  const withTopic = extractFacts({ text, origin: 'assistant', sessionId: 's1' });
  check('抽出了 Fact', withTopic.facts.length > 0, withTopic.facts.length);
  const allHaveTopic = withTopic.facts.every((f) => f.topic !== undefined);
  check('全部 Fact 都带 topic', allHaveTopic, withTopic.facts.map((f) => f.topic));

  // 关键：statement 必须与「不附加 topic」时完全一致
  const stmts = withTopic.facts.map((f) => f.statement).sort();
  const expected = extractFacts({ text, origin: 'assistant', sessionId: 's1' })
    .facts.map((f) => f.statement)
    .sort();
  check('statement 不受 topic 影响', JSON.stringify(stmts) === JSON.stringify(expected), {
    stmts,
    expected,
  });

  // 用户消息不附加 topic（一句话消息 topic 等于全文，无意义）
  const userFacts = extractFacts({
    text: '把音频放到桌面，不要用 IDM 下载。',
    origin: 'user',
    sessionId: 's1',
  });
  check(
    '用户消息不附加 topic',
    userFacts.facts.every((f) => f.topic === undefined),
    userFacts.facts.map((f) => f.topic),
  );
}

// ────────────────────────────────────────────────────────────
// 3. topic 落成标签
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) topic → tags ===');
{
  check('undefined → 空数组', topicTags(undefined).length === 0, topicTags(undefined));
  check('空串 → 空数组', topicTags('').length === 0, topicTags(''));
  check('正常 topic → topic:xxx', topicTags('像素感') [0] === 'topic:像素感', topicTags('像素感'));
  check('换行被压成空格', topicTags('第一行\n第二行')[0] === 'topic:第一行 第二行', topicTags('第一行\n第二行'));

  const text = '图标尺寸排查这次是真的查清了。尺寸必须从 24 格画布搬到 16 格网格。';
  const result = extractFacts({ text, origin: 'assistant', sessionId: 's1' });
  const items = factsToItems(result.facts);
  check(
    '抽出了 Fact（前置条件）',
    items.length > 0,
    result.rejected.map((r) => r.reason),
  );
  check(
    'factsToItems 写入 topic 标签',
    items.some((i) => i.tags.some((t) => t.startsWith('topic:'))),
    items.map((i) => i.tags),
  );
  check(
    'topic 标签内容正确',
    items.some((i) => i.tags.includes('topic:图标尺寸排查这次是真的查清了')),
    items.map((i) => i.tags),
  );
  // 既有标签必须保留（不能因为加了 topic 就丢 lrc_schema）
  check(
    '既有标签不丢',
    items.every((i) => i.tags.includes('lrc_schema') && i.tags.includes('distilled')),
    items.map((i) => i.tags),
  );
  // content 不得含 topic（否则去重会失真）
  check(
    'content 不含 topic 前缀',
    items.every((i) => !i.content.includes('图标尺寸排查这次是真的查清了')),
    items.map((i) => i.content),
  );
}

// ────────────────────────────────────────────────────────────
// 4. 折叠摘要用 topic 作标题
// ────────────────────────────────────────────────────────────
console.log('\n=== 4) 折叠摘要用 topic 作头 ===');
{
  const make = (statement: string, topic?: string) => ({
    kind: 'conclusion' as const,
    subject: '',
    predicate: '',
    value: '',
    statement,
    scope: 'project' as const,
    origin: 'assistant' as const,
    confidence: 0.9,
    source: { sessionId: 's1', turn: 1 },
    status: 'active' as const,
    enriched: false,
    ...(topic === undefined ? {} : { topic }),
  });

  const withTopic = foldFacts([
    make('尺寸必须从 24 格画布搬到 16 格网格', '图标尺寸排查'),
    make('字号只能是 12 的倍数', '图标尺寸排查'),
    make('点阵字一旦被设成 13px 就不清晰', '图标尺寸排查'),
    make('阴影换成无偏移的硬投影', '图标尺寸排查'),
  ]);
  check('带 topic 时折叠成功', withTopic !== null);
  if (withTopic !== null) {
    const body = withTopic.fact.statement;
    console.log(`  摘要: ${body.slice(0, 120)}`);
    check('摘要头是 topic', body.startsWith('【图标尺寸排查】'), body.slice(0, 30));
    check('摘要不含「本批 N 条」', !/本批 \d+ 条/.test(body), body.slice(0, 30));
    check('摘要继承 topic 字段', withTopic.fact.topic === '图标尺寸排查', withTopic.fact.topic);
    check('成员内容仍在', body.includes('24 格画布') && body.includes('12 的倍数'), body);
  }

  // 无 topic 时退回计数字头（行为与本改动前一致）
  const noTopic = foldFacts([
    make('尺寸必须从 24 格画布搬到 16 格网格'),
    make('字号只能是 12 的倍数'),
    make('点阵字一旦被设成 13px 就不清晰'),
    make('阴影换成无偏移的硬投影'),
  ]);
  check('无 topic 时仍能折叠', noTopic !== null);
  if (noTopic !== null) {
    check(
      '无 topic 退回「本批 N 条」头',
      /^本批 4 条：/.test(noTopic.fact.statement),
      noTopic.fact.statement.slice(0, 20),
    );
    check('无 topic 时 fact.topic 为 undefined', noTopic.fact.topic === undefined, noTopic.fact.topic);
  }

  // 混合（不同 topic）：**不用单一主题当标题**，改为逐条带 topic
  const mixed = foldFacts([
    make('尺寸必须从 24 格画布搬到 16 格网格', '图标尺寸排查'),
    make('字号只能是 12 的倍数', '字号阶梯'),
    make('点阵字一旦被设成 13px 就不清晰', '图标尺寸排查'),
    make('阴影换成无偏移的硬投影', '投影效果'),
  ]);
  const mixedBody = mixed?.fact.statement ?? '';
  check('混合批次不用单一主题当标题', !mixedBody.startsWith('【'), mixedBody.slice(0, 20));
  check('混合批次头是计数', /^本批 4 条：/.test(mixedBody), mixedBody.slice(0, 20));
  // 正文不重复 topic（会膨胀 20%~75%），主题改由标签承载
  check('正文不重复 topic', !mixedBody.includes(' › '), mixedBody);
  check(
    '全部成员主题收进 topics',
    mixed?.topics.includes('图标尺寸排查') === true &&
      mixed.topics.includes('字号阶梯') &&
      mixed.topics.includes('投影效果'),
    mixed?.topics,
  );
  check('混合批次 fact.topic 为空（不误标）', mixed?.fact.topic === undefined, mixed?.fact.topic);
}

// ────────────────────────────────────────────────────────────
// 5. 真实会话回放：topic 覆盖率与可读性
// ────────────────────────────────────────────────────────────
console.log('\n=== 5) 真实形态样本的主题可读性 ===');
{
  const samples = [
    '现状已经查清。先给你结论，再列清单。图标实例里有 42px、26px、20px 三种。',
    '已提交（`814ffd8`）。## 像素感这次是真的出来了 之前那几轮改的是颜色。',
    '剩下还有一件事需要你来决定。「我的」这个页签，我最后用的是锁。',
  ];
  for (const s of samples) {
    const topic = extractTopic(s);
    console.log(`  原文: ${s.slice(0, 40)}…`);
    console.log(`  topic: ${topic ?? '<无>'}`);
    check('样例有 topic', topic !== undefined && topic.length >= 4, topic);
  }
}

console.log('');
if (failed === 0) console.log('全部通过');
else {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
