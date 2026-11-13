/**
 * 路径 1（确定性上下文裁剪）的端到端测试。
 *
 * 用法：node scripts/e2e-trim.ts
 *
 * 覆盖：
 *   1. 裁剪范围选择（工具配对平衡、保留尾部、节点太少）
 *   2. 确定性摘要（四类信息、去重、字符上限、不含推理）
 *   3. trimContext 全链路（引擎不可达 / 低于阈值 / 成功 / 异常恢复）
 *   4. 路径 2：工具输出剪枝（三条取服务路径 + 异常隔离）
 */
import {
  buildDeterministicSummary,
  findRetryStart,
  pruneReasoning,
  pruneToolCallArguments,
  pruneToolResults,
  resolveSessionEvents,
  selectTrimRange,
  summaryStats,
  trimContext,
} from '../src/context-trim.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// ────────────────────────────────────────────────────────────
// 0. 会话事件源兼容（P0 回归）
// ────────────────────────────────────────────────────────────
console.log('=== 0) 会话事件源兼容 ===');

const sampleEvents = [{ type: 'user/message' }, { type: 'assistant/message' }];
check(
  '真实形状：只有 log',
  resolveSessionEvents({ surface: {}, log: sampleEvents })?.length === 2,
);
check(
  '旧形状：events getter',
  resolveSessionEvents({ surface: {}, events: sampleEvents })?.length === 2,
);
check(
  '新形状：snapshotEvents()',
  resolveSessionEvents({ surface: {}, snapshotEvents: () => sampleEvents })?.length === 2,
);
check('三种形状都没有时返回 undefined', resolveSessionEvents({ surface: {} }) === undefined);
check('session 为 null 时返回 undefined', resolveSessionEvents(null) === undefined);
check(
  'snapshotEvents 抛错时退回 log',
  resolveSessionEvents({
    snapshotEvents: () => {
      throw new Error('boom');
    },
    log: sampleEvents,
  })?.length === 2,
);

// ────────────────────────────────────────────────────────────
// 1. 裁剪范围选择
// ────────────────────────────────────────────────────────────
console.log('=== 1) 裁剪范围选择 ===');

const events = [
  { type: 'user/message' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  { type: 'tool/result' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'user/message' },
];
const nodes = [0, 1, 2, 3, 4, 5];

const range = selectTrimRange(nodes, events, 2);
check('保留尾部 2 个节点', range?.startIdx === 0 && range?.endIdx === 3, range);
check('范围端点取自 surface seq', range?.start === 0 && range?.end === 3, range);

// 尾部正好落在未闭合工具调用上：必须往前退到平衡切点
const openTail = [
  { type: 'user/message' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  { type: 'tool/result' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
];
const openRange = selectTrimRange([0, 1, 2, 3], openTail, 1);
check('尾部未闭合时退到平衡切点', openRange?.endIdx === 2, openRange);

check('节点太少返回 null', selectTrimRange([0, 1], events.slice(0, 2), 2) === null);
check('空 surface 返回 null', selectTrimRange([], [], 2) === null);

// 回归：起点不能落在宿主注入的系统节点上（否则 compactRegion 恒失败）
const sysEvents = [
  {
    type: 'user/message',
    data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd: G:\\x' }] },
  },
  {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实提问' }] },
  },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'c' }] } } },
];
const sysRange = selectTrimRange([0, 1, 2, 3, 4], sysEvents, 2);
check('跳过开头的系统节点', sysRange?.startIdx === 1, sysRange);
check('系统节点仍在区间外', sysRange?.start === 1, sysRange);

// 回归：DSH 某些版本把系统提示作为 surface 的 node 0（type=system/message）
const sysMsgEvents = [
  { type: 'system/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实提问' }] },
  },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'c' }] } } },
];
const sysMsgRange = selectTrimRange([0, 1, 2, 3, 4], sysMsgEvents, 2);
check('system/message 不作为起点', sysMsgRange?.startIdx === 1, sysMsgRange);
check('system/message 不在区间内', sysMsgRange?.start === 1, sysMsgRange);

// 回归：某些版本把系统提示写成「无 source 的 user/message」，会被判成可替换节点，
// 起点落到 0 → compactRegion 报 `node 0 holds the system prompt`。
// 兜底必须向后找到第一个「平衡切点 + 可替换」的节点，而不是简单 +1。
const noSourceSystem = [
  { type: 'user/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
];
const noSourceNodes = [0, 1, 2, 3, 4];
const noSourceRange = selectTrimRange(noSourceNodes, noSourceSystem, 2);
check('无 source 的系统提示会被误判为起点', noSourceRange?.startIdx === 0, noSourceRange);
check(
  '起点回退跳过系统提示',
  findRetryStart(noSourceNodes, noSourceSystem, 0, noSourceRange?.endIdx ?? 0) === 1,
);

// 回退不能破坏 tool-pairing：被跳过的前缀增量之和必须为 0
const pairingEvents = [
  { type: 'user/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  { type: 'tool/result' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
];
const pairingNodes = [0, 1, 2, 3, 4, 5];
check(
  '回退不会落在 tool/result 上（保持配对）',
  findRetryStart(pairingNodes, pairingEvents, 0, 3) === 1,
);
check('没有可回退空间时返回 null', findRetryStart(pairingNodes, pairingEvents, 0, 0) === null);

// 回归：裁剪摘要节点（user/message + source.kind='compact-checkpoint'）必须可再次被裁剪。
// 否则摘要层只增不减：每轮 trim 把旧区间换成摘要，下一轮从摘要之后开始，
// 摘要永远不被覆盖（实测 3.5 小时占上下文 63.6%，成为最大单项）。
const summaryEvents = [
  { type: 'system/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  {
    type: 'user/message',
    data: {
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: '## 已裁剪的历史（确定性摘要，无 LLM）' }],
    },
  },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'c' }] } } },
];
const summaryRange = selectTrimRange([0, 1, 2, 3, 4], summaryEvents, 2);
check('摘要节点可作为裁剪起点（可再次被裁剪）', summaryRange?.startIdx === 1, summaryRange);
check('摘要节点在裁剪区间内', summaryRange?.start === 1, summaryRange);

