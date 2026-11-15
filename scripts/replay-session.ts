/**
 * 真实会话回放：对比「旧路径（正则 + 透传）」与「新路径（schema）」的入库内容。
 *
 * 用法：node scripts/replay-session.ts <session-file> [more...]
 *
 * 只读会话文件，不连 LRC、不写库 —— 输出的是「如果现在这条消息进来，
 * 会入库什么」，用于人工核对噪声率。
 */
import { decodeSessionFile } from './session-file.ts';
import { extractFacts } from '../src/memory-extract.ts';
import { renderFact } from '../src/memory-schema.ts';

interface Msg {
  origin: 'user' | 'assistant';
  text: string;
}

/** 从会话文件里抠出 text 块（只取正文，不含推理）。 */
function messagesFrom(file: string): Msg[] {
  let events: unknown[] = [];
  try {
    events = decodeSessionFile(file);
  } catch {
    return [];
  }
  const out: Msg[] = [];
  for (const ev of events) {
    const e = ev as { type?: string; data?: Record<string, unknown> };
    const type = e.type ?? '';
    let content: unknown;
    let origin: 'user' | 'assistant' = 'assistant';
    if (type === 'assistant/message') {
      content = (e.data?.message as { content?: unknown } | undefined)?.content;
    } else if (type === 'user/message') {
      const source = (e.data?.source as { kind?: string } | undefined)?.kind;
      if (source !== undefined && source !== 'user') continue;
      content = e.data?.content;
      origin = 'user';
    } else {
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const b of content) {
      const block = b as { type?: string; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) texts.push(block.text);
    }
    if (texts.length === 0) continue;
    out.push({ origin, text: texts.join('\n') });
  }
  return out;
}

let total = 0;
let kept = 0;
for (const file of process.argv.slice(2)) {
  const msgs = messagesFrom(file);
  console.log(`\n===== ${file}（${msgs.length} 条正文消息）=====`);
  const reasons = new Map<string, number>();
  const facts = [];
  for (const m of msgs) {
    const r = extractFacts({ text: m.text, origin: m.origin, sessionId: 'replay' });
    facts.push(...r.facts);
    for (const x of r.rejected) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
  }
  console.log(`入库 ${facts.length} 条：`);
  for (const f of facts) console.log(`  ${f.origin === 'user' ? '我' : 'AI'} ${renderFact(f)}`);
  console.log(`拒绝原因分布：${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '无'}`);
  total += msgs.length;
  kept += facts.length;
}
console.log(`\n合计：${total} 条正文 → ${kept} 条记忆（${((kept / Math.max(1, total)) * 100).toFixed(1)}%）`);
