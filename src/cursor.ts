/**
 * 增量游标：只提炼上次之后的新增对话。
 *
 * ## 为什么需要
 *
 * 每次卸载都把整段 transcript 重新提炼一遍，同一句话会被反复写入 ——
 * 这是"上下文抢救"造成记忆膨胀的根因。
 *
 * ## 哈希校验
 *
 * transcript 可能被宿主截断或重写（比如会话恢复）。若只记行号，
 * 行号会指向错误的内容。所以同时记录"最后一行内容的哈希"：
 * 对不上就判定游标失效，退回全量提炼并记 warn。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CursorState {
  sessionId: string;
  /** 已处理到第几行（0 表示还没处理过） */
  lastLine: number;
  /** 第 lastLine 行内容的哈希，用于校验 transcript 是否被重写 */
  lastHash: string;
  updatedAt: number;
}

export interface SliceResult {
  /** 需要送去提炼的新增文本 */
  text: string;
  /** 本次从第几行开始（0-based） */
  fromLine: number;
  /** 游标是否失效（transcript 被重写），调用方应记 warn */
  reset: boolean;
}

/** 行内容哈希（取前 16 位十六进制，够用且省空间）。 */
export function hashLine(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 快照的**实质内容指纹**：折叠空白后取哈希。
 *
 * 为什么折叠空白：快照是 1~3 行短文本，换行/缩进差异不构成"状态变了"，
 * 但会让宿主认为 runtime-context 变了并 append 一条新消息。
 */
export function snapshotFingerprint(text: string): string {
  return hashLine(text.replace(/\s+/g, ' ').trim());
}

/**
 * 快照是否发生了**实质变化**（仅空白差异不算）。
 *
 * ## 为什么需要
 *
 * 宿主把 `systemPrompt.context` 渲染成一条 runtime-context 用户消息，
 * 文本一变就 append 一条新消息（旧消息留在 surface 里）。快照每轮都变
 * 就会不断插入新消息：既打乱前缀缓存，又让上下文持续膨胀。
 *
 * 因此只有实质变化才更新快照；内容相同（含仅空白差异）时保持原样，
 * 让宿主侧 `RuntimeContextProjection` 判定"无需更新"。
 */
export function snapshotChanged(previous: string, next: string): boolean {
  if (previous === next) return false;
  return snapshotFingerprint(previous) !== snapshotFingerprint(next);
}

/**
 * 按游标切出新增文本（**纯函数**，便于测试）。
 *
 * @param lines 当前 transcript 的全部行
 * @param state 上次保存的游标（null 表示首次）
 */
export function sliceByCursor(lines: string[], state: CursorState | null): SliceResult {
  if (state === null || state.lastLine <= 0) {
    return { text: lines.join('\n'), fromLine: 0, reset: false };
  }

  // 游标越界：transcript 变短了
  if (state.lastLine > lines.length) {
    return { text: lines.join('\n'), fromLine: 0, reset: true };
  }

  // 哈希校验：最后一行内容变了 ⇒ transcript 被重写
  const anchor = lines[state.lastLine - 1] ?? '';
  if (hashLine(anchor) !== state.lastHash) {
    return { text: lines.join('\n'), fromLine: 0, reset: true };
  }

  return {
    text: lines.slice(state.lastLine).join('\n'),
    fromLine: state.lastLine,
    reset: false,
  };
}

/** 根据本次处理结果推进游标。 */
export function advanceCursor(
  lines: string[],
  sessionId: string,
  fromLine: number,
  consumedLines: number,
): CursorState {
  const lastLine = Math.min(fromLine + consumedLines, lines.length);
  return {
    sessionId,
    lastLine,
    lastHash: lastLine > 0 ? hashLine(lines[lastLine - 1] ?? '') : '',
    updatedAt: Date.now(),
  };
}

/** 文件持久化的游标存储（按 sessionId 分槽）。 */
export class CursorStore {
  private readonly filePath: string;
  private cache: Record<string, CursorState> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private loadAll(): Record<string, CursorState> {
    if (this.cache !== null) return this.cache;
    try {
      if (existsSync(this.filePath)) {
        this.cache = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, CursorState>;
      } else {
        this.cache = {};
      }
    } catch {
      // 文件损坏不应阻断卸载：当作空游标，退回全量
      this.cache = {};
    }
    return this.cache;
  }

  get(sessionId: string): CursorState | null {
    return this.loadAll()[sessionId] ?? null;
  }

  set(state: CursorState): void {
    const all = this.loadAll();
    all[state.sessionId] = state;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {
      // 落盘失败不影响本次卸载，下次会退回全量
    }
  }
}

/**
 * 最近已发送块的持久化。
 *
 * 为什么需要：`Offloader.recent` 是内存态，插件重启后丢失，
 * 跨会话的换措辞复述会重新入库。落盘后查重窗口跨重启保留。
 */
export class RecentStore {
  private readonly filePath: string;
  private cache: string[] | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): string[] {
    if (this.cache !== null) return this.cache;
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
        this.cache = Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string')
          : [];
      } else {
        this.cache = [];
      }
    } catch {
      // 文件损坏不应阻断卸载：当作空窗口
      this.cache = [];
    }
    return this.cache;
  }

  save(items: string[]): void {
    this.cache = items;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(items), 'utf8');
    } catch {
      // 落盘失败不影响本次卸载
    }
  }
}
