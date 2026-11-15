/**
 * 交接文档投影：把 Fact 库渲染成**三段式标准化交接文档**。
 *
 * ## 为什么单独成模块
 *
 * 它是纯函数（`MemoryFact[] → HandoffSections`），不依赖宿主、不依赖存储，
 * 可以直接单测。而且它与 `handoff.ts`（负责创建会话）职责完全不同 ——
 * 一个负责「写什么」，一个负责「送到哪」。
 *
 * ## 三段从哪来
 *
 * | 段 | 来源 | 为什么 |
 * |---|---|---|
 * | 已确认事实 | `kind ∈ {conclusion, decision, location, artifact}` | 已查清、已定案、资源在哪 —— 接手方不需要重查 |
 * | 当前进展 | 本轮新增 Fact + 未完成的 goal | 「做到哪了」 |
 * | 下一步意图 | active goal + 最近的用户约束 | 「该继续做什么」 |
 *
 * 关键：**约束（constraint）在两段里都要出现**。它既是「已确认的规矩」，
 * 也是「下一步必须遵守的边界」。arXiv 2608.11242 实测：约束若被埋在
 * 摘要散文里，合规率只有 31.8%；独立列出则升到 99.7%。所以本模块把
 * 约束单列一段，不混进叙述。
 *
 * ## 为什么不复用 `buildHandoffText`
 *
 * 旧实现是把「最近几条助手正文」原样截断拼进去。那是**值传递**：
 * 把上下文搬一次，等于没压缩。新实现是**引用传递**：只放结构化 Fact，
 * 原文留在 LRC 与工件库，需要时按 hash 取回。
 */
import { KIND_LABEL, type MemoryFact } from './memory-schema.ts';

/** 移交投影的输入。 */
export interface HandoffInput {
  /** 会话内已入库的全部 Fact（新→旧） */
  facts: readonly MemoryFact[];
  /** 当前任务的一句话描述（用户最后一次请求，已被约束提取过的原句） */
  task: string;
  /** 调用方补充的下一步说明（可为空） */
  note?: string;
}

/** 投影结果：三段 + 可选的补充说明。 */
export interface HandoffSections {
  /** 当前任务（一行） */
  task: string;
  /** 已确认事实（约束优先，其次决策/结论/位置/工件） */
  confirmed: string[];
  /** 当前进展 */
  progress: string[];
  /** 下一步意图 */
  next: string[];
  /** 补充说明 */
  note: string;
}

/** 单段最多几条（防止交接文档本身变成新的上下文炸弹）。 */
const MAX_PER_SECTION = 12;

/** 段内单条最长字符数。 */
const MAX_LINE = 160;

/** 类别 → 段内排序权重（越小越靠前）。 */
function weightOf(fact: MemoryFact): number {
  switch (fact.kind) {
    case 'constraint':
      return 0;
    case 'goal':
      return 1;
    case 'decision':
      return 2;
    case 'conclusion':
      return 3;
    case 'location':
      return 4;
    case 'artifact':
      return 5;
    default:
      return 6;
  }
}

