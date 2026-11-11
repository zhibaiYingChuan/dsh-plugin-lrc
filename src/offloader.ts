/**
 * 持续记忆沉淀：把对话边聊边搬进 LRC 长期记忆。
 *
 * ## 与"压缩时抢救"的区别
 *
 * 压缩时抢救 = 上下文已经涨到阈值，才把结论捞出来。此时已经晚了：
 * 宿主会生成一句干瘪摘要，约束全丢。
 *
 * 持续沉淀 = 每 N 步 / 8 轮 / 6000 字符就把结论搬走，上下文增速降到 1/8 左右。
 *
 * ## 三层过滤都在这里收口
 *
 * 送进 LRC 之前依次经过：硬规则（`hardFilter`）→ 本地查重（`isDuplicate`）。
 * 宿主 LLM 的 `<lrc_memory>` 提炼由 `hardFilter` 优先采纳。
 * LRC 只负责存，不做任何语义判断。
 *
 * ## 本模块不依赖 DSH
 *
 * 只做"给定新增文本 → 过滤 → 提炼 → 落库 → 产出快照行"。
 * 事件订阅在 index.ts 里做，这样核心逻辑可以脱离宿主单测。
 */
import type { DistilledItem, LrcClient } from './lrc-client.ts';
import { advanceCursor, sliceByCursor, type CursorStore, type RecentStore } from './cursor.ts';
import {
  DEFAULT_DEDUP_THRESHOLD,
  extractMemoryTag,
  hardFilter,
  isDuplicate,
  isNoUpdate,
  maskPaths,
} from './memory-filter.ts';

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
  /** 快照里最多列几条结论 */
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
  /** 本次送进 distill 的字符数（验收标准 1 用） */
  charsSent: number;
  /** 提炼出的条数 */
  distilled: number;
  /** 新写入条数 */
  written: number;
  /** 合并进已有记忆的条数 */
  merged: number;
  /** 被本地查重丢弃的块数 */
  deduped: number;
  /** 注入下一轮的状态快照（1~3 行） */
  snapshot: string;
  /** 游标是否因 transcript 重写而失效 */
  reset: boolean;
}

/** 沉淀累计统计（`lrc_status` 用）。 */
export interface OffloadStats {
  /** 累计成功沉淀次数 */
  flushCount: number;
  /** 累计新写入条数 */
  totalWritten: number;
  /** 累计合并进已有记忆的条数 */
  totalMerged: number;
  /** 累计被本地查重丢弃的块数 */
  totalDeduped: number;
  /** 最近一次沉淀时间（毫秒时间戳；0 表示还没沉淀过） */
  lastFlushAt: number;
  /** 最近一次新写入条数 */
  lastFlushWritten: number;
  /** 最近一次合并条数 */
  lastFlushMerged: number;
  /** 当前查重窗口里的块数 */
  recentWindow: number;
}

/** 把提炼结果压成一行状态快照。 */
export function buildSnapshot(items: DistilledItem[], maxItems: number): string {
  if (items.length === 0) return '';
  const picked = items.slice(0, maxItems).map((item) => {
    // 去掉 `[决策] ` 这类前缀，快照里用更短的标签
    const body = item.content.replace(/^\[[^\]]+\]\s*/, '');
    // 40 字符会把中文结论截成半句（实测快照读起来像噪声），放宽到 120。
    const short = body.length > 120 ? `${body.slice(0, 120)}…` : body;
    return short;
  });
  return `[LRC 状态] ${picked.join('；')}。细节在 LRC，需要时 recall。`;
}

/**
 * 过程叙述词：出现这些词说明句子在描述「接下来要做什么」，不是已完成的结论。
 *
 * 实测 DSH 会话里 AI 会把「接下来我要确认工具参数存放在哪里」写成 `- 结论：…`，
 * 插件按行首标签直接挂 `[结论]`，导致结论计数约 10% 虚高。
 */
const PROCESS_NARRATION = /接下来|下一步|我要|待确认|待验证|还需要|准备|打算|将要/;

/** 完成时态词：出现这些词说明句子已经得出结论，即使含过程词也不降级。 */
const COMPLETION_WORDS = /已完成|已确认|已验证|已修复|结论是|因此|所以|说明|表明/;

/** 是否是「过程叙述冒充结论」：含过程词且不含完成词。 */
function isProcessNarration(body: string): boolean {
  return PROCESS_NARRATION.test(body) && !COMPLETION_WORDS.test(body);
}

/**
 * 标签行的类别判定。
 *
 * **行首声明优先**：`决策：…` / `约束：…` / `结论：…` 是模型按系统提示写的固定格式，
 * 必须直接采信。此前先跑关键词匹配，导致「结论：…约束→preference…」这种行
 * 因为正文里出现「约束」二字被劫持成约束。
 * 关键词只在没有行首声明时兜底。
 */
