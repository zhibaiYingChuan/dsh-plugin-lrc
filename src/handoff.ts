/**
 * 路径 6：新建会话 + 摘要注入（会话交接）。
 *
 * ## 为什么需要
 *
 * 路径 1/2 只能把上下文压小，压到极限仍然会撞窗口。这时唯一的出路是
 * 「另起炉灶」：把当前会话的结论整理成一份交接摘要，注入一个新会话，
 * 原会话原样保留（可随时回看）。
 *
 * ## 为什么做成显式工具而不是自动触发
 *
 * 新建会话会改变用户的工作现场。自动触发一旦判断失误，用户会突然发现
 * 自己在另一个会话里。所以只提供 `lrc_handoff` 工具，由用户或模型显式调用。
 *
 * ## 两条创建路径
 *
 * 1. `ctx.agents.create()` —— 建一个**带 agent 的**新会话，可直接继续对话（首选）
 * 2. `ctx.sessions.create()` —— 只建会话，没有 agent（兜底，至少内容落盘）
 *
 * 两条都失败时只返回摘要文本，不抛错。
 */

/** 交接摘要的输入。 */
export interface HandoffInput {
  /** 当前会话的最后一条真实用户请求 */
  lastUserRequest: string;
  /** 最近几条助手正文（按时间正序） */
  recentAssistant: string[];
  /** 最近一次沉淀产出的状态快照 */
  snapshot: string;
  /** LRC 归档索引行（可为空） */
  indexLines: string[];
  /** 调用方补充的下一步说明 */
  note: string;
}

/** 交接结果。 */
export interface HandoffResult {
  ok: boolean;
  /** 新会话 id（创建成功时） */
  sessionId?: string;
  /** agent / session / text-only */
  mode: string;
  /** 交接摘要全文 */
  text: string;
  /** 失败原因 */
  reason?: string;
}

/**
 * 组装交接摘要。
 *
 * 只保留「接手的人必须知道」的四块：当前任务、最近结论、长期记忆索引、下一步。
 * 不复制整段对话 —— 那等于把上下文原样搬过去。
 */
export function buildHandoffText(input: HandoffInput): string {
  const sections: string[] = ['# 会话交接', ''];

  sections.push('## 当前任务');
  sections.push(input.lastUserRequest.trim().length > 0 ? input.lastUserRequest.trim() : '（未记录）');
  sections.push('');

  if (input.recentAssistant.length > 0) {
    sections.push('## 最近结论');
    for (const line of input.recentAssistant) {
      const flat = line.replace(/\s+/g, ' ').trim();
      if (flat.length > 0) sections.push(`- ${flat.length > 300 ? `${flat.slice(0, 300)}…` : flat}`);
    }
    sections.push('');
  }

  if (input.snapshot.trim().length > 0) {
    sections.push('## 已沉淀状态');
    sections.push(input.snapshot.trim());
    sections.push('');
  }

  if (input.indexLines.length > 0) {
    sections.push('## 长期记忆索引');
    for (const line of input.indexLines) sections.push(`- ${line}`);
    sections.push('');
  }

  sections.push('## 下一步');
  sections.push(input.note.trim().length > 0 ? input.note.trim() : '（由接手方根据上述上下文继续）');

  return sections.join('\n');
}

/** 从会话日志里取最后一条真实用户请求与最近几条助手正文。 */
export function extractHandoffSource(session: unknown): {
  lastUserRequest: string;
  recentAssistant: string[];
} {
  const log = (session as { log?: unknown })?.log;
  if (!Array.isArray(log)) return { lastUserRequest: '', recentAssistant: [] };

  let lastUserRequest = '';
  const assistant: string[] = [];
  for (const raw of log) {
    const event = raw as {
      type?: string;
      data?: { message?: { content?: unknown }; content?: unknown; source?: { kind?: string } };
    };
    if (event?.type === 'user/message') {
      // 只认用户真正说的话，跳过技能目录 / 运行时上下文
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== 'user') continue;
      const text = textOf(event.data?.content);
      if (text.length > 0) lastUserRequest = text;
    } else if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content);
      if (text.length > 0) assistant.push(text);
    }
  }
  return { lastUserRequest, recentAssistant: assistant.slice(-5) };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) out.push(b.text);
  }
  return out.join('\n');
}

function safeGet(ctx: unknown, name: string): unknown {
  try {
    return (ctx as { get?: (n: string) => unknown })?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * 创建新会话并注入交接摘要。
 *
 * 优先建「带 agent 的会话」，这样接手方可以直接继续对话；
 * 失败则退化为「只建会话」；再失败就只返回摘要文本。
 *
 * @param deps - 宿主 ctx、当前 agent、交接摘要
 * @returns 交接结果（永不抛错）
 */
export async function createHandoffSession(deps: {
  ctx: unknown;
  agent: unknown;
  text: string;
  log: (message: string) => void;
}): Promise<HandoffResult> {
  const { ctx, agent, text, log } = deps;
  const current = agent as {
    session?: { id?: string; header?: { cwd?: string } };
    options?: unknown;
  };
  const currentId = current?.session?.id;
  const cwd = current?.session?.header?.cwd;
  const meta = {
    ...(cwd === undefined ? {} : { cwd }),
    ...(currentId === undefined ? {} : { parentSession: currentId }),
  };
  const userMessage = {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };

  // 路径 A：带 agent 的新会话（可直接继续对话）
  const agents = safeGet(ctx, 'agents') as
    | { create?: (options: unknown) => Promise<{ agent?: { session?: unknown } }> }
    | undefined;
  if (typeof agents?.create === 'function') {
    try {
      const handle = await agents.create({
        sessionId: `session-handoff-${Date.now()}`,
        meta,
        ...(current?.options === undefined ? {} : { agentOptions: current.options }),
      });
      const session = handle?.agent?.session as
        | { id?: string; append?: (type: string, data: unknown) => unknown }
        | undefined;
      if (typeof session?.append === 'function') {
        session.append('user/message', userMessage);
        log(`[lrc][handoff] 已创建带 agent 的新会话：${session.id ?? 'unknown'}`);
        return { ok: true, sessionId: session.id, mode: 'agent', text };
      }
    } catch (error) {
      log(
        `[lrc][handoff] agents.create 失败，退回 sessions.create：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // 路径 B：只建会话（没有 agent，但内容落盘）
  const sessions = safeGet(ctx, 'sessions') as
    | { create?: (id?: string, options?: unknown) => unknown }
    | undefined;
  if (typeof sessions?.create === 'function') {
    try {
      const session = sessions.create(undefined, { meta }) as
        | { id?: string; append?: (type: string, data: unknown) => unknown }
        | undefined;
      if (typeof session?.append === 'function') {
        session.append('user/message', userMessage);
        log(`[lrc][handoff] 已创建新会话（无 agent）：${session.id ?? 'unknown'}`);
        return { ok: true, sessionId: session.id, mode: 'session', text };
      }
    } catch (error) {
      log(
        `[lrc][handoff] sessions.create 失败，只返回摘要：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { ok: false, mode: 'text-only', text, reason: 'sessions-unavailable' };
}
