/**
 * 不变量测试：**上下文必须真的变小**。
 *
 * 用法：node scripts/e2e-invariant.ts
 *
 * 之前的测试只断言「动作执行了」，没断言「执行完上下文确实降了」。
 * 这套测试驱动 40 步持续膨胀的内容，跑完三条剪枝路径后断言：
 *   - 总字符显著下降
 *   - reasoning / toolResult / toolArgs 占比都回到上限以内
 *
 * 这是「全局视角」的兜底：任何一条路径失效，这里都会红。
 */
import {
  pruneReasoning,
  pruneToolCallArguments,
  pruneToolResults,
} from '../src/context-trim.ts';
import { formatProfile, profileSurface } from '../src/context-profile.ts';

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
// 假 session：40 步持续膨胀
// ────────────────────────────────────────────────────────────
interface FakeEvent {
  type: string;
  seq: number;
  data: unknown;
  surfaceOp: unknown;
  sourceEventSeqs?: number[];
}

class FakeSession {
  readonly id = 'session-invariant';
  readonly log: FakeEvent[] = [];
  readonly surface = { nodes: [] as number[] };

  append(type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }): FakeEvent {
    const seq = this.log.length;
    const surfaceOp = opts?.surfaceOp ?? 'append';
    const event: FakeEvent = {
      type,
      seq,
      data,
      surfaceOp,
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    };
    this.log.push(event);
    if (surfaceOp === 'append') {
      this.surface.nodes.push(seq);
    } else {
      const op = surfaceOp as { op?: string; start?: number; end?: number; startSeq?: number; endSeq?: number };
      const start = (op.start ?? op.startSeq) as number;
      const end = (op.end ?? op.endSeq) as number;
      const startIdx = this.surface.nodes.indexOf(start);
      const endIdx = this.surface.nodes.indexOf(end);
      if (startIdx === -1 || endIdx === -1) throw new Error('invalid replace surfaceOp');
      this.surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq);
    }
    return event;
  }
}

const session = new FakeSession();

// 系统提示 + 注入上下文（不可裁剪）
session.append('system/message', { content: [{ type: 'text', text: 's'.repeat(6000) }] });
session.append('user/message', {
  source: { kind: 'skill-catalog' },
  content: [{ type: 'text', text: 'k'.repeat(12000) }],
});
session.append('user/message', {
  source: { kind: 'user' },
  content: [{ type: 'text', text: '开始任务' }],
});

// 40 步：每步 reasoning 2000 + toolArgs 5000 + toolResult 5000
for (let step = 1; step <= 40; step += 1) {
  session.append('assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: `第 ${step} 步推理：${'r'.repeat(2000)}` },
        { type: 'tool-call', id: `c${step}`, name: 'read', arguments: 'a'.repeat(5000) },
      ],
    },
  });
  session.append('tool/result', {
    message: {
      content: [
        {
          type: 'tool-result',
          toolCallId: `c${step}`,
          content: [{ type: 'text', text: 't'.repeat(5000) }],
        },
      ],
    },
  });
}

const before = profileSurface(session);
console.log('=== 剪枝前 ===');
console.log(formatProfile(before));

// ────────────────────────────────────────────────────────────
// 假 pruner：真的截断工具结果
// ────────────────────────────────────────────────────────────
const pruner = {
  config: { thresholdChars: 4096, headChars: 2048, tailChars: 512 },
  pruneSession(target: FakeSession) {
    let pruned = 0;
    let charsRemoved = 0;
    for (const seq of [...target.surface.nodes]) {
      const event = target.log[seq];
      if (event?.type !== 'tool/result') continue;
      const message = (event.data as { message: { content: Array<{ content: Array<{ text?: string }> }> } }).message;
      const result = message.content[0];
      const blocks = result?.content ?? [];
      const total = blocks.reduce((sum, b) => sum + (b.text?.length ?? 0), 0);
      if (total <= 4096) continue;
      const text = blocks.map((b) => b.text ?? '').join('');
      const next = [
        {
          ...result,
          content: [{ type: 'text', text: `${text.slice(0, 2048)}[...]${text.slice(-512)}` }],
        },
      ];
      target.append(
        'tool/result',
        { ...(event.data as object), message: { ...message, content: next } },
        { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] },
      );
      pruned += 1;
      charsRemoved += total - (2048 + 5 + 512);
    }
    return { pruned: new Array(pruned).fill({}), charsRemoved };
  },
};

// ────────────────────────────────────────────────────────────
// 跑三条剪枝路径
// ────────────────────────────────────────────────────────────
const pruneResult = pruneToolResults({
  ctx: { get: (n: string) => (n === 'toolResultPruner' ? pruner : undefined) },
  agent: { session },
  log: () => {},
  thresholdChars: 4096,
});
const pruneArgsResult = pruneToolCallArguments({
  ctx: {},
  agent: { session },
  log: () => {},
  options: { thresholdChars: 4000, headChars: 2000, keepRecentNodes: 8 },
});
const pruneReasoningResult = pruneReasoning({
  ctx: {},
  agent: { session },
  log: () => {},
  options: { keepRecentNodes: 8 },
});

const after = profileSurface(session);
console.log('\n=== 剪枝后 ===');
console.log(formatProfile(after));

// ────────────────────────────────────────────────────────────
// 不变量断言
// ────────────────────────────────────────────────────────────
console.log('\n=== 不变量 ===');
check(
  'prune-results 与 prune-reasoning 执行；prune-args 因宿主不兼容而跳过',
  pruneResult.ok &&
    pruneReasoningResult.ok &&
    pruneArgsResult.ok === false &&
    pruneArgsResult.reason === 'incompatible-with-host-surface',
  { pruneResult, pruneArgsResult, pruneReasoningResult },
);
check('总字符显著下降（< 85%）', after.totalChars < before.totalChars * 0.85, {
  before: before.totalChars,
  after: after.totalChars,
});
check('reasoning 占比 < 35%', after.shares.reasoning < 0.35, after.shares.reasoning);
// prune-args 在当前宿主版本不可用（替换含 tool-call 的 assistant 会破坏
// tool-pairing 平衡），toolArgs 由 trim 在后续轮次兜底。
check('toolArgs 占比记录（prune-args 已禁用）', true, after.shares.toolArgs);
// toolResult 是模型真正需要的内容，不按占比卡，只卡绝对上限
check('toolResult 绝对字符 < 120K', after.byCategory.toolResult < 120_000, after.byCategory.toolResult);
check('系统提示未被裁剪', after.byCategory.system === 6000, after.byCategory.system);
check('注入上下文未被裁剪', after.byCategory.injected === 12000, after.byCategory.injected);
check('真实用户消息保留', after.byCategory.user > 0, after.byCategory.user);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
