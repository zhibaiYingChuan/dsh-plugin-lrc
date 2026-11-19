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
  isHistoryQuery,
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

// ── 9) 历史查询的语言信号（2026-11-19 六钥匙裁决）──
//
// ## 为什么需要这一层
//
// 实测：`recallInjectMinRawScore = 0.025`，而 LRC 单路召回上限
// `1/61 ≈ 0.0164` ⇒ 自动注入 **0 次**。调低阈值会让所有话题都注入
// （全面注入回归）。所以改用**确定性的语言信号**触发。
console.log('\n=== 9) 历史查询语言信号 ===');
{
  // 必须命中的真实说法
  const positives = [
    '上次那个方案是什么',
    '之前我们怎么改的',
    '以前是不是定过用 pnpm',
    '当初为什么选 PostgreSQL',
    '我们决定过用 RwLock 吧',
    '不是定过要 8pt 栅格吗',
    '还记得那个端口号吗',
    '继续上次的重构',
    '接着之前那个做',
    '为什么这么设计',
    '为什么用这个方案',
    '那个方案后来怎么样了',
    '我们之前改过什么',
    '之前怎么配置的，照着来',
    // 第五轮审查补的漏触发
    '翻一下之前的记录',
    '查一下历史记录',
    '我们不是定了用 pnpm 吗',
    '我们讨论过的那个方案',
    '回忆一下当时的决定',
    // 2026-11-19 实测漏判：真实提示词「回顾梳理我们前面所有的方案…」
    '回顾梳理我们前面所有的方案和项目的状态，查看还有哪些需要补齐的地方。',
    '回顾一下我们前面所有的方案',
    '梳理一下我们前面所有的决定',
    // 复审补的漏触发（由既有 `之前的(…)` 规则覆盖）
    '复盘一下我们之前的方案',
    '总结一下之前的工作',
    // 第三轮复审补的漏触发
    '梳理一下历史记录',
    '翻翻以前的记录',
    '看看之前的历史记录',
    '我们之前是怎么约定的',
    // 第四轮复审补的漏触发
    '之前那个决定是怎么来的',
    '我们之前定的接口规范在哪',
  ];
  for (const text of positives) {
    check(`命中：${text}`, isHistoryQuery(text) === true, text);
  }

  // 不该命中的普通指令（误触发会白注入 2 条 + 打断前缀缓存）
  //
  // ## 必须包含「含信号词但语义不是问历史」的句子（独立审查 major 2）
  //
  // 只放「不含任何信号词」的句子等于没测：它们恒不命中。
  // 下面这些是真实开发者会说的话，`之前`/`以前`/`原来` 在这里是**时间介词**。
  const negatives = [
    '把这个函数改成 async',
    '跑一下测试',
    '继续',
    '然后呢',
    '这个页面太宽了',
    '帮我加个导出功能',
    '端口 3099 被占用了',
    // ── 时间介词误触发（critical 1 的守卫）──
    '在提交之前先跑一遍测试',
    '运行之前记得先 build',
    '删除之前先备份数据库',
    '恢复原来的配置',
    '为什么改成 async 更好',
    '清空 git 历史记录',
    '按那个方案实现就行',
    // ── 反向弱信号误触发（复审 critical 1）──
    '确定之前先问一下',
    '改之前先跑测试',
    '调用之前先检查参数',
    // ── 当前推理 / 故障排查（复审 major 2、3）──
    '原来是这个原因',
    '原来是缓存没清',
    '为什么用不了这个 API',
    '为什么用 fetch 会报错',
    '为什么选不了',
    // ── 第三轮独立审查实测的 11 条真实误触发（裸词版本 22 条命中 21 条）──
    //
    // 这些句子**都含信号词**，但语义是当前指令/排障，不是问历史。
    // 只放「不含信号词」的句子等于没测 —— 它们恒不命中。
    '记录当时的时间戳',
    '你记得在 finally 里释放锁',
    '我们决定用 pnpm 吧',
    '为什么用这个 API 会 404',
    '沿用原来的命名风格',
    '刚才那个命令再执行一遍',
    '查一下 git 历史上这个文件谁改的',
    'git diff 看看改过什么',
    '把先前版本的字段名迁移过来',
    '在之前我写的函数里加日志',
    // ── 第四轮独立审查实测的 10 条（「与动词共现」挡不住的形态）──
    //
    // 第三轮把弱信号写成 `之前 + (说|定|用|改|…)`，实测 20 条真实编码指令
    // 仍命中 19 条 —— `用`/`改`/`说` 正是编码指令最高频的动词。
    // 所以改成「弱信号 + 疑问标记」双闸门，下面这些必须全部不命中。
    '之前用 axios 没问题，现在报错',
    '之前改的那行代码有 bug',
    '之前你写的函数加个日志',
    '记录当时用的参数',
    '当时是 3 秒超时，改成 5 秒',
    '之前讨论的接口先别动',
    '先前那个 bug 复现一下',
    '为什么用这个锁会死锁',
    '还记得要加 try-catch',
    '照旧跑一遍测试',
    // ── 第五轮独立审查实测（强信号口径不一致 / 疑问标记过松）──
    '之前不是这样的',
    '之前不是这个报错',
    '我们约定一下接口格式',
    '我们说好这个接口用 REST',
    '看看我改了什么',
    '之前怎么没报错',
    '以前为什么没问题',
    '记不记得要加 try-catch',
    // ── 第六轮独立审查实测（是非问 / 当前动作 / 授权选型）──
    '我提过 PR 了，你 review 一下',
    '接着之前的代码往下写，别改结构',
    '这个参数不是定了 5 秒吗',
    '之前那个接口改好了吗',
    '之前用什么库都行，你定',
    // ── 2026-11-19 新增「回顾/梳理/前面」的误触发守卫 ──
    //
    // 这三个词本身是中性动词/方位词，必须带历史宾语才算问历史。
    '回顾一下这段代码有没有问题',
    '回顾一下这个报错',
    '梳理一下当前需求',
    '梳理一下这个模块的依赖',
    '前面那个函数怎么改',
    '前面这段逻辑有问题',
    // ── 独立审查 M1：`我们/项目/方案/状态/整个` 不是历史专属宾语 ──
    '回顾一下我们刚才改的代码',
    '回顾一下我们现在的进度',
    '回顾一下我们这次的改动',
    '回顾一下项目结构',
    '回顾一下整个流程',
    '回顾一下方案A和方案B的差异',
    // ── 独立审查 M2：`所有/整个` 不是历史专属宾语 ──
    '梳理一下我们所有的接口',
    '梳理一下所有依赖关系',
    '梳理一下整个架构',
    // ── 独立审查 M3：`前面 + 所有/那些/这些` 是当前代码定位 ──
    '前面所有的函数都要加日志',
    '前面那些函数都要改成 async',
    '前面那些变量重命名一下',
    '前面这些接口先别动',
    // ── 第二轮复审 M-a：`回顾 + 之前/以前` 无法区分历史与当前 ──
    '回顾一下之前改的那行代码',
    '回顾一下之前的改动',
    '回顾一下之前的代码风格',
    '回顾一下以前的实现',
    // ── 第二轮复审 M-b：`前面 + 的(工作/记录/讨论/方案)` 是当前代码名词 ──
    '前面的工作目录改成绝对路径',
    '前面的记录表加个索引',
    '前面的讨论区样式调一下',
    '前面的方案字段要加校验',
    '前面提到的那个函数要加日志',
    '前面聊到的那个 bug 复现一下',
    '前面讨论的方案先别动',
    // ── 第二轮复审 M-c：`历史` 作定语是当前任务 ──
    '梳理一下历史数据迁移',
    '梳理一下历史遗留的 TODO',
    '回顾一下历史订单数据',
    '回顾一下历史提交',
    // ── 第三轮复审 major 1：`我们` 不构成消歧 ──
    '回顾一下我们之前那个报错',
    '回顾一下我们之前改的那行代码',
    '回顾一下我们以前的实现',
    '回顾一下我们整个流程',
    '回顾一下我们所有接口',
    // ── 第三轮复审 major 2：`前面` 单独出现是当前代码定位 ──
    '梳理一下前面的逻辑',
    '梳理一下前面那段代码',
    '梳理一下我们前面写的接口',
    '梳理一下我们前面提到的那个函数',
    // ── 第四轮复审 major 1：`所有/整个` 也不消歧，必须带历史宾语 ──
    '梳理一下我们前面所有的接口',
    '回顾一下我们前面所有的改动',
    '回顾一下我们前面整个流程',
    // ── 第四轮复审 major 2：`历史记录表/字段/索引` 是数据库对象 ──
    '查一下历史记录表有没有这个字段',
    '回顾一下历史记录表的结构，加个索引',
  ];
  for (const text of negatives) {
    check(`不命中：${text}`, isHistoryQuery(text) === false, text);
  }

  // 口语化说法必须命中（minor 7）
  //
  // ⚠ `按老规矩来` / `照旧处理` 已移出：它们是**续接指令**，不是问历史
  // （第四轮审查 critical 1）。它们现在落在弱信号里，必须带疑问标记才命中。
  const colloquial = [
    '前面说过要 8pt',
    // 复审 major 4 补的漏触发
    '当时用的什么库',
    '你记得我们用的什么吗',
    '之前不是说过吗',
    '之前提过这个方案',
    '之前聊过这个',
  ];
  for (const text of colloquial) {
    check(`命中（口语）：${text}`, isHistoryQuery(text) === true, text);
  }

  // 边界：空串 / 纯空白
  check('空串不命中', isHistoryQuery('') === false);
  check('纯空白不命中', isHistoryQuery('   ') === false);
}

