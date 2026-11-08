/**
 * 上下文画像：**全插件唯一的「上下文里到底有什么」测量入口**。
 *
 * ## 为什么需要
 *
 * 之前每条路径只知道自己那一块：prune 看工具结果、trim 看 token 总数、
 * 沉淀看正文。没人知道 reasoning 已经占到 29.5% —— 那是用户用外部探针量出来的。
 *
 * 有了画像之后：
 * - `lrc_status` 直接展示各类别占比，不用再跑外部脚本
 * - 日志每 N 步打一行构成，增速异常能立刻看出来
 * - 不变量测试可以断言「各类别占比不超过上限」
 *
 * ## 口径
 *
 * 只统计**当前 surface 可见节点**（`session.surface.nodes`），
 * 已被 compaction/prune 遮蔽的节点不计入 —— 它们不在上下文里。
 */
import { classifyEvent } from './event-classify.ts';
import { isSummaryNode, resolveSessionEvents } from './context-trim.ts';

/** 各类别的字符数。 */
export interface CategoryChars {
  /** 系统提示 */
  system: number;
  /** 宿主注入上下文（技能目录 / 运行时 / 时间 / 审批） */
  injected: number;
  /** 真实用户输入 */
  user: number;
  /** 助手正文 */
  assistantText: number;
  /** 助手推理 */
  reasoning: number;
  /** 工具调用参数 */
  toolArgs: number;
  /** 工具结果 */
  toolResult: number;
}

/** 一次上下文画像。 */
export interface ContextProfile {
  /** surface 可见节点数 */
  nodes: number;
  /** 可见字符总数 */
  totalChars: number;
  /** 可见节点里的摘要（checkpoint）条数：>3 说明摘要层在堆叠 */
  checkpoints: number;
  /** 各类别字符数 */
  byCategory: CategoryChars;
  /** 各类别占比（0~1） */
  shares: CategoryChars;
}

const EMPTY: CategoryChars = {
  system: 0,
  injected: 0,
  user: 0,
  assistantText: 0,
  reasoning: 0,
  toolArgs: 0,
  toolResult: 0,
};

/** 统计内容块里的文本字符数。 */
function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') chars += b.text.length;
  }
  return chars;
}

/** 统计内容块里的推理字符数。 */
function reasoningChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === 'reasoning' && typeof b.text === 'string') chars += b.text.length;
  }
  return chars;
}

/** 统计内容块里的工具参数字符数。 */
function toolArgsChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; arguments?: unknown };
    if (b?.type === 'tool-call' && typeof b.arguments === 'string') chars += b.arguments.length;
  }
  return chars;
}

/**
 * 测量当前 surface 的上下文构成。
 *
 * @param session - 宿主会话
 * @returns 上下文画像（session 不可读时返回全零）
 */
export function profileSurface(session: unknown): ContextProfile {
  const nodes = (session as { surface?: { nodes?: unknown } })?.surface?.nodes;
  const events = resolveSessionEvents(session);
  if (!Array.isArray(nodes) || events === undefined) {
    return { nodes: 0, totalChars: 0, checkpoints: 0, byCategory: { ...EMPTY }, shares: { ...EMPTY } };
  }

  const byCategory: CategoryChars = { ...EMPTY };
  let checkpoints = 0;
  for (const seq of nodes) {
    const event = events[seq as number] as
      | {
          type?: string;
          data?: {
            content?: unknown;
            message?: { content?: unknown };
          };
        }
      | undefined;
    if (event === undefined) continue;
    if (isSummaryNode(event)) checkpoints += 1;
    const category = classifyEvent(event);

    if (category === 'system') {
      byCategory.system += textChars(event.data?.content ?? event.data?.message?.content);
    } else if (category === 'injected') {
      byCategory.injected += textChars(event.data?.content);
    } else if (category === 'user') {
      byCategory.user += textChars(event.data?.content);
    } else if (category === 'assistant') {
      const content = event.data?.message?.content;
      byCategory.assistantText += textChars(content);
      byCategory.reasoning += reasoningChars(content);
      byCategory.toolArgs += toolArgsChars(content);
    } else if (category === 'tool-result') {
      const content = event.data?.message?.content;
      // 真实形状：content = [{type:'text', text:'...'}]（实测 223/223 事件如此）。
      // 历史实现去读 content[0].content（嵌套块），形状猜错 → toolResult 恒为 0%，
      // 于是「工具结果占满上下文」这件事在画像里完全看不见。两种形状都收。
      byCategory.toolResult += textChars(content);
      if (Array.isArray(content)) {
        for (const block of content) {
          const nested = (block as { content?: unknown })?.content;
          if (nested !== undefined) byCategory.toolResult += textChars(nested);
        }
      }
    }
  }

  const totalChars = Object.values(byCategory).reduce((sum, value) => sum + value, 0);
  const shares: CategoryChars = { ...EMPTY };
  if (totalChars > 0) {
    for (const key of Object.keys(byCategory) as Array<keyof CategoryChars>) {
      shares[key] = byCategory[key] / totalChars;
    }
  }

  return { nodes: nodes.length, totalChars, checkpoints, byCategory, shares };
}

/** 一行可读摘要（日志与 `lrc_status` 用）。 */
export function formatProfile(profile: ContextProfile): string {
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const parts = [
    `toolResult ${pct(profile.shares.toolResult)}`,
    `reasoning ${pct(profile.shares.reasoning)}`,
    `toolArgs ${pct(profile.shares.toolArgs)}`,
    `user ${pct(profile.shares.user)}`,
    `injected ${pct(profile.shares.injected)}`,
    `system ${pct(profile.shares.system)}`,
    `assistantText ${pct(profile.shares.assistantText)}`,
  ];
  // checkpoint 条数是摘要自增殖的直接指标：>3 说明 trim 没能吸收旧摘要
  const warn = profile.checkpoints > 3 ? ' ⚠摘要堆叠' : '';
  return (
    `[lrc][profile] 节点=${profile.nodes} 总字符=${profile.totalChars}` +
    ` checkpoint=${profile.checkpoints}${warn} | ${parts.join(' ')}`
  );
}
