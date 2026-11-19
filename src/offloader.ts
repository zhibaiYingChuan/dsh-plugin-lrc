/**
 * 持续记忆沉淀：把对话边聊边搬进 LRC 长期记忆。
 *
 * ## 唯一写入路径
 *
 * ```
 * 文本块 ──► extractFacts() ──► validateFact() ──► dedupeFacts() ──► migrate
 * ```
 *
 * 本模块只做「切片 / 查重 / 落库 / 产出快照」，**不做任何语义判定** ——
 * 判定全部在 `memory-schema.ts`（唯一真理源）与 `memory-extract.ts`
 * （唯一提取器）。这样任何修复都只有一处可落，不存在「补丁落在路径之外」。
 *
 * ## 与「压缩时抢救」的区别
 *
 * 压缩时抢救 = 上下文已经涨到阈值，才把结论捞出来。此时已经晚了：
 * 宿主会生成一句干瘪摘要，约束全丢。
 *
 * 持续沉淀 = 每 N 步 / 8 轮 / 6000 字符就把结论搬走。
 *
 * ## 本模块不依赖 DSH
 *
 * 事件订阅在 index.ts 里做，这样核心逻辑可以脱离宿主单测。
 */
import type { DistilledItem, LrcClient } from './lrc-client.ts';
import { advanceCursor, sliceByCursor, type CursorStore, type RecentStore } from './cursor.ts';
import {
  areNearDuplicate,
  DEFAULT_DEDUP_THRESHOLD,
  isDuplicate,
} from './memory-filter.ts';
import {
  dedupeFacts,
  extractFacts,
  extractFactsFromReasoning,
} from './memory-extract.ts';
import {
  factsToItems,
  factToItem,
  type MemoryFact,
} from './memory-schema.ts';
import {
  foldFacts,
  foldTags,
  FOLD_MAX_CHARS,
  FOLD_MIN_FACTS_DEFAULT,
} from './fold.ts';

export interface OffloadConfig {
  /** 累计多少轮触发一次卸载 */
  turnsThreshold: number;
  /** 累计多少字符触发一次卸载 */
  charsThreshold: number;
  /** 累计多少步触发一次卸载（长任务里正文很少，靠步数兜底） */
  stepsThreshold: number;
  /** 记忆归属项目 */
  project: string;
  /** 单次最多提炼条数 */
  maxItems: number;
  /** 快照里最多列几条 */
  snapshotItems: number;
  /** 本地查重阈值（Jaccard） */
  dedupThreshold: number;
  /** 查重时回看多少条已发送的块 */
  recentWindow: number;
  /**
   * 同批折叠开启（默认 true）。
   *
   * 关闭后行为与本模块引入折叠前**逐字一致**（每条 Fact 独立入库）——
   * 用于对照实验与回滚。
   */
  foldEnabled: boolean;
  /** 低于此条数不折叠（默认 [`FOLD_MIN_FACTS_DEFAULT`]） */
  foldMinFacts: number;
  /** 折叠摘要字符上限（默认 [`FOLD_MAX_CHARS`]） */
  foldMaxChars: number;
}

export const DEFAULT_OFFLOAD_CONFIG: OffloadConfig = {
  turnsThreshold: 8,
  charsThreshold: 6000,
  stepsThreshold: 20,
  project: 'dsh',
  maxItems: 40,
  snapshotItems: 3,
  dedupThreshold: DEFAULT_DEDUP_THRESHOLD,
  recentWindow: 50,
  foldEnabled: true,
  foldMinFacts: FOLD_MIN_FACTS_DEFAULT,
  foldMaxChars: FOLD_MAX_CHARS,
};

export interface OffloadResult {
  /** 本次处理的字符数 */
  charsSent: number;
  /** 通过 schema 校验的条数 */
  distilled: number;
  /** 新写入条数 */
  written: number;
  /** 合并进已有记忆的条数 */
  merged: number;
  /** 被本地查重丢弃的条数 */
  deduped: number;
  /** 折叠摘要覆盖的原始条数（0 = 本次未折叠） */
  folded?: number;
  /**
   * 本次**转交轮末暂存**、尚未写库的条数（0/undefined = 未转交）。
   *
   * 折叠开启时 `offload()` 不再直接写库，而是把这批 Fact 交给
   * [`Self::flushTurn`] 与同轮其它 Fact 一起折叠。此时 `written` 为 0，
   * 但内容**没有丢** —— 只是延后到轮末。调用方据此区分
   * 「真的没写」与「延后写」。
   */
  deferred?: number;
  /** 注入下一轮的状态快照（1~3 行） */
  snapshot: string;
  /** 游标是否因 transcript 重写而失效 */
  reset: boolean;
}

