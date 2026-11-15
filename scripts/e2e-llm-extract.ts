/**
 * LLM 兜底提取的单元测试。
 *
 * 用法：node scripts/e2e-llm-extract.ts
 *
 * 为什么必须单独成一套：这是**唯一会额外产生模型请求**的路径。
 * 抽对了只是省一点钱，抽错了会污染长期记忆（`recall` 会把噪声当约束反复召回）。
 * 同时它必须做到「任何异常都不影响主对话」—— 这一条的代价最高。
 */
import { extractWithLlm, shouldFallbackToLlm } from '../src/llm-extract.ts';
import { extractFacts, factsFromLlmLines } from '../src/memory-extract.ts';
import { factsToItems } from '../src/memory-schema.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/** 造一个假的会话：只需要 `requestHeader()` 与 `id`。 */
function fakeSession(provider = 'deepseek', model = 'deepseek-chat'): unknown {
  return {
    id: 'session-test',
    requestHeader: () => ({ config: { provider, model } }),
  };
}

/**
 * 造一个假的 ctx + llm 服务。
 *
 * `reply` 可以是字符串（模拟模型输出）或函数（模拟抛错/流式异常）。
 */
function fakeCtx(
  reply: string | (() => string),
  onOptions?: (options: unknown) => void,
): { ctx: unknown; calls: () => number } {
  let calls = 0;
  const llm = {
    stream: (options: unknown) => {
      calls += 1;
      onOptions?.(options);
      const text = typeof reply === 'function' ? reply() : reply;
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  return { ctx: { get: (name: string) => (name === 'llm' ? llm : undefined) }, calls: () => calls };
}

// ── 1) 规则落空时兜底能补上，且分类正确 ──
console.log('=== 1) 兜底补上规则漏掉的形态 ===');
{
  // 这几条是规则层**确实抽不到**的（拆不出「谓词 + 取值」三元组）
  const missed = [
    '这件事的来龙去脉是这样：旧进程没退出，新连接全被它挡住了。',
    '修完之后端口就通了，之前一直卡在握手阶段。',
  ];
  for (const m of missed) {
    const facts = extractFacts({ text: m, origin: 'assistant', sessionId: 's1' }).facts;
    check(`规则确实抽不到「${m.slice(0, 16)}…」`, facts.length === 0, facts.map((f) => f.statement));
  }

  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [
        { kind: 'conclusion', text: '旧进程未退出，导致新连接被阻断在握手阶段' },
        { kind: 'goal', text: '端口连通后握手耗时不超过 200ms' },
      ],
    }),
  );
  const lines = await extractWithLlm(ctx, fakeSession(), missed.join('\n'));
  console.log(`  兜底抽到: ${JSON.stringify(lines)}`);
  check('兜底抽到 2 条', lines.length === 2, lines);
  check('每条都带中文类别前缀', lines.every((l) => /^(约束|决策|结论|事实)：/.test(l)), lines);
  check('goal 归约束', lines.some((l) => l.startsWith('约束：') && l.includes('200ms')), lines);
}

// ── 2) 兜底结果接入 schema 后类别正确 ──
console.log('=== 2) 兜底结果能直接入库 ===');
{
  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [
        { kind: 'constraint', text: '缓存必须放在工作区之外' },
        { kind: 'decision', text: '改用 --stdin 传入 JSON' },
        { kind: 'conclusion', text: '根因是旧进程未退出' },
      ],
    }),
  );
  const lines = await extractWithLlm(ctx, fakeSession(), 'x'.repeat(120));
  // LLM 只产候选；入库判定统一由 schema 裁决
  const extracted = factsFromLlmLines(lines, { origin: 'assistant', sessionId: 's1' });
  const items = factsToItems(extracted.facts);
  check('入库 3 条', items.length === 3, items);
  check('约束类型正确', items[0]?.memory_type === 'preference', items[0]);
  check('决策类型正确', items[1]?.memory_type === 'decision', items[1]);
  check('结论类型正确', items[2]?.memory_type === 'fact', items[2]);
}

