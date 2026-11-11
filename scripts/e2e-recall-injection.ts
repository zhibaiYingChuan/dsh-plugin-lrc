/**
 * 主动召回注入的单元测试。
 *
 * 用法：node scripts/e2e-recall-injection.ts
 *
 * 为什么需要：这是"插件主动推"策略的核心。它的三个约束（缓存友好、
 * 不注入噪音、长度可控）如果任一条破，整个策略就不能默认开启。
 * 这些都能脱离宿主验证，因此单独成一套。
 */
import {
  formatRecallInjection,
  normalizeRecallOptions,
  topicFingerprint,
  DEFAULT_RECALL_INJECTION,
  type InjectedMemory,
} from '../src/recall-injection.ts';
import { userMessageText, isRealUserMessage } from '../src/session-text.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const mem = (id: string, content: string, score = 0.9): InjectedMemory => ({
  id,
  content,
  score_norm: score,
});

// ── 1) 基本形态 ──
console.log('=== 1) 注入文本形态 ===');
{
  const text = formatRecallInjection([
    mem('m1', '用户偏好纸质拼贴风格，不要渐变'),
    mem('m2', '视频时长确定为 60 秒'),
  ]);
  console.log(`  产出（${text.length} 字符）:\n${text.split('\n').map((l) => '    ' + l).join('\n')}`);
  check('含标题行', text.startsWith('[LRC 相关记忆]'), text.slice(0, 30));
  check('含两条内容', text.includes('纸质拼贴') && text.includes('60 秒'));
  check('长度可控（<= 240）', text.length <= 240, text.length);
}

// ── 2) 空输入 / 关闭 ──
console.log('=== 2) 不该注入的情况 ===');
check('零记忆返回空串', formatRecallInjection([]) === '');
check('关闭时返回空串', formatRecallInjection([mem('m1', 'x')], { ...DEFAULT_RECALL_INJECTION, maxItems: 0 }) === '');
check('空白内容被过滤', formatRecallInjection([mem('m1', '   ')]) === '');
check(
  '低相关度被过滤',
  formatRecallInjection([mem('m1', '沾边内容', 0.3)], { ...DEFAULT_RECALL_INJECTION, minScore: 0.5 }) === '',
);

// ── 3) 截断 ──
console.log('=== 3) 截断与预算 ===');
{
  const long = '这'.repeat(200);
  const t = formatRecallInjection([mem('m1', long)], { ...DEFAULT_RECALL_INJECTION, maxCharsPerItem: 20 });
  check('单条被截断', t.length < 60, t.length);
  check('截断带省略号', t.includes('…'), t);

  const many = Array.from({ length: 10 }, (_, i) => mem(`m${i}`, `内容${i}`));
  const t2 = formatRecallInjection(many, { ...DEFAULT_RECALL_INJECTION, maxItems: 2 });
  const lines = t2.split('\n').filter((l) => l.startsWith('- '));
  check('最多注入 maxItems 条', lines.length === 2, lines.length);

  // 总长超限时应收敛而不是炸开
  const bigs = Array.from({ length: 2 }, (_, i) => mem(`b${i}`, '长'.repeat(100)));
  const t3 = formatRecallInjection(bigs, { ...DEFAULT_RECALL_INJECTION, maxCharsPerItem: 80, maxTotalChars: 100 });
  check('总长不超过上限', t3.length <= 100, t3.length);
}

