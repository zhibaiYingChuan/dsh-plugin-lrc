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

/**
 * 带**绝对分**的记忆（新版 LRC 的真实返回形态）。
 *
 * `score_norm` 是相对 top1 归一化的（top1 恒 1.0），`score` 才是绝对相关度。
 * 实测：相关 ≈0.032 / 沾边 ≈0.016。
 */
const memRaw = (id: string, content: string, raw: number, norm = 1): InjectedMemory => ({
  id,
  content,
  score: raw,
  score_norm: norm,
});

// ── 1) 基本形态 ──
console.log('=== 1) 注入文本形态 ===');
{
  const text = formatRecallInjection([
    mem('m1', '用户偏好纸质拼贴风格，不要渐变'),
    mem('m2', '视频时长确定为 60 秒'),
  ]);
  console.log(`  产出（${text.length} 字符）:\n${text.split('\n').map((l) => '    ' + l).join('\n')}`);
  // 表头必须自带时效性声明：注入内容是历史，判断权在模型手里
  check('含来源与时效性声明表头', text.startsWith('[LRC 历史记忆（可能过时'), text.slice(0, 40));
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
    minRawScore: 0.02,
  });
  check(
    '完整配置原样保留',
    full.maxItems === 2 && full.minScore === 0.5 && full.minRawScore === 0.02,
    full,
  );

  // 全缺失：必须落到默认值，而不是 undefined
  const empty = normalizeRecallOptions({});
  check('空对象 → 默认 maxItems', empty.maxItems === DEFAULT_RECALL_INJECTION.maxItems, empty);
  check('空对象 → 默认 minScore（不是 0）', empty.minScore === DEFAULT_RECALL_INJECTION.minScore, empty);
  check(
    '空对象 → 默认 minRawScore（不是 0）',
    empty.minRawScore === DEFAULT_RECALL_INJECTION.minRawScore,
    empty,
  );
  check('空对象 → 默认单条长度', empty.maxCharsPerItem === DEFAULT_RECALL_INJECTION.maxCharsPerItem, empty);
  check('空对象 → 默认总长', empty.maxTotalChars === DEFAULT_RECALL_INJECTION.maxTotalChars, empty);
  check('null 输入不炸', normalizeRecallOptions(null).maxItems > 0);
  check('undefined 输入不炸', normalizeRecallOptions(undefined).maxItems > 0);

  // 关键回归：undefined 曾让 minScore 过滤恒为 false（永不注入）、
  // 让 maxItems 变成"全部注入"
  const undef = normalizeRecallOptions({ maxItems: undefined, minScore: undefined });
  check('maxItems=undefined 不变成"全部"', undef.maxItems === 2, undef.maxItems);
  check(
    'minScore=undefined 落到默认',
    undef.minScore === DEFAULT_RECALL_INJECTION.minScore,
    undef.minScore,
  );
  check(
    'minRawScore=undefined 落到默认（不是 0 ⇒ 不是永不放行）',
    undef.minRawScore === DEFAULT_RECALL_INJECTION.minRawScore,
    undef.minRawScore,
  );

  // NaN / 字符串 / 负值
  const weird = normalizeRecallOptions({
    maxItems: Number.NaN,
    minScore: Number.NaN,
    minRawScore: Number.NaN,
    maxCharsPerItem: '80',
    maxTotalChars: -5,
  });
  check('NaN → 默认 maxItems', weird.maxItems === 2, weird.maxItems);
  check('NaN → 默认 minScore', weird.minScore === DEFAULT_RECALL_INJECTION.minScore, weird.minScore);
  check(
    'NaN → 默认 minRawScore',
    weird.minRawScore === DEFAULT_RECALL_INJECTION.minRawScore,
    weird.minRawScore,
  );
  check('字符串数字 → 默认（不隐式转换）', weird.maxCharsPerItem === 80, weird.maxCharsPerItem);
  check('负总长 → 抬到 1', weird.maxTotalChars === 1, weird.maxTotalChars);

  // 边界：0 是合法值（显式关闭）
  check('maxItems=0 保留为 0', normalizeRecallOptions({ maxItems: 0 }).maxItems === 0);
  // 相对分夹紧到 [0,1]
  check('minScore>1 夹紧到 1', normalizeRecallOptions({ minScore: 5 }).minScore === 1);
  check('minScore<0 夹紧到 0', normalizeRecallOptions({ minScore: -1 }).minScore === 0);
  // 绝对分**不得**夹到 1：RRF 原始分量级是 0.02，夹上去等于永不注入
  check(
    'minRawScore 不被夹到 1',
    normalizeRecallOptions({ minRawScore: 0.02 }).minRawScore === 0.02,
    normalizeRecallOptions({ minRawScore: 0.02 }).minRawScore,
  );
  check('minRawScore<0 抬到 0', normalizeRecallOptions({ minRawScore: -1 }).minRawScore === 0);
}

