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
  type MemoryFact,
} from './memory-schema.ts';

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
    };
  }

  private record(result: OffloadResult): void {
    this.totalDeduped += result.deduped;
    if (result.written === 0 && result.merged === 0) return;
    this.flushCount += 1;
    this.totalWritten += result.written;
    this.totalMerged += result.merged;
    this.lastFlushAt = Date.now();
    this.lastFlushWritten = result.written;
    this.lastFlushMerged = result.merged;
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

    const migrated = await this.requireClient().migrate(factsToItems(kept) as DistilledItem[], this.config.project);
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
      snapshot: this.buildPooledSnapshot(kept, epoch),
      reset: slice.reset,
    };
    this.record(result);
    return result;
  }

  /**
   * 直接沉淀一批已提取的记忆（**不走行游标**）。
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
    options: { intoPool?: boolean } = {},
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
        snapshot: '',
        reset: false,
      };
      this.record(empty);
      return empty;
    }

    const migrated = await this.requireClient().migrate(factsToItems(kept) as DistilledItem[], this.config.project);
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
