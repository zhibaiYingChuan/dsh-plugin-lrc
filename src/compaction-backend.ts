/**
 * M4 压缩兜底：DSH 原生压缩触发时，用 LRC 状态快照替换模型摘要。
 *
 * ## 为什么还要这一层
 *
 * 持续卸载已经把上下文增速降到 1/5~1/10，压缩很少触发。
 * 但超长会话或一次性粘贴大文件仍可能触发 —— 这时不能让宿主生成
 * "前面聊了包管理器"这种烂摘要。
 *
 * ## 策略
 *
 * 1. 先取 LRC 状态快照（`/v1/context/index`）
 * 2. 拼上"最近进展"（最后几条消息的截断），补上 LRC 抓不到的"当前在做什么"
 * 3. **不调用大模型** —— 省一次调用，也避免摘要再次丢约束
 * 4. 任何一步失败 → 退回 `super.summarize()`，绝不阻断压缩
 *
 * ## 为什么只重写 summarize()
 *
 * 官方 `BasicCompactionEngine` 的注释明确：`summarize()` 是唯一子类钩子，
 * 选范围 / 写锁标记 / 替换表层 / 计价全部固定在 `compactSurfaceRegion` 里。
 * 重写那些会破坏回放确定性。
 */
import type { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/summarizer';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Message } from '@deepseek-ai/dsh-llm';
import { LrcClient } from './lrc-client.ts';

/** 单条"最近进展"的最大字符数。 */
const RECENT_CHARS = 200;
/** 最多带几条"最近进展"。 */
const RECENT_COUNT = 3;

/** 从重放消息里抽纯文本（只取 text 块）。 */
function extractText(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      const candidate = block as { type?: string; text?: unknown };
      if (candidate?.type === 'text' && typeof candidate.text === 'string') {
        parts.push(candidate.text);
      }
    }
    if (parts.length > 0) out.push(parts.join('\n'));
  }
  return out;
}

/** 拼出"最近进展"段落。 */
function buildRecent(messages: readonly Message[]): string {
  const texts = extractText(messages).filter((t) => t.trim().length > 0);
  const tail = texts.slice(-RECENT_COUNT);
  if (tail.length === 0) return '';
  const lines = tail.map((t) => {
    const flat = t.replace(/\s+/g, ' ').trim();
    return flat.length > RECENT_CHARS ? `${flat.slice(0, RECENT_CHARS)}…` : flat;
  });
  return `[最近进展] ${lines.join(' / ')}`;
}

export class LrcCompactionEngine extends BasicCompactionEngine {
  /** 与父类一致：摘要需要 llm，计价需要 tokenMeter，落盘需要 sessions。 */
  static inject = ['llm', 'tokenMeter', 'sessions'];

  /** 复用父类配置（阈值 / 保留比例 / 重试次数等）。 */
  static Config = BasicCompactionEngine.Config;

  private readonly lrc: LrcClient;
  private readonly project: string;

  constructor(ctx: Context, config: ConstructorParameters<typeof BasicCompactionEngine>[1] = {}) {
    super(ctx, config);
    this.lrc = new LrcClient();
    this.project = process.env.LRC_PROJECT ?? 'dsh';
  }

  /**
   * 用 LRC 状态快照替代模型摘要。
   *
   * 失败时退回 `super.summarize()` —— 压缩是宿主核心能力，
   * 不能因为旁路记忆服务挂掉而卡住用户。
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    try {
      const index = await this.lrc.index(this.project, 20);
      const recent = buildRecent(input.messages);

      const parts: string[] = [];
      if (index.count > 0) {
        parts.push(
          `[LRC 状态] 已归档 ${index.total} 条记忆（项目：${this.project}）。` +
            '关键决策与约束在 LRC 中，需要细节时调用 recall，不要凭摘要猜测。',
        );
      }
      if (recent.length > 0) parts.push(recent);

      if (parts.length === 0) {
        // LRC 里没东西、也没有最近进展：交给父类，别产出空摘要
        return await super.summarize(input, agent, signal);
      }

      return {
        summary: [{ type: 'text', text: parts.join('\n') }],
        // 未走 ctx.llm.stream()，按官方契约标记为"未标记摘要"
        provider: 'lrc',
        model: 'snapshot',
      };
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `[lrc] 压缩快照失败，退回模型摘要：${error instanceof Error ? error.message : String(error)}`,
      );
      return await super.summarize(input, agent, signal);
    }
  }
}

export default LrcCompactionEngine;