// 回归：摘要自增殖的遗留形态 —— surface 前部堆叠 N 条 checkpoint。
// 实测一次 trim 前有 85 条堆叠（97 节点里 85 条是摘要），
// 裁剪范围必须从**第一条** checkpoint 开始，一次把它们全部吸收。
const stackedEvents = [
  { type: 'system/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  ...Array.from({ length: 20 }, () => ({
    type: 'user/message',
    data: {
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: '## 已裁剪的历史（确定性摘要，无 LLM）' }],
    },
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `m${i}` }] } },
  })),
];
const stackedNodes = stackedEvents.map((_, i) => i);
const stackedRange = selectTrimRange(stackedNodes, stackedEvents, 8);
check('堆叠 checkpoint：起点是第一条摘要', stackedRange?.startIdx === 1, stackedRange);
check(
  '堆叠 checkpoint：一次覆盖全部摘要',
  stackedRange !== null && stackedRange.endIdx >= 20,
  stackedRange,
);

// 回归：宿主换版本改了 source.kind 时，必须按内容前缀仍能识别摘要节点，
// 否则 85 条堆叠会立刻复现。
const unknownKindEvents = [
  { type: 'system/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  {
    type: 'user/message',
    data: {
      source: { kind: 'some-future-kind' },
      content: [
        {
          type: 'text',
          text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation.',
        },
      ],
    },
  },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'c' }] } } },
];
const unknownKindRange = selectTrimRange([0, 1, 2, 3, 4], unknownKindEvents, 2);
check('未知 source.kind 的 checkpoint 按内容前缀识别', unknownKindRange?.startIdx === 1, unknownKindRange);

// ────────────────────────────────────────────────────────────
// 2. 确定性摘要
// ────────────────────────────────────────────────────────────
console.log('=== 2) 确定性摘要 ===');

const messages = [
  { role: 'user', content: [{ type: 'text', text: '把插件改成 external 模式' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '这段推理不该进摘要' },
      { type: 'tool-call', name: 'read_file', arguments: '{"path":"src/index.ts"}' },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool-result',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT: no such file' }],
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool-result',
        content: [{ type: 'text', text: '第一行输出\n第二行输出\n第三行' }],
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: '结论：改用 serviceFor 拿引擎' }] },
];

const summary = buildDeterministicSummary(messages, 2000);
check('包含用户请求', summary.includes('把插件改成 external 模式'), summary);
check('包含工具调用', summary.includes('read_file'), summary);
check('包含工具错误', summary.includes('ENOENT'), summary);
check('工具成功输出只留首行', summary.includes('第一行输出') && !summary.includes('第二行输出'), summary);
check('包含助手结论', summary.includes('改用 serviceFor'), summary);
check('不含推理', !summary.includes('这段推理不该进摘要'), summary);

const capped = buildDeterministicSummary(messages, 80);
check('遵守字符上限', capped.length <= 80, capped.length);