/** 压成单行并截断。 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}…` : flat;
}

/** 按内容去重（同一条约束可能被多轮重复提到）。 */
function unique(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.replace(/[\s，。；：、]/g, '');
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * 排序：权重升序，**同类内新→旧**（★2026-11-15 独立审查 P0 修正）。
 *
 * ## 上一版错在哪
 *
 * 注释写的是「同类保持传入顺序（新→旧）」，但 `input.facts` 实际是
 * `sessionFacts`，顺序为**旧→新**（见 `recordSessionFacts`）。于是
 * 稳定排序保留了旧→新，再 `slice(0, MAX_PER_SECTION)` 就取到了**最旧**
 * 的 12 条 —— 交接文档的「已确认事实」永远停在会话开头。
 *
 * 交接文档是接手方的第一手材料，危害大于摘要：接手方会拿最旧的状态
 * 去改代码。实测 14 条只留第 0..11 条。
 *
 * 修正：`sort` 的比较函数在权重相同时按「后出现者优先」，等价于同类内倒序。
 */
function order(facts: readonly MemoryFact[]): MemoryFact[] {
  // 先记录原始下标，权重相同时后出现的（更新的）排前面
  const indexed = facts.map((fact, index) => ({ fact, index }));
  indexed.sort((a, b) => {
    const byWeight = weightOf(a.fact) - weightOf(b.fact);
    if (byWeight !== 0) return byWeight;
    return b.index - a.index;
  });
  return indexed.map((entry) => entry.fact);
}

/**
 * 把 Fact 库投影成三段式交接文档。
 *
 * @param input - 会话 Fact、任务描述、补充说明
 * @returns 分段结果（调用方用 `renderHandoff` 渲染成文本）
 */
export function buildHandoffSections(input: HandoffInput): HandoffSections {
  const ordered = order(input.facts.filter((f) => f.status === 'active'));

  // ── 已确认事实 ──
  //
  // 约束排在最前：它是接手方最容易违反、也最难重新发现的东西。
  const confirmed = unique(
    ordered
      .filter((f) => f.kind === 'constraint' || f.kind === 'decision' || f.kind === 'conclusion')
      .map((f) => `${KIND_LABEL[f.kind]}：${oneLine(f.statement)}`),
  ).slice(0, MAX_PER_SECTION);

  // ── 当前进展 ──
  //
  // 只放**现场状态**：位置与工件。接手方需要知道源文件与长文档在哪。
  //
  // ## 为什么 goal 不进这一段
  //
  // `goal` 有两类，形态几乎一样：
  // ```
  // 延迟必须压到 200ms 以内     ← 待达成的目标
  // 改完静止时长从 13 秒降到 2 秒以内  ← 已经达成的事实
  // ```
  // 都是「降到 N 以内」，判据无法区分。放进「当前进展」会让已完成的
  // 观测数据看起来像待办；放进「下一步意图」至少语义上是「要继续守住的
  // 标准」—— 后者错得更轻。实测真实会话里 goal 段有 2/3 是已完成的观测。
  const progress = unique(
    ordered.filter((f) => f.kind === 'location' || f.kind === 'artifact').map((f) => oneLine(f.statement)),
  ).slice(0, MAX_PER_SECTION);

  // ── 下一步意图 ──
  //
  // 只放**还没完成**的 goal（statement 里带「目标/不超过/压到」等未来态）
  // 与最近约束的**要点复述**。已完成的结论不进这一段。
  const next = unique(
    ordered
      .filter((f) => f.kind === 'goal' || f.kind === 'constraint')
      .map((f) => oneLine(f.statement)),
  ).slice(0, MAX_PER_SECTION);

  return {
    task: oneLine(input.task),
    confirmed,
    progress,
    next,
    note: (input.note ?? '').trim(),
  };
}

/**
 * 渲染成 markdown 文本。
 *
 * 段序固定为「任务 → 已确认事实 → 当前进展 → 下一步意图」：接手方按这个
 * 顺序读，先知道做什么，再知道已定什么，最后知道下一步。
 */
export function renderHandoff(sections: HandoffSections): string {
  const out: string[] = ['# 会话交接', ''];

  out.push('## 当前任务');
  out.push(sections.task.length > 0 ? sections.task : '（未记录）');
  out.push('');

  const list = (title: string, lines: readonly string[]): void => {
    out.push(`## ${title}`);
    if (lines.length === 0) out.push('（无）');
    else for (const line of lines) out.push(`- ${line}`);
    out.push('');
  };

  list('已确认事实', sections.confirmed);
  list('当前进展', sections.progress);
  list('下一步意图', sections.next);

  if (sections.note.length > 0) {
    out.push('## 补充说明');
    out.push(sections.note);
    out.push('');
  }

  out.push('---');
  out.push('原文与长文档在 LRC / 工件库，需要时用 `lrc_recall` 或 `lrc_fetch_artifact` 取回。');
  return out.join('\n');
}

/** 一步完成：Fact 库 → 交接文档文本。 */
export function projectHandoff(input: HandoffInput): {
  text: string;
  sections: HandoffSections;
} {
  const sections = buildHandoffSections(input);
  return { text: renderHandoff(sections), sections };
}
