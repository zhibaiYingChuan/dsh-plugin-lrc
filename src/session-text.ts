/**
 * 从 DSH 会话事件里抽文本。
 *
 * 单独成模块的原因：这里全是纯函数，不依赖 `@deepseek-ai/*`，
 * 因此可以在没有 DSH 运行时的环境下直接单测（见 `scripts/e2e-host-payload.ts`）。
 *
 * ## 真实结构（来自 app.asar 内 `@deepseek-ai/dsh-session`）
 *
 * ```
 * Session      = { id, log: SessionEvent[], surface, header, requestHeader() }
 * SessionEvent = { type, seq, time, data, surfaceOp }
 * assistant/message → data.message.content
 * user/message      → data.content
 * ```
 *
 * 注意 `Session` **没有 `lines` 字段** —— 早期实现读 `agent.session.lines`
 * 恒为 `[]`，导致自动沉淀静默空转。
 */
import { hasConstraintMarker } from './memory-filter.ts';
import { classifyEvent, isRealUserEvent } from './event-classify.ts';

/** 取 assistant 消息的 content（兼容 `data.message` 与旧版 `message`）。 */
export function messageContent(event: unknown): unknown {
  const candidate = event as {
    type?: string;
    data?: { message?: { content?: unknown } };
    message?: { content?: unknown };
  };
  if (candidate?.type !== 'assistant/message') return undefined;
  return candidate.data?.message?.content ?? candidate.message?.content;
}

/**
 * 从消息内容里抽纯文本：正文块优先，没有正文时退回推理块。
 *
 * DSH 里大量 assistant 消息只有 `reasoning` + `tool-call`，没有 `text` 块，
 * 只认 `text` 会让沉淀计数器几乎不增长，8 轮阈值永远到不了。
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  const fallbacks: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; reasoning?: unknown };
    const value =
      typeof b?.text === 'string' ? b.text : typeof b?.reasoning === 'string' ? b.reasoning : '';
    if (value.length === 0) continue;
    if (b?.type === 'text') texts.push(value);
    else fallbacks.push(value);
  }
  return (texts.length > 0 ? texts : fallbacks).join('\n');
}

/**
 * 只取正文块（`type === 'text'`），**不含推理**。
 *
 * 沉淀源必须用这个：推理流是模型的内部思考，写进长期记忆就是噪声。
 * 实测一个会话因此写进 92 条垃圾，去重率约 1%。
 */
export function textBlocksOnly(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) texts.push(b.text);
  }
  return texts.join('\n');
}

/**
 * 只取推理块（`type === 'reasoning'`）。
 *
 * 工具密集型轮次里 assistant 往往只有 reasoning + tool-call，没有正文。
 * 这类轮次无法靠 `<lrc_memory>` 标签沉淀，只能在轮末从推理里抽结论句兜底。
 * 注意：**不能整段入库** —— 实测整段推理会写进 92 条垃圾，去重率约 1%。
 */
export function reasoningBlocksOnly(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0) {
      texts.push(b.text);
    }
  }
  return texts.join('\n');
}

/**
 * 是否存在**结构异常**的文本块：声明了 `text` / `reasoning` 但 `text` 不是字符串。
 *
 * 纯 tool-call 消息本来就没有这两类块，不该报警 —— 之前的告警条件
 * 「有内容块却既无 text 又无 reasoning」把 39 条纯工具调用消息全算成异常。
 */
export function hasMalformedTextBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: string; text?: unknown };
    return (b?.type === 'text' || b?.type === 'reasoning') && typeof b.text !== 'string';
  });
}

/** 从单条事件里取 assistant 文本（正文优先，其次推理）；仅用于计数与诊断。 */
export function extractAssistantText(event: unknown): string {
  return textFromContent(messageContent(event));
}

/**
 * 消息里是否有**可提取**的内容块。
 *
 * 只认 `text` / `reasoning`：纯 `tool-call` 消息本来就没有正文，
 * 把它算作"有内容块"会让告警在每次工具调用时误报。
 */