// ── 2b) statement 类必须能被 LLM 兜底产出并入库 ──
//
// ★2026-11-14 新发现的缺口：`statement`（陈述类）是规则层为解决
// 「定义句整类漏抽」而新增的类别，但 LLM 兜底的提示词与 `KIND_PREFIX`
// 里都只有五类，模型永远无法输出它 —— 开启兜底也补不上定义句。
console.log('=== 2b) statement 类贯通 LLM 兜底 ===');
{
  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [
        { kind: 'statement', text: 'awesome-code-animation 是一个代码动效聚合仓库' },
        { kind: 'statement', text: '这个仓库收录了 443 个项目' },
      ],
    }),
  );
  const lines = await extractWithLlm(ctx, fakeSession(), 'm'.repeat(120));
  console.log(`  兜底抽到: ${JSON.stringify(lines)}`);
  check('statement 映射为「事实：」前缀', lines.every((l) => l.startsWith('事实：')), lines);

  const extracted = factsFromLlmLines(lines, { origin: 'assistant', sessionId: 's1' });
  console.log(`  入库: ${JSON.stringify(extracted.facts.map((f) => [f.kind, f.statement]))}`);
  check('两条都通过 schema', extracted.facts.length === 2, extracted.rejected);
  check('类别是 statement', extracted.facts.every((f) => f.kind === 'statement'), extracted.facts.map((f) => f.kind));

  // 提示词里必须声明这一类，否则模型不会输出
  let seenSystem = '';
  const probe = fakeCtx('{"items":[]}', (options) => {
    seenSystem = String((options as { system?: unknown }).system ?? '');
  });
  await extractWithLlm(probe.ctx, fakeSession(), 'n'.repeat(120));
  check('提示词声明了 statement 类别', seenSystem.includes('statement'), seenSystem.slice(0, 120));
}

// ── 3) 各类失败必须静默返回空数组，绝不抛错 ──
console.log('=== 3) 失败静默 ===');
{
  // 3a. 模型输出不是 JSON
  {
    const { ctx, calls } = fakeCtx('我不知道你在说什么。');
    const lines = await extractWithLlm(ctx, fakeSession(), 'y'.repeat(120));
    check('非 JSON 返回空数组', lines.length === 0, lines);
    check('确实发起过调用', calls() === 1, calls());
  }
  // 3b. 模型输出空 items
  {
    const { ctx } = fakeCtx('{"items":[]}');
    check('空 items 返回空数组', (await extractWithLlm(ctx, fakeSession(), 'z'.repeat(120))).length === 0);
  }
  // 3c. 流抛错
  {
    const { ctx } = fakeCtx(() => {
      throw new Error('provider exploded');
    });
    let threw = false;
    let lines: string[] = [];
    try {
      lines = await extractWithLlm(ctx, fakeSession(), 'a'.repeat(120));
    } catch {
      threw = true;
    }
    check('流异常不抛错', !threw);
    check('流异常返回空数组', lines.length === 0, lines);
  }
  // 3d. 无 llm 服务
  {
    const ctx = { get: () => undefined };
    const lines = await extractWithLlm(ctx, fakeSession(), 'b'.repeat(120));
    check('无 llm 服务返回空数组', lines.length === 0, lines);
  }
  // 3e. 会话没有路由信息
  {
    const { ctx } = fakeCtx('{"items":[]}');
    const noRoute = { id: 's', requestHeader: () => ({ config: {} }) };
    check('无路由返回空数组', (await extractWithLlm(ctx, noRoute, 'c'.repeat(120))).length === 0);
  }
  // 3f. 空正文
  {
    const { ctx, calls } = fakeCtx('{"items":[]}');
    check('空正文返回空数组', (await extractWithLlm(ctx, fakeSession(), '   ')).length === 0);
    check('空正文不发起调用', calls() === 0, calls());
  }
}

// ── 4) 围栏与前后缀干扰下的 JSON 解析 ──
console.log('=== 4) 输出容错 ===');
{
  const cases: Array<[string, string]> = [
    ['带 json 围栏', '```json\n{"items":[{"kind":"constraint","text":"禁止直接改线上库"}]}\n```'],
    ['围栏无语言标记', '```\n{"items":[{"kind":"constraint","text":"禁止直接改线上库"}]}\n```'],
    ['前后带解释', '好的，结果如下：\n{"items":[{"kind":"constraint","text":"禁止直接改线上库"}]}\n以上。'],
  ];
  for (const [name, reply] of cases) {
    const { ctx } = fakeCtx(reply);
    const lines = await extractWithLlm(ctx, fakeSession(), 'd'.repeat(120));
    check(`${name}能解析`, lines.length === 1 && lines[0] === '约束：禁止直接改线上库', lines);
  }
}