// 回归 1：宿主注入的运行时上下文 / 技能目录不是用户发言，不能进「用户请求」
const noisy = [
  { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier.\nCurrent working directory: C:\\x' }] },
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nThe available skill catalog changed.\n</system-reminder>' }] },
  { role: 'user', content: [{ type: 'text', text: 'The user changed the approval policy from "ask" to "never".' }] },
  { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 42: 2026-11-07T13:26:57+08:00[Asia/Shanghai]' }] },
  { role: 'user', content: [{ type: 'text', text: '真正的需求：修好摘要截断' }] },
];
const noisySummary = buildDeterministicSummary(noisy, 2000);
check('过滤运行时上下文噪音', !noisySummary.includes('Current runtime context.'), noisySummary);
check('过滤技能目录噪音', !noisySummary.includes('available skill catalog'), noisySummary);
check('过滤审批策略噪音', !noisySummary.includes('approval policy'), noisySummary);
check('过滤时间采样噪音', !noisySummary.includes('Time sampled while preparing'), noisySummary);
check('真实请求仍保留', noisySummary.includes('修好摘要截断'), noisySummary);

// 回归 2：旧摘要摊平吸收，不再层层嵌套
const prior = [
  '## 已裁剪的历史（确定性摘要，无 LLM）',
  '### 用户请求',
  '- 早期需求：接入 LRC',
  '### 工具调用与结果',
  '- read_file',
  '### 助手结论',
  '- 结论：用 external 模式',
].join('\n');
const nested = buildDeterministicSummary(
  [
    { role: 'user', content: [{ type: 'text', text: prior }] },
    { role: 'user', content: [{ type: 'text', text: '新需求：补测试' }] },
  ],
  2000,
);
check('旧摘要不整段嵌套', (nested.match(/## 已裁剪的历史/g) ?? []).length === 1, nested);
check('旧摘要的请求被吸收', nested.includes('早期需求：接入 LRC'), nested);
check('旧摘要的结论被吸收', nested.includes('用 external 模式'), nested);
check('新请求同时在', nested.includes('新需求：补测试'), nested);

// 回归 2b：一次 trim 覆盖 85 条堆叠 checkpoint 时，真实内容必须优先于旧摘要。
// 旧实现按时间顺序边扫边吸收，最老的摘要先占满 12 个请求槽，
// 真实用户请求和较新的摘要条目全被丢弃。
const stacked = [
  ...Array.from({ length: 15 }, (_, i) => ({
    role: 'user' as const,
    content: [
      {
        type: 'text' as const,
        text: ['## 已裁剪的历史（确定性摘要，无 LLM）', '### 用户请求', `- 旧请求${String(i + 1).padStart(2, '0')}`].join('\n'),
      },
    ],
  })),
  { role: 'user' as const, content: [{ type: 'text' as const, text: '最新真实请求' }] },
];
const stackedSummary = buildDeterministicSummary(stacked, 4000);
check('堆叠摘要：真实请求优先保留', stackedSummary.includes('最新真实请求'), stackedSummary);
check('堆叠摘要：较新的旧摘要优先保留', stackedSummary.includes('旧请求15'), stackedSummary);
check('堆叠摘要：最老的旧摘要被挤出', !stackedSummary.includes('旧请求01'), stackedSummary);
check('堆叠摘要：仍只有一层标题', (stackedSummary.match(/## 已裁剪的历史/g) ?? []).length === 1, stackedSummary);

// 摘要条目统计：日志里要能看出「结论有没有被挤掉」
const stats = summaryStats(stackedSummary);
check('摘要统计含请求数', /请求 \d+/.test(stats), stats);
check('摘要统计含结论数', /结论 \d+/.test(stats), stats);
check('摘要统计含调用数', /调用 \d+/.test(stats), stats);
check(
  '摘要统计计数正确',
  summaryStats(
    [
      '## 已裁剪的历史（确定性摘要，无 LLM）',
      '### 用户请求',
      '- a',
      '- b',
      '### 助手结论',
      '- c',
      '### 工具调用与结果',
      '- d',
      '- e',
      '- f',
    ].join('\n'),
  ) === '请求 2 / 结论 1 / 错误 0 / 调用 3',
  summaryStats(
    [
      '## 已裁剪的历史（确定性摘要，无 LLM）',
      '### 用户请求',
      '- a',
      '- b',
      '### 助手结论',
      '- c',
      '### 工具调用与结果',
      '- d',
      '- e',
      '- f',
    ].join('\n'),
  ),
);

// 回归 2c：过程叙述（「接下来我要…」）不是结论，不能进 `### 助手结论`
const narrationSummary = buildDeterministicSummary(
  [
    { role: 'assistant', content: [{ type: 'text', text: '接下来我要确认工具参数存放在哪里' }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论：迁移必须分块' }] },
  ],
  2000,
);
check('过程叙述不进助手结论', !narrationSummary.includes('接下来我要确认'), narrationSummary);
check('真实结论仍在', narrationSummary.includes('迁移必须分块'), narrationSummary);

// 回归 3：超限时先砍工具调用，助手结论必须活下来
const heavy = [
  { role: 'user', content: [{ type: 'text', text: '需求：定位截断丢结论的 bug' }] },
  ...Array.from({ length: 20 }, (_, i) => ({
    role: 'tool' as const,
    content: [{ type: 'text' as const, text: `结果 ${i}：${'x'.repeat(80)}` }],
  })),
  { role: 'assistant', content: [{ type: 'text', text: '结论：截断从最低价值端砍，保住结论' }] },
];
const heavyTrimmed = buildDeterministicSummary(heavy, 400);
check('超限时助手结论仍在', heavyTrimmed.includes('保住结论'), heavyTrimmed);
check('超限时先牺牲工具调用', !heavyTrimmed.includes('结果 19'), heavyTrimmed);
check('超限后仍守上限', heavyTrimmed.length <= 400, heavyTrimmed.length);

// ────────────────────────────────────────────────────────────
// 2e. ★2026-11-12 实测回归：系统提示不得被当成「助手结论」
//
// 事故（session-644bba1d）：DSH 的模型配置是 `systemPromptUpdate: in-history`，
// 系统提示以 `role:'system'` 出现在重放历史里。原实现「非 user 非 tool 即
// 助手结论」把它收了进去，导致 5 份摘要的结论区**只有这一条**：
//   ### 助手结论
//   - You are an AI agent powered by DeepSeek Harness. You are a coding agent…
// 真实结论被挤掉，且系统提示残片变成了「历史里的助手发言」。
console.log('=== 2e) 系统提示不得进摘要 ===');
{
  const systemPrompt =
    'You are an AI agent powered by DeepSeek Harness. You are a coding agent powered by ' +
    'the deepseek/deepseek-v4.1-flash model. Tokens prefixed with @ are paths the user ' +
    'explicitly referenced. '.repeat(3);

  const withSystem = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    { role: 'user', content: [{ type: 'text', text: '把插件改成 external 模式' }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论：改用 serviceFor 拿引擎' }] },
  ];
  const s = buildDeterministicSummary(withSystem, 4000);
  console.log(`  摘要:\n${s.split('\n').map((l) => '    ' + l).join('\n')}`);
  check('系统提示不进助手结论', !s.includes('You are an AI agent powered by DeepSeek Harness'), s);
  check('真实结论仍在', s.includes('改用 serviceFor 拿引擎'), s);
  check('用户请求仍在', s.includes('把插件改成 external 模式'), s);

  // 兜底：role 字段丢失（某些版本重放不带 role）时也不能收进结论
  const noRole = [
    { content: [{ type: 'text', text: systemPrompt }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论：真实结论' }] },
  ];
  const s2 = buildDeterministicSummary(noRole, 4000);
  check('无 role 时系统提示仍被拦下', !s2.includes('You are an AI agent'), s2);
  check('无 role 时真实结论保留', s2.includes('真实结论'), s2);

  // ★关键：白名单不能把「无 role 的 assistant 正文」全部丢光
  //
  // 若 `isConversationRole` 只认 user|assistant，缺 role 的重放会让
  // 摘要只剩「用户请求」区、结论区全空 —— 比原来的污染更糟（那时至少有字），
  // 而且不报错、长度看起来正常。这里必须断言它**保留**。
  const noRoleAssistant = [
    { role: 'user', content: [{ type: 'text', text: '需求：修好摘要' }] },
    { content: [{ type: 'text', text: '结论：改为角色白名单' }] },
    { content: [{ type: 'text', text: '结论：补 no-role 用例' }] },
  ];
  const s2b = buildDeterministicSummary(noRoleAssistant, 4000);
  check('无 role 的 assistant 正文保留为结论', s2b.includes('改为角色白名单'), s2b);
  check('多条无 role 结论都保留', s2b.includes('补 no-role 用例'), s2b);
  check('用户请求区仍正常', s2b.includes('需求：修好摘要'), s2b);

  // 系统提示不得挤占结论槽位：给足真实结论时全部保留
  const manyConclusions = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    ...Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `结论 ${i}：第 ${i} 项已验证` }],
    })),
  ];
  const s3 = buildDeterministicSummary(manyConclusions, 4000);
  const conclusionCount = s3.split('\n').filter((l) => l.startsWith('- 结论 ')).length;
  check('真实结论不被系统提示挤占', conclusionCount === 5, { conclusionCount, s3 });
}

// ────────────────────────────────────────────────────────────
// 3. trimContext 全链路
// ────────────────────────────────────────────────────────────
console.log('=== 3) trimContext 全链路 ===');

// **必须用真实形状**：DSH 的 Session 公开成员是 surface / log（部分版本有
// events getter 或 snapshotEvents()），没有 `events` 字段的版本会让
// trimContext 恒返回 no-range。mock 只给 log，才能复现生产。
const session = { surface: { nodes }, log: events };
const agent = { session };

function makeEngine(totalTokens: number) {
  const engine = {
    // 真实 cordis Context 通过 get() 取服务；直接读属性会要求 inject
    ctx: {
      get: (n: string) =>
        n === 'tokenMeter'
          ? { measure: () => ({ totalTokens, nodes: nodes.map(() => ({ tokens: 1000 })) }) }
          : undefined,
    },
    summarize: async () => {
      throw new Error('原始 summarize 不该被调用');
    },
    // 模拟真实引擎：compactRegion 内部会动态调用 this.summarize
    compactRegion: async (start: number, end: number) => {
      await engine.summarize({
        messages: [
          { role: 'user', content: [{ type: 'text', text: '历史内容'.repeat(50) }] },
        ],
      });
      return { start, end };
    },
  };
  return engine;
}

const noEngine = await trimContext({
  ctx: { get: () => undefined },
  agent,
  options: { minTokens: 1, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: () => {},
});
check('引擎不可达时安全返回', noEngine.ok === false && noEngine.reason === 'engine-unavailable', noEngine);

const lowEngine = makeEngine(100);
const low = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => lowEngine } : undefined) },
  agent,
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: () => {},
});
check('低于阈值不裁剪', low.ok === false && low.reason === 'below-threshold', low);

// 节点数硬上限兜底：token 计量失真时，force 必须跳过阈值直接裁剪
const forcedEngine = makeEngine(100);
const forced = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => forcedEngine } : undefined) },
  agent,
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000, force: true },
  log: () => {},
});
check('force 跳过 token 阈值', forced.ok === true && forced.reason === 'ok', forced);

