/**
 * 事件分类：**全插件唯一的事件类型判定入口**。
 *
 * ## 为什么必须收口
 *
 * 之前每个模块各自写 `if (type === 'assistant/message')`：
 * - `session-text.ts` 判用户消息
 * - `context-trim.ts` 判裁剪边界
 * - `index.ts` 判沉淀来源
 *
 * 结果是每出现一个新事件类型（`system/message`、`user-approval`、
 * `skill-catalog`…）就要挨个补一遍，漏一个就是一次生产故障
 * （`system/message` 漏判直接让 trim 必挂并熔断）。
 *
 * 收口后只有这里需要认识新类型，其余模块只消费分类结果。
 */

/** 一个 surface 事件的内容类别。 */
export type EventCategory =
  /** 系统提示（DSH 某些版本把它作为 surface 的 node 0） */
  | 'system'
  /** 宿主注入的上下文：技能目录 / 运行时 / 时间 / 模型切换 / 审批提示 */
  | 'injected'
  /** 用户真正说的话 */
  | 'user'
  /** 助手消息（正文 / 推理 / 工具调用） */
  | 'assistant'
  /** 工具结果 */
  | 'tool-result'
  /** 未知类型（保守处理：不参与裁剪、不参与沉淀） */
  | 'unknown';

/**
 * 判定一个事件的内容类别。
 *
 * 用**白名单**：只有明确认识的类型才归入对话类别，其余一律 `unknown`。
 * 这样新类型出现时最坏是「不处理」，而不是「被误当成可裁剪节点」。
 *
 * @param event - 会话事件
 * @returns 内容类别
 */
export function classifyEvent(event: unknown): EventCategory {
  const e = event as { type?: string; data?: { source?: { kind?: string } } };
  switch (e?.type) {
    case 'system/message':
      return 'system';
    case 'assistant/message':
      return 'assistant';
    case 'tool/result':
      return 'tool-result';
    case 'user/message': {
      const kind = e.data?.source?.kind;
      // 没有 source 视为真实用户消息（兼容旧格式）
      return kind === undefined || kind === 'user' ? 'user' : 'injected';
    }
    default:
      return 'unknown';
  }
}

/**
 * 是否是可替换的对话节点（裁剪边界、剪枝目标）。
 *
 * `system` / `injected` / `unknown` 都不能被替换：
 * 替换系统提示会被 `compactRegion` 拒绝，替换注入上下文会丢运行时事实。
 */
export function isConversationNode(event: unknown): boolean {
  const category = classifyEvent(event);
  return category === 'user' || category === 'assistant' || category === 'tool-result';
}

/** 是否是真实用户消息（沉淀来源判定）。 */
export function isRealUserEvent(event: unknown): boolean {
  return classifyEvent(event) === 'user';
}