// ── 4) 话题指纹：这是缓存友好的关键 ──
console.log('=== 4) 话题指纹稳定性 ===');
{
  // 同一话题的多轮追问必须同指纹（否则每轮重注入，缓存全废）
  const sameTopic = [
    '根据 compression-account.md 生成视频',
    '根据 compression-account.md 生成视频，用纸质风格',
    '继续做这个视频',
  ];
  console.log('  同话题样本:');
  for (const s of sameTopic) console.log(`    "${s}" -> ${topicFingerprint(s)}`);

  // 不同话题必须不同指纹（否则会注入错内容）
  const other = topicFingerprint('数据库为什么选 PostgreSQL');
  const first = topicFingerprint('根据 compression-account.md 生成视频');
  check('无关话题指纹不同', first !== other, { first, other });
  check('空串指纹为空', topicFingerprint('') === '');
  check('纯标点指纹为空', topicFingerprint('，。！  ') === '');

  // 长度分桶：把微小长度差异抹平
  //
  // 注意：**不要求** "做视频" 与 "做视频吧" 指纹完全相同 —— bigram 天然
  // 会多出一个 "频吧"。真正要保证的是：核心词相同（"做视频" 的 bigram 出现在
  // 后者里），从而召回结果不会因一个语气词而剧变。
  const a = topicFingerprint('做视频');
  const b = topicFingerprint('做视频吧');
  const coreOf = (f: string) => f.split('|')[1]?.split(',').filter(Boolean) ?? [];
  const overlap = coreOf(a).filter((t) => coreOf(b).includes(t));
  check('语气词不改变核心特征（重合约 2/3）', overlap.length >= 2, { a, b, overlap });
  check('长度分桶相同', a.split('|')[0] === b.split('|')[0], { a: a.split('|')[0], b: b.split('|')[0] });
}

// ── 4b) 续接指令必须继承上一指纹（本次自审发现的真实缺陷）──
//
// 未修复前："继续做这个视频" 会算出与上轮完全不同的指纹 ⇒ 触发重注入
// ⇒ 打断缓存。而长任务里"继续/然后呢"是最常见的输入。
console.log('=== 4b) 续接指令继承指纹 ===');
{
  const base = topicFingerprint('根据 compression-account.md 生成视频');
  console.log(`  基准指纹: ${base}`);

  for (const s of ['继续', '然后呢', '接着做', '下一步', '好的', 'continue', 'ok']) {
    const f = topicFingerprint(s, base);
    check(`"${s}" 继承上一指纹`, f === base, { got: f, want: base });
  }

  // 关键：没有 previous 时不能凭空继承
  const alone = topicFingerprint('继续');
  check('无上一指纹时不继承', alone !== base && alone.length > 0, alone);

  // 长句即使含"继续"也不当续接（说的是新事情）
  const longText = '继续之前那个视频，但这次改用完全不同的数据库主题来做演示';
  const lf = topicFingerprint(longText, base);
  check('长句不被误判为续接', lf !== base, { lf, base });

  // 真正的换话题必须换指纹
  const switched = topicFingerprint('数据库为什么选 PostgreSQL 而不是 MySQL', base);
  check('换话题确实换指纹', switched !== base, { switched, base });
}

// ── 5) 确定性：同样输入必须产出同样文本（缓存前提）──
console.log('=== 5) 确定性 ===');
{
  const input = [mem('m1', 'A 内容'), mem('m2', 'B 内容')];
  const r1 = formatRecallInjection(input);
  const r2 = formatRecallInjection(input);
  check('相同输入产出完全相同', r1 === r2, { r1, r2 });

  const f1 = topicFingerprint('根据文档生成视频');
  const f2 = topicFingerprint('根据文档生成视频');
  check('指纹确定', f1 === f2, { f1, f2 });
}

// ── 6) 缓存代价评估：注入文本与快照拼接后的大小 ──
console.log('=== 6) 缓存代价 ===');
{
  const snapshot = '[LRC 状态] 已沉淀 3 条；细节在 LRC，需要时 recall。';
  const inject = formatRecallInjection([mem('m1', '用户偏好纸质拼贴'), mem('m2', '时长 60 秒')]);
  const merged = `${inject}\n\n${snapshot}`;
  console.log(`  快照 ${snapshot.length} 字符 + 注入 ${inject.length} 字符 = ${merged.length} 字符`);
  check('合并后仍在 500 字符内', merged.length < 500, merged.length);
  // 参照：实测缓存命中率 92.2%，每轮平均摄入 37456 tokens
  check('注入占比可忽略（<2%）', inject.length / 4000 < 0.02, inject.length / 4000);
}

