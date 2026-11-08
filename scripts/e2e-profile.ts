/**
 * 画像形状回归：`tool/result` 的两种 content 形状都必须被计入 toolResult。
 *
 * 用法：node scripts/e2e-profile.ts
 *
 * 背景：历史实现只读 `content[0].content`（嵌套块），而宿主实测 223/223 个
 * tool/result 事件都是扁平形状 `content = [{type:'text', text}]`。猜错形状
 * 的后果是画像里 toolResult 恒为 0%，「工具结果吃满上下文」完全不可见。
 *
 * 这套测试锁死两种形状，任何一边回退都会红。
 */
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

interface FakeEvent {
  type: string;
  seq: number;
  data: unknown;
  surfaceOp: unknown;
  sourceEventSeqs?: number[];
}

class FakeSession {
  readonly id = 'session-profile';
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
    this.surface.nodes.push(seq);
    return event;
  }
}

// ────────────────────────────────────────────────────────────
// 1) 扁平形状（宿主实际形状）：content = [{type:'text', text}]
// ────────────────────────────────────────────────────────────
{
  const session = new FakeSession();
  session.append('tool/result', {
    message: {
      content: [{ type: 'text', text: 'f'.repeat(5000) }],
    },
  });

  const profile = profileSurface(session);
  console.log('\n=== 扁平形状 ===');
  console.log(formatProfile(profile));

  check('扁平形状 toolResult 被计入', profile.byCategory.toolResult === 5000, profile.byCategory.toolResult);
  check('扁平形状 toolResult 占比为 100%', profile.shares.toolResult === 1, profile.shares.toolResult);
  check('扁平形状不算进 assistantText', profile.byCategory.assistantText === 0, profile.byCategory.assistantText);
}

// ────────────────────────────────────────────────────────────
// 2) 嵌套形状（历史实现只认这个）：content = [{type:'tool-result', content:[...]}]
// ────────────────────────────────────────────────────────────
{
  const session = new FakeSession();
  session.append('tool/result', {
    message: {
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'n'.repeat(4000) }],
        },
      ],
    },
  });

  const profile = profileSurface(session);
  console.log('\n=== 嵌套形状 ===');
  console.log(formatProfile(profile));

  check('嵌套形状 toolResult 被计入', profile.byCategory.toolResult === 4000, profile.byCategory.toolResult);
}

// ────────────────────────────────────────────────────────────
// 3) 混合形状：两种块出现在同一事件里，都要算，且不重复计数
// ────────────────────────────────────────────────────────────
{
  const session = new FakeSession();
  session.append('tool/result', {
    message: {
      content: [
        { type: 'text', text: 'a'.repeat(1000) },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          content: [{ type: 'text', text: 'b'.repeat(500) }],
        },
      ],
    },
  });

  const profile = profileSurface(session);
  check('混合形状总计 1500', profile.byCategory.toolResult === 1500, profile.byCategory.toolResult);
}

// ────────────────────────────────────────────────────────────
// 4) 工具结果占满上下文时，占比要真的看得出来
// ────────────────────────────────────────────────────────────
{
  const session = new FakeSession();
  session.append('system/message', { content: [{ type: 'text', text: 's'.repeat(1000) }] });
  session.append('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '干活' }],
  });
  for (let step = 1; step <= 10; step += 1) {
    session.append('tool/result', {
      message: { content: [{ type: 'text', text: 't'.repeat(9000) }] },
    });
  }

  const profile = profileSurface(session);
  console.log('\n=== 工具结果吃满上下文 ===');
  console.log(formatProfile(profile));

  check('toolResult 占比 > 90%', profile.shares.toolResult > 0.9, profile.shares.toolResult);
  check('系统提示未被误算成 toolResult', profile.byCategory.system === 1000, profile.byCategory.system);
}

// ────────────────────────────────────────────────────────────
// 5) checkpoint 条数：摘要自增殖的直接指标
// ────────────────────────────────────────────────────────────
{
  const session = new FakeSession();
  session.append('system/message', { content: [{ type: 'text', text: 's'.repeat(1000) }] });
  for (let i = 0; i < 5; i += 1) {
    session.append('user/message', {
      source: { kind: 'compact-checkpoint' },
      content: [{ type: 'text', text: '## 已裁剪的历史（确定性摘要，无 LLM）' }],
    });
  }
  session.append('assistant/message', { message: { content: [{ type: 'text', text: 'a' }] } });

  const profile = profileSurface(session);
  console.log('\n=== checkpoint 堆叠 ===');
  console.log(formatProfile(profile));

  check('checkpoint 条数被统计', profile.checkpoints === 5, profile.checkpoints);
  check('堆叠时日志带告警', formatProfile(profile).includes('⚠摘要堆叠'), formatProfile(profile));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
