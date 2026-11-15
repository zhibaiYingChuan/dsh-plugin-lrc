/**
 * 沉淀前**结构过滤**与沉淀不变量的端到端测试。
 *
 * 用法：node scripts/e2e-filter.ts
 *
 * ## 边界（2026-11 重构后）
 *
 * 本文件只测两件事：
 * 1. **结构过滤**：寒暄 / 代码围栏 / 正常日志 / 选项标签 / 机器输出 / 路径
 * 2. **沉淀不变量**：增量游标、查重、失败不推进游标、标签优先
 *
 * 「这句话值不值得记」的判定已迁到 `memory-schema.ts` 的三元组契约，
 * 对应测试在 `scripts/e2e-schema.ts`。两者分开，避免一改判据就要改两套。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LrcClient } from '../src/lrc-client.ts';
import { CursorStore } from '../src/cursor.ts';
import { Offloader } from '../src/offloader.ts';
import {
  extractMemoryTag,
  isDuplicate,
  isNoUpdate,
  isOptionLabel,
  isSmallTalk,
  jaccard,
  looksLikeMachineOutput,
  looksLikeNormalLog,
  maskPaths,
  stripCodeFences,
  stripMemoryTag,
} from '../src/memory-filter.ts';

/**
 * 测试内的**结构过滤组合**。
 *
 * 生产路径上「逐行结构过滤」已由 `memory-extract.ts` 的 `isStructuralNoise`
 * 承担，原 `hardFilter`（含 20 字门槛与词表豁免）随语义判定一起删除。
 * 这里只把同一批结构判据组合起来，验证它们各自的边界。
 */
