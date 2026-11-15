/**
 * 宿主载荷集成测试：用 DSH 真实的 `agent/pre-step` 结构跑一遍。
 *
 * 用法：node scripts/e2e-host-payload.ts
 *
 * ## 为什么需要这个套件
 *
 * 另外三个 e2e 脚本的 LRC 都是进程内 mock，`offload()` 直接喂 `string[]`，
 * 完全绕过 `agent/pre-step` 的真实载荷 —— 覆盖了"给定文本行之后"的全链路，
 * 唯独没测"文本行从哪来"。结果就是 65 项断言全绿、线上自动沉淀却从不触发。
 *
 * 本套件专门盯这一段：
 *   `agent.session.log` → `linesFromSession()` → `string[]`
 *
 * 真实结构（来自 app.asar 内 `@deepseek-ai/dsh-session`）：
 *   Session = { id, log: SessionEvent[], surface, header, requestHeader() }
 *   SessionEvent = { type, seq, time, data, surfaceOp }
 *   assistant/message → data.message.content
 *   user/message      → data.content
 */

import {
  extractAssistantText,
  hasContentBlocks,
  isRealUserMessage,
  linesFromSession,
  reasoningBlocksOnly,
} from '../src/session-text.ts';
import { extractFacts } from '../src/memory-extract.ts';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 构造一条 DSH 会话事件。 */
function event(type: string, data: unknown, seq: number) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, surfaceOp: 'append' };
}

/** 构造一条 assistant 消息事件。 */
function assistant(content: unknown[], seq: number) {
  return event('assistant/message', { message: { id: `m${seq}`, role: 'assistant', content } }, seq);
}

// ────────────────────────────────────────────────────────────
// 1. 真实载荷：session.log 投影成文本行
// ────────────────────────────────────────────────────────────

const session = {
  id: 'session-test',
  log: [
    event('user/message', { content: [{ type: 'text', text: '必须用 3099 作为正式端口，帮我看看怎么配' }] }, 1),
    // 无强约束词的用户指令：不得进沉淀源（否则会被 distill 当成约束入库）
    event('user/message', { content: [{ type: 'text', text: '根据这个文档中的视觉配色' }] }, 2),
    assistant([{ type: 'reasoning', text: '先确认现有端口约定' }], 3),
    assistant([{ type: 'tool-call', name: 'read', arguments: { path: 'a.ts' } }], 4),
    assistant([{ type: 'text', text: '决定用 3099 作为正式端口' }], 5),
    event('tool/result', { message: { content: [{ type: 'text', text: '文件内容' }] } }, 6),
    assistant([{ type: 'reasoning', text: '测试环境统一用 3111' }], 7),
  ],
};

const lines = linesFromSession(session);
// ★2026-11-14 语义变更：收集阶段不再做「值不值得记」的语义筛选。
//
// 旧实现在这里用 `hasConstraintMarker` + `carriesResourceLocation` 过滤用户
// 消息 —— 那等于在收集阶段就做价值判断，而判据与提取阶段不一致，两处漂移
// 必然漏（实测用户的「音频在桌面」因此从未进入沉淀源）。
//
// 现在收集阶段只排除「肯定不是用户说的话」（技能目录 / 运行时上下文），
// 价值判断统一交给 `memory-schema.ts` 的三元组契约。
check('session.log 能投影出文本行', lines.length === 3, `实际 ${lines.length} 行：${JSON.stringify(lines)}`);
check('含强约束词的用户消息被收录', lines[0] === '必须用 3099 作为正式端口，帮我看看怎么配', lines[0]);
check(
  '无约束词的用户指令也进入收集（是否入库由 schema 裁决）',
  lines.some((l) => l.includes('视觉配色')),
  JSON.stringify(lines),
);
check('正文消息被收录', lines.some((l) => l === '决定用 3099 作为正式端口'), JSON.stringify(lines));
check(
  '推理块不进沉淀源（否则内部思考会被写成长期记忆）',
  !lines.some((l) => l.includes('先确认现有端口约定') || l.includes('测试环境统一用 3111')),
  JSON.stringify(lines),
);
check('tool/result 不被当成对话行', !lines.some((l) => l.includes('文件内容')));
check('纯 tool-call 消息不产生空行', lines.every((l) => l.trim().length > 0));