function classifyTagLine(line: string): {
  kind: string;
  memoryType: string;
  tag: string;
  importance: number;
} {
  const head = /^(决策|约束|结论)\s*[：:]/.exec(line);
  if (head !== null) {
    const body = line.slice(head[0].length).trim();
    switch (head[1]) {
      case '约束':
        return { kind: '约束', memoryType: 'preference', tag: 'constraint', importance: 7 };
      case '决策':
        return { kind: '决策', memoryType: 'decision', tag: 'decision', importance: 7 };
      default:
        // 「结论：接下来我要…」是过程叙述，不是结论 → 降级为事实
        if (isProcessNarration(body)) {
          return { kind: '事实', memoryType: 'fact', tag: 'fact', importance: 5 };
        }
        return { kind: '结论', memoryType: 'fact', tag: 'conclusion', importance: 6 };
    }
  }
  // 关键词兜底也要先挖路径：`- 看下 docs/禁止.md` 不该被判成约束。
  const body = maskPaths(line);
  if (/禁止|严禁|不得|不要|不能|切勿|杜绝|不允许|必须|约束|一律|统一为/.test(body)) {
    return { kind: '约束', memoryType: 'preference', tag: 'constraint', importance: 7 };
  }
  if (/决策|决定|采用|改用|选型|定为|换成|改成/.test(body)) {
    return { kind: '决策', memoryType: 'decision', tag: 'decision', importance: 7 };
  }
  return { kind: '结论', memoryType: 'fact', tag: 'conclusion', importance: 6 };
}

/**
 * 把 `<lrc_memory>` 标签内容直接转成记忆条目。
 *
 * **必须绕过 distill**：标签内容已经是宿主 LLM 提炼过的精粮，
 * 再送进 LRC 的规则式打分会被二次过滤 —— 实测 `- 决策：用 pnpm 替代 npm`
 * 因为 `DECISION_WORDS` 里没有「决策」而被直接丢掉。
 */
export function itemsFromTag(tag: string): DistilledItem[] {
  const items: DistilledItem[] = [];
  const lines = tag.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim().replace(/^[-*+]\s*/, '').trim();
    if (line.length === 0) continue;
    const { kind, memoryType, tag: tagName, importance } = classifyTagLine(line);
    // 去掉模型自己写的 `决策：` 前缀，避免入库变成 `[决策] 决策：…` 重复
    const body = line.replace(/^(决策|约束|结论|决定)\s*[：:]\s*/, '').trim();
    items.push({
      content: `[${kind}] ${body.length > 0 ? body : line}`,
      memory_type: memoryType,
      tags: [tagName, 'distilled', 'lrc_memory'],
      importance,
      source_turns: [i, i],
    });
  }
  return items;
}

export class Offloader {
  /**
   * LRC 客户端**可后置注入**。
   *
   * 为什么不是构造时写死：插件可能在 LRC 还没起来时加载（实测桌面端晚 20 分钟），
   * 此前的做法是整个 Offloader 都不创建 —— 连 `observe()` 的计数都不做，
   * 于是 LRC 恢复后，之前那些轮次的内容已经不在待沉淀队列里了。
   *
   * 现在计数器先跑起来，连接一旦就绪只需 `bind()`，不丢历史累计。
   */
  private client: LrcClient | null;
  private readonly cursors: CursorStore;
  private readonly config: OffloadConfig;
  private readonly recentStore?: RecentStore;
  private pendingTurns = 0;
  private pendingChars = 0;
  private pendingSteps = 0;
  /** 最近已发送的块，用于本地查重（跨会话共享，避免重复入库） */
  private recent: string[] = [];
  /** 累计统计（`lrc_status` 用） */
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

  /** 连接是否已就绪。 */
  get connected(): boolean {
    return this.client !== null;
  }

  /**
   * 注入 / 替换客户端。
   *
   * 传 `null` 表示连接已断：保留所有计数器与游标，
   * 只停止发起 HTTP —— 恢复后可以接着从断点继续，不会重复也不会丢失。
   */
  bind(client: LrcClient | null): void {
    this.client = client;
  }

  /** 取客户端（未连接时抛错，调用方负责先判 `connected`）。 */
  private requireClient(): LrcClient {
    if (this.client === null) {
      throw new Error('LRC 尚未连接');
    }
    return this.client;
  }