// ── 5) 脏数据过滤 ──
console.log('=== 5) 脏数据过滤 ===');
{
  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [
        { kind: 'constraint', text: '好' }, // 太短
        { kind: 'constraint', text: '正常长度的约束内容' },
        { kind: 'constraint', text: 'x'.repeat(600) }, // 太长
        { kind: 'unknown_kind', text: '未知类别也要保住内容' }, // 未知类别
        { text: '缺 kind 字段' }, // 缺字段
        { kind: 'constraint', text: '正常长度的约束内容' }, // 重复
      ],
    }),
  );
  const lines = await extractWithLlm(ctx, fakeSession(), 'e'.repeat(120));
  console.log(`  过滤后: ${JSON.stringify(lines)}`);
  check('过短的被丢弃', !lines.some((l) => l === '约束：好'), lines);
  check('过长的被丢弃', !lines.some((l) => l.length > 520), lines);
  check('未知类别保内容', lines.some((l) => l.includes('未知类别也要保住内容')), lines);
  check('缺 kind 保内容', lines.some((l) => l.includes('缺 kind 字段')), lines);
  check('重复只留一条', lines.filter((l) => l.includes('正常长度的约束内容')).length === 1, lines);
}

// ── 6) 输入超长时截取尾部 ──
console.log('=== 6) 超长输入取尾部 ===');
{
  let seenInput = '';
  const { ctx } = fakeCtx('{"items":[]}', (options) => {
    const opts = options as { messages?: Array<{ content?: Array<{ text?: string }> }> };
    seenInput = opts.messages?.[0]?.content?.[0]?.text ?? '';
  });
  // 头部用唯一前缀标记，尾部用可辨识的后缀 —— 这样才验得出「截掉的是头」
  const head = `HEAD_MARKER_${'X'.repeat(1000)}`;
  const tail = 'TAIL_MARKER_END';
  await extractWithLlm(ctx, fakeSession(), head + tail, { maxInputChars: 200 });
  check('截断后长度受限', seenInput.length <= 200, seenInput.length);
  check('保留的是尾部', seenInput.endsWith(tail), seenInput.slice(-40));
  check('头部已被丢弃', !seenInput.includes('HEAD_MARKER'), seenInput.slice(0, 40));
}

// ── 7) 传给宿主的请求参数正确 ──
console.log('=== 7) 请求参数 ===');
{
  let seen: Record<string, unknown> = {};
  const { ctx } = fakeCtx('{"items":[]}', (options) => {
    seen = options as Record<string, unknown>;
  });
  await extractWithLlm(ctx, fakeSession('myprovider', 'mymodel'), 'f'.repeat(120));
  check('provider 来自会话路由', seen.provider === 'myprovider', seen.provider);
  check('model 来自会话路由', seen.model === 'mymodel', seen.model);
  check('temperature 为 0（要确定性）', seen.temperature === 0, seen.temperature);
  check('有 system 提示', typeof seen.system === 'string' && (seen.system as string).length > 50, seen.system);
  check('有 maxTokens 上限', typeof seen.maxTokens === 'number' && (seen.maxTokens as number) <= 1500, seen.maxTokens);
  check('带 signal 用于超时', seen.signal instanceof AbortSignal, String(seen.signal));
  check('传了 sessionId', seen.sessionId === 'session-test', seen.sessionId);
}

