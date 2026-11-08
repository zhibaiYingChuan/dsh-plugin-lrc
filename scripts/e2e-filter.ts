/**
 * 沉淀前过滤的端到端测试。
 *
 * 用法：node scripts/e2e-filter.ts
 *
 * 覆盖三层过滤 + 长任务触发场景：
 *   1. `<lrc_memory>` 标签提取（宿主 LLM 提炼）
 *   2. 硬规则过滤（寒暄 / 代码围栏 / 正常日志 / 过短行）
 *   3. 本地 Jaccard 查重
 *   4. 长任务：88 步只有 1 条正文时仍能触发
 *   5. turn/end 兜底：阈值未到但有待沉淀内容
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LrcClient } from '../src/lrc-client.ts';
import { CursorStore } from '../src/cursor.ts';
import { itemsFromTag, Offloader } from '../src/offloader.ts';
import {
  conclusionsFromReasoning,
  explainKeywordHit,
  extractMemoryTag,
  hardFilter,
  hasConstraintMarker,
  isDuplicate,
  isNoUpdate,
  isOptionLabel,
  isSmallTalk,
  jaccard,
  looksLikeNormalLog,
  maskPaths,
  stripCodeFences,
  stripMemoryTag,
} from '../src/memory-filter.ts';
import { hasUserConstraint } from '../src/session-text.ts';

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
// 修复前会把整段报告正文当成标签内容切碎入库，产出 `[结论] <lrc_memory>`、
// `[结论] ## 验证` 这类碎片。
check(
  '行内提及不干扰真标签',
  extractMemoryTag(
    '残留漏网依赖 `<lrc_memory>` 层兜底。\n<lrc_memory>\n- 决策：用 pnpm\n</lrc_memory>',
  ) === '- 决策：用 pnpm',
);
check(
  '标签体内的行内提及不影响提取',
  extractMemoryTag(
    '<lrc_memory>\n- 约束：依赖 `<lrc_memory>` 层兜底\n- 结论：已修复\n</lrc_memory>',
  ) === '- 约束：依赖 `<lrc_memory>` 层兜底\n- 结论：已修复',
);
check(
  '多个标签取最后一个',
  extractMemoryTag('<lrc_memory>旧</lrc_memory>\n<lrc_memory>新</lrc_memory>') === '新',
);
check(
  '只有行内提及、没有真标签时返回 null',
  extractMemoryTag('正文提到 `<lrc_memory>` 但没有真标签') === null,
);

// ────────────────────────────────────────────────────────────
// 2. 硬规则过滤
// ────────────────────────────────────────────────────────────
console.log('\n=== 2) 硬规则过滤 ===');
check('寒暄「你好」被丢弃', hardFilter('你好') === '');
check('寒暄「谢谢！」被丢弃', hardFilter('谢谢！') === '');
check('isSmallTalk 判定「好的，我来看看」', isSmallTalk('好的，我来看看') === true);
check('isSmallTalk 不误伤长正文', isSmallTalk('结论是：迁移必须分块，每块 20 条。') === false);

const fenced = [
  '说明文字：下面是一段实现，用来验证围栏剥离逻辑',
  '```ts',
  'const a = 1;',
  'const b = 2;',
  '```',
  '结束说明：围栏外的正文应当保留下来',
].join('\n');
check('代码围栏被剥离', !hardFilter(fenced).includes('const a = 1'));
check('围栏外说明保留', hardFilter(fenced).includes('说明文字：下面是一段实现'));
check('stripCodeFences 只留围栏外', stripCodeFences(fenced).includes('结束说明'));

const normalLog = '2026-11-06T07:30:15Z [info] model listing loaded 2 model(s)';
check('正常日志被丢弃', hardFilter(normalLog) === '');
check('looksLikeNormalLog 识别时间戳行', looksLikeNormalLog(normalLog) === true);
const errorLog = '2026-11-06T07:30:15Z [error] failed to connect to 127.0.0.1:3099';
check('报错日志保留', hardFilter(errorLog).includes('failed to connect'));

check('过短且无关键词的行被丢弃', hardFilter('嗯嗯') === '');
check('过短但含关键词的行保留', hardFilter('禁止用 npm') === '禁止用 npm');
check(
  '长正文保留',
  hardFilter('结论是：数据库最终确认选 PostgreSQL，因此需要事务支持') !== '',
);

check(
  '有标签时优先返回标签内容',
  hardFilter('一大段过程说明\n<lrc_memory>决定用 pnpm</lrc_memory>') === '决定用 pnpm',
);
check('标签写「无新增」时返回空', hardFilter('<lrc_memory>无新增</lrc_memory>') === '');
check(
  '标签内的代码围栏也被剥离',
  !hardFilter('<lrc_memory>决策：用 pnpm\n```ts\nconst x = 1;\n```</lrc_memory>').includes('const x = 1'),
);
check('isNoUpdate 识别「无新增。」', isNoUpdate('无新增。') === true);
check('isNoUpdate 不误判正文', isNoUpdate('决定用 pnpm') === false);

check('选项标签 `- **A**：` 被丢弃', isOptionLabel('- **A**：把 LrcCompactionEngine 接进 index.ts') === true);
check(
  '选项标签不进沉淀',
  hardFilter('- **C**：什么都不改，我把宿主重启后的加载日志再核一遍') === '',
);
check('普通条目不被误杀', isOptionLabel('- 禁止把密钥写进代码') === false);

// ────────────────────────────────────────────────────────────
// 2b. 词表命中路径：路径里的词不算正文关键词
// ────────────────────────────────────────────────────────────
console.log('\n=== 2b) 词表命中路径 ===');

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
check(
  '斜杠粘连的约束词不被整段挖掉',
  maskPaths('禁止使用3099/3111').includes('禁止'),
  maskPaths('禁止使用3099/3111'),
);
check('斜杠粘连的约束仍过门槛', hasUserConstraint('禁止使用3099/3111') === true);
check('斜杠粘连的约束仍进硬过滤', hardFilter('禁止使用3099/3111') === '禁止使用3099/3111');
check(
  '路径命中标记为 path 来源',
  explainKeywordHit('docs/规范.md')?.source === 'path',
  explainKeywordHit('docs/规范.md'),
);
check(
  '正文命中标记为 body 来源',
  explainKeywordHit('统一用 pnpm')?.source === 'body',
  explainKeywordHit('统一用 pnpm'),
);

const pathOnlyLines = [
  '见 docs/规范.md',
  'materials/架构图.png',
  '打开 G:\\proj\\端口.md',
  'docs/约定.md',
  '见 https://x.test/架构/端口.md',
  '见 C:\\Users\\Administrator\\Documents\\deepseek-harness\\docs\\规范.md 这个文件',
];
for (const line of pathOnlyLines) {
  const hit = explainKeywordHit(line);
  check(`纯路径行不收：${line}`, hardFilter(line) === '', { hit });
}

check('真实短约束不被路径规则误杀', hardFilter('禁止用 npm') === '禁止用 npm');
check('「统一用 pnpm」保留', hardFilter('统一用 pnpm') === '统一用 pnpm');
check('「端口 3111 是测试」保留', hardFilter('端口 3111 是测试') === '端口 3111 是测试');
check('英文短约束保留', hardFilter('Never touch 3099') === 'Never touch 3099');
check(
  '正常日志里的 error.log 不算报错',
  hardFilter('2026-11-06T07:30:15Z [info] 轮转 error.log 完成') === '',
);
check(
  '标签条目分类也不看路径里的词',
  itemsFromTag('看下 docs/禁止.md').every((item) => item.memory_type === 'fact'),
  itemsFromTag('看下 docs/禁止.md'),
);

// 回归：AI 把「接下来我要…」写成 `- 结论：…` 时，必须降级为事实，
// 否则结论计数虚高（实测约 10%）。
{
  const narration = itemsFromTag('- 结论：接下来我要确认工具参数和推理内容究竟存放在哪里');
  check(
    '过程叙述冒充结论 → 降级为事实',
    narration.length === 1 &&
      narration[0].content.startsWith('[事实]') &&
      narration[0].memory_type === 'fact',
    narration,
  );
  const completed = itemsFromTag('- 结论：已完成迁移，因此必须分块');
  check(
    '含完成时态词不降级',
    completed.length === 1 && completed[0].content.startsWith('[结论]'),
    completed,
  );
  const mixed = itemsFromTag('- 结论：接下来我要验证，已验证通过');
  check(
    '过程词 + 完成词同时出现不降级',
    mixed.length === 1 && mixed[0].content.startsWith('[结论]'),
    mixed,
  );
}

// ────────────────────────────────────────────────────────────
// 2c. 用户消息门槛：路径不骗人，真约束不漏
// ────────────────────────────────────────────────────────────
console.log('\n=== 2c) 用户消息门槛 ===');
check('路径里的「禁止」不通过门槛', hasUserConstraint('帮我排版 docs/禁止事项.md') === false);
check('无约束的任务描述仍被挡', hasUserConstraint('根据这个文档中的视觉配色') === false);
check('门槛与硬过滤共用同一份约束词表', hasUserConstraint('统一用 3111') === hasConstraintMarker('统一用 3111'));

const realConstraints = [
  '必须用 3099',
  '禁止连 3099',
  '不要改配置文件',
  '以后都用 pnpm，别用 npm',
  '统一用 3111 跑测试',
  '只允许 3111 端口',
  '默认 3111，别再连 3099',
  '务必先跑测试',
  'never use 3099',
  'must use 3111',
  "don't touch 3099",
  'always use 3111',
];
for (const text of realConstraints) {
  check(`真约束通过门槛：${text}`, hasUserConstraint(text) === true);
}

// ────────────────────────────────────────────────────────────
// 3. 本地查重
// ────────────────────────────────────────────────────────────
console.log('\n=== 3) 本地 Jaccard 查重 ===');
check('完全相同相似度为 1', jaccard('决定用 pnpm', '决定用 pnpm') === 1);
check(
  '换措辞相似度 ≥ 0.85',
  jaccard('决定用 pnpm 替代 npm，因为依赖解析更快', '决定用 pnpm 替代 npm，依赖解析更快') >= 0.85,
);
check(
  '完全不同相似度 < 0.85',
  jaccard('决定用 pnpm 替代 npm', '禁止连 3099 做测试') < 0.85,
);
check(
  'isDuplicate 命中复述',
  isDuplicate('决定用 pnpm 替代 npm，依赖解析更快', ['决定用 pnpm 替代 npm，因为依赖解析更快']) === true,
);
check('isDuplicate 不误杀新内容', isDuplicate('禁止连 3099 做测试', ['决定用 pnpm 替代 npm']) === false);

// ────────────────────────────────────────────────────────────
// 4/5. 触发场景（需要 mock LRC）
// ────────────────────────────────────────────────────────────
const memories: Array<{ content: string }> = [];
const calls: Array<{ path: string; chars: number }> = [];
/** 让接下来 N 次 distill 返回 500，用于验证"失败不推进游标"。 */
let failDistill = 0;
/** 最近一次送进 distill 的原文，用于验证围栏代码没有泄漏。 */
let lastDistillText = '';
/** 最近一次送进 migrate 的条目，用于验证标签内容绕过了 distill。 */
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
  if (url.pathname === '/v1/context/distill') {
    if (failDistill > 0) {
      failDistill -= 1;
      return send(res, 500, { error: 'mock_failure' });
    }
    const body = JSON.parse(raw) as { text: string };
    lastDistillText = body.text;
    calls.push({ path: 'distill', chars: body.text.length });
    const items = body.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 6)
      .map((l, i) => ({
        content: `[结论] ${l}`,
        memory_type: 'fact',
        tags: ['conclusion', 'distilled'],
        importance: 6,
        source_turns: [i, i] as [number, number],
      }));
    return send(res, 200, { items, count: items.length, index_line: `提炼 ${items.length} 条` });
  }
  if (url.pathname === '/v1/context/migrate') {
    const body = JSON.parse(raw) as { items: Array<{ content: string; memory_type: string }> };
    lastMigrateItems = body.items;
    calls.push({ path: 'migrate', chars: body.items.length });
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
    // 87 步纯工具调用：没有正文，observe 不会被调用
    for (let i = 0; i < 87; i += 1) offloader.observeStep();
    check('仅步数时 hasPending 为 true（步数兜底生效）', offloader.hasPending() === true);
    check('87 步已越过步数阈值', offloader.shouldOffload() === true);

    // 第 88 步：最终报告
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

    const lines = [report];
    const result = await offloader.offload('session-long', lines);
    check('长任务能产出沉淀', result !== null && result.distilled > 0, result);
    check('代码围栏未进入 distill', !calls.some((c) => c.path === 'distill' && c.chars > 2000));
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
    // 同一个 Offloader 实例（生产里也是单例），换会话再送同一句
    const before = calls.filter((c) => c.path === 'distill').length;
    const lines = ['结论是：端口纪律 3099 正式、3111 测试。'];
    const result = await shared.offload('session-dup', lines);
    const after = calls.filter((c) => c.path === 'distill').length;
    check('复述被本地查重拦下', result !== null && result.deduped > 0, result);
    check('未发出 distill 请求', after === before, { before, after });
  }

  console.log('\n=== 7) 失败不推进游标，下次可重试 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const lines = ['结论是：失败重试测试，端口纪律 3099 正式、3111 测试。'];
    failDistill = 1;
    let threw = false;
    try {
      await offloader.offload('session-fail', lines);
    } catch {
      threw = true;
    }
    check('distill 失败会抛错（由 index.ts 捕获）', threw === true);
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
    lastDistillText = '';
    await offloader.offload('session-fence', [message]);
    check('围栏内代码未泄漏', !lastDistillText.includes('SHOULD_NOT_LEAK'), lastDistillText);
    check('围栏外正文保留', lastDistillText.includes('围栏外的一句话'), lastDistillText);
  }

  console.log('\n=== 9) 多消息各自带标签时都能提取 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    const messages = [
      '第一轮回答\n<lrc_memory>决策：用 pnpm 替代 npm</lrc_memory>',
      '第二轮回答\n<lrc_memory>约束：禁止连 3099 做测试</lrc_memory>',
    ];
    lastMigrateItems = [];
    await offloader.offload('session-multi', messages);
    const joined = lastMigrateItems.map((i) => i.content).join('\n');
    check('第一条标签被提取', joined.includes('用 pnpm 替代 npm'), joined);
    check('第二条标签被提取', joined.includes('禁止连 3099 做测试'), joined);
  }

  console.log('\n=== 10) 标签内容绕过 distill，不被二次过滤 ===');
  {
    const offloader = new Offloader(client, cursors, { project: 'demo' });
    // `- 决策：…` 送进 distill 会被丢掉（DECISION_WORDS 里没有「决策」）
    const message = [
      '本轮结论如下',
      '<lrc_memory>',
      '- 决策：用 pnpm 替代 npm，因为依赖解析更快',
      '- 约束：禁止连 3099 做测试，测试一律用 3111',
      '- 结论：itemsFromTag 按行分类，约束→preference、决策→decision',
      '</lrc_memory>',
    ].join('\n');
    lastMigrateItems = [];
    lastDistillText = '';
    await offloader.offload('session-tag', [message]);
    check('标签内容未送进 distill', lastDistillText === '', lastDistillText);
    check('决策条目被保留', lastMigrateItems.some((i) => i.content.includes('用 pnpm 替代 npm')), lastMigrateItems);
    check('约束条目被保留', lastMigrateItems.some((i) => i.content.includes('禁止连 3099')), lastMigrateItems);
    check(
      '决策条目类型正确',
      lastMigrateItems.some((i) => i.content.includes('用 pnpm') && i.memory_type === 'decision'),
      lastMigrateItems,
    );
    check(
      '行首「结论：」不被正文关键词劫持',
      lastMigrateItems.some((i) => i.content.includes('itemsFromTag 按行分类') && i.memory_type === 'fact'),
      lastMigrateItems,
    );
  }
  console.log('\n=== 11) 推理结论兜底：只抽带结论标记的句子 ===');
  {
    const reasoning = [
      '我先看看这个文件的结构，然后从入口开始读。',
      '结论：路径 1 必须走 serviceFor 拿引擎，不能直接 ctx.get。',
      '这里有个细节，config 是 deepFreeze 的。',
      '因此改用 compactRegion 自选范围。',
      '```ts',
      'const noise = 1;',
      '```',
      '好的',
    ].join('\n');
    const picked = conclusionsFromReasoning(reasoning);
    const joined = picked.join('\n');
    check('抽到带「结论」的句子', joined.includes('serviceFor 拿引擎'), picked);
    check('抽到带「因此」的句子', joined.includes('compactRegion 自选范围'), picked);
    check('丢弃无标记的过程句', !joined.includes('先看看这个文件的结构'), picked);
    check('丢弃寒暄', !joined.includes('好的'), picked);
    check('丢弃代码围栏', !joined.includes('const noise'), picked);
    check('条数受上限约束', conclusionsFromReasoning(reasoning, 1).length === 1);
    check('空输入返回空数组', conclusionsFromReasoning('').length === 0);

    // 英文推理：只认中文标记会把整轮内容漏掉
    const english = conclusionsFromReasoning(
      'We should use ctx.get instead of direct property access. ' +
        'The root cause is the inject check. ' +
        'Random chatter without any marker here. ' +
        'Therefore the fix is safe.',
    );
    const englishJoined = english.join('\n');
    check('英文结论句被抽取', englishJoined.includes('ctx.get'), english);
    check('英文根因句被抽取', englishJoined.includes('root cause'), english);
    check('英文 therefore 句被抽取', englishJoined.includes('the fix is safe'), english);
    check('无标记英文句被丢弃', !englishJoined.includes('Random chatter'), english);
    check('版本号不被句号切开', conclusionsFromReasoning('The version is v0.10.0 and it must stay.').length === 1);
    // 弱标记 + 过程叙述：不能当结论（实测这类句子把快照灌成噪声）
    check(
      '英文过程叙述被丢弃',
      conclusionsFromReasoning('I should check the file first before editing.').length === 0,
    );
    check(
      '英文强标记仍保留',
      conclusionsFromReasoning('Therefore the fix is safe.').length === 1,
    );
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
