/**
 * 噪声鲁棒性测试（对标 EMNLP26《Skill State》的噪声压力测试）。
 *
 * ## 它到底在防什么
 *
 * 摘要采集的第一道防线是 `context-trim.ts` 的 `NOISE_PREFIXES`（内容前缀）
 * 与 `source.kind`（来源标记）。命中就跳过，不当成用户请求。
 *
 * 这两份都是**手写清单**。风险不在"清单不够长"，而在**有人改代码时
 * 不小心把某一条删了/改坏了**，而摘要丢真实用户请求是不会报错的
 * （它只是安静地少一段）。本测试就是那条"删了就变红"的保险丝。
 *
 * ## 为什么全部用内联合成样本，不读会话文件
 *
 * 第一版直接从 `D:\Users\.dsh\sessions` 读最新会话。三个问题：
 * 1. **样本为空时测试恒真**：实测该会话 3721 条正文里只有 17 条真实用户
 *    发言且集中在中段，切末尾 40 条时黄金集为空 → `retention 100% (0/0)`
 *    → 5 条断言全部通过，什么都没验。
 * 2. **非确定性**：换机器/换会话，测试结论就变。
 * 3. **污染 `npm test`**：会话样本不足时整个测试链变红。
 *
 * 所以这里把真实会话里的语料**抄成常量**，样本固定、无外部依赖。
 *
 * ## 为什么必须有 8 条用户请求（独立审查 P0）
 *
 * 「用户请求」桶的槽位上限是 12（`collect(requests, …, 12)`）。
 * 若窗口只放 3 条，把上限改成 3 也照样全绿 —— 测试等于没有锁定这个预算。
 * 8 条能覆盖"上限被砍到 3~7"这类退化，又不至于撞上 12 的上限本身。
 *
 * 用法：node --import ./scripts/register-loader.mjs scripts/e2e-noise.ts
 */
import { buildDeterministicSummary } from '../src/context-trim.ts';

let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

interface Msg {
  role: string;
  content: Array<{ type: string; text?: string }>;
  source?: { kind?: string };
}

// ────────────────────────────────────────────────────────────
// 语料（从真实会话 session-95eaf7e3 抄录，去掉路径与个人信息）
// ────────────────────────────────────────────────────────────

/**
 * 黄金集：8 条真实用户请求。
 *
 * 必须满足两点：
 * - 长度 ≥ 20 字符（太短无法做锚点匹配，也无法可靠判断是否被截断）
 * - 内容互不相同（否则去重会掩盖留存率）
 */
const GOLDEN: readonly string[] = [
  '所有的图标要用 SVG 绘制出来。不是简单的文字。你如果是文字的话，你也要把它画的像画一点。',
  '可以啊，我肯定要很很好看的视觉效果，让年轻人一看就很喜欢。你刚刚的修复，你不给我网址，我也看不见。',
  '你应该多画几个版本，让我来选。这里面的词都是有具体物体的对照或者说是联想。可以朝这个方向去设计去画。',
  '不是已经选过了图形的确认点吗？你为什么还要重新绘制啊？你要重新绘制，也要按照原有的图形的样式去绘制呀。',
  '嗯，你整体的样式和配色给我看一下呀，我现在只能看到你截图最下面的样子。',
  '我没有看见你给我的像素效果。我也不知道目前的进度是如何，然后后续我们应该推进哪些？',
  '我的意思是你去学习这两个仓库的像素艺术设计，然后根据两个仓库的像素艺术设计的方向，来优化我们的视觉设计。',
  '那看看还有哪些可以优化的视觉方向，我们先把视觉方向的优化底子全部打好，后续的就有视觉方向的标准的，对吧？',
];

