/**
 * 同批折叠：把一次提炼产出的 N 条碎片，压成 **1 条**可读的批次摘要。
 *
 * ## 为什么需要这一层（真实数据）
 *
 * 抽取器是**句子级**的 —— 一句可复用陈述 = 一条记忆。这在抽取侧是对的
 * （判定有界、可单测），但在**入库侧**会造成灾难：实测 session-95eaf7e3
 * 一个会话写入 1515 条，长度中位数仅 **33 字**，其中 19.3% ≤ 20 字：
 * ```
 * [事实] `.num`是一个通用数字类
 * [事实] `.num` 只负责等宽数字，不负责尺寸
 * [结论] 两者差一倍，昵称显得太弱
 * ```
 * 这三条本是**同一段字号排查**的连续推理，单独召回任何一条都是错的。
 *
 * ## 设计要点
 *
 * 1. **确定性、零 LLM**：折叠只做排序与拼接，因此可单测、零成本、
 *    同一批输入必然产出同一输出（与抽取器同属规则层）。
 * 2. **信息不丢**：摘要里保留**每一条**成员陈述原文，只去掉重复的。
 *    只写「14 条相关记忆」这种计数是 LRC 现有合成层的缺陷
 *    （1089 条空壳 `「洛书合成·变动触发」823 条相关记忆的几何融合结果。`），
 *    本模块刻意不重复那个错误。
 * 3. **有界**：总长超过上限时按优先级截断，并**显式标注**略去条数，
 *    不静默丢内容。
 * 4. **小批不动**：低于阈值时返回 `null`，调用方走原路径，
 *    既有行为零变更（含既有 e2e 断言）。
 */
import { areNearDuplicate } from './memory-filter.ts';
import {
  importanceOf,
  topicTags,
  type FactKind,
  type MemoryFact,
} from './memory-schema.ts';

/** 低于这个条数不折叠：2~3 条本就是一次完整表述，折叠反而损失精度。 */
export const FOLD_MIN_FACTS_DEFAULT = 4;

/**
 * 折叠后内容的字符上限。
 *
 * 取值依据：实测一批 10~14 条、每条 35 字左右，合计约 500 字，**远低于**上限
 * ⇒ 正常路径信息无损。上限只用于挡住异常长的批次（如一次贴进整份报告）。
 */
export const FOLD_MAX_CHARS = 2_000;

/** 类别在摘要里的排序优先级（小的先列）——与「接手方最需要什么」一致。 */
const PRIORITY: Record<FactKind, number> = {
  constraint: 0,
  goal: 0,
  location: 0,
  artifact: 0,
  decision: 1,
  conclusion: 2,
  statement: 3,
  fact: 3,
};

/** 折叠结果。 */
export interface FoldedBatch {
  /** 折叠后的单条 Fact（statement 即摘要正文） */
  fact: MemoryFact;
  /** 被折叠进去的原始条数（去重后） */
  covered: number;
  /** 因长度上限未列入摘要的条数（0 = 完全无损） */
  omitted: number;
  /** 写入用的重要性：取成员最大值（一批里只要有一条高价值约束，整批就该优先召回） */
  importance: number;
  /**
   * 批内出现的**全部**主题（去重、按出现顺序）。
   *
   * 用于落成 `topic:xxx` 标签 —— 摘要正文不再重复 topic（会膨胀 20%~75%），
   * 但主题必须能被检索到。上限见 [`FOLD_TOPIC_TAG_LIMIT`]。
   */
  topics: string[];
}

/**
 * 折叠摘要最多带入几个 topic 标签。
 *
 * ## 为什么要有上限
 *
 * LRC 的 tags 会被前端渲染成 chip。一条摘要携带 15 个 topic 会把界面撑坏，
 * 而且 `G:\dsh-plugin-lrc` 的空壳合成记忆已经因为「tags 无界并集」
 * 出过事故（LRC 侧实测单条最多 5512 个标签）。
 *
 * 取 5：实测一轮内不同 topic 通常是 1~5 个（238 条消息 / 42 轮 ≈ 5.7），
 * 5 能覆盖绝大多数轮次；超出的不丢（它们仍在正文的 statement 里）。
 */
export const FOLD_TOPIC_TAG_LIMIT = 5;

export interface FoldOptions {
  /** 低于此条数不折叠（默认 [`FOLD_MIN_FACTS_DEFAULT`]） */
  minFacts?: number;
  /** 摘要字符上限（默认 [`FOLD_MAX_CHARS`]） */
  maxChars?: number;
}