// ★2026-11-12 实测回归：节点数超限时必须**渐进裁剪**，不能一次砍 92%
//
// 事故（session-e1419190）：141 个节点一次裁掉 131 个，08:27 又裁 127/137。
// 每次都是「一次性重写整段前缀」，KV 前缀缓存全部作废，且只剩 8 个节点
// 让模型丢失工作脉络。
{
  // 记录 compactRegion 实际收到的区间，用它算「裁了多少节点」
  function engineWithRange(): { engine: ReturnType<typeof makeEngine>; ranges: Array<{ start: number; end: number }> } {
    const ranges: Array<{ start: number; end: number }> = [];
    const engine = makeEngine(100);
    engine.compactRegion = async (start: number, end: number) => {
      ranges.push({ start, end });
      await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200) }] }] });
      return { start, end };
    };
    return { engine, ranges };
  }

  const limited = engineWithRange();
  await trimContext({
    ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => limited.engine } : undefined) },
    agent,
    options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000, force: true, maxNodesPerRun: 3 },
    log: () => {},
  });
  const unlimited = engineWithRange();
  await trimContext({
    ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => unlimited.engine } : undefined) },
    agent,
    options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000, force: true },
    log: () => {},
  });

  // nodes 是 seq 数组；用下标差算节点数
  const count = (r: Array<{ start: number; end: number }>): number => {
    if (r.length === 0) return 0;
    const { start, end } = r[0];
    const si = nodes.indexOf(start);
    const ei = nodes.indexOf(end);
    return si >= 0 && ei >= 0 ? ei - si + 1 : 0;
  };
  const limitedCount = count(limited.ranges);
  const unlimitedCount = count(unlimited.ranges);
  console.log(`  渐进裁剪: 单次裁 ${limitedCount} 个；不限制: 裁 ${unlimitedCount} 个`);
  check('maxNodesPerRun 真的限制了单次规模', limitedCount > 0 && limitedCount <= 3, limitedCount);
  check('不限制时裁得更多', unlimitedCount > limitedCount, { limitedCount, unlimitedCount });
  check('渐进裁剪不是一次砍光', limitedCount < unlimitedCount, { limitedCount, unlimitedCount });

  // ★第三次独立审查：上一版把 `'40'` 断言成「视为不限制」，等于把事故根因
  // （限制失效 ⇒ 一次裁 92%）固化成回归锁。**非法值必须退化到安全侧（40）**。
  // 这里的 6 节点夹具只有 4 个可裁节点，limit=40 天然不生效 ——
  // 真正的判据在 §1b 的真实 145 节点 surface 上。
  // 字符串是宿主 patch 的真实形态，必须转数后生效
  const strLimited = selectTrimRange(nodes, events, 2, '3' as unknown as number);
  check('字符串 "3" 被转数并生效', strLimited !== null && strLimited.endIdx - strLimited.startIdx + 1 <= 3, strLimited);
  // 小数应向下取整，而不是参与非法算术
  const frac = selectTrimRange(nodes, events, 2, 3.7);
  check('小数 3.7 向下取整为 3', frac !== null && frac.endIdx - frac.startIdx + 1 <= 3, frac);
}