// ────────────────────────────────────────────────────────────
// 1b. 系统注入的 user/message 必须被过滤掉
// ────────────────────────────────────────────────────────────

const injected = {
  id: 'session-injected',
  log: [
    event(
      'user/message',
      { source: { kind: 'user' }, content: [{ type: 'text', text: '必须用 3099，真实提问' }] },
      1,
    ),
    event(
      'user/message',
      {
        source: { kind: 'skill-catalog' },
        content: [{ type: 'text', text: '- `office-docx`: Create Word documents.' }],
      },
      2,
    ),
    event(
      'user/message',
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd: G:\\x' }] },
      3,
    ),
    event(
      'user/message',
      { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'now: 2026-11-06' }] },
      4,
    ),
    event(
      'user/message',
      { source: { kind: 'model-selection' }, content: [{ type: 'text', text: 'model: x' }] },
      5,
    ),
    event('user/message', { content: [{ type: 'text', text: '禁止用 3111，无 source 的旧格式' }] }, 6),
  ],
};

const injectedLines = linesFromSession(injected);
check(
  '只保留 source.kind=user 与无 source 的消息',
  injectedLines.length === 2,
  JSON.stringify(injectedLines),
);
check('真实用户消息保留', injectedLines[0] === '必须用 3099，真实提问', injectedLines[0]);
check('无 source 的旧格式保留', injectedLines[1] === '禁止用 3111，无 source 的旧格式', injectedLines[1]);
check(
  '技能目录不被当成用户发言',
  !injectedLines.some((l) => l.includes('office-docx')),
  JSON.stringify(injectedLines),
);
check(
  '运行时/时间/模型切换上下文都被过滤',
  !injectedLines.some((l) => l.includes('cwd:') || l.includes('now:') || l.includes('model:')),
  JSON.stringify(injectedLines),
);
check(
  'isRealUserMessage 判定正确',
  isRealUserMessage(injected.log[0]) === true &&
    isRealUserMessage(injected.log[1]) === false &&
    isRealUserMessage(injected.log[5]) === true,
);

// ────────────────────────────────────────────────────────────
// 1c. 用户消息门槛：路径里出现的词不算约束
// ────────────────────────────────────────────────────────────

const gated = {
  id: 'session-gated',
  log: [
    // 路径里带「禁止」，但不是约束
    event('user/message', { content: [{ type: 'text', text: '帮我排版 docs/禁止事项.md' }] }, 1),
    // 「别用」不在旧词表里，曾被门槛漏掉
    event('user/message', { content: [{ type: 'text', text: '以后都用 pnpm，别用 npm' }] }, 2),
    // 英文约束从来没被旧词表覆盖
    event('user/message', { content: [{ type: 'text', text: 'must use 3111 for tests' }] }, 3),
    // 无约束的任务描述，仍应被挡
    event('user/message', { content: [{ type: 'text', text: '根据这个文档中的视觉配色' }] }, 4),
  ],
};

const gatedLines = linesFromSession(gated);
// 收集阶段已不做语义筛选，所以这组断言改为验证**下游 schema 的判定**：
// 哪些句子最终能变成一条记忆。
const gatedFacts = gatedLines
  .flatMap((text) => extractFacts({ text, origin: 'user', sessionId: 'session-gated' }).facts)
  .map((f) => f.statement);