/**
 * 把一批 Fact 折叠成 1 条批次摘要。
 *
 * @returns 折叠结果；条数不足、或全部被长度上限挡掉时返回 `null`
 *          （调用方据此走原路径，不产生任何行为变更）
 */
export function foldFacts(
  facts: readonly MemoryFact[],
  options: FoldOptions = {},
): FoldedBatch | null {
  const minFacts = options.minFacts ?? FOLD_MIN_FACTS_DEFAULT;
  const maxChars = options.maxChars ?? FOLD_MAX_CHARS;
  if (facts.length < minFacts || minFacts <= 0) return null;

  // ── 1. 批内去重 ──
  // 抽取器会把同一条约束从多条路径各抽一次（标签 / 正文 / 推理兜底），
  // 不先收敛，摘要里会出现同一句话三遍。
  const unique: MemoryFact[] = [];
  for (const fact of facts) {
    const statement = fact.statement.trim();
    if (statement.length === 0) continue;
    if (unique.some((prev) => areNearDuplicate(prev.statement, statement, 0.85))) continue;
    unique.push(fact);
  }
  if (unique.length < 2) return null;

  // ── 2. 主类别：取**占比最高**的 kind（tie 时取优先级高的） ──
  //
  // ## 为什么不能一律置为 conclusion
  //
  // `kind` 决定写入 LRC 的 `memory_type`（见 memory-schema 的 `MEMORY_TYPE`）。
  // 若摘要恒为 conclusion ⇒ 恒写成 `fact`，于是 `preference` / `decision`
  // 这两类**按类型过滤**的能力对摘要整体失效（实测库内 preference 仅 97 条、
  // 占比 1%，正是碎片化 + 误分类叠加的结果）。
  //
  // 取众数而非最大值：一批 10 条里 7 条是结论、1 条是约束时，
  // 把整批标成「约束」会让偏好检索召回到大量无关内容 —— 少数派的高价值
  // 应当体现在 `importance` 上（已取成员最大值），而不是改写类型。
  const counts = new Map<FactKind, number>();
  for (const fact of unique) counts.set(fact.kind, (counts.get(fact.kind) ?? 0) + 1);
  const dominantKind: FactKind = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (PRIORITY[a[0]] ?? 9) - (PRIORITY[b[0]] ?? 9);
  })[0]?.[0] ?? 'conclusion';

  // ── 3. 排序：类别优先 → 同类别里长句优先 ──
  // 长句通常承载更多限定条件（`昵称保持 12px 是合适的，因为榜单里数字才是主角`），
  // 比 `两者差一倍` 更值得在截断时留下。
  const ordered = [...unique].sort((a, b) => {
    const pa = PRIORITY[a.kind] ?? 9;
    const pb = PRIORITY[b.kind] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.statement.trim().length - a.statement.trim().length;
  });

  // ── 4. 拼接（超额时按优先级截断，并显式标注） ──
  //
  // ## 批次头必须**尽量短**
  //
  // 实测（2176 条真实记忆，1 分钟窗）：批次头写成
  // `本批 10 条（结论 10）：` 时，148 个折叠批的头开销合计 4440 字，
  // 把**字符数从 64492 抬到 68292（+5.9%）** —— 条数降了但字符涨了，
  // 「省上下文」这个目标反而倒退。
  //
  // ## 为什么**不**用单条 topic 作标题（实测否决）
  //
  // 曾把批次头换成「首个非空 topic」，想让摘要可读。但一轮含多条消息，
  // 各消息 topic 不同（实测一条轮次里有 `像素感这次是真的出来了`、
  // `现状已经查清`、`剩下还有一件事…`）。取首个 = **静默丢弃其余主题**，
  // 且把整轮内容错误地归到第一个主题名下。
  //
  // ## 现在的做法：整批同主题才写头；跨主题时**正文不重复 topic**
  //
  // 实测（该 session 42 轮 / 266 条 Fact）权衡三种写法：
  // ```
  // 取首个 topic 作头      → 丢弃其余主题（信息损失）
  // 逐条全职 topic         → 字符 6236 → 10880（174.5%）
  // 逐条 6 字 topic 前缀   → 字符 6236 → 7514（120.5%）
  // ```
  // 三种都不理想。根因：**topic 本身就是从正文首句提取的**，
  // 在同一轮里它与 statement 高度冗余 —— 正文再加一遍只是重复。
  //
  // 最终选择：正文只写 statement（零冗余），topic 改为**收进标签**。
  // 主题信息不丢（可按 `topic:xxx` 过滤），但摘要正文不膨胀。
  // 整批同主题时额外用 `【主题】` 作头 —— 那是唯一零成本的场景
  // （1 次头声明替代 N 次重复）。
  const DISTINCT_TOPICS = new Set(
    unique.map((f) => f.topic).filter((t): t is string => t !== undefined && t.length > 0),
  );
  const singleTopic = DISTINCT_TOPICS.size === 1 ? [...DISTINCT_TOPICS][0] : undefined;
  const head =
    singleTopic !== undefined ? `【${singleTopic}】` : `本批 ${unique.length} 条：`;
  const parts: string[] = [];
  let used = head.length;
  let omitted = 0;
  for (const fact of ordered) {
    const statement = fact.statement.trim();
    if (used + statement.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    parts.push(statement);
    used += statement.length + 1;
  }
  // 一条都放不下 ⇒ 不折叠（否则摘要只剩计数，正是要避免的空壳形态）
  if (parts.length === 0) return null;

  const body =
    head +
    parts.join('；') +
    (omitted > 0 ? `…（另有 ${omitted} 条因长度上限未列出）` : '');

  // 折叠摘要只在**整批同主题**时继承 topic；跨主题时留空，
  // 避免把混批错误标成某一个主题。全部主题另收进 `topics`（落成标签）。
  const topic = singleTopic;
  // 按**出现顺序**收集（不排序）：折叠后正文第一条来自 priority 最高的成员，
  // 其 topic 最有代表性，应排在标签首位。
  const topics: string[] = [];
  for (const f of unique) {
    if (f.topic === undefined || f.topic.length === 0) continue;
    if (topics.includes(f.topic)) continue;
    if (topics.length >= FOLD_TOPIC_TAG_LIMIT) break;
    topics.push(f.topic);
  }

  // ── 5. 元数据 ──
  // origin 取「含用户」优先：用户原话是需求源，不该被 AI 的推断覆盖。
  const origin: 'user' | 'assistant' = unique.some((f) => f.origin === 'user')
    ? 'user'
    : 'assistant';
  // 临时参数（`这次不超过 5 秒`）不晋升为跨会话规则：只有全批都是 session 才算 session。
  const scope: MemoryFact['scope'] = unique.every((f) => f.scope === 'session')
    ? 'session'
    : 'project';
  // 重要性取成员最大值：一批里只要有一条高价值约束，整批就该被优先召回。
  const importance = Math.max(
    ...unique.map((f) => importanceOf({ ...f, kind: f.kind, origin: f.origin, scope: f.scope })),
  );
  const turn = unique.reduce((max, f) => Math.max(max, f.source.turn ?? 0), 0);

  const fact: MemoryFact = {
    kind: dominantKind,
    subject: '',
    predicate: '',
    value: '',
    statement: body,
    scope,
    origin,
    confidence: 0.9,
    source: { sessionId: unique[0].source.sessionId, turn: turn > 0 ? turn : undefined },
    status: 'active',
    // 摘要不是三元组，不可参与冲突判定 —— 显式标 false，
    // 让 `factKey` 退化为按整句比对（避免与真结论误合并）。
    enriched: false,
    // 摘要继承批次主题 ⇒ `factToItem` 会把它落成 `topic:xxx` 标签，
    // 让这条摘要在库里也能被主题检索到（★2026-11-17）
    ...(topic === undefined ? {} : { topic }),
  };

  return { fact, covered: unique.length, omitted, importance, topics };
}

/**
 * 折叠摘要的标签。
 *
 * `folded` 供审计与后续过滤；`fold:N` 保留被折叠的原始条数，
 * 使「1515 条碎片被压成多少条摘要」可被直接统计出来。
 *
 * ## 必须带 `scope:`（2026-11-17 审查修出的 minor）
 *
 * 修前折叠摘要缺 `scope:xxx` 标签，于是「按 scope 过滤」对摘要整体失效
 * （临时参数摘要会在跨会话检索里被当成长期规则召回）。
 * `factToItem` 已收成统一基座，这里补齐与 `factsToItems` 同口径的 scope 标签。
 */
export function foldTags(batch: FoldedBatch): string[] {
  return [
    batch.fact.kind,
    'folded',
    `fold:${batch.covered}`,
    'lrc_schema',
    'distilled',
    `scope:${batch.fact.scope}`,
    // 全部成员主题落成标签（正文不重复它们，避免膨胀）
    ...batch.topics.flatMap((t) => topicTags(t)),
  ];
}