// ────────────────────────────────────────────────────────────
// 1b) 真实 surface 回归锁（session-e1419190，145 节点）
//
// ★第二次独立审查的核心批评：上一版用 6 节点玩具 fixture 验证渐进裁剪，
// 而「遇到不可替换就 break」的旧实现在小 surface 上也能得同样结果 ——
// 断言无法区分对错。这里用**按 session-e1419190 真实节点构成拼装的 fixture**
// （145 节点，20 step/start、23 tool/call、22 tool/result、19 step/end、
//  16 assistant+1toolcall、3 个 assistant+2toolcall、2 compact-checkpoint、
//  15 job/registered、15 job/settled 等 —— 构成比例取自解码日志）。
//
// **注意诚实边界**：这是「同量级的真实构成」，不是逐事件原样拷贝
// （真实 145 节点时刻只有一个 compact-checkpoint，此处为覆盖多摘要场景放了 2 个）。
// 判据体现在三处：不限制应砍掉绝大部分、limit=40 必须落在 [30,40]、
// 端点必须工具配对平衡。用 HEAD 旧算法在同一 fixture 上跑 limit=40 得「裁 1」，
// 即断言能真正区分对错。
//
// 结构编码：
//   C=compact-checkpoint  S=skill-catalog  R=runtime-context  U=user
//   A=assistant(1 tool-call)  A2=assistant(≥2 并行 tool-call)  A0=assistant(纯文本)
//   c=tool/call  r=tool/result  s=step/start  e=step/end
//   j=job/registered  J=job/settled  B=compaction/start  E=compaction/end
//   M=compaction/summary  H=request/header
// ────────────────────────────────────────────────────────────
// ★第二次审查的核心批评：上一版用 6 节点玩具 fixture 验证渐进裁剪，
// 而「遇到不可替换就 break」的旧实现在小 surface 上也能得同样结果 ——
// 断言无法区分对错。
//
// ★★第七次审查指出上一版 fixture **仍然失真**：145 个节点里有 98 个是
// 宿主**不会放进 surface** 的类型（`tool/call`、`step/start`、`job/*`、
// `request/header`、`compaction/*`）。真实的 `foldSurface` 结果只有 4 种：
// `tool/result` / `assistant/message` / `user/message` / `system/message`
// —— `tool/call` 是 `assistant/message` 的内嵌块，不是独立节点。
// 把 fixture 削成真实类型后只剩 47 节点，新旧实现都得 37，断言完全失去区分力。
//
// 现在按**真实构成**生成（141 节点：system 1、user 类 19、
// assistant 61、tool/result 60），只使用那 4 种类型，且 tool 配对平衡。
// ────────────────────────────────────────────────────────────
console.log('=== 1b) 真实 surface 回归锁（141 节点，仅 surface 真实类型） ===');
{
  /** 一条带 n 个 tool-call 的 assistant 消息。 */
  const assistant = (calls: number): unknown => ({
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'r' },
          ...Array.from({ length: calls }, () => ({ type: 'tool-call' })),
        ],
      },
    },
  });
  /** 纯文本 assistant（无 tool-call，不参与 tool 平衡）。 */
  const assistantText = (): unknown => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'ok' }] } },
  });
  const toolResult = (): unknown => ({ type: 'tool/result', data: { content: [{ type: 'text', text: 'out' }] } });
  const injected = (kind: string): unknown => ({
    type: 'user/message',
    data: { source: { kind }, content: [{ type: 'text', text: 'ctx' }] },
  });
  const realUser = (): unknown => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '请继续' }] },
  });

  // 按真实构成拼装（比例取自解码日志：141 时刻 tool/result 64、assistant 58、
  // user 类 19、system 1）。这里让 tool 严格配对：
  //   1 system + 19 user类 + 59×(assistant1+toolResult) + 1×(assistant2+2toolResult)
  //   + 1 纯文本 assistant
  //   = 1 + 19 + 118 + 3 + 1 = 142 → 去掉一个 user 类，得 141
  const realEvents: unknown[] = [];
  realEvents.push({ type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } });
  // 19 个 user 类（含各种 injected 与 1 条真实用户）
  const kinds = [
    'compact-checkpoint', 'skill-catalog', 'lrc-prune',
    ...Array.from({ length: 9 }, () => 'runtime-context'),
    ...Array.from({ length: 5 }, () => 'time-context'),
  ];
  for (const k of kinds) realEvents.push(injected(k));
  realUser();
  realEvents.push(realUser());
  // 主体：59 组「1 tool-call + tool/result」
  for (let i = 0; i < 59; i += 1) {
    realEvents.push(assistant(1));
    realEvents.push(toolResult());
  }
  // 1 组并行（2 tool-call + 2 tool/result），用于覆盖并行场景
  realEvents.push(assistant(2));
  realEvents.push(toolResult());
  realEvents.push(toolResult());
  // 结尾纯文本 assistant
  realEvents.push(assistantText());

  const realNodes = realEvents.map((_, i) => i);
  console.log(`    节点数=${realNodes.length}`);
  check('fixture 规模与真实事故同量级（130~150）', realNodes.length >= 130 && realNodes.length <= 150, realNodes.length);

  // 只允许 surface 真实类型
  const allowed = new Set(['tool/result', 'assistant/message', 'user/message', 'system/message']);
  const badTypes = realEvents
    .map((e) => (e as { type?: string }).type ?? '')
    .filter((t) => !allowed.has(t));
  check('fixture 只含 surface 真实类型', badTypes.length === 0, [...new Set(badTypes)]);

  // tool 配对必须平衡到 0
  let running = 0;
  for (const e of realEvents) {
    const ev = e as { type?: string; data?: { message?: { content?: unknown } } };
    if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content;
      running += Array.isArray(content)
        ? content.filter((b) => (b as { type?: string })?.type === 'tool-call').length
        : 0;
    } else if (ev.type === 'tool/result') running -= 1;
  }
  check('fixture 的 tool 配对在结尾平衡（=0）', running === 0, running);

  const unlimited = selectTrimRange(realNodes, realEvents, 8);
  const capped = selectTrimRange(realNodes, realEvents, 8, 40);
  const cntOf = (r: typeof unlimited): number => (r === null ? 0 : r.endIdx - r.startIdx + 1);
  console.log(`    不限制: 裁 ${cntOf(unlimited)}；limit=40: 裁 ${cntOf(capped)}`);

  check('不限制时确实会砍掉绝大部分（>100）', cntOf(unlimited) > 100, cntOf(unlimited));
  check('limit=40 时规模被压到 40 以内', cntOf(capped) > 0 && cntOf(capped) <= 40, cntOf(capped));
  check('limit=40 不会退化成「只裁 1 个」', cntOf(capped) >= 30, cntOf(capped));

  // 端点必须落在「切点平衡 + 可替换」位置，否则宿主会拒绝
  const balancedAt = (r: typeof unlimited): boolean => {
    if (r === null) return false;
    let run = 0;
    const cut = [true];
    for (let i = 0; i < realNodes.length; i += 1) {
      const ev = realEvents[i] as { type?: string; data?: { message?: { content?: unknown } } };
      if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content;
        run += Array.isArray(content)
          ? content.filter((b) => (b as { type?: string })?.type === 'tool-call').length
          : 0;
      } else if (ev.type === 'tool/result') run -= 1;
      cut.push(run === 0);
    }
    return cut[r.startIdx] === true && cut[r.endIdx + 1] === true;
  };
  check('limit=40 端点切点平衡', balancedAt(capped), capped);
  check('不限制端点切点平衡', balancedAt(unlimited), unlimited);

  // ★第二次独立审查 P1-3：`positiveInt` 对 (0,1) 曾返回 0 被当成「不限制」；
  // 第十一轮又发现 `0.3 → 1` 更糟：真实增长节奏是「每步 +2.25、每 10 步裁一次」，
  // limit=1 ⇒ 141 → 161 → 181 → … → 341 **单调膨胀**（事故 A 的观感）。
  // 所以 (0,1) 必须退化为默认上限 40。
  for (const v of [0.3, 0.5, 0.9]) {
    const r = selectTrimRange(realNodes, realEvents, 8, v);
    check(`小数 ${v} 退化为默认 40（不是 1）`, r !== null && cntOf(r) <= 40, { v, count: cntOf(r) });
  }

  // ★第三次独立审查 P1-1：上一版把 `'40'` 断言成「视为不限制」，
  // 等于把事故根因（限制失效 ⇒ 一次裁 92%）固化成回归锁。
  // 在真实 surface 上，非法值必须退化到安全侧（40），绝不能变成不限制（134）。
  const unsafeCases: Array<[string, unknown]> = [
    ['字符串 "40"', '40'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['负数', -5],
    ['0', 0],
  ];
  for (const [label, value] of unsafeCases) {
    const r = selectTrimRange(realNodes, realEvents, 8, value as unknown as number);
    const c = cntOf(r);
    check(`真实 surface：${label} 退化到安全侧（≤40），不得变成不限制`, r !== null && c <= 40, {
      c,
      unlimited: cntOf(unlimited),
    });
  }

  // ★第二次独立审查 P1-5：keepRecentNodes 非法值必须被收口，不得算出 NaN 区间
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '8' as unknown as number]) {
    const r = selectTrimRange(realNodes, realEvents, bad);
    const valid =
      r !== null &&
      Number.isInteger(r.startIdx) &&
      Number.isInteger(r.endIdx) &&
      Number.isFinite(r.start) &&
      Number.isFinite(r.end);
    check(`keepRecent=${String(bad)} 不产生 NaN 区间`, valid, r);
  }

  // ★第五次审查 P1-2：`keepRecentNodes` 的小数不能被归一成 0/1 ——
  // 那等价「几乎全裁」（实测 192 节点裁 188 = 97.9%，比事故更激进）。
  // 正确处置是「当作没配」，用默认 8，因此结果应与显式传 8 完全一致。
  for (const frac of [0.3, 0.5, 0.9]) {
    const r = selectTrimRange(realNodes, realEvents, frac);
    const c = cntOf(r);
    const same = selectTrimRange(realNodes, realEvents, 8);
    check(`keepRecent=${frac} 视同默认 8（不近全裁）`, r !== null && c === cntOf(same), {
      c,
      wantDefault8: cntOf(same),
    });
  }
}