check(
  '路径里的「禁止」不会被当成约束（schema 拆不出三元组）',
  !gatedFacts.some((s) => s.includes('禁止事项')),
  JSON.stringify(gatedFacts),
);
check(
  '「别用」类约束成为记忆',
  gatedFacts.some((s) => s.includes('别用') && s.includes('npm')),
  JSON.stringify(gatedFacts),
);
check(
  '英文约束成为记忆',
  gatedFacts.some((s) => s.includes('must use') && s.includes('3111')),
  JSON.stringify(gatedFacts),
);
check('无约束任务描述不成为记忆', !gatedFacts.some((s) => s.includes('视觉配色')), JSON.stringify(gatedFacts));

// ────────────────────────────────────────────────────────────
// 2. 旧实现读 session.lines —— 必须证明它不存在
// ────────────────────────────────────────────────────────────

check(
  'Session 上没有 lines 字段（旧实现的断点）',
  (session as { lines?: unknown }).lines === undefined,
);

// ────────────────────────────────────────────────────────────
// 3. 单条事件解析
// ────────────────────────────────────────────────────────────

check(
  'assistant/message 从 data.message.content 取正文',
  extractAssistantText(assistant([{ type: 'text', text: '结论是 A' }], 10)) === '结论是 A',
);
check(
  '没有正文时退回 reasoning',
  extractAssistantText(assistant([{ type: 'reasoning', text: '推理内容' }], 11)) === '推理内容',
);
check(
  '正文与推理同时存在时只取正文',
  extractAssistantText(
    assistant(
      [
        { type: 'reasoning', text: '推理内容' },
        { type: 'text', text: '正文内容' },
      ],
      12,
    ),
  ) === '正文内容',
);
check(
  '纯 tool-call 消息返回空串（不该报警）',
  extractAssistantText(assistant([{ type: 'tool-call', name: 'read' }], 13)) === '',
);
check(
  '非 assistant 事件返回空串',
  extractAssistantText(event('user/message', { content: 'hi' }, 14)) === '',
);

// ────────────────────────────────────────────────────────────
// 3b. 告警条件：纯 tool-call 不该被当成"有内容块"
// ────────────────────────────────────────────────────────────

check(
  '纯 tool-call 消息不算有内容块（不该报警）',
  hasContentBlocks(assistant([{ type: 'tool-call', name: 'read' }], 16)) === false,
);
check('text 块算有内容块', hasContentBlocks(assistant([{ type: 'text', text: 'x' }], 17)) === true);
check(
  'reasoning 块算有内容块',
  hasContentBlocks(assistant([{ type: 'reasoning', text: 'x' }], 18)) === true,
);

// ────────────────────────────────────────────────────────────
// 3c. 推理块提取：工具密集型轮次的兜底来源
// ────────────────────────────────────────────────────────────

check(
  '只取推理块',
  reasoningBlocksOnly([
    { type: 'reasoning', text: '推理一' },
    { type: 'text', text: '正文' },
    { type: 'reasoning', text: '推理二' },
  ]) === '推理一\n推理二',
);
check(
  '没有推理块时返回空串',
  reasoningBlocksOnly([{ type: 'text', text: '正文' }]) === '',
);
check('content 非数组时返回空串', reasoningBlocksOnly('纯字符串') === '');
check('content 为 null 时返回空串', reasoningBlocksOnly(null) === '');

// ────────────────────────────────────────────────────────────
// 4. 异常输入不崩
// ────────────────────────────────────────────────────────────

check('session 为 null 时返回空数组', linesFromSession(null).length === 0);
check('session 无 log 时返回空数组', linesFromSession({ id: 'x' }).length === 0);
check('log 非数组时返回空数组', linesFromSession({ log: 'oops' }).length === 0);
check('content 为字符串时可用', extractAssistantText(assistant('纯字符串', 15)) === '纯字符串');

// ────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────

console.log('');
if (failed === 0) {
  console.log(`全部通过（${passed} 项）`);
} else {
  console.log(`失败 ${failed} 项 / 共 ${passed + failed} 项`);
  process.exitCode = 1;
}