// ── 8) 触发闸门：密度判据 ──
//
// ★端到端实测暴露的漏洞：首版「规则抽到 0 条才兜底」会漏，
// 因为规则抽到 1 条不代表抽全了。
console.log('=== 8) 触发闸门（类型缺口 + 密度）===');
/** §8~§11 共用的基准入参（全部条件默认满足）。 */
const base = {
  text: 'x'.repeat(1000),
  extracted: [] as string[],
  enabled: true,
  minChars: 120,
  maxCalls: 40,
  usedCalls: 0,
  minIntervalMs: 0,
  sinceLastMs: Number.MAX_SAFE_INTEGER,
};
{
  check('全部满足时触发', shouldFallbackToLlm(base));
  check('开关关闭不触发', !shouldFallbackToLlm({ ...base, enabled: false }));
  check('正文过短不触发', !shouldFallbackToLlm({ ...base, text: 'x'.repeat(20) }));
  check('额度用尽不触发', !shouldFallbackToLlm({ ...base, usedCalls: 40 }));
  check('间隔不足不触发', !shouldFallbackToLlm({ ...base, minIntervalMs: 30000, sinceLastMs: 1000 }));
  check('额度为 0 表示不限制', shouldFallbackToLlm({ ...base, maxCalls: 0, usedCalls: 9999 }));

  // 密度：1200 字期望 1 条（正文无归因/决策/目标信号，只走密度判据）
  const plain = '这是一段没有信号词的普通叙述内容。'.repeat(50); // 约 950 字
  check(
    '无信号词 + 950 字抽出 0 条 → 触发（长正文什么都没抽到）',
    shouldFallbackToLlm({ ...base, text: plain, extracted: [] }),
  );
  check(
    '无信号词 + 950 字抽出 1 条 → 不触发（期望 1，已达标）',
    !shouldFallbackToLlm({ ...base, text: plain, extracted: ['约束：某条约束内容'] }),
  );
  const longPlain = '这是一段没有信号词的普通叙述内容。'.repeat(100); // 约 1900 字
  check(
    '无信号词 + 1900 字抽出 1 条 → 触发（期望 2）',
    shouldFallbackToLlm({ ...base, text: longPlain, extracted: ['约束：某条约束内容'] }),
  );

  // ★类型缺口：含归因词但没抽出结论 → 触发（不受长度门槛影响）
  const attribution = '排查之后定位到问题出在旧进程没有随会话退出，所以新连接全被挡住了。';
  check('含归因词 + 没抽出结论 → 触发', shouldFallbackToLlm({
    ...base,
    text: attribution,
    extracted: ['约束：以后不要再碰那台机器上的 3099'],
  }));
  check('含归因词 + 抽出结论 → 不触发', !shouldFallbackToLlm({
    ...base,
    text: attribution,
    extracted: [
      '约束：以后不要再碰那台机器上的 3099',
      '结论：旧进程没有随会话退出，新连接被挡住',
    ],
  }));

  // 决策缺口
  check('含决策信号但没抽出决策 → 触发', shouldFallbackToLlm({
    ...base,
    text: '经过对比，我们决定改用 pnpm 作为包管理器，锁文件更稳定。',
    extracted: ['结论：npm 锁文件在 CI 上不稳定'],
  }));

  // 目标缺口
  check('含量化目标但没抽出约束 → 触发', shouldFallbackToLlm({
    ...base,
    text: '优化后的输入成本压到 10 元以内，P99 延迟也降到 200ms 以下。',
    extracted: ['结论：缓存命中率提升'],
  }));

  // 长度门槛：短正文 + 抽出 0 条也**不**触发（成本修正）
  check('83 字抽 0 条不触发（短正文没结论是正常现象）', !shouldFallbackToLlm({ ...base, text: 'x'.repeat(83), extracted: [] }));
  check('160 字抽 0 条触发（过长门框）', shouldFallbackToLlm({ ...base, text: 'x'.repeat(160), extracted: [] }));
  check('25 字抽 0 条不触发（低于绝对地板）', !shouldFallbackToLlm({ ...base, text: 'x'.repeat(25), extracted: [] }));
}

// ── 9) 独立审查发现的误触发（裸词绕过长度门槛）──
//
// ★首版 GOAL_SIGNAL 写 `压到|降到|...|以内|以下|目标`，其中「以内/以下/目标」
// 是中文高频虚指。配合「类型缺口不受长度门槛约束」，短正文也会触发真实调用：
// ```
// 以下是我对这段代码的检查结果…      (29 字) → 触发
// 这次改动限制在单个文件以内        (30 字) → 触发
// 这次任务的整体目标是把插件跑通    (26 字) → 触发
// ```
// 三条都远低于 minChars=120，成本闸门被完全绕过。
console.log('=== 9) 裸「以下/以内/目标」不得触发 ===');
{
  const noise = [
    '以下是我对这段代码的检查结果，整体逻辑没有问题，可以继续。',
    '为了保证可维护性，这次改动限制在单个文件以内，不引入新依赖。',
    '这次任务的整体目标是把插件跑通，然后再考虑优化性能。',
    '三周以内我会把这个模块补完，之后再做性能优化。',
  ];
  for (const n of noise) {
    check(`不触发「${n.slice(0, 16)}…」`, !shouldFallbackToLlm({ ...base, text: n, extracted: [] }), {
      chars: n.length,
    });
  }

  // 真量化目标仍要触发（不能被收紧误杀）
  const realGoals = [
    '这次要把握手耗时压到 200ms 以内，成本降到 10 元以下。',
    '延迟不超过 150ms，内存占用控制在 200MB 以内。',
  ];
  for (const g of realGoals) {
    check(`量化目标触发「${g.slice(0, 16)}…」`, shouldFallbackToLlm({ ...base, text: g, extracted: [] }), g);
  }
}

// ── 10) 目标缺口不得被任意约束掩盖 ──
//
// ★首版判据是 `GOAL_SIGNAL.test(text) && !has('约束：')`。而目标归「约束」类别，
// 所以抽出**任何**约束都会掩盖目标缺口：
// ```
// 正文: 只支持 Windows。响应时间得进到 200ms 以内。
// 规则: 抽出「约束：只支持 Windows」⇒ has('约束：')=true ⇒ 判定目标不缺
// ```
console.log('=== 10) 目标缺口不被无关约束掩盖 ===');
{
  const text = '只支持 Windows。响应时间得进到 200ms 以内。';
  const unrelated = ['约束：只支持 Windows'];
  check('含目标但只抽出无关约束 → 触发', shouldFallbackToLlm({ ...base, text, extracted: unrelated }), {
    text,
    unrelated,
  });

  const withGoal = ['约束：只支持 Windows', '约束：响应时间压到 200ms 以内'];
  check('目标已抽出 → 不触发', !shouldFallbackToLlm({ ...base, text, extracted: withGoal }), withGoal);
}