const okEngine = makeEngine(100000);
const originalSummarize = okEngine.summarize;
const logs: string[] = [];
const ok = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => okEngine } : undefined) },
  agent,
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: (m) => logs.push(m),
});
check('成功裁剪', ok.ok === true && ok.reason === 'ok', ok);
check('摘要字符数已记录', (ok.summaryChars ?? 0) > 0, ok);
check('summarize 已恢复', okEngine.summarize === originalSummarize);
check('写了裁剪日志', logs.some((l) => l.includes('[lrc][trim]')), logs);

// ────────────────────────────────────────────────────────────
// 3b) ★第四次独立审查的 P0：token 触发路径也必须限流
//
// 上一版只在 `force` 时传 `maxNodesPerRun`，token 触发时传 `undefined`。
// 真实事故的窗口下（contextWindow=1M ⇒ trimMin≈10.5 万），141 节点时刻
// force 先触发，所以「看起来修好了」；但窗口换到 800K 时 trimMin 降到 8 万，
// 节点数 114 就触发 token 路径 ⇒ 一次裁 104（91%），**同一事故原样复发**。
//
// 所以这里断言：**不传 force**（纯 token 触发）时，若给了
// `maxNodesPerRun`，单次规模也必须受限。
// ────────────────────────────────────────────────────────────
console.log('=== 3b) token 路径同样限流 ===');
{
  const tokenEngine = (): { engine: ReturnType<typeof makeEngine>; ranges: Array<{ start: number; end: number }> } => {
    const ranges: Array<{ start: number; end: number }> = [];
    const engine = makeEngine(100);
    engine.compactRegion = async (start: number, end: number) => {
      ranges.push({ start, end });
      await engine.summarize({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200) }] }] });
      return { start, end };
    };
    return { engine, ranges };
  };

  const tokenOnly = tokenEngine();
  const tokenOutcome = await trimContext({
    ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => tokenOnly.engine } : undefined) },
    agent,
    // force 缺省 = false ⇒ 走 token 判定路径（meter 返回 100 tokens/节点，远超 minTokens）
    options: { minTokens: 100, keepRecentNodes: 2, maxSummaryChars: 2000, maxNodesPerRun: 3 },
    log: () => {},
  });
  const count = (r: Array<{ start: number; end: number }>): number => {
    if (r.length === 0) return 0;
    const si = nodes.indexOf(r[0].start);
    const ei = nodes.indexOf(r[0].end);
    return si >= 0 && ei >= 0 ? ei - si + 1 : 0;
  };
  check('token 路径触发裁剪', tokenOutcome.ok === true, tokenOutcome);
  check('token 路径单次规模受限（≤3）', count(tokenOnly.ranges) > 0 && count(tokenOnly.ranges) <= 3, count(tokenOnly.ranges));

  // ★第五次审查 P1-1：限流阀的默认值必须下沉到 `trimContext` 内部，
  // 不能依赖「唯一装配点恰好传了」。漏传时也必须受限，而不是退化成不限制。
  const noOpt = tokenEngine();
  const noOptOutcome = await trimContext({
    ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => noOpt.engine } : undefined) },
    agent,
    // 刻意**不传** maxNodesPerRun
    options: { minTokens: 100, keepRecentNodes: 2, maxSummaryChars: 2000 },
    log: () => {},
  });
  check('漏传 maxNodesPerRun 时仍然限流（不退化）', noOptOutcome.ok === true && count(noOpt.ranges) > 0 && count(noOpt.ranges) <= 40, {
    ok: noOptOutcome.ok,
    count: count(noOpt.ranges),
  });
}

