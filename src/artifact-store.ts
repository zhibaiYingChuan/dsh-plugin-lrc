/**
 * 工件库：按内容 hash 寻址的**大块文本**存储。
 *
 * ## 为什么与 LRC 分开
 *
 * LRC 的定位是「几百条可语义检索的事实」。若把用户粘贴的几百页文档
 * 也塞进去，会出现三个问题：
 * 1. `recall` 会召回长文档片段，把上下文重新灌满 —— 正是「什么都往里丢」；
 * 2. 语义检索对「原文」没有意义（用户要的是原样取回，不是相似匹配）；
 * 3. LRC 的写入是毫秒级设计，大文本会拖慢整条沉淀链路。
 *
 * 所以分成两个存储：
 * ```
 * LRC        = Fact 库（语义检索，几百条）
 * artifacts/ = 工件库（按 hash 取回，文件）
 * ```
 * 两者靠一条 `location` 类别的指针 Fact 关联。
 *
 * ## 为什么按内容 hash 寻址
 *
 * 同一份文档被粘贴两次、或在多个会话里重复出现时，hash 天然去重 ——
 * 不需要任何相似度比较，也不需要额外的索引表。
 *
 * ## 配额
 *
 * 工件只增不减会撑爆磁盘（实测一次会话可能贴进数十 MB）。
 * 超额按**最旧访问时间**淘汰，与 LRU 同构。
 *
 * 本模块是纯 Node（fs + crypto），不依赖宿主，可直接单测。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 工件元数据（`index.json` 里的一项）。 */
export interface ArtifactMeta {
  hash: string;
  /** 原始字符数 */
  chars: number;
  /** 首行摘要，用于在指针 Fact 里说明「这是什么」 */
  preview: string;
  /** 写入时间（毫秒） */
  createdAt: number;
}

/** 一次「落盘」的结果。 */
export interface StoreResult {
  meta: ArtifactMeta;
  /** 是否命中了已有工件（hash 相同 ⇒ 没有真的写盘） */
  reused: boolean;
}

/** 低于这个长度不值得落盘：一次工具输出、一段代码片段都不算「长文本」。 */
export const MIN_ARTIFACT_CHARS = 8_000;

/** 单个工件的字符上限：超过就只存前 N 字符，避免一次贴进 100MB。 */
export const MAX_ARTIFACT_CHARS = 2_000_000;

/** 工件库默认磁盘配额（字节）。 */
const DEFAULT_QUOTA_BYTES = 200 * 1024 * 1024;

/** 内容 hash：取前 16 位十六进制（够用且便于在指针里显示）。 */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 是否是「值得落盘的超长文本」。
 *
 * 判据只看长度与行数，不猜语义 —— 语义判断不在这一层。
 */
export function isArtifactWorthy(text: string, minChars = MIN_ARTIFACT_CHARS): boolean {
  return text.trim().length >= minChars;
}

/** 从内容里取首行作为预览（去掉 markdown 标记与多余空白）。 */
function previewOf(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>\-*+\s]+/, '').trim())
      .find((l) => l.length > 0) ?? '';
  const flat = firstLine.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/**
 * 工件库。
 *
 * 目录结构：
 * ```
 * <root>/index.json       元数据索引（hash → meta）
 * <root>/<hash>.txt       工件本体
 * ```
 * 索引与本体分开：取回时不必扫描目录，淘汰时不必读文件内容。
 */
export class ArtifactStore {
  private readonly root: string;
  private readonly quotaBytes: number;
  private index: Record<string, ArtifactMeta> | null = null;

  constructor(root: string, quotaBytes: number = DEFAULT_QUOTA_BYTES) {
    this.root = root;
    // ## 配额必须在这里再兜一次底
    //
    // `NaN <= x` 恒为 false，会让 `evictIfNeeded` 把所有工件都判成「超额」
    // 然后全部删除 —— 包括刚写入的那个。调用方传错（`undefined * 1024 * 1024`）
    // 是真实会发生的，不能只靠调用方自己防。
    this.quotaBytes =
      typeof quotaBytes === 'number' && Number.isFinite(quotaBytes) && quotaBytes > 0
        ? Math.floor(quotaBytes)
        : DEFAULT_QUOTA_BYTES;
  }

  private indexPath(): string {
    return join(this.root, 'index.json');
  }

  private bodyPath(hash: string): string {
    return join(this.root, `${hash}.txt`);
  }