// ── 10b) 类型缺口必须按类别判，不能靠中文前缀 ──
//
// ★旧判据是 `line.startsWith('结论：')`，那是 `constraintsFromProse` 时代
// 的形态。schema 之后传入的是 `MemoryFact.statement`（`HEAD 是 e839e55`
// 这种裸陈述），永远不以「结论：」开头 ⇒ 类型缺口恒为真 ⇒ 每次带因果
// 信号的正文都触发兜底，成本闸门形同虚设。
console.log('=== 10b) 类型缺口按类别判 ===');
{
  const attribution = '排查之后定位到问题出在旧进程没有随会话退出，所以新连接全被挡住了。';
  const bareStatement = ['旧进程没有随会话退出']; // 裸陈述，无「结论：」前缀
  check(
    '裸陈述 + 未传类别 → 仍判缺口（旧行为，兼容）',
    shouldFallbackToLlm({ ...base, text: attribution, extracted: bareStatement }),
  );
  check(
    '裸陈述 + 传类别 conclusion → 不判缺口',
    !shouldFallbackToLlm({
      ...base,
      text: attribution,
      extracted: bareStatement,
      extractedKinds: ['conclusion'],
    }),
  );
  check(
    '传了别的类别 → 仍判缺口',
    shouldFallbackToLlm({
      ...base,
      text: attribution,
      extracted: ['以后不要再碰 3099'],
      extractedKinds: ['constraint'],
    }),
  );
}

// ── 11) 会话配额必须按会话分桶（三个标量的实现会失效）──
//
// ★首版用「单个 count + 单个 sessionId」，重置写在 runLlmFallback 内部。
// 实测两个致命缺陷（依赖外部逻辑，这里用等价模型固化语义）：
// ```
// 缺陷 1：A 用满 40 次 ⇒ shouldFallback 恒 false ⇒ runLlmFallback 永不调用
//         ⇒ 重置永不执行 ⇒ 切到 B 也拿不到额度（直到进程重启）
// 缺陷 2：A/B 交替 ⇒ 每次归属变化都清零 ⇒ 交替 200 次一次都没被拦
// ```
// 修法是 Map<sessionId, {count, lastAt}>，且**不做清零动作**。
console.log('=== 11) 会话配额分桶 ===');
{
  // 复刻 index.ts 的 Map 实现，验证语义
  const quota = new Map<string, { count: number; lastAt: number }>();
  const quotaFor = (sid: string): { count: number; lastAt: number } => {
    const e = quota.get(sid);
    if (e !== undefined) return e;
    const fresh = { count: 0, lastAt: 0 };
    quota.set(sid, fresh);
    return fresh;
  };
  const gate = (sid: string): boolean => {
    const q = quotaFor(sid);
    return shouldFallbackToLlm({
      ...base,
      text: base.text,
      extracted: [],
      usedCalls: q.count,
      sinceLastMs: q.lastAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - q.lastAt,
    });
  };
  const consume = (sid: string): void => {
    const q = quotaFor(sid);
    q.count += 1;
    q.lastAt = Date.now();
  };

  for (let i = 0; i < 40; i += 1) if (gate('A')) consume('A');
  check('A 用满 40 次', quotaFor('A').count === 40);
  check('A 用满后被拦', !gate('A'));
  check('切到 B 首判放行', gate('B'));

  quota.clear();
  let blocked = 0;
  for (let i = 0; i < 200; i += 1) {
    const sid = i % 2 === 0 ? 'A' : 'B';
    if (!gate(sid)) {
      blocked += 1;
      continue;
    }
    consume(sid);
  }
  check('交替 200 次被拦 >100 次', blocked > 100, { blocked });
  check(
    '每会话计数不超上限',
    quotaFor('A').count <= 40 && quotaFor('B').count <= 40,
    { a: quotaFor('A').count, b: quotaFor('B').count },
  );
}