// 回归：cordis 的服务属性访问要求 inject，直接读 engine.ctx.tokenMeter 会抛
// `cannot get property "tokenMeter" without inject`。必须走 ctx.get()。
const strictMeter = {
  measure: () => ({ totalTokens: 100000, nodes: nodes.map(() => ({ tokens: 1000 })) }),
};
const strictEngineCtx = new Proxy(
  { get: (n: string) => (n === 'tokenMeter' ? strictMeter : undefined) },
  {
    get(target, prop) {
      if (prop === 'get') return target.get;
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  },
);
const strictEngine = {
  ctx: strictEngineCtx,
  summarize: async () => {
    throw new Error('原始 summarize 不该被调用');
  },
  compactRegion: async (start: number, end: number) => ({ start, end }),
};
const strictOutcome = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => strictEngine } : undefined) },
  agent,
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: () => {},
});
check(
  '不直接读 engine.ctx.tokenMeter（inject 回归）',
  strictOutcome.ok === true,
  strictOutcome,
);

const failEngine = makeEngine(100000);
const failOriginal = failEngine.summarize;
failEngine.compactRegion = async () => {
  throw new Error('no open turn');
};
const failedTrim = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => failEngine } : undefined) },
  agent,
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: () => {},
});
check(
  '引擎抛错时安全返回',
  failedTrim.ok === false && failedTrim.reason.startsWith('error:'),
  failedTrim,
);
check('异常后 summarize 仍恢复', failEngine.summarize === failOriginal);