  /** 载入索引（文件损坏时按空索引处理，不阻断主流程）。 */
  private load(): Record<string, ArtifactMeta> {
    if (this.index !== null) return this.index;
    try {
      if (existsSync(this.indexPath())) {
        const parsed = JSON.parse(readFileSync(this.indexPath(), 'utf8')) as unknown;
        this.index =
          parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, ArtifactMeta>) : {};
      } else {
        this.index = {};
      }
    } catch {
      this.index = {};
    }
    return this.index;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.indexPath()), { recursive: true });
      writeFileSync(this.indexPath(), JSON.stringify(this.load(), null, 2), 'utf8');
    } catch {
      // 落盘失败不影响本次返回：工件本体已写入，重启后会退化为「索引缺失」
    }
  }

  /**
   * 落盘一份工件。
   *
   * @param text - 原文
   * @returns 元数据；`reused` 为 true 表示 hash 已存在、未重复写盘
   */
  store(text: string): StoreResult {
    const body = text.length > MAX_ARTIFACT_CHARS ? text.slice(0, MAX_ARTIFACT_CHARS) : text;
    const hash = hashContent(body);
    const index = this.load();
    const existing = index[hash];
    if (existing !== undefined) {
      // 命中：刷新访问时间（LRU 需要），不重写本体
      this.touch(hash);
      return { meta: existing, reused: true };
    }

    const meta: ArtifactMeta = {
      hash,
      chars: body.length,
      preview: previewOf(body),
      createdAt: Date.now(),
    };
    try {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(this.bodyPath(hash), body, 'utf8');
    } catch {
      // 写盘失败：仍登记索引（bodyPath 缺失时取回会返回 null），
      // 但不抛错 —— 沉淀链路不应因为磁盘问题中断。
    }
    index[hash] = meta;
    this.persist();
    this.evictIfNeeded();
    return { meta, reused: false };
  }

  /** 取回原文；不存在或已被淘汰时返回 null。 */
  fetch(hash: string): string | null {
    const index = this.load();
    if (index[hash] === undefined) return null;
    try {
      const body = readFileSync(this.bodyPath(hash), 'utf8');
      this.touch(hash);
      return body;
    } catch {
      return null;
    }
  }

  /** 是否存在。 */
  has(hash: string): boolean {
    return this.load()[hash] !== undefined;
  }

  /** 元数据（不存在返回 null）。 */
  meta(hash: string): ArtifactMeta | null {
    return this.load()[hash] ?? null;
  }

  /** 全部工件（按写入时间从新到旧）。 */
  list(): ArtifactMeta[] {
    return Object.values(this.load()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 刷新访问时间（LRU 用）。失败静默。 */
  private touch(hash: string): void {
    try {
      const path = this.bodyPath(hash);
      if (existsSync(path)) {
        const now = new Date();
        utimesSync(path, now, now);
      }
    } catch {
      // 访问时间只影响淘汰顺序，失败可忽略
    }
  }

  /** 当前占用字节数（按实际文件大小，不是字符数）。 */
  usageBytes(): number {
    try {
      if (!existsSync(this.root)) return 0;
      let total = 0;
      for (const name of readdirSync(this.root)) {
        if (!name.endsWith('.txt')) continue;
        try {
          total += statSync(join(this.root, name)).size;
        } catch {
          // 单文件读不到就跳过
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * 超额时按**最旧访问时间**淘汰，直到回到配额内。
   *
   * 用访问时间而不是写入时间：一个很早写入、但今天还在被取回的工件，
   * 比上周写入、再也没碰过的更值得保留。
   */
  private evictIfNeeded(): void {
    let usage = this.usageBytes();
    if (usage <= this.quotaBytes) return;
    const index = this.load();
    const candidates = Object.values(index)
      .map((meta) => {
        let atimeMs = meta.createdAt;
        try {
          atimeMs = statSync(this.bodyPath(meta.hash)).atimeMs;
        } catch {
          // 文件已不存在：直接用写入时间，让它优先被清掉
        }
        return { meta, atimeMs };
      })
      .sort((a, b) => a.atimeMs - b.atimeMs);

    for (const { meta } of candidates) {
      if (usage <= this.quotaBytes) break;
      try {
        const path = this.bodyPath(meta.hash);
        const size = existsSync(path) ? statSync(path).size : 0;
        if (existsSync(path)) unlinkSync(path);
        delete index[meta.hash];
        usage -= size;
      } catch {
        // 删不掉就跳过（下次再试）
      }
    }
    this.persist();
  }
}