// ── 11b) 配额的两个时间戳必须分开（复核发现的二次缺陷）──
// ★合并成一个 `lastAt` 会同时破坏两件事：
// ```
// 若在 quotaFor 里刷新它做 LRU ⇒ sinceLastMs 恒为 0 ⇒ 最小间隔判据永久失效
// 若只在调用时更新   ⇒ 被配额拦下的活跃会话被 LRU 误淘汰 ⇒ 配额反复重置
// ```
// 复核实测后者：21 会话 × 50 轮 = 1050 条事件全部放行。
console.log('=== 11b) 配额双时间戳 + LRU 不重置活跃会话 ===');
{
  interface Q {
    count: number;
    lastCallAt: number;
    touchedAt: number;
  }
  const MAX = 20;
  const map = new Map<string, Q>();
  const maxCalls = 40;

  const quotaFor = (sid: string): Q => {
    const e = map.get(sid);
    if (e !== undefined) {
      e.touchedAt = Date.now();
      return e;
    }
    if (map.size >= MAX) {
      let victim: string | null = null;
      let at = Number.POSITIVE_INFINITY;
      for (const [k, v] of map) {
        if (v.count >= maxCalls) continue;
        if (v.touchedAt < at) {
          at = v.touchedAt;
          victim = k;
        }
      }
      if (victim !== null) map.delete(victim);
    }
    const fresh: Q = { count: 0, lastCallAt: 0, touchedAt: Date.now() };
    map.set(sid, fresh);
    return fresh;
  };
  const gate = (sid: string): boolean => {
    const q = quotaFor(sid);
    return shouldFallbackToLlm({
      ...base,
      extracted: [],
      usedCalls: q.count,
      minIntervalMs: 0,
      sinceLastMs: q.lastCallAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - q.lastCallAt,
    });
  };
  const consume = (sid: string): void => {
    const q = quotaFor(sid);
    q.count += 1;
    q.lastCallAt = Date.now();
  };

  // 21 个会话各 50 轮：每个都应被限制在 40 次以内
  let total = 0;
  for (let round = 0; round < 50; round += 1) {
    for (let s = 0; s < 21; s += 1) {
      if (gate(`s${s}`)) {
        consume(`s${s}`);
        total += 1;
      }
    }
  }
  console.log(`  21 会话 × 50 轮 → 总调用 ${total} 次`);
  // ★单靠会话配额**无法**约束这个总量：桶被淘汰后会重新获得全额额度。
  // 复核实测 1050 次全部放行。这是进程级配额存在的根本原因。
  check('会话配额单靠自身不足以约束多窗口总量', total > 21 * 40, { total });

  // 间隔判据不能被 LRU 刷新破坏：刚调用过的会话应被间隔拦住
  map.clear();
  const s0 = 'x';
  check('首次放行', gate(s0));
  consume(s0);
  check(
    '刚调用后因间隔被拦（LRU 刷新不影响 lastCallAt）',
    !shouldFallbackToLlm({
      ...base,
      extracted: [],
      usedCalls: quotaFor(s0).count,
      minIntervalMs: 30000,
      sinceLastMs: Date.now() - quotaFor(s0).lastCallAt,
    }),
  );
}

// ── 11c) 进程级配额是最终硬上限 ──
//
// ★会话配额按桶独立，多窗口下总量成倍放大，且桶被淘汰后会重新开额度。
// 复核实测：21 会话 × 50 轮 = 1050 次全部放行。
// 进程级配额打满后，**任何**会话都不再兜底。
console.log('=== 11c) 进程级配额硬上限 ===');
{
  const GLOBAL_MAX = 200;
  let globalCalls = 0;
  const map = new Map<string, { count: number; lastCallAt: number; touchedAt: number }>();
  const quotaFor = (sid: string) => {
    const e = map.get(sid);
    if (e !== undefined) {
      e.touchedAt = Date.now();
      return e;
    }
    const fresh = { count: 0, lastCallAt: 0, touchedAt: Date.now() };
    map.set(sid, fresh);
    return fresh;
  };
  const gate = (sid: string): boolean => {
    const q = quotaFor(sid);
    return shouldFallbackToLlm({
      ...base,
      extracted: [],
      usedCalls: q.count,
      minIntervalMs: 0,
      sinceLastMs: q.lastCallAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - q.lastCallAt,
      globalCalls,
      globalMaxCalls: GLOBAL_MAX,
    });
  };
  const consume = (sid: string): void => {
    const q = quotaFor(sid);
    q.count += 1;
    q.lastCallAt = Date.now();
    globalCalls += 1;
  };

  for (let round = 0; round < 50; round += 1) {
    for (let s = 0; s < 21; s += 1) {
      const sid = `s${s}`;
      if (gate(sid)) consume(sid);
    }
  }
  console.log(`  21 会话 × 50 轮 + 进程上限 ${GLOBAL_MAX} → 总调用 ${globalCalls} 次`);
  check(`进程级上限 ${GLOBAL_MAX} 生效（原为 1050）`, globalCalls <= GLOBAL_MAX, { globalCalls });
  check('达到上限后任何会话都被拦', !gate('newSession'), { globalCalls });
}