/** 沉淀累计统计（`lrc_status` 用）。 */
export interface OffloadStats {
  flushCount: number;
  totalWritten: number;
  totalMerged: number;
  totalDeduped: number;
  lastFlushAt: number;
  lastFlushWritten: number;
  lastFlushMerged: number;
  recentWindow: number;
  /** 累计被折叠覆盖的原始 Fact 条数 */
  totalFolded: number;
  /** 累计产出批次摘要条数（`totalFolded / totalFlushes` 即平均压缩比） */
  foldBatches: number;
}

/** 快照优先级（0 最高）。 */
function keepPriority(fact: MemoryFact): number {
  switch (fact.kind) {
    case 'location':
    case 'constraint':
    case 'goal':
      return 0;
    case 'artifact':
      // ## 工件指针必须与 location 同级（★2026-11-14 审查 P1）
      //
      // 它的作用是「告诉模型有这样一份长文档，要用就去取」。若排进 rank 3
      // （默认分支），`snapshotItems=3` 时会被三条约束完全挤掉 ——
      // 实测：3 条约束 + 1 条工件指针 → 快照里**没有**工件，模型因此
      // 永远不知道该调 `lrc_fetch_artifact`，落盘等于白做。
      //
      // 排 0 是因为它与「资源在哪」同属**现场状态**：缺了它，接手方会在
      // 一个信息不全的现场里继续干活。
      return 0;
    case 'decision':
      return 1;
    case 'conclusion':
      return 2;
    default:
      return 3;
  }
}

/**
 * 把记忆压成一行状态快照。
 *
 * ## 为什么不是「取最近几条」
 *
 * 原实现是 `items.slice(0, maxItems)` —— 纯按顺序取，等于「最新优先」。
 * 实测注入序列（session-e1419190，20 次注入）全是**过程中遇到的问题**，
 * 没有一条是「当前任务的约束」；而 turn 4 用户明确说「音频在桌面，
 * 别走 IDM 下载」，这条约束从未进入快照。
 *
 * ## 现在的取法
 *
 * 约束 / 目标 / 资源位置 > 决策 > 结论 > 事实，同类按新到旧，
 * 且**跨类轮转** —— 单纯按类别排序后取前 N 条，会让同质条目
 * （三条都在说「缓存放工作区外」）占满全部槽位。
 */
export function buildSnapshot(facts: readonly MemoryFact[], maxItems: number): string {
  if (facts.length === 0) return '';
  const picked = pickDiverseSnapshot(facts, maxItems);
  if (picked.length === 0) return '';
  return `[LRC 状态] ${picked.join('；')}。细节在 LRC，需要时 recall。`;
}

/**
 * 跨类轮转取词，同类去掉近似重复。
 *
 * @param facts - 候选池（应为新到旧）
 * @param maxItems - 最多输出几条
 */