/** 助手正文（结论段的正常内容）。 */
const ASSISTANT_LINES: readonly string[] = [
  '把图标盒统一成 40×40，内部图标 26×26，这样在三个尺寸下都不会糊。',
  '结论：像素图必须用 shape-rendering="crispEdges"，否则缩放会插值变模糊。',
  '决定改用 16 / 32 / 48 / 64 四个整数倍档位，避免小数坐标导致的半像素渲染。',
  '问题出在渐变色上：CSS 渐变在 16px 下会退化成脏色块，改成实心加描边。',
  '根因是锁梁和锁体之间只有 1 格空隙，放大后看起来像一块砖。',
  '改成用 currentColor 继承父级颜色，这样朱砂和骨白两套主题不用各画一份。',
  '结论：先把五个屏的视觉底子打完，再回头补动效，顺序反了会重复改。',
  '决定把调色板收敛到五档：墨、宣、骨白、朱砂、印泥红。',
  '问题出在圆盘在 16px 下和盘子、钱币、桃子没有区别，必须加内圈区分。',
  '改用 1px 细线描边更不行，在 3 倍图下会消失，最小要 2px。',
  '结论：截图统一用 3 倍图，否则看不出白点带这类细节缺陷。',
  '决定把戒斗环抽成独立组件 ShackleRing，入门屏复用同一个。',
];

/** 工具输出（工具调用段的正常内容）。 */
const TOOL_LINES: readonly string[] = [
  'Successfully wrote 2314 bytes to web/src/components/IconSet.tsx',
  'Read 96 lines from web/src/styles/tokens.css',
  'Build succeeded in 1.42s, 0 errors, 0 warnings',
  'Found 12 files matching px-*.png',
  'exit code 0',
  'TypeDoc: generated 34 modules',
  'Applied 3 edits to web/src/pages/Onboarding.tsx',
  'Snapshot saved to .shots/95-十六枚-候选.png',
  'Lint passed: 0 problems',
  'Installed 42 packages in 3.1s',
  'exit code 0',
  'Rendered 16 icons at 4 sizes each: 64 files written',
  'Wrote web/src/styles/pixel.css (1887 bytes)',
  'Read 214 lines from web/src/components/ShackleRing.tsx',
  'Build succeeded in 1.38s',
  'exit code 0',
  'Applied 7 edits to web/src/pages/Home.tsx',
  'Screenshot captured: 1280x2400 @3x',
  'exit code 0',
  'Found 0 type errors',
];