// ── 12) 换行折叠：模型输出含换行时不得产生碎片 ──
//
// ★`extractWithLlm` 返回 `前缀：text` 后用 `\n` 拼接，下游 `itemsFromTag`
// 又按 `\n` 切行。JSON 的 text 若含换行，第二段失去前缀、被判成「结论」：
// ```
// → [结论] 第二行被换行切开了   （无主谓碎片）
// ```
console.log('=== 12) 换行折叠 ===');
{
  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [{ kind: 'conclusion', text: '第一行结论内容很重要\n第二行被换行切开了' }],
    }),
  );
  const lines = await extractWithLlm(ctx, fakeSession(), 'g'.repeat(120));
  check('只产出 1 条（不是 2 条）', lines.length === 1, lines);
  check('换行已被折叠为空格', lines[0]?.includes('第一行结论内容很重要 第二行被换行切开了'), lines[0]);
}

// ── 13) 非正常结束必须丢弃（半截输出不能当成功）──
//
// ★`LlmRuntime` 把适配器异常归一化为 `finish{reason:{kind:'error'}}`，
// **不抛异常**。若不看这个字段，超时/崩溃时拿到的半截文本会被当完整输出解析。
console.log('=== 13) 非正常结束丢弃 ===');
{
  /** 造一个指定 finish kind 的流。 */
  const ctxWithFinish = (finishKind: string, payload: string): { ctx: unknown } => ({
    ctx: {
      get: (name: string) =>
        name === 'llm'
          ? {
              stream: () =>
                (async function* () {
                  yield { type: 'text-delta', index: 0, text: payload };
                  yield { type: 'finish', reason: { kind: finishKind } };
                })(),
            }
          : undefined,
    },
  });

  const payload = JSON.stringify({ items: [{ kind: 'conclusion', text: '这条内容足够长可以入库' }] });
  check('error 结束丢弃', (await extractWithLlm(ctxWithFinish('error', payload).ctx, fakeSession(), 'h'.repeat(120))).length === 0);
  check('aborted 结束丢弃', (await extractWithLlm(ctxWithFinish('aborted', payload).ctx, fakeSession(), 'i'.repeat(120))).length === 0);
  check('stop 结束正常解析', (await extractWithLlm(ctxWithFinish('stop', payload).ctx, fakeSession(), 'j'.repeat(120))).length === 1);
  // 不发 finish 的适配器也要能工作（不能要求必须等于 stop）
  const noFinish = {
    ctx: {
      get: (name: string) =>
        name === 'llm'
          ? {
              stream: () =>
                (async function* () {
                  yield { type: 'text-delta', index: 0, text: payload };
                })(),
            }
          : undefined,
    },
  };
  check('无 finish 块仍能解析（黑名单而非白名单）', (await extractWithLlm(noFinish.ctx, fakeSession(), 'k'.repeat(120))).length === 1);
}

// ── 14) 判定模式：候选清单 + 原样复制（★2026-11-14）──
//
// 规则层把「结构合格但没命中谓词表」的句子放进 `pending`，由模型判定。
// 这一步是整套设计的核心：结构判据对「垃圾」与「真判断句」零区分力
// （实测 82/82 全通过），只有语义能区分。
console.log('=== 14) 判定模式 ===');
{
  let seenSystem = '';
  let seenInput = '';
  const { ctx } = fakeCtx(
    JSON.stringify({
      items: [
        { kind: 'statement', text: '分层极其干净，改造成本低' },
        { kind: 'conclusion', text: '这是跨模型做对比实验的前提，它做到了' },
      ],
    }),
    (options) => {
      const opts = options as {
        system?: string;
        messages?: Array<{ content?: Array<{ text?: string }> }>;
      };
      seenSystem = String(opts.system ?? '');
      seenInput = String(opts.messages?.[0]?.content?.[0]?.text ?? '');
    },
  );

  const candidates = [
    '代码已全部读完，结论如下',
    '分层极其干净，改造成本低',
    '这是跨模型做对比实验的前提，它做到了',
  ];
  const lines = await extractWithLlm(ctx, fakeSession(), 'x'.repeat(200), { candidates });

  check('候选模式下用判定提示词', seenSystem.includes('记忆筛选器'), seenSystem.slice(0, 60));
  check('候选被编号送入', seenInput.includes('1. 代码已全部读完'), seenInput.slice(0, 80));
  check('候选超过原正文长度时仍用候选', !seenInput.startsWith('xxx'), seenInput.slice(0, 40));
  check('判定产物 2 条', lines.length === 2, lines);

  // 判定产物必须能入库：不要求三元组（语义已由模型裁决）
  const extracted = factsFromLlmLines(lines, { origin: 'assistant', sessionId: 's1' });
  console.log(`  入库: ${JSON.stringify(extracted.facts.map((f) => f.statement))}`);
  check('两条都通过 validateJudgedFact', extracted.facts.length === 2, extracted.rejected);
  check('三元组为空仍可入库', extracted.facts.every((f) => f.predicate === ''), extracted.facts);

  // 结构底线仍然生效：表格行 / JSON / 提问即使模型说保留也要拦
  const garbage = factsFromLlmLines(
    [
      '事实：| 优点 | 缺点 |',
      '事实：{"a":1}',
      '事实：这样做真的对吗？',
      '事实：**加粗的片段**',
    ],
    { origin: 'assistant', sessionId: 's1' },
  );
  console.log(`  结构底线拦下: ${JSON.stringify(garbage.rejected.map((r) => r.reason))}`);
  check('表格行被拦', garbage.facts.length === 0, garbage.facts);
}

