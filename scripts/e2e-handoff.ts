/**
 * 路径 6（会话交接）的端到端测试。
 *
 * 用法：node scripts/e2e-handoff.ts
 *
 * 覆盖：
 *   1. 交接摘要组装（四块内容、长行截断、空输入）
 *   2. 从会话日志提取来源（最后一条真实用户请求、最近 5 条助手正文）
 *   3. 创建新会话的三条路径（agents.create / sessions.create / 只返回文本）
 */
import {
  buildHandoffText,
  createHandoffSession,
  extractHandoffSource,
} from '../src/handoff.ts';

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
// 1. 交接摘要组装
// ────────────────────────────────────────────────────────────
console.log('=== 1) 交接摘要组装 ===');

const full = buildHandoffText({
  lastUserRequest: '把插件升级到 M5',
  recentAssistant: ['结论：路径 1 已修复', 'x'.repeat(400)],
  snapshot: '[LRC 状态] 已沉淀 3 条',
  indexLines: ['[决策] 用 pnpm', '[约束] 禁止连 3099'],
  note: '先跑全量测试',
});
check('包含当前任务', full.includes('把插件升级到 M5'), full);
check('包含最近结论', full.includes('路径 1 已修复'), full);
check('包含已沉淀状态', full.includes('[LRC 状态]'), full);
check('包含长期记忆索引', full.includes('用 pnpm') && full.includes('禁止连 3099'), full);
check('包含下一步', full.includes('先跑全量测试'), full);
check('长行被截断', full.includes('…') && !full.includes('x'.repeat(400)), full.length);

const minimal = buildHandoffText({
  lastUserRequest: '',
  recentAssistant: [],
  snapshot: '',
  indexLines: [],
  note: '',
});
check('空输入给出占位', minimal.includes('（未记录）') && minimal.includes('（由接手方'), minimal);
check('空输入不产生空章节', !minimal.includes('## 最近结论'), minimal);

// ────────────────────────────────────────────────────────────
// 2. 从会话日志提取来源
// ────────────────────────────────────────────────────────────
console.log('=== 2) 从会话日志提取来源 ===');

const session = {
  log: [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } },
    { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '技能目录' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答一' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '推理' }] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最后一问' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答二' }] } } },
  ],
};
const source = extractHandoffSource(session);
check('取最后一条真实用户请求', source.lastUserRequest === '最后一问', source.lastUserRequest);
check('跳过技能目录', !source.lastUserRequest.includes('技能目录'), source.lastUserRequest);
check('只收助手正文', source.recentAssistant.join('|') === '回答一|回答二', source.recentAssistant);
check('无 log 时返回空', extractHandoffSource({}).lastUserRequest === '');
check('session 为 null 时返回空', extractHandoffSource(null).recentAssistant.length === 0);

// ────────────────────────────────────────────────────────────
// 3. 创建新会话的三条路径
// ────────────────────────────────────────────────────────────
console.log('=== 3) 创建新会话 ===');

const currentAgent = {
  session: { id: 'session-old', header: { cwd: 'G:\\proj' } },
  options: { provider: 'p', model: 'm' },
};

// 路径 A：agents.create 成功
const appendedA: Array<{ type: string; data: unknown }> = [];
const agentsOk = {
  create: async () => ({
    agent: {
      session: {
        id: 'session-new-agent',
        append: (type: string, data: unknown) => appendedA.push({ type, data }),
      },
    },
  }),
};
const resultA = await createHandoffSession({
  ctx: { get: (n: string) => (n === 'agents' ? agentsOk : undefined) },
  agent: currentAgent,
  text: '交接内容',
  log: () => {},
});
check('agents.create 成功', resultA.ok === true && resultA.mode === 'agent', resultA);
check('返回新会话 id', resultA.sessionId === 'session-new-agent', resultA);
check('注入一条用户消息', appendedA.length === 1 && appendedA[0]?.type === 'user/message', appendedA);
check(
  '注入内容为交接摘要',
  (appendedA[0]?.data as { content: Array<{ text: string }> }).content[0]?.text === '交接内容',
);

// 路径 B：agents.create 抛错 → sessions.create 兜底
const appendedB: Array<{ type: string; data: unknown }> = [];
const agentsFail = {
  create: async () => {
    throw new Error('no agent factory registered');
  },
};
const sessionsOk = {
  create: () => ({
    id: 'session-new-plain',
    append: (type: string, data: unknown) => appendedB.push({ type, data }),
  }),
};
const logsB: string[] = [];
const resultB = await createHandoffSession({
  ctx: {
    get: (n: string) =>
      n === 'agents' ? agentsFail : n === 'sessions' ? sessionsOk : undefined,
  },
  agent: currentAgent,
  text: '交接内容',
  log: (m) => logsB.push(m),
});
check('agents 失败后退回 sessions', resultB.ok === true && resultB.mode === 'session', resultB);
check('返回兜底会话 id', resultB.sessionId === 'session-new-plain', resultB);
check('兜底也注入用户消息', appendedB.length === 1, appendedB);
check('记录了退回原因', logsB.some((l) => l.includes('agents.create 失败')), logsB);

// 路径 C：两条都不可用 → 只返回文本
const resultC = await createHandoffSession({
  ctx: { get: () => undefined },
  agent: currentAgent,
  text: '交接内容',
  log: () => {},
});
check('都不可用时只返回文本', resultC.ok === false && resultC.mode === 'text-only', resultC);
check('文本仍然完整', resultC.text === '交接内容', resultC);

// 路径 D：sessions.create 抛错 → 只返回文本
const resultD = await createHandoffSession({
  ctx: {
    get: (n: string) =>
      n === 'sessions'
        ? {
            create: () => {
              throw new Error('store rejected');
            },
          }
        : undefined,
  },
  agent: currentAgent,
  text: '交接内容',
  log: () => {},
});
check('sessions 抛错时只返回文本', resultD.ok === false && resultD.mode === 'text-only', resultD);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
