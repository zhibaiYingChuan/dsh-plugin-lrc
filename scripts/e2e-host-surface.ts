/**
 * 用**宿主自己的 `foldSurface`** 验证 prune-reasoning 的替换体是否合法。
 *
 * 这不是 mock 掉 surface 校验，而是直接跑宿主代码（`tmp-host/surface.js`，
 * 从 app.asar 抽出）。目的：证明「替换体用 user/message + sourceEventSeqs」
 * 在真实校验下能通过，且不会破坏 tool-pairing 平衡。
 *
 * 用法：node scripts/e2e-host-surface.ts
 */
// @ts-expect-error 宿主抽取产物，无类型声明
import { foldSurface } from '../tmp-host/surface.js';
import { pruneReasoning } from '../src/context-trim.ts';

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

interface FakeEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp: unknown;
  sourceEventSeqs?: number[];
}

const log: FakeEvent[] = [];
function append(type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }): FakeEvent {
  const seq = log.length;
  const event: FakeEvent = {
    type,
    seq,
    time: Date.now(),
    data,
    surfaceOp: opts?.surfaceOp ?? 'append',
    ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
  };
  log.push(event);
  return event;
}

// 构造一个合法的 surface 日志
append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } });
append('user/message', { role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } });
// 纯文本+推理的 assistant（应被 prune-reasoning 替换）
append('assistant/message', {
  message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r1' }, { type: 'text', text: 't1' }] },
});
// 含 tool-call 的 assistant（应被跳过）
append('assistant/message', {
  message: {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'r2' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
  },
});
append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: 'result' }], toolCallId: 'c1' } });
append('user/message', { role: 'user', content: [{ type: 'text', text: '第二个提问' }], source: { kind: 'user' } });

// 先验证基线合法
const base = foldSurface(log) as { nodes: number[] };
check('基线 surface 合法', base.nodes.length === 6, base.nodes);

// mock session：append 时用宿主 foldSurface 校验，非法会抛
const session = {
  surface: { nodes: [...base.nodes] },
  log,
  append(type: string, data: unknown, opts: { surfaceOp?: unknown; sourceEventSeqs?: number[] }) {
    const seq = log.length;
    const event: FakeEvent = {
      type,
      seq,
      time: Date.now(),
      data,
      surfaceOp: opts?.surfaceOp ?? 'append',
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    };
    const folded = foldSurface([...log, event]) as { nodes: number[] };
    log.push(event);
    session.surface.nodes = [...folded.nodes];
    return event;
  },
};

const outcome = pruneReasoning({
  ctx: {},
  agent: { session },
  log: () => {},
  options: { keepRecentNodes: 1 },
});
check('prune-reasoning 成功', outcome.ok === true && outcome.pruned === 1, outcome);
check(
  '替换体是 user/message（source.kind=lrc-prune）',
  log.some((e) => e.type === 'user/message' && (e.data as { source?: { kind?: string } })?.source?.kind === 'lrc-prune'),
  log.map((e) => e.type),
);
check(
  '含 tool-call 的节点未被替换',
  !log.some(
    (e) =>
      e.type === 'user/message' &&
      (e.data as { source?: { kind?: string } })?.source?.kind === 'lrc-prune' &&
      Array.isArray((e.data as { content?: unknown[] })?.content) &&
      ((e.data as { content: { type?: string }[] }).content).some((b) => b.type === 'tool-call'),
  ),
);

// tool-pairing 平衡：assistant 的 tool-call +1、tool/result -1、user 0
function balanceOk(events: FakeEvent[]): boolean {
  let open = 0;
  for (const e of events) {
    if (e.type === 'assistant/message') {
      const content = (e.data as { message?: { content?: { type?: string }[] } })?.message?.content ?? [];
      open += content.filter((b) => b.type === 'tool-call').length;
    } else if (e.type === 'tool/result') {
      open -= 1;
    }
    if (open < 0) return false;
  }
  return open === 0;
}
check('tool-pairing 平衡未被破坏', balanceOk(log), log.map((e) => e.type));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