// ── 15) pending 是兜底的主判据（不受 minChars 约束）──
console.log('=== 15) pending 触发兜底 ===');
{
  // 待裁决材料够长（≥ 绝对地板 24 字符）但原正文很短 ⇒ 仍须触发
  const pending = ['分层极其干净，改造成本低', '工具实现的细节做得比多数开源 agent 认真'];
  const short = pending.join('\n');
  check(
    '待裁决材料足够 → 触发（不受 minChars 拦）',
    shouldFallbackToLlm({ ...base, text: short, extracted: [], pending }),
  );
  check(
    '无 pending → 短正文不触发',
    !shouldFallbackToLlm({ ...base, text: short, extracted: [], pending: [] }),
  );
  check(
    '规则抽到 3 条但仍有 60 条待裁决 → 触发',
    shouldFallbackToLlm({
      ...base,
      text: short,
      extracted: ['a', 'b', 'c'],
      pending: Array.from({ length: 60 }, (_, i) => `候选句 ${i}`),
    }),
  );
  // 只有一句很短的话 ⇒ 材料不足，不值得调用
  check(
    '仅 1 条 8 字候选 → 不触发（材料不足）',
    !shouldFallbackToLlm({ ...base, text: '分层干净', extracted: [], pending: ['分层干净'] }),
  );

  // ── ★2026-11-15 P2-9：长正文 + 单条短 pending 不能被压掉 ──
  //
  // 独立审查 P0：首版地板一律用 `chars`（pending 总长 OR 正文长度），
  // 于是「有 1 条短候选」反而把长正文从 true 压成 false —— 判据方向反了。
  //
  // 构造：240 字正文（含因果信号）+ 14 字 pending。
  // 修前 chars=14 < 24 ⇒ false；修后 materialChars=max(14,240)=240 ⇒ true。
  const longBody = '排查结论：旧进程未退出，新连接被阻断在握手阶段。'.repeat(10);
  check(
    '长正文 + 短 pending → 仍触发（不被地板压掉）',
    shouldFallbackToLlm({ ...base, text: longBody, extracted: [], pending: ['file:// 的图片会被拦截'] }),
  );
  check(
    '同一长正文无 pending 也触发',
    shouldFallbackToLlm({ ...base, text: longBody, extracted: [], pending: [] }),
  );
  // 地板仍须拦住「正文和 pending 都极短」的真碎片
  check(
    '正文与 pending 都极短 → 仍被地板拦住',
    !shouldFallbackToLlm({ ...base, text: '完成', extracted: [], pending: ['完成'] }),
  );
  // ## `max` 的边界：两者都恰好在门槛以下（第二轮审查 P2-3）
  //
  // `ABSOLUTE_MIN_CHARS = 24`。正文 20 字 + pending 20 字 ⇒ max=20 < 24 ⇒ 拦。
  // 若实现误写成「相加」会得到 40 ⇒ 放行，这条能区分两种实现。
  check(
    '正文与 pending 各 20 字 → 仍拦（未误用相加）',
    !shouldFallbackToLlm({
      ...base,
      text: '这是一段二十个字的测试正文内容啊',
      extracted: [],
      pending: ['这也是一条二十字上下的候选句子'],
    }),
  );
}

console.log('');
if (failed === 0) console.log('全部通过');
else {
  console.log(`${failed} 项失败`);
  process.exitCode = 1;
}