// ── 7) 配置规范化：缺字段不得静默反转语义 ──
//
// 这一组锁住本轮自审发现的缺陷：宿主传的裸配置缺字段时 `undefined`
// 参与比较会静默反转语义（不报错、日志正常），与 NaN 退避同构。
console.log('=== 7) 配置规范化 ===');
{
  const full = normalizeRecallOptions({
    maxItems: 2,
    maxCharsPerItem: 80,
    maxTotalChars: 240,
    minScore: 0.5,
  });
  check('完整配置原样保留', full.maxItems === 2 && full.minScore === 0.5, full);

  // 全缺失：必须落到默认值，而不是 undefined
  const empty = normalizeRecallOptions({});
  check('空对象 → 默认 maxItems', empty.maxItems === DEFAULT_RECALL_INJECTION.maxItems, empty);
  check('空对象 → 默认 minScore（不是 0）', empty.minScore === DEFAULT_RECALL_INJECTION.minScore, empty);
  check('空对象 → 默认单条长度', empty.maxCharsPerItem === DEFAULT_RECALL_INJECTION.maxCharsPerItem, empty);
  check('空对象 → 默认总长', empty.maxTotalChars === DEFAULT_RECALL_INJECTION.maxTotalChars, empty);
  check('null 输入不炸', normalizeRecallOptions(null).maxItems > 0);
  check('undefined 输入不炸', normalizeRecallOptions(undefined).maxItems > 0);

  // 关键回归：undefined 曾让 minScore 过滤恒为 false（永不注入）、
  // 让 maxItems 变成"全部注入"
  const undef = normalizeRecallOptions({ maxItems: undefined, minScore: undefined });
  check('maxItems=undefined 不变成"全部"', undef.maxItems === 2, undef.maxItems);
  check('minScore=undefined 不变成"永不注入"', undef.minScore === 0.5, undef.minScore);

  // NaN / 字符串 / 负值
  const weird = normalizeRecallOptions({
    maxItems: Number.NaN,
    minScore: Number.NaN,
    maxCharsPerItem: '80',
    maxTotalChars: -5,
  });
  check('NaN → 默认 maxItems', weird.maxItems === 2, weird.maxItems);
  check('NaN → 默认 minScore', weird.minScore === 0.5, weird.minScore);
  check('字符串数字 → 默认（不隐式转换）', weird.maxCharsPerItem === 80, weird.maxCharsPerItem);
  check('负总长 → 抬到 1', weird.maxTotalChars === 1, weird.maxTotalChars);

  // 边界：0 是合法值（显式关闭）
  check('maxItems=0 保留为 0', normalizeRecallOptions({ maxItems: 0 }).maxItems === 0);
  // 相关度夹紧到 [0,1]
  check('minScore>1 夹紧到 1', normalizeRecallOptions({ minScore: 5 }).minScore === 1);
  check('minScore<0 夹紧到 0', normalizeRecallOptions({ minScore: -1 }).minScore === 0);
}

// ── 8) 用户消息取文本：锁住"功能写了却从未触发"的缺陷 ──
//
// 未修复前用 `messageContent(event)` 取用户消息 —— 那个函数只认
// `assistant/message`，对用户消息恒返回 undefined ⇒ textBlocksOnly 恒空
// ⇒ 注入一次都不会发生，且不报错。这一组是那个缺陷的永久防线。
console.log('=== 8) 用户消息取文本 ===');
{
  const userEvent = {
    type: 'user/message',
    seq: 3,
    data: {
      content: [{ type: 'text', text: '根据 compression-account.md 生成视频' }],
      source: { kind: 'user' },
    },
  };
  check('能取到用户正文', userMessageText(userEvent) === '根据 compression-account.md 生成视频', userMessageText(userEvent));
  check('该事件被判定为真实用户消息', isRealUserMessage(userEvent) === true);

  // 宿主注入的上下文不能被当成用户提问
  const injected = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '技能目录……' }], source: { kind: 'skill-catalog' } },
  };
  check('注入上下文不算真实用户消息', isRealUserMessage(injected) === false);

  // assistant 消息不能走这个函数（形状不同）
  const assistant = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '好的' }] } },
  };
  check('assistant 消息返回空串', userMessageText(assistant) === '');

  // 异常形态不得抛错
  check('null 事件不炸', userMessageText(null) === '');
  check('缺 data 不炸', userMessageText({ type: 'user/message' }) === '');
  check('content 为字符串', userMessageText({ type: 'user/message', data: { content: '直接字符串' } }) === '直接字符串');
  // 推理块不能当 query（那是模型内部思考，不是用户意图）
  check(
    '忽略非 text 块',
    userMessageText({
      type: 'user/message',
      data: { content: [{ type: 'reasoning', text: '内部' }] },
    }) === '',
  );
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
