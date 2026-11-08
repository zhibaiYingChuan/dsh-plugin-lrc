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
  /** 展示用相关度（0–1，相对 top1 归一化） */
  score_norm: number;
  importance: number;
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
    options: { topK?: number; project?: string } = {},
  ): Promise<RecallResult> {
    const body: Record<string, unknown> = {
      query,
      top_k: options.topK ?? 5,
    };
    if (options.project !== undefined && options.project.length > 0) {
      body.project = options.project;
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
}