export function pickDiverseSnapshot(facts: readonly MemoryFact[], maxItems: number): string[] {
  if (facts.length === 0 || maxItems <= 0) return [];

  const groups = new Map<number, MemoryFact[]>();
  for (const fact of facts) {
    const rank = keepPriority(fact);
    const list = groups.get(rank) ?? [];
    list.push(fact);
    groups.set(rank, list);
  }

  const bodyOf = (fact: MemoryFact): string => fact.statement.trim();
  const keyOf = (s: string): string => s.replace(/[\s，。；：、！？（）()"'`*]/g, '');

  const picked: string[] = [];
  const pickedKeys: string[] = [];
  const cursor = new Map<number, number>();

  const push = (fact: MemoryFact): void => {
    const body = bodyOf(fact);
    picked.push(body.length > 120 ? `${body.slice(0, 120)}…` : body);
    pickedKeys.push(keyOf(body));
  };

  /** 取一条未与已选重复的候选。 */
  const takeNext = (rank: number): boolean => {
    const list = groups.get(rank) ?? [];
    let i = cursor.get(rank) ?? 0;
    while (i < list.length) {
      const fact = list[i] as MemoryFact;
      const key = keyOf(bodyOf(fact));
      i += 1;
      if (key.length === 0) continue;
      if (pickedKeys.some((p) => areNearDuplicate(p, key, 0.75))) continue;
      push(fact);
      cursor.set(rank, i);
      return true;
    }
    cursor.set(rank, i);
    return false;
  };

  /**
   * 从指定类别里取一条**满足谓词**的候选并摘掉它。
   *
   * 必须从组里 `splice` 而不是只挪游标：目标常常排在若干条目之后，
   * 把游标设到 `idx + 1` 会把它前面那些条目一起跳过（实测导致
   * 「不要用 IDM 下载」被跳掉、反而注入了低优先级结论）。
   */
  const takeMatching = (rank: number, pred: (f: MemoryFact) => boolean): boolean => {
    const list = groups.get(rank) ?? [];
    const idx = list.findIndex(pred);
    if (idx < 0) return false;
    push(list[idx] as MemoryFact);
    list.splice(idx, 1);
    return true;
  };

  // ── 第一步：给三类「现场状态」预留槽位 ──
  //
  // 1. **资源位置**（`D:\Desktop，score.wav`）：事故里模型缺的就是「源文件在哪」。
  // 2. **用户纠正**：只提权资源位置时，它会与大量助手约束争第二槽位，
  //    实测注入次数从 3/16 回退到 1/15。
  // 3. **工件指针**（★2026-11-14 审查 P1）：长文本落盘后，这是模型
  //    知道「该去取回什么」的**唯一线索**。实测不给预留时，
  //    3 条约束就能把它完全挤掉，落盘等于白做。
  //
  // 三个预留都要求 `maxItems >= 3`：`snapshotItems=3`（生产默认）下，
  // 优先级依次是「资源位置 → 工件指针 → 用户纠正」，剩下的空位才给约束。
  //
  // ## 为什么先占工件而不是用户纠正
  //
  // 用户纠正通常已被抽成 constraint（rank 0），即使不做专属预留也还在
  // 轮转队列里；而工件指针是**唯一**的索引，丢了就再没有别的线索。
  if (maxItems >= 3) {
    takeMatching(0, (f) => f.kind === 'location');
    takeMatching(0, (f) => f.kind === 'artifact');
    takeMatching(0, (f) => f.origin === 'user' && f.kind !== 'location' && f.kind !== 'artifact');
  }

  // ── 第二步：只在高价值类（约束/目标/位置、决策）之间轮转 ──
  //
  // 实测：`maxItems=3` 时若让「约束/决策/结论」各占一条，新加入的高价值
  // 约束就进不来 —— 结论虽优先级最低，却在第一轮就锁定第三个槽位。
  const order = [...groups.keys()].sort((a, b) => a - b);
  const HIGH = order.filter((r) => r <= 1);
  const LOW = order.filter((r) => r > 1);

  let progress = true;
  while (picked.length < maxItems && progress) {
    progress = false;
    for (const rank of HIGH) {
      if (picked.length >= maxItems) break;
      if (takeNext(rank)) progress = true;
    }
  }

  // ── 第三步：仍有余位才用结论/事实补满 ──
  for (const rank of [...LOW, ...HIGH]) {
    if (picked.length >= maxItems) break;
    while (picked.length < maxItems && takeNext(rank)) {
      // 继续填这个类别
    }
  }
  return picked;
}

export class Offloader {
  /**
   * LRC 客户端**可后置注入**。
   *
   * 为什么不是构造时写死：插件可能在 LRC 还没起来时加载（实测桌面端晚 20 分钟），
   * 此前的做法是整个 Offloader 都不创建 —— 连 `observe()` 的计数都不做，
   * 于是 LRC 恢复后，之前那些轮次的内容已经不在待沉淀队列里了。
   */
  private client: LrcClient | null;
  private readonly cursors: CursorStore;
  private readonly config: OffloadConfig;
  private readonly recentStore?: RecentStore;
  private pendingTurns = 0;
  private pendingChars = 0;
  private pendingSteps = 0;
  /** 最近已发送的内容，用于本地查重（跨会话共享，避免重复入库） */
  private recent: string[] = [];
  /**
   * 快照候选池（**跨批累积**，上限 20）。
   *
   * `buildSnapshot` 只对**传入的那一批**排序，而真实调用每次只传
   * 当前这一条消息抽出的 1~2 条 —— 此时「按类别优先排序」在数学上
   * 等于「原序」，整场会话结束时关键约束全被下一条过程记录顶掉。
   */
  private snapshotPool: MemoryFact[] = [];
  private readonly snapshotPoolMax = 20;
  /**
   * 池代次：会话切换时递增，用于丢弃**在飞**的旧会话沉淀结果。
   *
   * 光有 `snapshotGeneration` 不够：那个闸门在 `index.ts` 的 `.then` 回调里，
   * 而 `buildPooledSnapshot()` **内部**就改池子 —— 等闸门返回时池子早已被改脏。
   */
  private poolEpoch = 0;
  private flushCount = 0;
  private totalWritten = 0;
  private totalMerged = 0;
  private totalDeduped = 0;
  private lastFlushAt = 0;
  private lastFlushWritten = 0;
  private lastFlushMerged = 0;
  private totalFolded = 0;
  private foldBatches = 0;

  constructor(
    client: LrcClient | null,
    cursors: CursorStore,
    config: Partial<OffloadConfig> = {},
    recentStore?: RecentStore,
  ) {
    this.client = client;
    this.cursors = cursors;
    this.config = { ...DEFAULT_OFFLOAD_CONFIG, ...config };
    this.recentStore = recentStore;
    // 查重窗口跨插件重启保留：否则重启后换措辞复述会重新入库
    this.recent = recentStore?.load() ?? [];
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** 当前池代次（发起异步请求时先取一份，返回时比对）。 */
  get epoch(): number {
    return this.poolEpoch;
  }

  bind(client: LrcClient | null): void {
    this.client = client;
  }

  private requireClient(): LrcClient {
    if (this.client === null) {
      throw new Error('LRC 尚未连接');
    }
    return this.client;
  }

  /** 记录一轮新增文本（由 index.ts 在 assistant/message 事件里调用）。 */
  observe(text: string): void {
    if (text.trim().length === 0) return;
    this.pendingTurns += 1;
    this.pendingChars += text.length;
  }

  /**
   * 记录一步。
   *
   * 长任务（88 步 / 138 次工具调用）里正文可能只有最后一条，
   * 只按"正文消息数"计数永远到不了阈值 —— 必须同时按步数兜底。
   */
  observeStep(): void {
    this.pendingSteps += 1;
  }

  shouldOffload(): boolean {
    return (
      this.pendingTurns >= this.config.turnsThreshold ||
      this.pendingChars >= this.config.charsThreshold ||
      this.pendingSteps >= this.config.stepsThreshold
    );
  }

  /**
   * 是否有待沉淀内容（turn/end 兜底用）。
   *
   * 必须包含 `pendingSteps`：长任务里可能只有工具调用、没有正文，
   * 此时步数阈值已经触发，但 turns/chars 都是 0。
   */
  hasPending(): boolean {
    return this.pendingTurns > 0 || this.pendingChars > 0 || this.pendingSteps > 0;
  }

  resetCounters(): void {
    this.pendingTurns = 0;
    this.pendingChars = 0;
    this.pendingSteps = 0;
  }

  /**
   * 清空快照池（**会话切换时必须调用**）。
   *
   * 池子里装的是本会话的约束/决策，换会话后不能继续注入 ——
   * 那与 `bindSnapshotToSession` 防的跨会话泄漏是同一类问题。
   */
  resetSnapshotPool(): void {
    this.snapshotPool = [];
    this.poolEpoch += 1;
  }

  /**
   * 把新条目并入池子，再用**整个池子**生成快照。
   *
   * @param facts - 本批新记忆
   * @param epoch - 发起请求时的池代次；与当前不一致说明已切会话，
   *                这批结果属旧会话，**不得写入池子**
   */
  private buildPooledSnapshot(facts: readonly MemoryFact[], epoch: number = this.poolEpoch): string {
    if (epoch !== this.poolEpoch) return '';
    const seen = new Set(this.snapshotPool.map((f) => f.statement.replace(/\s+/g, '')));
    for (const fact of facts) {
      const key = fact.statement.replace(/\s+/g, '');
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      this.snapshotPool.push(fact);
    }
    if (this.snapshotPool.length > this.snapshotPoolMax) {
      // ## 淘汰判据必须与取词判据**同一套**（`keepPriority`）
      //
      // 上一版淘汰只认 preference/decision，而取词把「资源位置」也提到
      // rank 0 —— 两边不一致时，资源位置进了池但一满就被删，
      // 提权在真实时序下完全失效（实测前 24 次注入一次都没出现）。
      const isHigh = (f: MemoryFact): boolean => keepPriority(f) <= 1;

      // 资源位置与工件指针要**钉住**：两者天然最早确立（用户一上来就
      // 交代文件在哪 / 贴进长文档），而下面按「新到旧」保留的规则会让它们
      // 第一个被丢。工件上限单独算，避免一份长文档占满 pin 名额。
      const pinned: MemoryFact[] = [];
      const rest: MemoryFact[] = [];
      let pinnedLoc = 0;
      let pinnedArtifact = 0;
      for (const fact of this.snapshotPool) {
        if (fact.kind === 'location' && pinnedLoc < 2) {
          pinned.push(fact);
          pinnedLoc += 1;
        } else if (fact.kind === 'artifact' && pinnedArtifact < 1) {
          pinned.push(fact);
          pinnedArtifact += 1;
        } else {
          rest.push(fact);
        }
      }

      const high = rest.filter(isHigh);
      const low = rest.filter((f) => !isHigh(f));
      const budget = Math.max(0, this.snapshotPoolMax - pinned.length);

      // ## 两个必须避开的坑
      //
      // 1. `slice(-0)` 返回整个数组（JS 规范）⇒ 池子无界增长。
      // 2. 保留哪一端：池子追加式，`slice(0, max)` 留的是**最旧**的，
      //    与「越新越相关」相反。所以高价值按新到旧保留。
      const highKept = budget > 0 ? high.slice(-budget) : [];
      const room = Math.max(0, budget - highKept.length);
      this.snapshotPool = room > 0 ? [...pinned, ...highKept, ...low.slice(-room)] : [...pinned, ...highKept];
    }
    // 池子是追加的（旧 → 新），注入时从新到旧取
    return buildSnapshot([...this.snapshotPool].reverse(), this.config.snapshotItems);
  }

  stats(): OffloadStats {
    return {
      flushCount: this.flushCount,
      totalWritten: this.totalWritten,
      totalMerged: this.totalMerged,
      totalDeduped: this.totalDeduped,
      lastFlushAt: this.lastFlushAt,
      lastFlushWritten: this.lastFlushWritten,
      lastFlushMerged: this.lastFlushMerged,
      recentWindow: this.recent.length,
      totalFolded: this.totalFolded,
      foldBatches: this.foldBatches,
    };
  }

  private record(result: OffloadResult): void {
    this.totalDeduped += result.deduped;
    if (result.folded !== undefined && result.folded > 0) {
      this.totalFolded += result.folded;
      this.foldBatches += 1;
    }
    if (result.written === 0 && result.merged === 0) return;
    this.flushCount += 1;
    this.totalWritten += result.written;
    this.totalMerged += result.merged;
    this.lastFlushAt = Date.now();
    this.lastFlushWritten = result.written;
    this.lastFlushMerged = result.merged;
  }

  /**
   * 把一批已查重的 Fact 转成待写入条目 —— **写入前先做同批折叠**。
   *
   * ## 为什么折叠只在写入侧
   *
   * 快照（注入下一轮的那 1~3 行）仍用**原始 Fact**：它服务的是
   * 「本会话当前的约束/位置」，需要具体到「音频在 D:\Desktop」这种粒度；
   * 批次摘要只适合存进 LRC 供日后 recall。两个消费者需求相反，
   * 因此折叠只作用于 `migrate` 的入参，不改快照。
   *
   * ## 为什么条数不足时原样返回
   *
   * `foldFacts` 在条数 < `foldMinFacts` 时返回 `null`，这里退回逐条映射，
   * 行为与本模块引入折叠前**逐字一致**。
   *
   * @returns `items` 待写入条目；`folded` 折叠覆盖的原始条数（0 = 未折叠）
   */
  private toItems(facts: readonly MemoryFact[]): { items: DistilledItem[]; folded: number } {
    if (this.config.foldEnabled) {
      const batch = foldFacts(facts, {
        minFacts: this.config.foldMinFacts,
        maxChars: this.config.foldMaxChars,
      });
      if (batch !== null) {
        const item = factToItem(batch.fact, foldTags(batch), batch.importance);
        return { items: [item as DistilledItem], folded: batch.covered };
      }
    }
    return { items: factsToItems(facts) as DistilledItem[], folded: 0 };
  }

  /**
   * 执行一次卸载：从 transcript 的新增切片提取记忆并落库。
   *
   * @param sessionId 会话 ID（游标按会话分槽）
   * @param lines 当前 transcript 的全部行
   */
  async offload(
    sessionId: string,
    lines: readonly (string | { text: string; origin?: 'user' | 'assistant' })[],
  ): Promise<OffloadResult | null> {
    const epoch = this.poolEpoch;
    const state = this.cursors.get(sessionId);
    const plain = lines.map((l) => (typeof l === 'string' ? l : l.text));
    const originOf = (i: number): 'user' | 'assistant' => {
      const l = lines[i];
      return typeof l === 'string' ? 'assistant' : (l.origin ?? 'assistant');
    };
    const slice = sliceByCursor(plain, state);

    if (slice.text.trim().length === 0) {
      this.resetCounters();
      return null;
    }

    // 每个元素就是一条完整消息（可能多行）—— 正好是提取单元。
    // **不能按物理行切**：围栏状态需要跨行维护，逐行处理会让代码透传。
    const collected: MemoryFact[] = [];
    let charsSent = 0;
    for (let i = slice.fromLine; i < plain.length; i += 1) {
      const message = plain[i] as string;
      if (message.trim().length === 0) continue;
      charsSent += message.length;
      const result = extractFacts({
        text: message,
        origin: originOf(i),
        sessionId,
        turn: i,
      });
      collected.push(...result.facts);
    }

    // 本地查重（跨批 + 批内）：换措辞复述连 HTTP 都不发
    const { fresh, dropped } = dedupeFacts(collected, [], (a, b) =>
      areNearDuplicate(a, b, this.config.dedupThreshold),
    );
    const kept: MemoryFact[] = [];
    let deduped = dropped;
    for (const fact of fresh) {
      if (isDuplicate(fact.statement, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      kept.push(fact);
    }

    if (kept.length === 0) {
      // 本段确实没有可入库内容 ⇒ 游标可以安全推进（不会丢任何东西）
      this.commitCursor(sessionId, plain, slice.fromLine);
      const empty: OffloadResult = {
        charsSent,
        distilled: 0,
        written: 0,
        merged: 0,
        deduped,
        snapshot: '',
        reset: slice.reset,
      };
      this.record(empty);
      return empty;
    }

    // ## 折叠开启时，**不得在这里直接写库**（2026-11-17 实测新会话发现）
    //
    // `flush()` 在 turn/end 会调到这里，而它每次只处理**游标之后的新增片段** ——
    // 一个 step 往往只有 1~2 条 Fact，凑不满 `foldMinFacts`（4 条），
    // 于是 `toItems` 退化为逐条写入。实测新会话 20:37~20:40：
    // ```
    // 9 条互不相关的短句直接入库（`像素画的动感只能靠逐帧切换` 18 字）
    // 而此前 flushTurn 的折叠摘要已经写过 ⇒ 折叠路径是通的，是这条绕过了它
    // ```
    // 修法：折叠开启时把结果交给**轮末桶**，与正文抽取的 Fact 汇成一批。
    // 游标照常推进 —— 这些 Fact 已被 `turnFacts` 接住，不会丢。
    if (this.config.foldEnabled && kept.length > 0) {
      this.accumulate(kept);
      this.commitCursor(sessionId, plain, slice.fromLine);
      // ## 不 push `recent`（2026-11-17 实测发现）
      //
      // `recent` 的用途是「防止**已写库**内容被换措辞重复写入」。
      // 这批还只在内存桶里、尚未写库，若推进 `recent`，轮末 `flushTurn`
      // → `offloadFacts` 会用它去重 ⇒ **转交的这批判为重复、凭空少掉**
      // （实测：4 条桶收口后只剩 3 条，foldMinFacts 不够 ⇒ 退化为逐条）。
      // 重复抽取由**游标已推进**挡住，不需要 recent 兜底。
      const deferred: OffloadResult = {
        charsSent,
        distilled: kept.length,
        written: 0,
        merged: 0,
        deduped,
        folded: 0,
        deferred: kept.length,
        snapshot: this.buildPooledSnapshot(kept, epoch),
        reset: slice.reset,
      };
      this.record(deferred);
      return deferred;
    }

    const { items, folded } = this.toItems(kept);
    const migrated = await this.requireClient().migrate(items, this.config.project);
    // **只有 migrate 成功才推进游标**（见方法尾部注释）
    this.commitCursor(sessionId, plain, slice.fromLine);
    this.recent.push(...kept.map((f) => f.statement));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);

    const result: OffloadResult = {
      charsSent,
      distilled: kept.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      folded,
      snapshot: this.buildPooledSnapshot(kept, epoch),
      reset: slice.reset,
    };
    this.record(result);
    return result;
  }

  /**
   * 本轮累积器（按**轮次**为边界，不是按条数）。
   *
   * ## 为什么边界是「轮」而不是「N 条」
   *
   * 折叠的主旨是让「一批」成为**语义批次**。`assistant/message` 是逐条触发的，
   * 若每条都立即写库，实测按分钟切分时 **845/993 批不足 4 条**
   * （其中 448 批只有 1 条）—— 折叠只在约 36% 的事实上生效。
   *
   * 而一轮对话（5~15 分钟）天然把「同一次排查/同一件事」圈在一起：
   * 实测按 5/10/60 分钟窗，折叠覆盖的事实占比分别为
   * **71.8% / 87.4% / 99.0%**。
   *
   * ## 为什么**不**按 topic 再分桶（实测否决）
   *
   * 曾按 `轮 × topic` 分桶，想避免「整轮摘要被标成第一条消息的主题」。
   * 实测该 session（42 轮 / 238 条有产出的消息 / 266 条 Fact）：
   * ```
   * 分桶数 238，其中能折叠（≥4 条）的只有 2 个
   * ⇒ 条数 266 → 260（97.7%），折叠等于没做
   * ```
   * 根因：平均每条消息只产 1.1 条 Fact，topic 几乎等于消息唯一标识，
   * 按 topic 分桶**退化为按消息分桶**，折叠永远凑不满。
   *
   * 正确做法是：仍按轮分桶，但在**摘要正文里逐条保留各自的主题**
   * （见 `foldFacts` 的 topic 处理），让主题信息不丢，同时保住折叠率。
   *
   * ## 与「攒 8 条」的区别
   *
   * 8 是魔法数字 —— 它既不对应任何语义边界，又会让某些轮次不触发、
   * 某些轮次提前触发。轮次是宿主已有的真实边界。
   */
  private turnFacts = new Map<string, MemoryFact[]>();

  /**
   * 把 Fact **暂存到本轮**（不落库），等 [`Self::flushTurn`] 统一折叠写入。
   *
   * ## 调用方必须保证「轮末一定冲刷」
   *
   * 暂存意味着数据只在内存里。调用方要在这三个时机冲刷：
   * 1. `turn/end`
   * 2. **下一次 `turn/start`**（用户中止上一轮时走不到 turn/end ——
   *    实测 turn 2/3 都是 aborted by user）
   * 3. 切换会话（旧会话不会再收到 turn/end）
   *
   * @returns 当前暂存总条数（便于调用方判断是否触达上限）
   */
  accumulate(facts: readonly MemoryFact[]): number {
    if (facts.length === 0) return 0;
    for (const fact of facts) {
      const owner = fact.source.sessionId ?? '';
      const list = this.turnFacts.get(owner) ?? [];
      list.push(fact);
      this.turnFacts.set(owner, list);
    }
    return this.turnPending();
  }

  /** 本轮已暂存但未写库的条数（`lrc_status` 用）。 */
  turnPending(owner?: string): number {
    if (owner !== undefined) return this.turnFacts.get(owner)?.length ?? 0;
    let total = 0;
    for (const list of this.turnFacts.values()) total += list.length;
    return total;
  }

  /**
   * 冲刷本轮暂存的 Fact（**折叠后一次写库**）。
   *
   * @param owner - 只冲刷该会话的桶；缺省冲刷全部
   * @param options.intoPool - 是否并入快照池。**切会话后补写旧会话时必须传
   *   `false`** —— 与 `offloadFacts` 同口径：那时池子已属于新会话，
   *   把旧会话的约束推进去会让新会话下一次注入出现「B 的约束；A 私有：…」。
   * @returns 合并后的写入结果；无暂存时返回零值结果
   */
  async flushTurn(
    owner?: string,
    options: { intoPool?: boolean } = {},
  ): Promise<OffloadResult> {
    const empty: OffloadResult = {
      charsSent: 0,
      distilled: 0,
      written: 0,
      merged: 0,
      deduped: 0,
      folded: 0,
      snapshot: '',
      reset: false,
    };
    // ## 桶键就是会话 ID（按轮累积，不按 topic 再分）
    const keys = owner === undefined ? [...this.turnFacts.keys()] : [owner];
    // ## 先取走再写，但**写失败必须回桶**（2026-11-17 独立审查修出的 critical）
    //
    // 旧实现删桶后 `await offloadFacts(batch)` 一旦抛错（migrate 超时/503/
    // LRC 重启），这批 Fact 已从 Map 移除，调用方只 `logger.warn` ⇒
    // **数据永久丢失**。这与项目红线「宁重不漏」直接冲突
    // （历史事故：LRC 桌面端晚起 20 分钟导致约束永久丢失）。
    //
    // 修法：每个桶独立 try/catch，失败时把 batch **放回桶头**并继续下一个桶。
    // 重复写入的代价可接受 —— LRC 的 migrate 是幂等的（相似度命中即合并），
    // 且 `recent` 窗口会挡掉同一批的重复。
    const results: OffloadResult[] = [];
    for (const key of keys) {
      const list = this.turnFacts.get(key);
      if (list === undefined || list.length === 0) continue;
      this.turnFacts.delete(key);
      try {
        results.push(await this.offloadFacts(list, options));
      } catch (error) {
        // 放回桶头（保持原有先后顺序：这批比后来的更新，但也比未来的旧）
        const current = this.turnFacts.get(key) ?? [];
        this.turnFacts.set(key, [...list, ...current]);
        // 继续处理其它桶：一个会话失败不该阻塞别的会话
        continue;
      }
    }
    if (results.length === 0) return empty;

    return {
      charsSent: results.reduce((s, r) => s + r.charsSent, 0),
      distilled: results.reduce((s, r) => s + r.distilled, 0),
      written: results.reduce((s, r) => s + r.written, 0),
      merged: results.reduce((s, r) => s + r.merged, 0),
      deduped: results.reduce((s, r) => s + r.deduped, 0),
      folded: results.reduce((s, r) => s + (r.folded ?? 0), 0),
      // 多桶时取最后一个非空快照（最新状态）
      snapshot: [...results].reverse().find((r) => r.snapshot.length > 0)?.snapshot ?? '',
      reset: false,
    };
  }

  /**
   * 直接沉淀一批已提取的记忆（**立即写库，不走轮内累积**）。
   *
   * 用于推理兜底与 LLM 补全：这些内容不在 transcript 行流里，
   * 无法用行号游标追踪，只能按内容查重。
   *
   * @param options.intoPool - 是否并入快照池。**补写旧会话时必须传 `false`**：
   *   补写发生在切会话之后，此时池子已属于新会话，push 进去会让新会话
   *   下一次注入出现「B 的约束；A 会话私有：…」。
   */
  async offloadFacts(
    facts: readonly MemoryFact[],
    options: { intoPool?: boolean; deferToTurn?: boolean } = {},
  ): Promise<OffloadResult> {
    const epoch = this.poolEpoch;
    const { fresh, dropped } = dedupeFacts(facts, [], (a, b) =>
      areNearDuplicate(a, b, this.config.dedupThreshold),
    );
    const kept: MemoryFact[] = [];
    let deduped = dropped;
    for (const fact of fresh) {
      // 同批也要查重：模型常把同一条约束说三遍
      if (isDuplicate(fact.statement, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      kept.push(fact);
    }
    if (kept.length === 0) {
      const empty: OffloadResult = {
        charsSent: 0,
        distilled: 0,
        written: 0,
        merged: 0,
        deduped,
        folded: 0,
        snapshot: '',
        reset: false,
      };
      this.record(empty);
      return empty;
    }

    // ## 延后到轮末（2026-11-17 实测新会话发现）
    //
    // 推理兜底 / LLM 兜底 / 切会话补写这几条路径的产物**不在 transcript 行流里**，
    // 各自只有 1~3 条，单独走折叠永远凑不满 `foldMinFacts` ⇒ 逐条碎片入库。
    // 实测新会话 20:37~20:40 写入的 9 条全是这种形态。
    // 调用方传 `deferToTurn: true` 时先入桶，等 `flushTurn` 与本轮其它 Fact 一起折叠。
    if (options.deferToTurn === true && this.config.foldEnabled) {
      this.accumulate(kept);
      // 同样**不 push recent**：这批尚未写库，推进 recent 会让轮末收口
      // 把自己判成重复（见 `offload()` 同名分支的注释）。
      const deferred: OffloadResult = {
        charsSent: kept.reduce((sum, f) => sum + f.statement.length, 0),
        distilled: kept.length,
        written: 0,
        merged: 0,
        deduped,
        folded: 0,
        deferred: kept.length,
        snapshot: options.intoPool === false ? '' : this.buildPooledSnapshot(kept, epoch),
        reset: false,
      };
      this.record(deferred);
      return deferred;
    }

    const { items, folded } = this.toItems(kept);
    const migrated = await this.requireClient().migrate(items, this.config.project);
    this.recent.push(...kept.map((f) => f.statement));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);

    const result: OffloadResult = {
      charsSent: kept.reduce((sum, f) => sum + f.statement.length, 0),
      distilled: kept.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      folded,
      snapshot: options.intoPool === false ? '' : this.buildPooledSnapshot(kept, epoch),
      reset: false,
    };
    this.record(result);
    return result;
  }

  /** 推进游标并重置计数器（只在本次内容已处理完时调用）。 */
  private commitCursor(sessionId: string, lines: string[], fromLine: number): void {
    const consumed = lines.length - fromLine;
    this.cursors.set(advanceCursor(lines, sessionId, fromLine, consumed));
    this.resetCounters();
  }
}

/** 供 index.ts 使用的提取入口（保持单一来源）。 */
export { extractFacts, extractFactsFromReasoning };