// 回归：起点落在 node 0（无 source 的系统提示）时，宿主拒绝；
// 兜底必须自动后移到平衡切点并成功，而不是整段放弃（实测该区间会涨到 81k tokens）。
const node0Events = [
  { type: 'user/message', data: { content: [{ type: 'text', text: 'system prompt' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
];
const node0Nodes = [0, 1, 2, 3, 4];
const node0Session = { surface: { nodes: node0Nodes }, log: node0Events };
const node0Calls: Array<[number, number]> = [];
const node0Engine = {
  ctx: {
    get: (n: string) =>
      n === 'tokenMeter'
        ? { measure: () => ({ totalTokens: 100000, nodes: node0Nodes.map(() => ({ tokens: 1000 })) }) }
        : undefined,
  },
  summarize: async () => {
    throw new Error('原始 summarize 不该被调用');
  },
  compactRegion: async (start: number, end: number) => {
    node0Calls.push([start, end]);
    if (start === 0) throw new Error('surface replace: node 0 holds the system prompt');
    return { start, end };
  },
};
const node0Logs: string[] = [];
const node0Outcome = await trimContext({
  ctx: { get: (n: string) => (n === 'agentPresets' ? { serviceFor: () => node0Engine } : undefined) },
  agent: { session: node0Session },
  options: { minTokens: 60000, keepRecentNodes: 2, maxSummaryChars: 2000 },
  log: (m) => node0Logs.push(m),
});
check('node 0 被拒后回退成功', node0Outcome.ok === true, node0Outcome);
check('回退起点不是 0', node0Calls.length === 2 && node0Calls[1]?.[0] === 1, node0Calls);
check('写了回退日志', node0Logs.some((l) => l.includes('起点回退后成功')), node0Logs);

// ────────────────────────────────────────────────────────────
// 4. 路径 2：工具输出剪枝
// ────────────────────────────────────────────────────────────
console.log('=== 4) 工具输出剪枝 ===');

const noSession = pruneToolResults({ ctx: {}, agent: {}, log: () => {} });
check('无 session 时安全返回', noSession.ok === false && noSession.reason === 'no-session', noSession);

const noPruner = pruneToolResults({ ctx: { get: () => undefined }, agent, log: () => {} });
check(
  '剪枝服务不可达时安全返回',
  noPruner.ok === false && noPruner.reason === 'pruner-unavailable',
  noPruner,
);

const pruneLogs: string[] = [];
const directPruner = {
  pruneSession: () => ({ pruned: [{}, {}], charsRemoved: 12345 }),
};
const direct = pruneToolResults({
  ctx: { get: (n: string) => (n === 'toolResultPruner' ? directPruner : undefined) },
  agent,
  log: (m) => pruneLogs.push(m),
});
check('宿主层直取剪枝服务', direct.ok === true && direct.pruned === 2, direct);
check('记录省下的字符数', direct.charsRemoved === 12345, direct);
check('写了剪枝日志', pruneLogs.some((l) => l.includes('[lrc][prune]')), pruneLogs);

// 阈值覆盖：临时改 pruner.config，剪完必须恢复
const seenConfigs: Array<{ thresholdChars?: number }> = [];
const configPruner = {
  config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
  pruneSession() {
    seenConfigs.push({ ...this.config });
    return { pruned: [{}], charsRemoved: 100 };
  },
};
const overrideOutcome = pruneToolResults({
  ctx: { get: (n: string) => (n === 'toolResultPruner' ? configPruner : undefined) },
  agent,
  log: () => {},
  thresholdChars: 4096,
});
check('阈值覆盖生效', seenConfigs[0]?.thresholdChars === 4096, seenConfigs[0]);
check('阈值覆盖后恢复', configPruner.config.thresholdChars === 8192, configPruner.config);
check('覆盖后仍返回成功', overrideOutcome.ok === true, overrideOutcome);

const presetPruner = { pruneSession: () => ({ pruned: [{}], charsRemoved: 100 }) };
const viaPreset = pruneToolResults({
  ctx: {
    get: (n: string) =>
      n === 'agentPresets' ? { serviceFor: () => presetPruner } : undefined,
  },
  agent,
  log: () => {},
});
check('经 agentPresets.serviceFor 取到剪枝服务', viaPreset.ok === true && viaPreset.pruned === 1, viaPreset);

const enginePruner = { pruneSession: () => ({ pruned: [{}], charsRemoved: 50 }) };
const viaEngine = pruneToolResults({
  ctx: {
    get: (n: string) =>
      n === 'agentPresets'
        ? {
            serviceFor: (_a: unknown, name: string) =>
              name === 'compaction' ? { ctx: { get: () => enginePruner } } : undefined,
          }
        : undefined,
  },
  agent,
  log: () => {},
});
check('经引擎 ctx 取到剪枝服务', viaEngine.ok === true && viaEngine.pruned === 1, viaEngine);

const throwingPruner = {
  pruneSession: () => {
    throw new Error('session rejected replacement');
  },
};
const pruneFailed = pruneToolResults({
  ctx: { get: (n: string) => (n === 'toolResultPruner' ? throwingPruner : undefined) },
  agent,
  log: () => {},
});
check(
  '剪枝抛错时安全返回',
  pruneFailed.ok === false && pruneFailed.reason.startsWith('error:'),
  pruneFailed,
);

// ────────────────────────────────────────────────────────────
// 5. 路径 2b：工具参数截断
// ────────────────────────────────────────────────────────────
console.log('=== 5) 工具参数截断 ===');

const longArgs = 'x'.repeat(5000);
const argEvents = [
  {
    type: 'assistant/message',
    data: {
      message: {
        content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: longArgs }],
      },
    },
  },
];
const appended: Array<{ type: string; data: any; opts: any }> = [];
const argSession = {
  surface: { nodes: [0] },
  log: argEvents,
  append(type: string, data: unknown, opts: unknown) {
    appended.push({ type, data, opts });
    return { seq: 99 };
  },
};

const argOutcome = pruneToolCallArguments({
  ctx: {},
  agent: { session: argSession },
  log: () => {},
  options: { thresholdChars: 4000, headChars: 2000 },
});
// 宿主 surface 校验不允许替换含 tool-call 的 assistant 节点
// （会破坏 tool-pairing 平衡），故本路径在当前宿主版本下不可用。
check(
  '含 tool-call 的节点不可替换（宿主 surface 校验）',
  argOutcome.ok === false && argOutcome.reason === 'incompatible-with-host-surface',
  argOutcome,
);
check('不产生任何替换事件', appended.length === 0, appended.length);
check(
  '无 session 时安全返回',
  pruneToolCallArguments({ ctx: {}, agent: {}, log: () => {} }).reason === 'no-session',
);
check(
  'session 无 append 时安全返回',
  pruneToolCallArguments({
    ctx: {},
    agent: { session: { surface: { nodes: [0] }, log: argEvents } },
    log: () => {},
  }).reason === 'no-range',
);

// ────────────────────────────────────────────────────────────
// 6. 路径 2c：丢弃旧推理
// ────────────────────────────────────────────────────────────
console.log('=== 6) 丢弃旧推理 ===');

const reasoningEvents = [
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'r1' }, { type: 'text', text: 't1' }] } },
  },
  // 纯推理消息：丢掉推理会变成空消息，必须跳过
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'r2' }] } },
  },
  // 含 tool-call：替换会破坏 tool-pairing 平衡，必须跳过
  {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'r3' },
          { type: 'tool-call', id: 'c', name: 'x', arguments: '{}' },
        ],
      },
    },
  },
  // 最近节点：保留
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'r4' }, { type: 'text', text: 't4' }] } },
  },
];
const reasoningAppended: Array<{ type: string; data: any; opts: any }> = [];
const reasoningSession = {
  surface: { nodes: [0, 1, 2, 3] },
  log: reasoningEvents,
  append(type: string, data: unknown, opts: unknown) {
    reasoningAppended.push({ type, data, opts });
    return { seq: 99 };
  },
};
const reasoningOutcome = pruneReasoning({
  ctx: {},
  agent: { session: reasoningSession },
  log: () => {},
  options: { keepRecentNodes: 1 },
});
check(
  '只替换纯文本+推理的旧消息',
  reasoningOutcome.ok === true && reasoningOutcome.pruned === 1,
  reasoningOutcome,
);
check('纯推理消息不处理', reasoningAppended.length === 1, reasoningAppended.length);
check(
  '含 tool-call 的消息不替换（保护 tool-pairing）',
  !reasoningAppended.some((a) => a.opts.surfaceOp.startSeq === 2),
  reasoningAppended.map((a) => a.opts.surfaceOp.startSeq),
);
check(
  '保留最近节点',
  !reasoningAppended.some((a) => a.opts.surfaceOp.startSeq === 3),
  reasoningAppended.map((a) => a.opts.surfaceOp.startSeq),
);
check(
  '替换体是 user/message（宿主规则）',
  reasoningAppended[0]?.type === 'user/message',
  reasoningAppended[0]?.type,
);
check(
  'sourceEventSeqs 覆盖被替换节点',
  JSON.stringify(reasoningAppended[0]?.opts.sourceEventSeqs) === '[0]',
  reasoningAppended[0]?.opts.sourceEventSeqs,
);
check(
  '推理块被移除',
  reasoningAppended[0]?.data.content.every((b: { type?: string }) => b.type !== 'reasoning'),
);
check(
  '其他块保留',
  reasoningAppended[0]?.data.content.some((b: { type?: string }) => b.type === 'text'),
);
check(
  '无 session 时安全返回',
  pruneReasoning({ ctx: {}, agent: {}, log: () => {} }).reason === 'no-session',
);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
