/**
 * 工件库 + 交接文档投影的端到端测试。
 *
 * 用法：node scripts/e2e-artifact-handoff.ts
 *
 * ## 为什么这两块放在一起
 *
 * 它们属于同一条链路的两端：
 * ```
 * 长文本 ──落盘──► 工件库 ──指针 Fact──► LRC ──投影──► 交接文档
 * ```
 * 任一环断了，另一环的价值也随之消失（存了取不回 / 交接里没有内容）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, hashContent, isArtifactWorthy } from '../src/artifact-store.ts';
import { buildHandoffSections, projectHandoff, renderHandoff } from '../src/handoff-projection.ts';
import { makeArtifactFact, validateFact, type MemoryFact } from '../src/memory-schema.ts';
import { buildSnapshot } from '../src/offloader.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'lrc-artifact-'));

try {
  // ────────────────────────────────────────────────────────────
  // 1. 工件库：落盘 / 取回 / 去重
  // ────────────────────────────────────────────────────────────
  console.log('=== 1) 工件库基础 ===');
  {
    const store = new ArtifactStore(join(workDir, 'a1'));
    const doc = `# 架构说明\n\n${'这是一段很长的文档内容。'.repeat(800)}`;

    check('短文本不落盘', !isArtifactWorthy('短文本', 100));
    check('长文本落盘', isArtifactWorthy(doc, 8000), doc.length);

    const first = store.store(doc);
    check('首次落盘标记为新增', first.reused === false, first);
    check('hash 是 16 位十六进制', /^[0-9a-f]{16}$/.test(first.meta.hash), first.meta.hash);
    check('记录了原始字符数', first.meta.chars === doc.length, { got: first.meta.chars, want: doc.length });
    check('预览取首行', first.meta.preview.includes('架构说明'), first.meta.preview);

    const again = store.store(doc);
    check('同内容第二次落盘复用（hash 去重）', again.reused === true && again.meta.hash === first.meta.hash, again);

    const back = store.fetch(first.meta.hash);
    check('取回内容与原文一致', back === doc, back === null ? 'null' : `长度 ${back.length}`);
    check('不存在的 hash 返回 null', store.fetch('deadbeefdeadbeef') === null);
    check('has() 判定正确', store.has(first.meta.hash) && !store.has('deadbeefdeadbeef'));

    // 不同内容 → 不同 hash
    const other = store.store(`${doc}\n\n追加一句不同的话。`);
    check('不同内容得到不同 hash', other.meta.hash !== first.meta.hash, { a: first.meta.hash, b: other.meta.hash });

    check('list 按新到旧', store.list()[0]?.hash === other.meta.hash, store.list().map((m) => m.hash));
    check('占用字节数 > 0', store.usageBytes() > 0, store.usageBytes());
  }

  // ────────────────────────────────────────────────────────────
  // 2. 工件库：索引损坏 / 文件缺失时的降级
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 2) 工件库降级 ===');
  {
    const root = join(workDir, 'a2');
    const store = new ArtifactStore(root);
    const doc = 'x'.repeat(9000);
    const { meta } = store.store(doc);

    // 索引损坏：按空索引处理，不抛错
    const brokenRoot = join(workDir, 'a2b');
    const broken = new ArtifactStore(brokenRoot);
    broken.store(doc);
    writeFileSync(join(brokenRoot, 'index.json'), '{ 这不是合法 JSON', 'utf8');
    const reloaded = new ArtifactStore(brokenRoot);
    check('索引损坏时降级为空索引（不抛错）', reloaded.list().length === 0, reloaded.list());

    // 本体缺失：fetch 返回 null 而不是抛错
    const removed = join(root, `${meta.hash}.txt`);
    if (existsSync(removed)) {
      // 用 statSync + 直接覆盖为空文件模拟「文件被外部删掉」
      writeFileSync(removed, '', 'utf8');
    }
    const emptyBody = store.fetch(meta.hash);
    check('本体被清空时返回空串而非崩溃', emptyBody === '', emptyBody === null ? 'null' : `"${emptyBody}"`);
  }

  // ────────────────────────────────────────────────────────────
  // 3. 指针 Fact
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 3) 指针 Fact ===');
  {
    const base = { origin: 'user' as const, sessionId: 's1' };
    const fact = makeArtifactFact({
      hash: 'abc123def4567890',
      preview: '架构说明',
      chars: 12345,
      kindLabel: '长文档',
      ...base,
    });
    check('类别为 artifact', fact.kind === 'artifact', fact.kind);
    check('三元组齐全', fact.subject.length > 0 && fact.predicate.length > 0 && fact.value.length > 0, fact);
    check('value 是 hash', fact.value === 'abc123def4567890', fact.value);
    check('statement 含 hash 与预览', fact.statement.includes('abc123def4567890') && fact.statement.includes('架构说明'), fact.statement);
    check('scope 为 session（不跨会话召回）', fact.scope === 'session', fact.scope);
    check('通过校验闸门', validateFact(fact).ok === true, validateFact(fact));

    // 非法 hash 必须被拒
    const bad = { ...fact, value: 'not-a-hash' };
    check('非法 hash 被拒', !validateFact(bad).ok, validateFact(bad));
  }

  // ────────────────────────────────────────────────────────────
  // 4. 交接文档投影：三段
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 4) 交接文档投影 ===');
  {
    const mk = (kind: MemoryFact['kind'], statement: string, origin: 'user' | 'assistant' = 'assistant'): MemoryFact => ({
      kind,
      subject: '',
      predicate: 'p',
      value: 'v',
      statement,
      scope: 'project',
      origin,
      confidence: 0.9,
      source: { sessionId: 's1' },
      status: 'active',
    });

    const facts: MemoryFact[] = [
      mk('constraint', '不要用 IDM 下载音频', 'user'),
      mk('constraint', '缓存必须放在工作区之外'),
      mk('decision', '改用整段旁白作为唯一音轨'),
      mk('conclusion', '根因是旧进程没有随会话退出'),
      mk('location', 'Desktop 位于 D:\\Desktop', 'user'),
      mk('goal', '延迟必须压到 200ms 以内'),
      // 已撤回的不该出现
      { ...mk('constraint', '这条已撤回'), status: 'retracted' },
    ];

    const { text, sections } = projectHandoff({
      facts,
      task: '把 w4 视频重做一版',
      note: '先看音频是否对得上',
    });

    console.log(`  交接文档 ${text.length} 字符，三段条数：` +
      `事实 ${sections.confirmed.length} / 进展 ${sections.progress.length} / 下一步 ${sections.next.length}`);

    check('有「当前任务」段', text.includes('## 当前任务') && text.includes('把 w4 视频重做一版'), text.slice(0, 200));
    check('有「已确认事实」段', text.includes('## 已确认事实'));
    check('有「当前进展」段', text.includes('## 当前进展'));
    check('有「下一步意图」段', text.includes('## 下一步意图'));

    // ★2026-11-15 独立审查：同类内改为**新→旧**。
    // 原断言写的是 `confirmed[0]` 含 IDM（即数组第 1 条），那是旧→新顺序的
    // 产物。账本当 append 时代码确实如此，但现在要求「越新越靠前」——
    // 第 1 条 `不要用 IDM` 之后还有 `缓存必须放在工作区之外`，后者更新。
    check('约束排在事实段最前', sections.confirmed[0]?.startsWith('约束：') === true, sections.confirmed);
    check(
      '同类内越新越靠前',
      sections.confirmed[0]?.includes('缓存必须放在工作区之外') === true,
      sections.confirmed,
    );
    check('旧约束仍然保留（未丢失）', sections.confirmed.some((l) => l.includes('IDM')), sections.confirmed);
    check('资源位置进入进展段', sections.progress.some((l) => l.includes('D:\\Desktop')), sections.progress);
    check('目标进入下一步段', sections.next.some((l) => l.includes('200ms')), sections.next);
    check('已撤回的 Fact 不出现在任何段', !text.includes('这条已撤回'), text);
    check('结尾提示取回通道', text.includes('lrc_fetch_artifact'), text.slice(-200));
    check('补充说明被保留', text.includes('先看音频是否对得上'));
  }

  // ────────────────────────────────────────────────────────────
  // 5. 交接文档：空输入的降级
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 5) 空输入降级 ===');
  {
    const { text, sections } = projectHandoff({ facts: [], task: '' });
    check('空 Fact 不抛错', typeof text === 'string' && text.length > 0);
    check('三段都标注（无）', (text.match(/（无）/g) ?? []).length === 3, text);
    check('任务标注未记录', text.includes('（未记录）'), text.slice(0, 120));
    check('sections 三个数组都为空', sections.confirmed.length === 0 && sections.progress.length === 0 && sections.next.length === 0);
  }

  // ────────────────────────────────────────────────────────────
  // 6. 交接文档：单段条数上限（防止交接本身变成上下文炸弹）
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 6) 条数上限 ===');
  {
    const facts: MemoryFact[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'constraint' as const,
      subject: '',
      predicate: 'p',
      value: 'v',
      statement: `第 ${i} 条约束必须遵守某个规则`,
      scope: 'project' as const,
      origin: 'assistant' as const,
      confidence: 0.9,
      source: { sessionId: 's1' },
      status: 'active' as const,
    }));
    const sections = buildHandoffSections({ facts, task: 't' });
    check('单段最多 12 条', sections.confirmed.length === 12, sections.confirmed.length);
    check('整篇文档不超过 4000 字符', renderHandoff(sections).length < 4000, renderHandoff(sections).length);
  }

  // ────────────────────────────────────────────────────────────
  // 7. hash 稳定性
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 7) hash 稳定性 ===');
  {
    const a = hashContent('同样的内容');
    const b = hashContent('同样的内容');
    const c = hashContent('同样的内容 ');
    check('同内容 hash 相同', a === b, { a, b });
    check('空白差异产生不同 hash', a !== c, { a, c });
    check('hash 长度 16', a.length === 16, a.length);
  }

  // ────────────────────────────────────────────────────────────
  // 8. 配额 NaN 防护（★审查 P0 回归）
  // ────────────────────────────────────────────────────────────
  //
  // 旧 patch 不含 artifactQuotaMb ⇒ `Math.max(1, undefined) * 1024 * 1024`
  // 得到 NaN ⇒ `usage <= NaN` 恒 false ⇒ **每次落盘都清空全部工件**。
  console.log('\n=== 8) 配额 NaN 防护 ===');
  {
    const root = join(workDir, 'nan-quota');
    // 直接传 NaN：模拟 `undefined * 1024 * 1024`
    const store = new ArtifactStore(root, NaN);
    const doc = 'z'.repeat(9000);
    const { meta } = store.store(doc);
    check('NaN 配额被兜底为默认值（工件不被误删）', store.has(meta.hash), { has: store.has(meta.hash) });
    check('NaN 配额下仍能取回', store.fetch(meta.hash) === doc);

    const undef = new ArtifactStore(join(workDir, 'undef-quota'), undefined);
    const r2 = undef.store(doc);
    check('undefined 配额下工件保留', undef.has(r2.meta.hash));

    const zero = new ArtifactStore(join(workDir, 'zero-quota'), 0);
    const r3 = zero.store(doc);
    check('0 配额被兜底（不会被判成超额）', zero.has(r3.meta.hash));
  }

  // ────────────────────────────────────────────────────────────
  // 9. 工件指针必须能进快照（★审查 P1 回归）
  // ────────────────────────────────────────────────────────────
  console.log('\n=== 9) 工件指针进入快照 ===');
  {
    const art = makeArtifactFact({
      hash: 'abc123def4567890',
      preview: '架构说明',
      chars: 12345,
      kindLabel: '长文档',
      origin: 'user',
      sessionId: 's1',
    });
    const mkConstraint = (statement: string): MemoryFact => ({
      kind: 'constraint',
      subject: '',
      predicate: 'p',
      value: 'v',
      statement,
      scope: 'project',
      origin: 'assistant',
      confidence: 0.9,
      source: { sessionId: 's1' },
      status: 'active',
    });
    // 三条约束把槽位占满：工件指针必须仍能挤进快照
    const snap = buildSnapshot(
      [mkConstraint('不要用 IDM 下载'), mkConstraint('缓存必须放在工作区之外'), mkConstraint('禁止连 3099'), art],
      3,
    );
    check('3 条约束竞争下工件指针仍被注入', snap.includes('工件库'), snap);
    check('快照仍带上约束', snap.includes('IDM') || snap.includes('工作区'), snap);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
