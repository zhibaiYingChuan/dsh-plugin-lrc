/**
 * DSH 插件入口：内置 LRC + 持续卸载。
 *
 * ## 职责
 *
 * 1. 启动/复用 LRC 运行时（`runtime.ts`）
 * 2. 订阅会话事件，累计新增对话
 * 3. 达到阈值（8 轮 / 6000 字符）时执行卸载（`offloader.ts`）
 * 4. 注册 `lrc_offload_now` 工具，允许模型手动触发
 *
 * ## 关于事件名
 *
 * `session/event` 与 `agent/pre-step` 来自 DSH 官方压缩后端的用法。
 * 本插件对事件载荷做**防御式解析**：字段对不上就跳过并记一次 warn，
 * 不会因为 DSH 版本差异而崩溃。
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LrcRuntime } from './runtime.ts';
import { LrcClient } from './lrc-client.ts';
import { CursorStore } from './cursor.ts';
import { Offloader } from './offloader.ts';

export const name = 'dsh-plugin-lrc';

/** 等工具注册表就绪后再执行 apply。 */
export const inject = ['tools'];

export interface Config {
  /** 指向已有 LRC；留空则自动探测/启动 */
  baseUrl: string;
  token: string;
  project: string;
  /** 累计多少轮卸载一次 */
  offloadTurns: number;
  /** 累计多少字符卸载一次 */
  offloadChars: number;
  /** 单次最多提炼条数 */
  maxItems: number;
}

export const Config: Schema = Schema.object({
  baseUrl: Schema.string().default(''),
  token: Schema.string().default(''),
  project: Schema.string().default('dsh'),
  offloadTurns: Schema.number().default(8),
  offloadChars: Schema.number().default(6000),
  maxItems: Schema.number().default(40),
});

/** 从事件里尽力取出 assistant 文本；取不到返回空串。 */
function extractAssistantText(event: unknown): string {
  const candidate = event as { type?: string; message?: { content?: unknown } };
  if (candidate?.type !== 'assistant/message') return '';
  const content = candidate.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

export function apply(ctx: Context, config: Config): void {
  const cacheDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'lrc-plugin');
  const runtime = new LrcRuntime({
    cacheDir,
    log: (message) => ctx.logger.info(message),
  });

  let offloader: Offloader | null = null;
  let client: LrcClient | null = null;
  let warnedShape = false;

  // 异步初始化：不阻塞插件加载
  void (async () => {
    const result = await runtime.ensure();
    if (result.mode === 'degraded') {
      ctx.logger.warn(`[lrc] 未启用卸载：${result.reason ?? '未知原因'}`);
      return;
    }
    client = new LrcClient({ baseUrl: result.baseUrl, token: config.token || undefined });
    offloader = new Offloader(client, new CursorStore(join(cacheDir, 'cursor.json')), {
      turnsThreshold: config.offloadTurns,
      charsThreshold: config.offloadChars,
      project: config.project,
      maxItems: config.maxItems,
    });
    ctx.logger.info(`[lrc] 卸载器就绪（${result.mode}）：${result.baseUrl}`);
  })();

  // 订阅会话事件：累计新增文本
  ctx.on('session/event', (session: unknown, event: unknown) => {
    if (offloader === null) return;
    const text = extractAssistantText(event);
    if (text.length === 0) {
      if (!warnedShape) {
        warnedShape = true;
        ctx.logger.warn('[lrc] 未从 session/event 取到 assistant 文本，卸载可能不生效');
      }
      return;
    }
    offloader.observe(text);
  });

  // 每步开始前检查阈值
  ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<unknown>) => {
    if (offloader !== null && offloader.shouldOffload()) {
      try {
        const session = (_payload as { agent?: { session?: { id?: string } } })?.agent?.session;
        const sessionId = session?.id ?? 'default';
        const lines = ((_payload as { agent?: { session?: { lines?: string[] } } })?.agent?.session
          ?.lines ?? []) as string[];
        const result = await offloader.offload(sessionId, lines);
        if (result !== null) {
          ctx.logger.info(
            `[lrc] 已卸载 ${result.distilled} 条（新增 ${result.written} / 合并 ${result.merged}）`,
          );
        }
      } catch (error) {
        ctx.logger.warn(
          `[lrc] 卸载失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return next();
  });

  // 手动触发工具
  ctx.tools.register(
    defineTool({
      name: 'lrc_offload_now',
      description:
        '立即把当前对话的结论卸载到 LRC 长期记忆库。' +
        '用于用户要求"把这段记下来"或上下文即将变长时。返回一行状态快照。',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: '要卸载的对话原文（可含多轮，按换行分隔）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            snapshot: { type: 'string', required: true },
            distilled: { type: 'number', required: true },
            written: { type: 'number', required: true },
            merged: { type: 'number', required: true },
          },
        },
        render: (_args: unknown, value: { snapshot: string }) => [
          { type: 'text', text: value.snapshot },
        ],
      },
      async execute(args: { text: string }) {
        if (client === null) {
          return { snapshot: 'LRC 未就绪，本次未卸载', distilled: 0, written: 0, merged: 0 };
        }
        try {
          const result = await client.migrateText(args.text, config.project, config.maxItems);
          return {
            snapshot: result.indexLine,
            distilled: result.distilled,
            written: result.written,
            merged: result.merged,
          };
        } catch (error) {
          return {
            snapshot: `LRC 未连接，本次未卸载（${String(error).slice(0, 120)}）`,
            distilled: 0,
            written: 0,
            merged: 0,
          };
        }
      },
    }),
  );
}
