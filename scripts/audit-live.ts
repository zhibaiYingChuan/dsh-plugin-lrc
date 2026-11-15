/**
 * 实时会话审计：只看「本会话发生了什么」，不写库、不连 LRC。
 *
 * 用法：node scripts/audit-live.ts <session-file>
 *
 * 与 `replay-session.ts` 的区别：
 * - `replay` 关注「提取率」（所有正文 → 多少条记忆）
 * - `audit` 关注「链路是否真的跑通」：每条 Fact 的来源、被拒原因分布、
 *   工件指针、快照内容、交接文档长什么样
 */
import { decodeSessionFile } from './session-file.ts';
import { extractFacts } from '../src/memory-extract.ts';
import { buildSnapshot } from '../src/offloader.ts';
import { projectHandoff } from '../src/handoff-projection.ts';
import { isArtifactWorthy } from '../src/artifact-store.ts';
import type { MemoryFact } from '../src/memory-schema.ts';

const file = process.argv[2];
if (file === undefined) {
  console.log('用法：node scripts/audit-live.ts <session-file>');
  process.exit(1);
}

interface Block {
  type?: string;
  text?: unknown;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

const events = decodeSessionFile(file) as Array<{
  type?: string;
  seq?: number;
  data?: { message?: { content?: unknown }; content?: unknown; source?: { kind?: string } };
}>;

const facts: MemoryFact[] = [];
const reasonCount = new Map<string, number>();
const pendingAll: string[] = [];
const longTexts: Array<{ seq: number; chars: number; preview: string }> = [];
let userCount = 0;
let assistantCount = 0;
let lastUser = '';
let rejectedSamples: Array<{ text: string; reason: string }> = [];

for (const e of events) {
  if (e.type === 'user/message') {
    const kind = e.data?.source?.kind;
    if (kind !== undefined && kind !== 'user') continue;
    const text = textOf(e.data?.content);
    if (text.length === 0) continue;
    userCount += 1;
    lastUser = text;
    if (isArtifactWorthy(text)) {
      longTexts.push({
        seq: e.seq ?? 0,
        chars: text.length,
        preview: text.split('\n').find((l) => l.trim().length > 0)?.slice(0, 60) ?? '',
      });
    }
    const r = extractFacts({ text, origin: 'user', sessionId: 'audit' });
    facts.push(...r.facts);
    pendingAll.push(...r.pending);
    for (const x of r.rejected) reasonCount.set(x.reason, (reasonCount.get(x.reason) ?? 0) + 1);
    rejectedSamples.push(...r.rejected.slice(0, 3));
  } else if (e.type === 'assistant/message') {
    const text = textOf(e.data?.message?.content);
    if (text.length === 0) continue;
    assistantCount += 1;
    const r = extractFacts({ text, origin: 'assistant', sessionId: 'audit' });
    facts.push(...r.facts);
    pendingAll.push(...r.pending);
    for (const x of r.rejected) reasonCount.set(x.reason, (reasonCount.get(x.reason) ?? 0) + 1);
  }
}

console.log(`===== 会话概况 =====`);
console.log(`用户消息 ${userCount} 条 / 助手正文 ${assistantCount} 条 / 事件 ${events.length} 个`);
console.log(`提取到 Fact ${facts.length} 条`);
console.log('');

console.log(`===== 超长文本（应被落盘为工件）=====`);
if (longTexts.length === 0) {
  console.log('无（本会话没有 >8000 字符的用户输入）');
} else {
  for (const t of longTexts) console.log(`seq=${t.seq} ${t.chars} 字符：${t.preview}`);
}
console.log('');

console.log(`===== 全部 Fact（按类别）=====`);
const byKind = new Map<string, MemoryFact[]>();
for (const f of facts) {
  const list = byKind.get(f.kind) ?? [];
  list.push(f);
  byKind.set(f.kind, list);
}
for (const [kind, list] of byKind) {
  console.log(`--- ${kind} (${list.length}) ---`);
  for (const f of list) {
    const tag = f.origin === 'user' ? '我' : 'AI';
    console.log(`  ${tag} ${f.statement}`);
  }
}
console.log('');

console.log(`===== 拒绝原因分布 =====`);
const sorted = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [reason, n] of sorted) console.log(`  ${reason}: ${n}`);
console.log('');

console.log(`===== 待 LLM 裁决（${pendingAll.length} 条）=====`);
if (pendingAll.length === 0) {
  console.log('无（规则层已覆盖全部结构合格的句子）');
} else {
  console.log('这些句子结构合格但没命中谓词表 —— 由 LLM 判定去留：');
  for (const p of pendingAll.slice(0, 20)) console.log(`  · ${p.slice(0, 76)}`);
  if (pendingAll.length > 20) console.log(`  … 另有 ${pendingAll.length - 20} 条`);
}
console.log('');

console.log(`===== 快照（snapshotItems=3，最新在前）=====`);
console.log(buildSnapshot([...facts].reverse(), 3) || '（空）');
console.log('');

console.log(`===== 交接文档投影 =====`);
const { text: handoff, sections } = projectHandoff({
  facts,
  task: lastUser.slice(0, 100),
  note: '',
});
console.log(
  `三段：事实 ${sections.confirmed.length} / 进展 ${sections.progress.length} / 下一步 ${sections.next.length}`,
);
console.log(`总长 ${handoff.length} 字符`);