function userMsg(text: string, kind?: string): Msg {
  return { role: 'user', content: [{ type: 'text', text }], ...(kind === undefined ? {} : { source: { kind } }) };
}
function assistantMsg(text: string): Msg {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function toolMsg(text: string): Msg {
  return { role: 'tool', content: [{ type: 'text', text }] };
}

/**
 * 合成 40 条窗口：8 用户 + 12 助手 + 20 工具 = 40。
 *
 * 40 与真实 trim 每次裁掉的节点数一致（实测 38–40）。
 * 用户请求分散插入，避免全部集中在一处（那会让槽位竞争失真）。
 */
function baseWindow(): Msg[] {
  const out: Msg[] = [];
  const perUser = Math.floor(40 / GOLDEN.length); // = 5
  let u = 0;
  for (let i = 0; i < 40; i += 1) {
    if (i % perUser === 0 && u < GOLDEN.length) {
      out.push(userMsg(GOLDEN[u] as string, 'user'));
      u += 1;
    } else if (i % 3 === 0) {
      out.push(assistantMsg(ASSISTANT_LINES[i % ASSISTANT_LINES.length] as string));
    } else {
      out.push(toolMsg(TOOL_LINES[i % TOOL_LINES.length] as string));
    }
  }
  // 补齐未插入的用户请求
  while (u < GOLDEN.length) {
    out.splice(u * perUser + u, 0, userMsg(GOLDEN[u] as string, 'user'));
    u += 1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// 噪音：全部取自真实会话里存在的 4 种注入形态
// ────────────────────────────────────────────────────────────
//
// 刻意**不包含**任何虚构的 kind。之前那版用自造的 `session-sync`
// 推出「未知噪音失守」，那是反事实推演，不是实测缺陷——已删除。
//
// ## 四种形态的防线强弱并不相同（变异测试实测）
//
// | 形态 | 命中的防线 | 删掉前缀会变红吗 |
// |---|---|---|
// | `runtime-context` | 仅 `NOISE_PREFIXES` | ✅ 会（retention 8→5，污染 25%）|
// | `time-context` | 仅 `NOISE_PREFIXES` | ✅ 会 |
// | `skill-catalog` | 仅 `NOISE_PREFIXES` | ✅ 会（污染 25%，retention 不变）|
// | `tool-jobs` | `source.kind` 硬拦截 + 前缀 | ❌ **不会**（冗余防线）|
//
// `tool-jobs` 是唯一有双保险的：`context-trim.ts` 里有一行
// `if (message.source?.kind === 'tool-jobs') continue;` 独立生效。
// 所以删掉前缀它仍被拦住 —— **这不是测试漏检，是防线冗余**。
// 保留它作为"双保险确实成立"的活证据。

interface Noise {
  make: (i: number) => Msg;
  marker: string;
  /** 该形态是否只有前缀一条防线；false 表示有 kind 硬拦截兜底 */
  prefixOnly: boolean;
}

const NOISES: readonly Noise[] = [
  {
    marker: 'background job',
    make: (i) => userMsg(`background job pwsh-${i} (pwsh: node server/src/index.js) finished`, 'tool-jobs'),
    prefixOnly: false,
  },
  {
    marker: 'Current runtime context',
    make: (i) => userMsg(`Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Node v${i}`, 'runtime-context'),
    prefixOnly: true,
  },
  {
    marker: 'Time sampled while preparing',
    make: (i) => userMsg(`Time sampled while preparing turn ${i}, step ${i * 7}: 2026-11-15T1${i % 10}:00:00+08:00`, 'time-context'),
    prefixOnly: true,
  },
  {
    marker: 'available skill catalog changed',
    make: (i) => userMsg('The available skill catalog changed. This complete catalog replaces every earlier catalog.', 'skill-catalog'),
    prefixOnly: true,
  },
];

/** 均匀交错插入噪音。 */
function interleave(real: Msg[], noise: Msg[]): Msg[] {
  if (noise.length === 0) return [...real];
  const out: Msg[] = [];
  const step = real.length / (noise.length + 1);
  let ni = 0;
  for (let i = 0; i < real.length; i += 1) {
    while (ni < noise.length && ni * step <= i) {
      out.push(noise[ni] as Msg);
      ni += 1;
    }
    out.push(real[i] as Msg);
  }
  while (ni < noise.length) {
    out.push(noise[ni] as Msg);
    ni += 1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// 度量
// ────────────────────────────────────────────────────────────

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** 取某个 `### xxx` 段的正文。 */
function sectionOf(summary: string, title: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of summary.split('\n')) {
    if (line.startsWith('### ')) {
      inside = line.includes(title);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

const ANCHOR = 40;

interface Result {
  retention: number;
  hits: number;
  total: number;
  reqLeak: number;
  conLeak: number;
  chars: number;
}

/**
 * @param messages 待摘要的消息
 * @param expectNoise 期望插入的噪音条数（用于自检噪音确实进去了）
 */
function measure(messages: Msg[], expectNoise: number): Result {
  // 自检：噪音真的插进去了吗。若 interleave 出错返回原数组，
  // 下面所有断言都会"通过"（污染 0、retention 持平）——那是假绿。
  if (messages.filter((m) => m.source?.kind !== undefined && m.source.kind !== 'user').length < expectNoise) {
    throw new Error(`噪音未正确插入：期望 ${expectNoise}，实际 ${messages.filter((m) => m.source?.kind !== undefined && m.source.kind !== 'user').length}`);
  }

  const summary = buildDeterministicSummary(messages, 4000);
  const flat = flatten(summary);
  const hits = GOLDEN.filter((g) => flat.includes(flatten(g).slice(0, ANCHOR))).length;

  const reqSec = sectionOf(summary, '用户请求');
  const conSec = sectionOf(summary, '助手结论');
  const reqLeak = NOISES.filter((n) => reqSec.includes(n.marker)).length / NOISES.length;
  const conLeak = NOISES.filter((n) => conSec.includes(n.marker)).length / NOISES.length;

  return {
    retention: hits / GOLDEN.length,
    hits,
    total: GOLDEN.length,
    reqLeak,
    conLeak,
    chars: summary.length,
  };
}

function report(label: string, r: Result): void {
  console.log(
    `  ${label.padEnd(12)} retention ${(r.retention * 100).toFixed(0).padStart(3)}% (${r.hits}/${r.total})` +
      `  用户段污染 ${(r.reqLeak * 100).toFixed(0).padStart(3)}%` +
      `  结论段污染 ${(r.conLeak * 100).toFixed(0).padStart(3)}%  摘要 ${r.chars} 字符`,
  );
}

// ────────────────────────────────────────────────────────────
// 跑
// ────────────────────────────────────────────────────────────

console.log('========================================');
console.log(' 噪声鲁棒性测试');
console.log('========================================');
const base = baseWindow();
console.log(`窗口: ${base.length} 条（${GOLDEN.length} 用户 + ${base.filter((m) => m.role === 'assistant').length} 助手 + ${base.filter((m) => m.role === 'tool').length} 工具）`);

console.log('\n=== 1) 基线（无噪音）===');
const baseline = measure(base, 0);
report('N=0', baseline);
check(
  `基线：${GOLDEN.length} 条真实请求全部保留`,
  baseline.hits === GOLDEN.length,
  { hits: baseline.hits, total: GOLDEN.length },
);

console.log('\n=== 2) 已知噪音（真实会话存在的 4 种注入形态）===');
const results: Record<number, Result> = {};
for (const n of [5, 20, 50]) {
  const noise = Array.from({ length: n }, (_, i) => (NOISES[i % NOISES.length] as Noise).make(i));
  results[n] = measure(interleave(base, noise), n);
  report(`N=${n}`, results[n] as Result);
}

const all = [5, 20, 50].map((n) => results[n] as Result);

check(
  '噪音不挤掉真实请求（三档 retention 与基线持平）',
  all.every((r) => r.hits === baseline.hits),
  { base: baseline.hits, got: all.map((r) => r.hits) },
);
check(
  '噪音不混进「用户请求」段（三档污染为 0）',
  all.every((r) => r.reqLeak === 0),
  all.map((r) => r.reqLeak),
);
check(
  '噪音不混进「助手结论」段（三档污染为 0）',
  all.every((r) => r.conLeak === 0),
  all.map((r) => r.conLeak),
);
check('摘要长度受 maxChars 约束（<=4000）', all.every((r) => r.chars <= 4000), all.map((r) => r.chars));

// 记录各形态的防线强度（供人工核对，也防止 `prefixOnly` 变成无用字段）。
const singleLine = NOISES.filter((n) => n.prefixOnly).map((n) => n.marker);
const dualLine = NOISES.filter((n) => !n.prefixOnly).map((n) => n.marker);
console.log(`\n  单防线（仅前缀）: ${singleLine.join(' / ')}`);
console.log(`  双防线（前缀 + kind）: ${dualLine.join(' / ') || '无'}`);
check(
  '至少有一种噪音只靠前缀拦截（否则测试锁不住 NOISE_PREFIXES）',
  singleLine.length > 0,
  { singleLine, dualLine },
);

// ────────────────────────────────────────────────────────────
// 结论（全部用实算值，不写死任何数字）
// ────────────────────────────────────────────────────────────
console.log('\n========================================');
console.log(' 结论');
console.log('========================================');
const minRet = Math.min(...all.map((r) => r.retention));
const maxReq = Math.max(...all.map((r) => r.reqLeak));
const maxCon = Math.max(...all.map((r) => r.conLeak));
console.log(`retention 最低 ${(minRet * 100).toFixed(0)}%（基线 ${(baseline.retention * 100).toFixed(0)}%，共 ${GOLDEN.length} 条真实请求）`);
console.log(`用户段污染峰值 ${(maxReq * 100).toFixed(0)}% / 结论段污染峰值 ${(maxCon * 100).toFixed(0)}%`);
console.log('');
console.log('对照论文（warehouse 50 步，注入无关事件）：');
console.log('  历史追加基线  0.68 → 0.61 → 0.53（跌 15 个百分点）');
console.log('  Skill State   0.97 → 0.98（不跌）');
console.log('');
console.log('本测试锁定的是「现有 4 种注入形态被误放行」这一类回归，');
console.log('不主张对未知注入形态的覆盖 —— 那属于准入判据的设计问题，不是本测试的范围。');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