function structuralFilter(text: string): string {
  const kept: string[] = [];
  for (const raw of stripCodeFences(stripMemoryTag(text)).split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (isSmallTalk(line)) continue;
    if (isOptionLabel(line)) continue;
    if (looksLikeNormalLog(line)) continue;
    if (looksLikeMachineOutput(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

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
// 1. 标签提取
// ────────────────────────────────────────────────────────────
console.log('=== 1) <lrc_memory> 标签提取 ===');
check(
  '正常标签',
  extractMemoryTag('正文\n<lrc_memory>决定用 pnpm 替代 npm</lrc_memory>') === '决定用 pnpm 替代 npm',
);
check('无标签返回 null', extractMemoryTag('普通回答，没有标签') === null);
check('未闭合返回 null', extractMemoryTag('<lrc_memory>只有开头') === null);
check('空标签返回 null', extractMemoryTag('<lrc_memory>   </lrc_memory>') === null);
check(
  '多行标签保留换行',
  extractMemoryTag('<lrc_memory>第一行\n第二行</lrc_memory>') === '第一行\n第二行',
);
check(
  'stripMemoryTag 去掉标签保留正文',
  stripMemoryTag('前文\n<lrc_memory>结论</lrc_memory>\n后文') === '前文\n\n后文',
);
// 回归：正文里行内提及标签（`` `<lrc_memory>` 层兜底 ``）不得被当成真标签。
check(
  '行内提及不干扰真标签',
  extractMemoryTag(
    '残留漏网依赖 `<lrc_memory>` 层兜底。\n<lrc_memory>\n- 决策：用 pnpm\n</lrc_memory>',
  ) === '- 决策：用 pnpm',
);
check(
  '多个标签取最后一个',
  extractMemoryTag('<lrc_memory>旧</lrc_memory>\n<lrc_memory>新</lrc_memory>') === '新',
);
check('只有行内提及、没有真标签时返回 null', extractMemoryTag('正文提到 `<lrc_memory>` 但没有真标签') === null);

// ────────────────────────────────────────────────────────────
// 2. 结构过滤
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 结构过滤 ===');
check('寒暄「你好」被丢弃', structuralFilter('你好') === '');
check('寒暄「谢谢！」被丢弃', structuralFilter('谢谢！') === '');
check('isSmallTalk 判定「好的，我来看看」', isSmallTalk('好的，我来看看') === true);
check('isSmallTalk 不误伤长正文', isSmallTalk('结论是：迁移必须分块，每块 20 条。') === false);

const normalLog = '2026-11-06T07:30:15Z [info] model listing loaded 2 model(s)';
check('正常日志被丢弃', structuralFilter(normalLog) === '');
check('looksLikeNormalLog 识别时间戳行', looksLikeNormalLog(normalLog) === true);
const errorLog = '2026-11-06T07:30:15Z [error] failed to connect to 127.0.0.1:3099';
check('报错日志保留', structuralFilter(errorLog).includes('failed to connect'));

check('选项标签 `- **A**：` 被丢弃', isOptionLabel('- **A**：把 LrcCompactionEngine 接进 index.ts') === true);
check('普通条目不被误杀', isOptionLabel('- 禁止把密钥写进代码') === false);
check('stripCodeFences 只留围栏外', stripCodeFences('a\n```ts\nconst x = 1;\n```\nb').includes('b'));

// ────────────────────────────────────────────────────────────
// 2b. 机器输出判据（结构特征，不看中文多少）
// ────────────────────────────────────────────────────────────
console.log('\n=== 2b) 机器输出判定 ===');
check('JSON 对象判为机器输出', looksLikeMachineOutput('{"结论是":"ok"}') === true);
check('JSON 数组判为机器输出', looksLikeMachineOutput('[1,2,3]') === true);
check('键值行判为机器输出', looksLikeMachineOutput('err=定位到') === true);
check('注释型约束不当机器输出', looksLikeMachineOutput('TODO: 不要用 IDM 下载') === false);
check('带中文句读的键值行是人话', looksLikeMachineOutput('pnpm: 只用 pnpm，不要用 npm。') === false);
check('盘符路径不当键名', looksLikeMachineOutput('D:\\Desktop，score.wav，这是你要打音频。') === false);
check('时间戳前缀不当数组', looksLikeMachineOutput('[2026-11-14] 必须重新构建 dist 后再提交。') === false);

// ────────────────────────────────────────────────────────────
// 2c. 路径挖空
// ────────────────────────────────────────────────────────────
console.log('\n=== 2c) 路径挖空 ===');
check('maskPaths 挖掉 URL', !maskPaths('见 https://x.test/docs/规范.md').includes('规范'));
check('maskPaths 挖掉 Windows 路径', !maskPaths('打开 G:\\proj\\端口.md').includes('端口'));
check('maskPaths 挖掉相对路径', !maskPaths('见 docs/约定.md').includes('约定'));
check(
  'maskPaths 输出与原文等长（诊断可对齐）',
  maskPaths('见 docs/规范.md').length === '见 docs/规范.md'.length,
);
check('maskPaths 不误伤正文词', maskPaths('端口 3111 是测试').includes('端口'));
// 回归：相对路径规则若用「任意非空白字符 + 斜杠」，会把 `禁止使用3099/3111`
// 整段挖成空格，真实约束直接丢失。只认 ASCII 路径段后必须保留「禁止」。
check('斜杠粘连的约束词不被整段挖掉', maskPaths('禁止使用3099/3111').includes('禁止'));

// ────────────────────────────────────────────────────────────
// 3. 本地查重
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 本地查重 ===');
check('完全相同相似度为 1', jaccard('决定用 pnpm', '决定用 pnpm') === 1);
check(
  '换措辞相似度 ≥ 0.85',
  jaccard('决定用 pnpm 替代 npm，因为依赖解析更快', '决定用 pnpm 替代 npm，依赖解析更快') >= 0.85,
);
check('完全不同相似度 < 0.85', jaccard('决定用 pnpm 替代 npm', '禁止连 3099 做测试') < 0.85);
check(
  'isDuplicate 命中复述',
  isDuplicate('决定用 pnpm 替代 npm，依赖解析更快', ['决定用 pnpm 替代 npm，因为依赖解析更快']) === true,
);
check('isDuplicate 不误杀新内容', isDuplicate('禁止连 3099 做测试', ['决定用 pnpm 替代 npm']) === false);
// 取值不同 ⇒ 不是复述（这是「用户改了主意」必须能入库的前提）
check(
  '取值不同不当重复（pnpm/npm）',
  isDuplicate('必须用 npm', ['必须用 pnpm']) === false,
);
check(
  '取值不同不当重复（端口）',
  isDuplicate('必须用 3111', ['必须用 3099']) === false,
);
check(
  '中文对立词不当重复',
  isDuplicate('必须放在工作区之内', ['必须放在工作区之外']) === false,
);

// ────────────────────────────────────────────────────────────
// 4/5. 触发场景（需要 mock LRC）
// ────────────────────────────────────────────────────────────
const memories: Array<{ content: string }> = [];
/** 让接下来 N 次 migrate 返回 500，用于验证"失败不推进游标"。 */
let failMigrate = 0;
/** 最近一次送进 migrate 的条目。 */
let lastMigrateItems: Array<{ content: string; memory_type: string }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const raw = await readBody(req);
  if (url.pathname === '/health') return send(res, 200, { status: 'running' });
  if (url.pathname === '/v1/context/migrate') {
    if (failMigrate > 0) {
      failMigrate -= 1;
      return send(res, 500, { error: 'mock_migrate_failure' });
    }
    const body = JSON.parse(raw) as { items: Array<{ content: string; memory_type: string }> };
    lastMigrateItems = body.items;
    let written = 0;
    let merged = 0;
    for (const item of body.items) {
      if (memories.some((m) => jaccard(m.content, item.content) >= 0.85)) merged += 1;
      else {
        memories.push(item);
        written += 1;
      }
    }
    return send(res, 200, { written, merged, failed: 0 });
  }
  send(res, 404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('无法获取 mock 端口');
const baseUrl = `http://127.0.0.1:${address.port}`;
const workDir = mkdtempSync(join(tmpdir(), 'lrc-filter-'));

try {
  const client = new LrcClient({ baseUrl });
  const cursors = new CursorStore(join(workDir, 'cursor.json'));

  console.log('\n=== 4) 长任务：88 步只有 1 条正文 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo', stepsThreshold: 20 });
    for (let i = 0; i < 87; i += 1) offloader.observeStep();
    check('仅步数时 hasPending 为 true（步数兜底生效）', offloader.hasPending() === true);
    check('87 步已越过步数阈值', offloader.shouldOffload() === true);

    const report = [
      '# 项目审查报告',
      '结论是：工程质量高于同类项目，短板在工程治理。',
      '约束：禁止在未确认语义前修改 index.ts。',
      '```ts',
      'const noise = 1;',
      '```',
    ].join('\n');
    offloader.observe(report);
    offloader.observeStep();
    check('最终报告到达后有待沉淀内容', offloader.hasPending() === true);

    const result = await offloader.offload('session-long', [report]);
    check('长任务能产出沉淀', result !== null && result.distilled > 0, result);
  }

  console.log('\n=== 5) turn/end 兜底：阈值未到但有待沉淀内容 ===');
  const shared = new Offloader(client, cursors, { project: 'demo' });
  {
    shared.observe('结论是：端口纪律 3099 正式、3111 测试。');
    check('单条正文未达阈值', shared.shouldOffload() === false);
    check('但存在待沉淀内容', shared.hasPending() === true);
    const result = await shared.offload('session-turn', ['结论是：端口纪律 3099 正式、3111 测试。']);
    check('turn/end 兜底能产出', result !== null && result.distilled > 0, result);
  }

  console.log('\n=== 6) 本地查重：复述不发 HTTP ===');
  {
    const before = memories.length;
    const result = await shared.offload('session-dup', ['结论是：端口纪律 3099 正式、3111 测试。']);
    check('复述被本地查重拦下', result !== null && result.deduped > 0, result);
    check('库内未增长', memories.length === before, { before, after: memories.length });
  }

  console.log('\n=== 7) 失败不推进游标，下次可重试 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    // 必须是**含谓词的完整陈述**：schema 之后「约束：…」这种人工前缀不再是
    // 语义载体，拆不出三元组就根本不会发 migrate，那这段测试也就测不到失败路径。
    const lines = ['端口纪律必须遵循 3099 正式、3111 测试的约定。'];
    failMigrate = 1;
    let threw = false;
    try {
      await offloader.offload('session-fail', lines);
    } catch {
      threw = true;
    }
    check('migrate 失败会抛错（由 index.ts 捕获）', threw === true);
    const state = cursors.get('session-fail');
    check('失败后游标未推进', state === null || state.lastLine === 0, state);

    const retry = await offloader.offload('session-fail', lines);
    check('失败后可重试同一段', retry !== null && retry.distilled > 0, retry);
  }

  console.log('\n=== 8) 围栏代码在沉淀路径上被过滤 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const message = [
      '决定：围栏外的一句话，说明为什么这样做。',
      '```ts',
      'const internalSecret = "SHOULD_NOT_LEAK";',
      '```',
    ].join('\n');
    lastMigrateItems = [];
    await offloader.offload('session-fence', [message]);
    const dumped = JSON.stringify(lastMigrateItems);
    check('围栏内代码未泄漏', !dumped.includes('SHOULD_NOT_LEAK'), dumped);
    check('围栏外正文保留', dumped.includes('围栏外的一句话'), dumped);
  }

  console.log('\n=== 9) 多消息各自带标签时都能提取 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const messages = [
      '第一轮回答\n<lrc_memory>决策：改用 pnpm 替代 npm</lrc_memory>',
      '第二轮回答\n<lrc_memory>约束：禁止连 3099 做测试</lrc_memory>',
    ];
    lastMigrateItems = [];
    await offloader.offload('session-multi', messages);
    const joined = lastMigrateItems.map((i) => i.content).join('\n');
    check('第一条标签被提取', joined.includes('改用 pnpm 替代 npm'), joined);
    check('第二条标签被提取', joined.includes('禁止连 3099 做测试'), joined);
  }

  console.log('\n=== 10) 标签路径与正文路径共用同一 schema ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const message = [
      '本轮结论如下',
      '<lrc_memory>',
      '- 决策：改用 pnpm 替代 npm，因为依赖解析更快',
      '- 约束：禁止连 3099 做测试，一律用 3111',
      '- 结论：端口纪律 3099 正式、3111 测试',
      '</lrc_memory>',
    ].join('\n');
    lastMigrateItems = [];
    await offloader.offload('session-tag', [message]);
    check('决策条目被保留', lastMigrateItems.some((i) => i.content.includes('改用 pnpm')), lastMigrateItems);
    check('约束条目被保留', lastMigrateItems.some((i) => i.content.includes('禁止连 3099')), lastMigrateItems);
    check(
      '决策条目类型正确',
      lastMigrateItems.some((i) => i.content.includes('改用 pnpm') && i.memory_type === 'decision'),
      lastMigrateItems,
    );
    check(
      '每条都带类别前缀（无裸原文条目）',
      lastMigrateItems.every((i) => /^\[(约束|决策|结论|事实)\]/.test(i.content)),
      lastMigrateItems.map((i) => i.content),
    );
  }

  console.log('\n=== 11) 残句不得入库（schema 闸门） ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const message = ['那我得确认两件事：git 的状态，以及 DSH 能不能起来。', '这必须用上。'].join('\n');
    lastMigrateItems = [];
    const result = await offloader.offload('session-residue', [message]);
    check('残句全部被拒', lastMigrateItems.length === 0, lastMigrateItems.map((i) => i.content));
    check('本次 distilled 为 0', result !== null && result.distilled === 0, result);
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