  /** 记录一轮新增文本（由 index.ts 在 assistant/message 事件里调用）。 */
  observe(text: string): void {
    const cleaned = hardFilter(text);
    if (cleaned.trim().length === 0) return;
    this.pendingTurns += 1;
    this.pendingChars += cleaned.length;
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

  /** 是否达到卸载阈值。 */
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
   * 此时步数阈值已经触发，但 turns/chars 都是 0。漏掉步数会让
   * "88 步兜底"恰好在这类任务上失效。
   */
  hasPending(): boolean {
    return this.pendingTurns > 0 || this.pendingChars > 0 || this.pendingSteps > 0;
  }

  /** 重置计数器（卸载成功或会话切换时调用）。 */
  resetCounters(): void {
    this.pendingTurns = 0;
    this.pendingChars = 0;
    this.pendingSteps = 0;
  }

  /** 累计沉淀统计（`lrc_status` 用）。 */
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

  /** 记录一次沉淀结果（只统计真正有产出的批次）。 */
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
   * 执行一次卸载。
   *
   * @param sessionId 会话 ID（游标按会话分槽）
   * @param lines 当前 transcript 的全部行
   * @returns 卸载结果；没有新增内容时返回 null
   */
  async offload(sessionId: string, lines: string[]): Promise<OffloadResult | null> {
    const state = this.cursors.get(sessionId);
    const slice = sliceByCursor(lines, state);

    if (slice.text.trim().length === 0) {
      this.resetCounters();
      return null;
    }

    // 第一层：硬规则过滤。
    //
    // **按"消息"整段过滤，不能按物理行**：`stripCodeFences` 需要跨行维护
    // 围栏状态，逐行调用时状态永远是初始值，围栏内的代码会直接透传。
    // `lines` 的每个元素就是一条完整消息（可能多行），正好是过滤单元。
    const newLines = lines.slice(slice.fromLine);

    // 第二层产物：标签内容直接成条目，**绕过 distill**（避免二次过滤）
    const taggedItems: DistilledItem[] = [];
    // 兜底路径：没有标签的消息走硬规则 + distill
    const untagged: string[] = [];

    for (const message of newLines) {
      const tag = extractMemoryTag(message);
      if (tag !== null) {
        if (!isNoUpdate(tag)) taggedItems.push(...itemsFromTag(tag));
        continue;
      }
      const cleaned = hardFilter(message);
      if (cleaned.trim().length > 0) untagged.push(cleaned);
    }

    // 第三层：本地查重 —— 换措辞复述连 HTTP 都不发
    const freshTagged: DistilledItem[] = [];
    const freshBlocks: string[] = [];
    let deduped = 0;
    for (const item of taggedItems) {
      if (isDuplicate(item.content, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      freshTagged.push(item);
    }
    for (const block of untagged) {
      if (isDuplicate(block, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      freshBlocks.push(block);
    }

    // 没有新内容：这段确实没有可沉淀的东西，游标可以安全推进
    if (freshTagged.length === 0 && freshBlocks.length === 0) {
      this.commitCursor(sessionId, lines, slice.fromLine);
      const empty: OffloadResult = {
        charsSent: 0,
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

    let items: DistilledItem[] = [...freshTagged];
    let charsSent = freshTagged.reduce((sum, item) => sum + item.content.length, 0);

    if (freshBlocks.length > 0) {
      const text = freshBlocks.join('\n');
      charsSent += text.length;
      const distilled = await this.requireClient().distill(
        text,
        this.config.project,
        this.config.maxItems,
      );
      items = [...items, ...distilled.items];
    }

    let written = 0;
    let merged = 0;
    if (items.length > 0) {
      const migrated = await this.requireClient().migrate(items, this.config.project);
      written = migrated.written;
      merged = migrated.merged;
    }

    // **只有 distill + migrate 都成功才推进游标**。
    // 提前推进会让任何一次网络抖动 / LRC 重启 / 超时把这一批对话永久丢掉。
    this.commitCursor(sessionId, lines, slice.fromLine);

    // 记录已发送的块，供后续查重
    this.recent.push(...freshTagged.map((item) => item.content), ...freshBlocks);
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);

    const result: OffloadResult = {
      charsSent,
      distilled: items.length,
      written,
      merged,
      deduped,
      snapshot: buildSnapshot(items, this.config.snapshotItems),
      reset: slice.reset,
    };
    this.record(result);
    return result;
  }

  /**
   * 直接沉淀一批已提炼的条目（**不走行游标**）。
   *
   * 用于推理结论兜底：这些句子来自 reasoning 流，不在 transcript 行流里，
   * 无法用行号游标追踪，只能按内容查重。查重窗口与主路径共用。
   *
   * @param items 已分类的记忆条目
   * @returns 卸载结果；全部被查重拦下时返回零值结果
   */
  async offloadItems(items: DistilledItem[]): Promise<OffloadResult> {
    const fresh: DistilledItem[] = [];
    let deduped = 0;
    for (const item of items) {
      if (isDuplicate(item.content, this.recent, this.config.dedupThreshold)) {
        deduped += 1;
        continue;
      }
      fresh.push(item);
    }
    if (fresh.length === 0) {
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

    const migrated = await this.requireClient().migrate(fresh, this.config.project);
    this.recent.push(...fresh.map((item) => item.content));
    if (this.recent.length > this.config.recentWindow) {
      this.recent = this.recent.slice(-this.config.recentWindow);
    }
    this.recentStore?.save(this.recent);

    const result: OffloadResult = {
      charsSent: fresh.reduce((sum, item) => sum + item.content.length, 0),
      distilled: fresh.length,
      written: migrated.written,
      merged: migrated.merged,
      deduped,
      snapshot: buildSnapshot(fresh, this.config.snapshotItems),
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
