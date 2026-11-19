/**
 * LRC HTTP 客户端（纯 TypeScript，不依赖 DSH）。
 *
 * 为什么单独成文件：DSH 插件 API 处于 Developer Preview，签名会变；
 * 而 LRC 的 HTTP 接口是稳定的。插件 API 变了只需改 index.ts。
 */

export interface DistilledItem {
  content: string;
  memory_type: string;
  tags: string[];
  importance: number;
  source_turns: [number, number];
  /**
   * 来源：`user` = 用户说的话，`assistant` = 助手正文/推理。
   *
   * ## 为什么必须带
   *
   * 快照提权（资源位置）必须区分「谁在说」：用户交代「音频在桌面」
   * 与助手陈述「桌面上的文件与 assets/score.wav 的 MD5 一致」在文本形态上
   * 无法区分。靠不断加词表三次都失败了（英文推理句 → 中文结论 → …），
   * 根治办法是让判据能看到来源。
   *
   * LRC 侧不需要这个字段（`migrate` 会忽略未知键），它只用于本地快照取词。
   */
  origin?: 'user' | 'assistant';
}

export interface DistillResult {
  items: DistilledItem[];
  count: number;
  index_line: string;
}

export interface MigrateResult {
  written: number;
  merged: number;
  failed: number;
  remaining?: number;
  truncated?: boolean;
}

export interface IndexResult {
  index_line: string;
  count: number;
  total: number;
  items: Array<{
    id: string;
    content_preview: string;
    memory_type: string;
    created_at_ms: number;
  }>;
}

/** 一条召回结果（`/v1/memories/enrich` 的子集）。 */
export interface RecallItem {
  id: string;
  content: string;
  memory_type: string;
  /**
   * 融合分（RRF 名次分，**不是语义相关度**）。
   *
   * RRF = Σ1/(60+rank)，值域 `(0, 2/61]`。实测只有三个离散簇：
   * 单路命中 0.0164、双路命中 0.0301、双路靠前 0.0328，无中间值。
   * 它衡量的是「命中几条检索通路、各排第几」，与查询-记忆的语义相似度正交。
   *
   * 用途：作为**粗筛**（要求至少两路命中）足够，作为相关性证明不够。
   * 缺失（含 `null`）时调用方需退回相对分路径，见 `formatRecallInjection`。
   */
  score?: number;
  /** 展示用相关度（0–1，相对 top1 归一化） */
  score_norm: number;
  importance: number;
  /**
   * 纪要覆盖的**时间段起点**（ISO 8601，来自写入时的 `source_timestamp_ms`）。
   *
   * ## 为什么用它而不是「写入时刻」
   *
   * 会话纪要写入时会把 `source_timestamp_ms` 设成「本段对话的开始时间」，
   * 所以 `created_at` 的大小顺序 = 各段的**时间窗先后**。
   *
   * 冷启动探查必须据此选「最新的一段」而不是「最长的一段」：
   * ```
   * 87f7d090  11-14 11:28 → 11-17 05:10  22 轮 / 2776 字（旧段的完整记录）
   * a9584d98  11-17 23:03 → 11-18 04:10   2 轮 / 1104 字（新段，且推翻了旧段结论）
   * ```
   * 「最长」会选中旧段，把正在生长的会话锁死在历史版本上（六钥匙裁决）。
   */
  created_at?: string | null;
  /**
   * 记忆的业务键（会话纪要恒为 `session-minutes:<sessionId>`）。
   *
   * 用于「冷启动探查」：插件本地账本丢失（旧版本升级 / 账本被 prune）
   * 时，靠它从库里找回既有纪要的 `id`，避免下次写入因
   * `memoryId` 为空而**新建第二条**同 `event_id` 的纪要。
   * 非纪要记忆通常没有这个字段。
   *
   * 可为 `null`：LRC 的 `EnrichedMemory.event_id` 是 `Option<String>`
   * 且**没有** `skip_serializing_if`，JSON 里会输出 `"event_id": null`
   * （十二轮审查 m3）。用 `=== expected` 比较时 null 自然不匹配，
   * 行为正确 —— 但类型必须如实声明，否则下游写 `?? ''` 会掩盖问题。
   */
  event_id?: string | null;
}