export function hasContentBlocks(event: unknown): boolean {
  const content = messageContent(event);
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: string };
    return b?.type === 'text' || b?.type === 'reasoning';
  });
}

/**
 * 取用户消息的正文文本（`user/message` 的 `data.content`）。
 *
 * # 为什么必须单独有这个函数
 *
 * `messageContent()` 只认 `assistant/message`（它读 `data.message.content`），
 * 对用户消息**恒返回 `undefined`**。曾经在 `session/event` 里用
 * `refreshRecallInjection(messageContent(event))` 取 query，结果
 * `textBlocksOnly(undefined)` 恒为空串 ⇒ 召回注入**一次都不可能触发**，
 * 而且不报错、日志也看不出问题。用户消息的内容在 `data.content`，不是
 * `data.message.content` —— 这两个形状的差异必须由本模块统一吸收，
 * 不能让调用方各自拼接。口径与 `linesFromSession` 完全一致。
 */
export function userMessageText(event: unknown): string {
  const candidate = event as { type?: string; data?: { content?: unknown } };
  if (candidate?.type !== 'user/message') return '';
  return textBlocksOnly(candidate.data?.content);
}

/**
 * 是否是用户真正说的话。
 *
 * DSH 的 `user/message` 事件里 `data.source.kind` 有多种取值：
 * `user` / `skill-catalog` / `runtime-context` / `time-context` / `model-selection`。
 * 只有 `user` 是用户输入，其余都是宿主注入的上下文 —— 实测一份技能目录
 * 就有 12K 字符，混进沉淀源会直接写满 `maxItems`。
 *
 * 没有 `source` 字段时按用户消息处理（兼容旧格式）。
 */
export function isRealUserMessage(event: unknown): boolean {
  // 判定统一走 event-classify.ts，避免各模块各写一套
  return isRealUserEvent(event);
}

/**
 * 用户消息里的**强约束词**。
 *
 * 用户消息是指令，不是结论。只有带约束信号的发言才值得进沉淀源 ——
 * 否则「根据这个文档配色」这类任务描述会被 distill 当成约束入库
 * （实测：文件名里的「规范」二字命中约定词表，整条指令被存成 `[约束]`）。
 *
 * 词表与路径预处理统一在 `memory-filter.ts`（`CONSTRAINT_WORDS` /
 * `hasConstraintMarker`）：先挖掉路径 token 再匹配，避免 `docs/禁止事项.md`
 * 里的「禁止」把纯任务指令放进门槛。
 */
export function hasUserConstraint(text: string): boolean {
  return hasConstraintMarker(text);
}

/**
 * 从 `agent.session.log` 投影出对话文本行。
 *
 * `log` 是 append-only 的事件数组，正好满足游标"按行号推进"的前提。
 */
export function linesFromSession(session: unknown): string[] {
  const log = (session as { log?: unknown })?.log;
  if (!Array.isArray(log)) return [];
  const lines: string[] = [];
  for (const raw of log) {
    const event = raw as {
      type?: string;
      data?: { message?: { content?: unknown }; content?: unknown };
    };
    const category = classifyEvent(event);
    if (category === 'assistant') {
      // 只取正文块：推理流不进沉淀源（否则会把内部思考写成长期记忆）
      const text = textBlocksOnly(event.data?.message?.content);
      if (text.length > 0) lines.push(text);
    } else if (category === 'user') {
      // `user/message` 不只装用户说的话：DSH 会把技能目录、运行时上下文、
      // 时间上下文、模型切换通知都塞进同一个事件类型，靠 `data.source.kind` 区分。
      // 不过滤的话，一份 12K 字符的技能目录会被当成用户发言送进 distill。
      if (!isRealUserMessage(event)) continue;
      const text = textBlocksOnly(event.data?.content);
      if (text.length === 0) continue;
      // 用户消息是指令，不是结论：只有含强约束词才进沉淀源。
      if (!hasUserConstraint(text)) continue;
      lines.push(text);
    }
  }
  return lines;
}