// ── 7b) 双闸门：绝对分与相对分各管一件事 ──
//
// 未修复前只有 `score_norm >= 0.5` 一道闸门。而 `score_norm` 是**相对 top1**
// 归一化的 —— top1 永远是 1.0，所以无论话题多无关，都至少会注入一条。
// 那是把噪音当记忆，比不注入更坏（模型会把无关历史当当前事实）。
console.log('=== 7b) 双闸门过滤 ===');
{
  // 场景 A：话题完全无关 ⇒ 整批都不该注入
  // （实测无关候选绝对分 0.015 上下，top1 相对分仍是 1.0）
  const offTopic = [memRaw('m1', '无关历史 A', 0.0153, 1.0), memRaw('m2', '无关历史 B', 0.0148, 0.97)];
  check('无关话题整段不注入', formatRecallInjection(offTopic) === '');

  // 场景 B：话题相关 ⇒ 强相关的两条注入
  const onTopic = [memRaw('m1', '相关历史 A', 0.0315, 1.0), memRaw('m2', '相关历史 B', 0.0312, 0.99)];
  const t = formatRecallInjection(onTopic);
  const lines = t.split('\n').filter((l) => l.startsWith('- '));
  check('相关话题注入两条', lines.length === 2, lines.length);

  // 场景 C：一强一弱（0.0315 → 0.0164，相对 0.52）⇒ 只留强的
  // 弱的那条是向量近邻，不是同一件事；跟着进来就是噪音
  const mixed = [memRaw('m1', '强相关', 0.0315, 1.0), memRaw('m2', '明显掉队', 0.0164, 0.52)];
  const tm = formatRecallInjection(mixed);
  check('相对分掉队项被剔除', tm.includes('强相关') && !tm.includes('明显掉队'), tm);

  // 场景 D：绝对分达标且相对分并列 ⇒ 两条都留（断言两条，不是只断言 A）
  const tight = [memRaw('m1', '同档 A', 0.0315, 1.0), memRaw('m2', '同档 B', 0.0310, 0.98)];
  const tt = formatRecallInjection(tight);
  check('同档候选都保留', tt.includes('同档 A') && tt.includes('同档 B'), tt);

  // 场景 E：旧版 LRC 不返回 score ⇒ 只走相对闸门（0.85，比历史 0.5 更严）
  check('无绝对分时按相对分放行（高）', formatRecallInjection([mem('m1', '旧版高', 0.95)]) !== '');
  check('无绝对分时按相对分拦截（低）', formatRecallInjection([mem('m1', '旧版低', 0.6)]) === '');

  // 场景 E2：`score: null` 必须与 undefined 同等对待 —— 都走相对闸门。
  //
  // `typeof null === 'object'`：若判据只写 `typeof === 'number'`，
  // null 会落到 `return true`；而 LRC 侧把字段序列化成 null 是常规操作。
  const withNull = { id: 'n1', content: 'null 绝对分', score: null, score_norm: 1.0 } as unknown as InjectedMemory;
  check('score=null 不炸且不退化为永不放行', formatRecallInjection([withNull]) !== '', formatRecallInjection([withNull]));
  const nullLowNorm = { id: 'n2', content: 'null 且相对分低', score: null, score_norm: 0.5 } as unknown as InjectedMemory;
  check('score=null 时相对闸门仍生效', formatRecallInjection([nullLowNorm]) === '');

  // 场景 E3：NaN 绝对分同样降级为缺失
  const withNaN = { id: 'n3', content: 'NaN 绝对分', score: Number.NaN, score_norm: 0.95 } as unknown as InjectedMemory;
  check('score=NaN 时相对分可放行', formatRecallInjection([withNaN]) !== '');

  // 场景 F：排序按绝对分降序（模型对首条注意力最高）
  const reversed = [memRaw('m1', '次强', 0.0300, 1.0), memRaw('m2', '最强', 0.0400, 1.0)];
  const tr = formatRecallInjection(reversed);
  check('绝对分最高的排第一', tr.split('\n')[1]?.includes('最强') === true, tr);

  // 场景 G：真实 LRC 的离散簇（★用实测值，不用编造的中间值）
  //
  // 实测 24 条查询：单路恒 0.0164（=1/61），双路 0.0301/0.0328，**无中间值**。
  // 0.025 的语义因此是「至少两路命中」，不是「相似度够高」。
  check('单路簇 0.0164 被拦', formatRecallInjection([memRaw('c1', '单路', 0.0164, 1.0)]) === '');
  check('双路簇 0.0301 放行', formatRecallInjection([memRaw('c2', '双路', 0.0301, 1.0)]) !== '');
  check('双路簇 0.0328 放行', formatRecallInjection([memRaw('c3', '双路强', 0.0328, 1.0)]) !== '');
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