// ── 10) 碎片过滤（2026-11-19 六钥匙裁决）──
//
// ## 为什么需要
//
// 实测 dsh 项目 2217 条记忆里 2037 条（92%）是未折叠碎片。它们不会
// 「灌满」上下文（注入只取 2 条），但会**挤占 top2 槽位** ——
// 一条 8 字的「改成实心的裂痕」排到第 1，就把真正有用的纪要挤掉了。
//
// ## 为什么判据是「悬空词开头」而不是长度
//
// 长度会误伤：`用户偏好纸质拼贴风格，不要渐变`（16 字）完整且高价值。
// 区别在**有没有主语**，而「以改成/先/再/但开头」是主语缺失的可靠特征。
console.log('\n=== 10) 碎片过滤 ===');
{
  const opts = normalizeRecallOptions({ maxItems: 2, minRawScore: 0, minScore: 0 });

  // 悬空词开头 ⇒ 挡
  const frag = formatRecallInjection([memRaw('a', '[决策] 改成实心的裂痕', 0.032)], opts);
  check('「改成…」残句不注入', frag === '', frag);

  // 完整短句 ⇒ 放行（长度不是判据）
  const shortOk = formatRecallInjection(
    [memRaw('b', '用户偏好纸质拼贴风格，不要渐变', 0.032)],
    opts,
  );
  check('16 字完整短句放行', shortOk.includes('纸质拼贴'), shortOk);

  // 长记忆 ⇒ 放行
  const long = formatRecallInjection(
    [
      memRaw(
        'c',
        '[结论] 宿主已于 11:30:55 重启，这次重启发生在 dist 更新之后，因此修复已实际生效',
        0.032,
      ),
    ],
    opts,
  );
  check('长记忆正常注入', long.includes('宿主已于'), long);

  // 同一个残句，只改 importance：9 放行 / 8 挡
  //
  // ⚠ 必须用**同一个**残句做对照（独立审查 major 1）：
  // 之前用「以后所有图标…」测豁免，但它剥前缀后本就不匹配悬空词，
  // 删掉豁免分支测试仍 PASS —— 那是恒真的假测试。
  const fragText = '[决策] 改成实心的裂痕';
  const exempt = formatRecallInjection(
    [{ ...memRaw('d', fragText, 0.032), importance: 9 }],
    opts,
  );
  check('同一残句 importance=9 放行', exempt.includes('实心的裂痕'), exempt);
  const notExempt = formatRecallInjection(
    [{ ...memRaw('e', fragText, 0.032), importance: 8 }],
    opts,
  );
  check('同一残句 importance=8 挡', notExempt === '', notExempt);

  // 宽口径会误伤的完整句 ⇒ 必须放行（窄口径的守卫）
  const complete = formatRecallInjection(
    [memRaw('e2', '[结论] 先确认宿主如何处理 assistant/message', 0.032)],
    opts,
  );
  check('「先确认…」完整句放行', complete.includes('先确认'), complete);

  // 只剩类型前缀、没有正文 ⇒ 挡（否则会注入一行 `- [决策]`）
  check(
    '只有类型前缀不注入',
    formatRecallInjection([memRaw('e3', '[决策]', 0.032)], opts) === '',
  );

  // 关闭过滤 ⇒ 残句也放行（可回滚）
  const off = normalizeRecallOptions({
    maxItems: 2,
    minRawScore: 0,
    minScore: 0,
    fragmentPrefixes: '',
  });
  check(
    'fragmentPrefixes 为空时关闭过滤',
    formatRecallInjection([memRaw('f', '[决策] 改成实心的裂痕', 0.032)], off) !== '',
  );

  // 混合批次：残句被剔除后，完整记忆仍能占满槽位
  const mixed = formatRecallInjection(
    [
      memRaw('g', '[决策] 改成实心的裂痕', 0.032),
      memRaw('h', '[决策] 只保留框架和两根贴边竖栏', 0.031),
      memRaw('i', '[结论] 临时库隔离生效，58 项中 57 项通过，只剩「有围观话术」这一项失败', 0.030),
    ],
    opts,
  );
  check('混合批次只留完整记忆', mixed.includes('临时库隔离') && !mixed.includes('实心的裂痕'), mixed);

  // 归一化
  check(
    'fragmentPrefixes 非字符串落默认',
    normalizeRecallOptions({ fragmentPrefixes: 123 }).fragmentPrefixes ===
      DEFAULT_RECALL_INJECTION.fragmentPrefixes,
  );
  // null 是「显式关闭」，不是「落默认」（独立审查 minor）
  check('fragmentPrefixes=null 视为关闭', normalizeRecallOptions({ fragmentPrefixes: null }).fragmentPrefixes === '');
  // 空白串 / 漏写 `^` 都必须落默认，否则会静默全挡（独立审查 major 2）
  check(
    'fragmentPrefixes 空白串落默认',
    normalizeRecallOptions({ fragmentPrefixes: '   ' }).fragmentPrefixes ===
      DEFAULT_RECALL_INJECTION.fragmentPrefixes,
  );
  check(
    'fragmentPrefixes 漏写 ^ 落默认',
    normalizeRecallOptions({ fragmentPrefixes: '改成' }).fragmentPrefixes ===
      DEFAULT_RECALL_INJECTION.fragmentPrefixes,
  );
  check(
    'fragmentExemptImportance 夹到 10',
    normalizeRecallOptions({ fragmentExemptImportance: 99 }).fragmentExemptImportance === 10,
  );
  check(
    'fragmentExemptImportance 负数归 0',
    normalizeRecallOptions({ fragmentExemptImportance: -3 }).fragmentExemptImportance === 0,
  );
  // 写错正则时放行而不是全挡
  check(
    '非法正则不炸且放行',
    formatRecallInjection(
      [memRaw('j', '[决策] 改成实心的裂痕', 0.032)],
      normalizeRecallOptions({ maxItems: 2, minRawScore: 0, minScore: 0, fragmentPrefixes: '^([' }),
    ) !== '',
  );

  // ## 剔除碎片后重算相对分（独立审查 major 3）
  //
  // top1 是碎片（raw 0.032），top2 是完整记忆（raw 0.016，相对分 0.5）。
  // 不重算 ⇒ top2 被 minScore 0.85 挡掉 ⇒ 槽位空着。
  // 重算后 top2 成为存活项里的 top1（相对分 1.0）⇒ 正常注入。
  const rescored = formatRecallInjection(
    [
      memRaw('k', '[决策] 改成实心的裂痕', 0.032, 1.0),
      memRaw('l', '[结论] 临时库隔离生效，58 项中 57 项通过，只剩「有围观话术」这一项失败', 0.016, 0.5),
    ],
    normalizeRecallOptions({ maxItems: 2, minRawScore: 0, minScore: 0.85 }),
  );
  check('碎片被剔除后，次强记忆仍能注入', rescored.includes('临时库隔离'), rescored);

  // ## 无过滤时**不得**重算（复审建议）
  //
  // LRC 有「近重复折叠」，可能把原 top1 折掉，此时返回首项 norm 本就 <1。
  // 无条件重算会把它抬到 1.0，让原本 0.8 的次项越过 0.85 —— 与 minScore 语义相反。
  const noFilter = formatRecallInjection(
    [
      memRaw('m', '[结论] 完整记忆 A，长度足够长可以独立理解，不会被碎片判据挡住', 0.032, 0.8),
      memRaw('n', '[结论] 完整记忆 B，长度足够长可以独立理解，不会被碎片判据挡住', 0.016, 0.5),
    ],
    normalizeRecallOptions({ maxItems: 2, minRawScore: 0, minScore: 0.85 }),
  );
  check('无过滤时不重算相对分（0.8 仍被 0.85 挡）', noFilter === '', noFilter);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
