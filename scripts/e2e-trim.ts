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