export interface RecallResult {
  memories: RecallItem[];
  /** 候选总数（折叠前） */
  total: number;
}

export interface LrcClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

export class LrcClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: LrcClientOptions = {}) {
    const raw = options.baseUrl ?? process.env.LRC_BASE ?? 'http://127.0.0.1:3099';
    this.baseUrl = raw.replace(/\/+$/, '');
    this.token = options.token ?? process.env.LRC_TOKEN;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * 底层请求封装。
   *
   * 非 2xx 一律抛错并带上状态码与响应体前 300 字符 —— 调用方必须能区分
   * "服务没起"（fetch 抛错）与"服务起了但拒绝"（带状态码的 Error）。
   */
  async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LRC ${path} 返回 ${response.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  /** 健康检查：服务是否可用。 */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** 提炼对话文本（不写库）。 */
  async distill(text: string, project?: string, maxItems = 40): Promise<DistillResult> {
    return this.request<DistillResult>('/v1/context/distill', {
      method: 'POST',
      body: JSON.stringify({ text, project, max_items: maxItems }),
    });
  }

  /** 批量写入（幂等：同内容走相似合并）。 */
  async migrate(items: DistilledItem[], project?: string): Promise<MigrateResult> {
    return this.request<MigrateResult>('/v1/context/migrate', {
      method: 'POST',
      body: JSON.stringify({ items, project }),
    });
  }

  /** 取归档索引。 */
  async index(project?: string, limit = 20): Promise<IndexResult> {
    const query = new URLSearchParams();
    if (project) query.set('project', project);
    query.set('limit', String(limit));
    return this.request<IndexResult>(`/v1/context/index?${query.toString()}`, {
      method: 'GET',
    });
  }

  /** 记忆总数（用于验收"不膨胀"）。 */
  async totalMemories(): Promise<number> {
    const stats = await this.request<{ total_memories?: number }>('/v1/memories/stats', {
      method: 'GET',
    });
    return stats.total_memories ?? 0;
  }

  /**
   * 召回相关记忆（三路融合 + 近重复折叠）。
   *
   * 这是插件唯一的**读**路径：DSH 没有 MCP 客户端，AI 看不到 LRC 的
   * `recall` 工具，只能通过插件注册的原生工具读回记忆。
   */
  async recall(
    query: string,
    options: { topK?: number; project?: string; tags?: string[] } = {},
  ): Promise<RecallResult> {
    const body: Record<string, unknown> = {
      query,
      top_k: options.topK ?? 5,
    };
    if (options.project !== undefined && options.project.length > 0) {
      body.project = options.project;
    }
    // ## tags 过滤是「冷启动探查」的唯一可靠手段（实测）
    //
    // 纯语义 query 无法稳定把同 `event_id` 的纪要召回（它们的正文
    // 与 query 的相似度不可控）。而 `session:<sessionId>` 这个标签
    // 是每条纪要必带的，实测连续 3 次都能稳定命中同一批。
    if (options.tags !== undefined && options.tags.length > 0) {
      body.tags = options.tags;
    }
    const data = await this.request<{ memories?: RecallItem[]; total?: number }>(
      '/v1/memories/enrich',
      { method: 'POST', body: JSON.stringify(body) },
    );
    return { memories: data.memories ?? [], total: data.total ?? 0 };
  }

  /**
   * 删除一条记忆（幂等）。
   *
   * 用于**纠错**：AI 发现某条记忆是错的（例如把「没找到」误写成「不存在」），
   * 必须能撤回，否则错误结论会被持续召回、污染后续所有对话。
   */
  async forget(memoryId: string): Promise<{ deleted: boolean; alreadyDeleted: boolean }> {
    const data = await this.request<{
      success?: boolean;
      deleted?: boolean;
      already_deleted?: boolean;
    }>('/v1/memories/forget', {
      method: 'POST',
      body: JSON.stringify({ memory_id: memoryId }),
    });
    return {
      deleted: data.deleted === true,
      alreadyDeleted: data.already_deleted === true,
    };
  }

  /** 一步完成"提炼 + 迁移"。 */
  async migrateText(
    text: string,
    project?: string,
    maxItems = 40,
  ): Promise<{ distilled: number; written: number; merged: number; indexLine: string }> {
    const distilled = await this.distill(text, project, maxItems);
    if (distilled.items.length === 0) {
      return { distilled: 0, written: 0, merged: 0, indexLine: distilled.index_line };
    }
    const migrated = await this.migrate(distilled.items, project);
    return {
      distilled: distilled.count,
      written: migrated.written,
      merged: migrated.merged,
      indexLine: distilled.index_line,
    };
  }

  /**
   * 写入**单条**记忆，可携带真实发生时间（`source_timestamp_ms`）。
   *
   * ## 为什么不能用 `migrate` 代替（2026-11-17 实测）
   *
   * `migrate` 的请求体没有时间字段，LRC 侧在 `v1_api.rs` 里把
   * `source_timestamp` 硬编码为 `None` ⇒ 落库时间恒为**摄入时刻**。
   * 实测对照（写入一条「声称发生在 2026-01-01」的记忆）：
   * ```
   * /v1/memories/remember  → created_at = 2026-01-01  ✅ 偏差 0.0 秒
   * /v1/context/migrate    → created_at = 写入当天    ❌ 偏差 319.9 天
   * ```
   * 会话纪要的价值完全依赖真实时间（「什么时候定的这个方案」），
   * 用摄入时刻等于把 65.8 小时的会话压成一个瞬间 —— 时序信息永久丢失。
   *
   * ## `event_id` **不是**覆盖语义（十二轮审查 M4，已核对 LRC 源码）
   *
   * LRC 的去重完全基于**内容相似度**，与 `event_id` 无关：
   * - `memory_store.rs` 的 `build_candidates` / `find_similar_in_snapshot`
   *   都**不读** `event_id`
   * - `memory_write.rs` 的 `apply_merge` 只在合并后把 `event_id` 更新成新值
   *
   * 实测矩阵（同一 `event_id` 连续写两次）：
   * ```
   * 内容 Jaccard ≥ 0.5 ⇒ 合并 ⇒ 返回同一个 memory_id，库内 1 条
   * 内容 Jaccard < 0.5 ⇒ 新建 ⇒ 返回新的 memory_id，库内 **2 条**
   * ```
   *
   * 所以「一份对话一份纪要」不能靠 `event_id` 保证，必须由调用方
   * 记住上次返回的 `memory_id`，在 id 变化时主动 `forget(旧 id)`。
   * 参会见 `session-minutes.ts` 的 `MinutesLedgerState.memoryId`。
   */
  async remember(input: {
    content: string;
    memoryType: string;
    project?: string;
    tags?: string[];
    importance?: number;
    eventId?: string;
    /** 真实发生时间（Unix 毫秒）。缺省 = 摄入时刻。 */
    sourceTimestampMs?: number;
    entities?: Array<{ name: string; kind?: string }>;
  }): Promise<{ memoryId: string }> {
    const body: Record<string, unknown> = {
      content: input.content,
      memory_type: input.memoryType,
    };
    if (input.project !== undefined) body.project = input.project;
    if (input.tags !== undefined) body.tags = input.tags;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.eventId !== undefined) body.event_id = input.eventId;
    if (input.sourceTimestampMs !== undefined) body.source_timestamp_ms = input.sourceTimestampMs;
    if (input.entities !== undefined) body.entities = input.entities;

    const data = await this.request<{ memory_id?: string; success?: boolean }>(
      '/v1/memories/remember',
      { method: 'POST', body: JSON.stringify(body) },
    );
    return { memoryId: data.memory_id ?? '' };
  }
}
