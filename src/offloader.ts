/**
 * 持续卸载器：把对话边聊边搬进 LRC 长期记忆。
 *
 * ## 与"压缩时抢救"的区别
 *
 * 压缩时抢救 = 上下文已经涨到阈值，才把结论捞出来。此时已经晚了：
 * 宿主会生成一句干瘪摘要，约束全丢。
 *
 * 持续卸载 = 每 8 轮或 6000 字符就把结论搬走，上下文增速降到 1/8 左右，
 * 压缩很少触发；即使触发，摘要也是 LRC 状态快照。
 *
 * ## 本模块不依赖 DSH
 *
 * 只做"给定新增文本 → 提炼 → 落库 → 产出快照行"。
 * 事件订阅在 index.ts 里做，这样核心逻辑可以脱离宿主单测。
 */
import type { DistilledItem, LrcClient } from './lrc-client.ts';
import { advanceCursor, sliceByCursor, type CursorStore } from './cursor.ts';

export interface OffloadConfig {
  /** 累计多少轮触发一次卸载 */
  turnsThreshold: number;
  /** 累计多少字符触发一次卸载 */
  charsThreshold: number;
  /** 记忆归属项目 */
  project: string;
  /** 单次最多提炼条数 */
  maxItems: number;
  /** 快照里最多列几条结论 */
  snapshotItems: number;
}

export const DEFAULT_OFFLOAD_CONFIG: OffloadConfig = {
  turnsThreshold: 8,
  charsThreshold: 6000,
  project: 'dsh',
  maxItems: 40,
  snapshotItems: 3,
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
  /** 注入下一轮的状态快照（1~3 行） */
  snapshot: string;
  /** 游标是否因 transcript 重写而失效 */
  reset: boolean;
}

/** 把提炼结果压成一行状态快照。 */
export function buildSnapshot(items: DistilledItem[], maxItems: number): string {
  if (items.length === 0) return '';
  const picked = items.slice(0, maxItems).map((item) => {
    // 去掉 `[决策] ` 这类前缀，快照里用更短的标签
    const body = item.content.replace(/^\[[^\]]+\]\s*/, '');
    const short = body.length > 40 ? `${body.slice(0, 40)}…` : body;
    return short;
  });
  return `[LRC 状态] ${picked.join('；')}。细节在 LRC，需要时 recall。`;
}

export class Offloader {
  private readonly client: LrcClient;
  private readonly cursors: CursorStore;
  private readonly config: OffloadConfig;
  private pendingTurns = 0;
  private pendingChars = 0;

  constructor(client: LrcClient, cursors: CursorStore, config: Partial<OffloadConfig> = {}) {
    this.client = client;
    this.cursors = cursors;
    this.config = { ...DEFAULT_OFFLOAD_CONFIG, ...config };
  }

  /** 记录一轮新增文本（由 index.ts 在 assistant/message 事件里调用）。 */
  observe(text: string): void {
    this.pendingTurns += 1;
    this.pendingChars += text.length;
  }

  /** 是否达到卸载阈值。 */
  shouldOffload(): boolean {
    return (
      this.pendingTurns >= this.config.turnsThreshold ||
      this.pendingChars >= this.config.charsThreshold
    );
  }

  /** 重置计数器（卸载成功或会话切换时调用）。 */
  resetCounters(): void {
    this.pendingTurns = 0;
    this.pendingChars = 0;
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

    const distilled = await this.client.distill(
      slice.text,
      this.config.project,
      this.config.maxItems,
    );

    let written = 0;
    let merged = 0;
    if (distilled.items.length > 0) {
      const migrated = await this.client.migrate(distilled.items, this.config.project);
      written = migrated.written;
      merged = migrated.merged;
    }

    // 只有成功落库才推进游标：失败时下次会重试同一段
    const consumed = lines.length - slice.fromLine;
    this.cursors.set(advanceCursor(lines, sessionId, slice.fromLine, consumed));
    this.resetCounters();

    return {
      charsSent: slice.text.length,
      distilled: distilled.count,
      written,
      merged,
      snapshot: buildSnapshot(distilled.items, this.config.snapshotItems),
      reset: slice.reset,
    };
  }
}
