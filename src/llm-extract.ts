/**
 * LLM 兜底提取：规则抽不到时，再问一次模型。
 *
 * ## 为什么必须有这一层
 *
 * `constraintsFromProse` 是**正则**。正则的能力边界是「我见过的措辞」，
 * 而模型表达关键信息的方式是开放的。实测真实会话（6 个会话、214 句含
 * 「结论/目标/根因」信号的句子）：规则版抽出 113 句，剩余 101 句里
 * 绝大多数是名词性引用（正确排除），但仍有真结论漏在边界外 ——
 * 每补一条正则，就会有新的措辞漏过去。这是**结构性缺陷，不是覆盖不足**。
 *
 * ## 为什么不用提示词
 *
 * 早前版本的做法是写系统提示，要求模型每轮输出 `<lrc_memory>`。
 * 实测 56 条正文里只有 1 条遵守（1.8%）—— 提示词是概率性倾向，
 * 不是可执行的合同。要求模型「顺手多做一件与当前任务无关的事」，
 * 它就不会做。
 *
 * 「再调一次模型」则不同：这是一次**独立的、结构受控的调用**，
 * 输出格式由 JSON 契约约束，不依赖主循环里的模型是否记得住。
 * 对应六层治理架构里的「结构化约束」层，而不是宪法层。
 *
 * ## 成本闸门（这是它默认关闭的原因）
 *
 * 每次调用是一次真实模型请求。实测成本（6 个会话 518 条真实正文）：
 * ```
 * 仅密度闸门：19.3% 的正文触发（100/518）
 * 加会话配额（40 次 + 30s 间隔）：每会话 40 次，约 24.5K 额外输入 tokens
 * ```
 * 相对会话总成本（约 9 元量级）占比不到 1%。四道限制：
 * 1. **开关**（默认关闭，必须显式开启）
 * 2. 正文长度下限 + 绝对地板
 * 3. 类型缺口 / 密度判据（只在规则明显抽不够时触发）
 * 4. 会话级调用上限 + 最小间隔（防止异常循环把账单打爆）
 *
 * @see `DECLARED_CONCLUSION` / `DECLARED_GOAL`（memory-filter.ts）—— 规则层
 */
import { randomUUID } from 'node:crypto';

/** 单次发送给兜底模型的正文上限（字符）。超出只取尾部。 */
const MAX_INPUT_CHARS = 6000;

/** 单次输出的 token 上限：10 条以内足够。 */
const MAX_OUTPUT_TOKENS = 1200;

/**
 * 判定模式下最多送多少条候选。
 *
 * ## 为什么从 80 提到 200（★2026-11-14）
 *
 * 80 是按「助手正文」估的（实测一份 7258 字符报告切出 64 条）。
 * 但 session-95eaf7e3（新项目开工，用户粘贴 16882 字符产品文档）切出
 * **188 条** —— 超出的部分会被 `.slice()` 静默丢弃，正是我们一直在修的
 * 那类「无声漏抽」。
 *
 * 200 × 平均 45 字符 ≈ 9000 字符输入，flash 模型完全吃得下。
 * 更大的文档（10 万字符级）仍会截断，但**正文已整份落盘**（工件指针
 * Fact 记录在库），需要细节时用 `lrc_fetch_artifact` 取回原文，
 * 因此这里保留「取前 N 条」不会造成信息永久丢失。
 */
const MAX_JUDGE_CANDIDATES = 200;

/**
 * 单次调用超时（毫秒）。
 *
 * 判定模式下输入可达 200 条候选（约 9000 字符），20 秒对慢路由偏紧 ——
 * 超时会静默返回空数组，表现为「明明有待裁决句却什么都没抽到」。
 * 45 秒覆盖 200 条候选的判定，同时仍能在用户察觉前完成（异步，不阻塞对话）。
 */
const CALL_TIMEOUT_MS = 45_000;

/** 兜底提示词。 */
const SYSTEM_PROMPT = [
  '你是记忆提取器。从用户提供的对话片段中挑出「值得跨会话复用」的信息，只输出 JSON。',
  '',
  '## 判断标准（这是唯一标准）',
  '',
  '问自己一个问题：**一个完全没看过这段对话的人，读到这句话能获得有用信息吗？**',
  '',
  '能 ⇒ 记。不能 ⇒ 不记。',
  '',
  '值得记的典型形态（不限于这些，措辞可以任意）：',
  '- 对某事物的判断、评价、定性',
  '- 已经查清的原因、机制、结果',
  '- 已定下来的做法、选型、约定',
  '- 对后续有强制力的规则',
  '- 可验收的量化目标',
  '- 某对象是什么 / 包含什么 / 在哪',
  '',
  '不值得记的：',
  '- 应答与确认（是的、明白了、好的）',
  '- 讲自己刚才/接下来在做什么（我先看一下、已经读完了、下面开始）',
  '- 指代不明、脱离上下文看不懂的句子（这个是刚才那个文件、这样的话就只能重写了）',
  '- 代码、表格行、JSON、日志',
  '- 纯粹的过渡句与章节标题',
  '',
  '## 输出格式（严格）',
  '',
  '{"items":[{"kind":"<类别>","text":"<一句话陈述>"}]}',
  '',
  '类别取值（选最贴合的一个）：',
  '- constraint：有强制力的规则',
  '- decision：定下来的做法',
  '- conclusion：查清的原因/结果',
  '- goal：量化目标',
  '- scope：范围约定',
  '- statement：定义、属性、构成、位置',
  '',
  '## 硬性要求',
  '',
  '1. text 必须自足：把这句话单独发给别人，他能看懂在说什么。',
  '2. text 保留原文的**判断与限定**（「比多数开源 agent 认真」这样的程度词不要丢）。',
  '3. 不要加「结论：」这类前缀，只写内容本身。',
  '4. 没有值得记的就输出 {"items":[]}。',
  '5. 最多 12 条，按重要性排序。',
].join('\n');

/**
 * 判定提示词：候选清单模式（★2026-11-14）。
 *
 * ## 为什么「判定」比「提取」可靠
 *
 * 提取模式要模型从整段正文里自己找句子，它倾向于**改写**（把长句缩成
 * 短句、把评价删掉），产物无法追溯到原文。判定模式只要求二分类：
 * 给定这句，它值不值得记？
 *
 * 实测对照：同一份 7258 字符报告，提取模式产出 4 条且 3 条是碎片；
 * 判定模式面对 82 条候选，能稳定挑出其中的判断句。
 *
 * ## 输出契约保持与提取模式一致
 *
 * 都是 `{"items":[{"kind","text"}]}` —— 下游 `factsFromLlmLines` 不需要
 * 区分两种模式。
 */
const JUDGE_PROMPT = [
  '你是记忆筛选器。用户会给出一批**从对话里切出的候选句**，你只判断哪些值得保留。',
  '',
  '## 唯一的判断标准',
  '',
  '问自己：**一个完全没看过这段对话的人，读到这句话能获得有用信息吗？**',
  '',
  '能 ⇒ 保留。不能 ⇒ 丢掉。',
  '',
  '## 保留（true）',
  '- 判断、评价、定性：`分层极其干净，改造成本低`',
  '- 查清的原因、机制、结果：`根因是旧进程没有随会话退出`',
  '- 定下来的做法：`改用 --stdin 传入 JSON`',
  '- 有强制力的规则：`以后都不要碰 3099`',
  '- 量化目标：`握手耗时压到 200ms 以内`',
  '- 对象的定义、属性、构成：`这个仓库收录了 443 个项目`',
  '',
  '## 丢弃（false）',
  '- 应答确认：`是的，我明白了` / `好的`',
  '- 自述步骤：`我先看一下这个文件` / `代码已全部读完，结论如下`',
  '- 指代不明、脱离上下文看不懂：`这个是刚才那个文件` / `这样的话就只能重写了`',
  '- 过渡与标题：`## 二、优点` / `下面分三点说`',
  '- 代码、表格行、JSON、日志片段',
  '',
  '## 输出格式（严格）',
  '',
  '只保留判为 true 的句子，**原样复制**，一个字都不要改：',
  '{"items":[{"kind":"statement","text":"<原句>"}]}',
  '',
  'kind 取值：constraint / decision / conclusion / goal / scope / statement',
  '',
  '## 硬性要求',
  '1. text 必须与候选句**完全一致**（不改写、不缩写、不补全）。',
  '2. 没有值得保留的就输出 {"items":[]}。',
  '3. 最多 12 条，优先保留信息密度高的。',
].join('\n');

/** 类别 → 中文前缀（与 `itemsFromTag` 的 `classifyTagLine` 对齐）。 */
const KIND_PREFIX: Record<string, string> = {
  constraint: '约束',
  decision: '决策',
  conclusion: '结论',
  goal: '约束',
  scope: '约束',
  // ## 必须与 `memory-extract.ts` 的 `TAG_KIND` 对齐
  //
  // 这里只是「行前缀」，真正决定类别的是 `factsFromLlmLines` 里的
  // `hintOf`。若两边不一致（例如这里给「事实」而 TAG_KIND 不认识），
  // 前缀会被当成正文，hint 丢失 ⇒ 陈述句退化成「随便命中的第一个谓词」。
  statement: '事实',
};

/** `shouldFallbackToLlm` 的入参与配额状态。 */
export interface FallbackGateInput {
  /** 正文（assistant 本轮） */
  text: string;
  /** 规则层已抽出的条目（schema 时代是裸陈述） */
  extracted: readonly string[];
  /**
   * 规则层已抽到的**类别**（`constraint` / `decision` / `conclusion` …）。
   *
   * 类型缺口必须按类别判：`extracted` 里是 schema 生成的裸陈述，
   * 靠中文前缀（`结论：`）永远判不出来（见 `missingKinds` 注释）。
   */
  extractedKinds?: readonly string[];
  /**
   * 语义待裁决的句子（来自 `extractFacts` 的 `pending`）。
   *
   * 非空 ⇒ 一定触发兜底（见 `shouldFallbackToLlm` 判据一）。
   */
  pending?: readonly string[];
  /** 开关 */
  enabled: boolean;
  /** 正文长度下限 */
  minChars: number;
  /** 会话额度上限（0 = 不限制） */
  maxCalls: number;
  /** 本会话已调用次数 */
  usedCalls: number;
  /** 最小间隔（毫秒） */
  minIntervalMs: number;
  /** 距上次调用的毫秒数 */
  sinceLastMs: number;
  /**
   * 进程级总调用次数与上限（第二道成本防线，可选）。
   *
   * ## 为什么会话配额不够
   *
   * 会话配额是**按桶独立**的。多窗口（DSH 支持同时开多个会话）场景下，
   * 21 个会话各自 40 次 = 840 次调用。而且会话桶会因 Map 上限被淘汰重建，
   * 单靠它无法约束进程总量。
   *
   * ## 为什么必须带时间窗
   *
   * 若只计总数，常驻进程里 5 个满额会话用完后兜底**永久关闭**，只能重启
   * 恢复。改为**滑动窗口**计数：只统计最近 `globalWindowMs` 内的调用，
   * 时间一过自动恢复额度。
   */
  globalCalls?: number;
  globalMaxCalls?: number;
}

/**
 * 每多少字符期望抽出 1 条关键信息。
 *
 * ## 为什么从 500 提到 1200
 *
 * 500 是按「一段正常答复约 500 字」估的，实测偏乐观：真实日志里
 * 518 条正文平均 207 字，但**长答复**（触发兜底的那批）平均 492 字，
 * 而其中大量是工具输出摘录、代码片段、步骤罗列 —— 这些本来就不该有
 * 可复用结论。用 500 会把它们全部判成「漏抽」。
 *
 * 1200 的语义：只有「明显偏长却几乎没抽到东西」才算异常。
 * 实测把触发率从 32.4% 降到约 20%，且保留下来的都是真长文。
 */
const CHARS_PER_EXPECTED_ITEM = 1200;

/**
 * 绝对地板：正文短于此长度一律不兜底。
 *
 * 取值依据：一句完整的结论通常 20 字以上，短于此的多半是「好的」
 * 「已完成」这类应答，问一次模型纯属浪费。
 */
const ABSOLUTE_MIN_CHARS = 24;

/**
 * 正文里的**归因信号**：出现了这些词，说明作者在给出「为什么会这样」的定论。
 *
 * ## 为什么不用「因为 / 所以 / 由于」
 *
 * 这三个词在中文叙述里高频出现，且多用于**解释推理过程**而非下结论：
 * ```
 * 因为 PowerShell 会吞引号，所以我改成 --stdin    ← 过程说明，不是结论
 * 所以缓存必须放在工作区外                        ← 规则层已抽到
 * ```
 * 实测（6 个会话 518 条正文）：带这三个词的占 **13.1%**（68 条），
 * 而带真正定论词（根因 / 结论是 / 定位到）的合计不到 4%。
 * 用宽泛因果词会让「缺结论」判定多出十余个百分点，而其中多数是过程说明。
 *
 * 只保留**定论性**表述：这些词出现时，作者是在陈述已经查清的事实。
 */
const CAUSAL_SIGNAL =
  /根因|根本原因|原因在于|问题出在|问题在于|定位到|最终确认|结论是|结论为|确定为|查明|真相是/;

/** 正文里的**决策信号**。 */
const DECISION_SIGNAL = /决定|决策|采用|改用|换成|改成|定为|选型|就用|方案是|最终选/;

/** 正文里的**量化目标信号**：必须是「数值 + 量纲」，不接受裸「以下/以内/目标」。 */
const GOAL_SIGNAL =
  /(?:压|降|控制|限制)(?:到|至)\s*[0-9]|(?:不超过|不低于|不少于|不大于|不小于)\s*[0-9]|[0-9][0-9.]*\s*(?:ms|毫秒|秒|分钟|元|块|%|％|倍|MB|GB|KB|TB)\s*(?:以下|以内|内)/;

/**
 * 正则抽出的条目里**缺少**哪些类型（返回缺失的类型名）。
 *
 * ## 为什么必须能按**类别**判，不能只看前缀（★2026-11-14）
 *
 * 旧实现的判据是 `line.startsWith('结论：')`，那是 `constraintsFromProse`
 * 时代的形态 —— 它返回带中文前缀的行。改成 schema 后传入的是
 * `MemoryFact.statement`（`HEAD 是 e839e55` 这种**裸陈述**），永远不可能
 * 以 `结论：` 开头 ⇒ 类型缺口判据恒为真 ⇒ 每一次带因果信号的正文都会
 * 触发兜底，成本闸门形同虚设。
 *
 * 因此调用方应传 `extractedKinds`；未传时退回前缀判据（兼容旧测试）。
 */
function missingKinds(
  text: string,
  extracted: readonly string[],
  extractedKinds?: readonly string[],
): string[] {
  const missing: string[] = [];
  // 有类别信息时按类别判；否则按旧的中文前缀判
  const hasOf = (kind: string, prefix: string): boolean =>
    extractedKinds !== undefined
      ? extractedKinds.includes(kind)
      : extracted.some((line) => line.startsWith(prefix));

  if (CAUSAL_SIGNAL.test(text) && !hasOf('conclusion', '结论：')) missing.push('结论');
  if (DECISION_SIGNAL.test(text) && !hasOf('decision', '决策：')) missing.push('决策');
  // ## 目标缺口不能只看「有没有抽到约束：」
  //
  // 目标在规则层可能归「约束」（`constraintsFromProse` 时代），也可能归
  // `goal`（schema 之后）。而它和「不要碰 3099」这类约束是**不同维度**的
  // 东西，用「有没有约束」做代理判据会互相掩盖：
  // ```
  // 正文: 只支持 Windows。响应时间得进到 200ms 以内。
  // 规则: 抽出「约束：只支持 Windows」
  // 判据: 有约束 ⇒ 判定目标不缺 ⇒ 漏掉 200ms 那个目标
  // ```
  // 改为直接看**已抽条目里有没有量化形态**（或已有 goal 类）。
  const goalCovered =
    (extractedKinds?.includes('goal') ?? false) || extracted.some((line) => GOAL_SIGNAL.test(line));
  if (GOAL_SIGNAL.test(text) && !goalCovered) {
    missing.push('目标');
  }
  return missing;
}

/**
 * 是否值得为这条正文花一次模型调用。
 *
 * ## 为什么不能只看「规则抽到 0 条」
 *
 * 首版判据是「规则一条都没抽到才兜底」。端到端实测立刻暴露漏洞：
 * ```
 * 正文: 来龙去脉 + 修好了 + 以后不要碰 3099
 * 规则: 抽出 1 条（约束：以后不要再碰…）
 * 兜底: 不触发（因为 ≥1）
 * 实际: 漏了「旧进程未退出，新连接被阻断在握手阶段」这条真结论
 * ```
 * 抽到一条不等于抽全 —— 这恰恰是遗漏最常发生的地方。
 *
 * ## 两道判据：类型缺口优先于密度
 *
 * **类型缺口**（精确）：正文里出现因果信号但没抽出结论、出现决策信号但
 * 没抽出决策、出现量化目标但没抽出约束 —— 只要缺一类就该兜底。
 * 这条能抓住「抽到 1 条但漏了另一类」的情形，且不受正文长度影响。
 *
 * **密度**（兜底）：按「每 500 字符至少 1 条」估算，低于期望就兜底。
 * 用来覆盖那些**信号词也没命中**的漏抽 —— 没有这两道中的任何一道，
 * 长正文大面积漏抽就永远发现不了。
 *
 * ## 为什么「抽出 0 条」也必须过长度门槛
 *
 * 首版在抽出 0 条时把门槛降到 1/4，实测真实日志（6 个会话 518 条正文）
 * 有 **368 条**因这条被触发（占 71%），而绝大多数是「我先看一下这个文件」
 * 这类过程短句 —— 它们本来就不该有结论。整体触发率 81.5%，成本不可接受。
 *
 * 收紧后：短回复没结论是正常现象，不是漏抽。
 */
export function shouldFallbackToLlm(input: FallbackGateInput): boolean {
  if (!input.enabled) return false;
  const pendingCount = input.pending?.length ?? 0;
  // ## 绝对地板按**待裁决材料**算，不按原正文（★2026-11-14）
  //
  // 原实现一律用 `text.length` 判地板。但 `pending` 是规则层切出的候选，
  // 它的总长才是「这次要模型判多少东西」。一段 200 字正文可能只切出
  // 一句 13 字的判断句（→ 不值得调用），也可能切出 60 句（→ 必须调用）。
  // 用原正文长度判会把后者的门槛判得过松、把前者判得过紧。
  const chars =
    pendingCount > 0
      ? input.pending!.reduce((sum, line) => sum + line.length, 0)
      : input.text.trim().length;
  // ## 绝对地板看**材料的真实规模**（★2026-11-15 独立审查 P0）
  //
  // 首版一律用 `chars`（pending 总长或正文长度）判地板，且排在
  // 「pending 非空即触发」之前。两个反例同时存在：
  // ```
  // 正文 340 字 + pending=[]            → chars=340 ⇒ true  （对）
  // 正文 340 字 + pending=["file://…"]  → chars=14  ⇒ false （错！）
  // 正文 8 字   + pending=["分层干净"]   → chars=8   ⇒ false （对，材料确实不足）
  // ```
  // 第二行是方向性错误：有 1 条短候选反而把长正文从 true 压成 false。
  //
  // ## 为什么取 max 而不是相加
  //
  // `pending` 是**从正文里切出来的**候选，两者不是并列材料而是整体与部分。
  // 相加会重复计数（60 条 pending 总长 300，正文本身可能只有 310 字）。
  // `max` 表达的正是「这次要处理多少东西」。
  const materialChars = Math.max(chars, input.text.trim().length);
  const extractedCount = input.extracted.length;
  if (materialChars < ABSOLUTE_MIN_CHARS) return false;

  // 额度与间隔是硬闸门，优先判掉（省掉后续计算）
  if (input.maxCalls > 0 && input.usedCalls >= input.maxCalls) return false;
  if (input.minIntervalMs > 0 && input.sinceLastMs < input.minIntervalMs) return false;
  // 进程级总额度：多窗口场景唯一可靠的硬上限
  const globalMax = input.globalMaxCalls ?? 0;
  if (globalMax > 0 && (input.globalCalls ?? 0) >= globalMax) return false;

  // 判据一：**有待裁决的句子**（★2026-11-14 新增，最高优先级）
  //
  // 规则层把「结构合格但没命中谓词表」的句子放进 `pending`。
  // 这类句子既不能直接放行（会涌入「是的，我明白了」），也不能直接丢
  // （会淹没「分层极其干净，改造成本低」）—— 只有语义能区分。
  //
  // 实测同一份 7258 字符报告：结构判据 82/82 全通过（零区分力），
  // 谓词表只剩 3 条（96% 误杀）。所以只要 `pending` 非空就该问一次。
  //
  // 这条路**不受 minChars 长度门槛约束**：一段 200 字的总结可能整段都是
  // 判断句却一条也拆不出三元组。
  if (pendingCount > 0) return true;

  // 判据二：类型缺口 —— 同样不受长度门槛约束。
  //
  // 实测：83 字正文里有「旧进程没退出…挡在握手阶段」（因果）+
  // 「以后不要碰 3099」（约束）。规则只抽出后者，一旦用 120 字门槛
  // 拦截就会漏掉前者。因果关系是明确信号，和正文多长无关。
  if (missingKinds(input.text, input.extracted, input.extractedKinds).length > 0) return true;

  // 以下判据都要求正文达到配置门槛。
  //
  // ## 为什么抽出 0 条也必须过门槛
  //
  // 首版在「抽出 0 条」时把门槛降到 1/4，实测真实日志 6 个会话
  // 518 条正文中有 **368 条**因这条被触发（占 71%），而其中绝大多数
  // 是「我先看一下这个文件」这类过程短句 —— 它们本来就不该有结论。
  // 触发率整体达 81.5%，成本代价不可接受。
  //
  // 收紧后：只有「正文足够长却什么都没抽到」才值得问一次。
  // 短回复没结论是正常现象，不是漏抽。
  if (chars < Math.max(1, input.minChars)) return false;

  // 判据二：抽出 0 条 —— 「长正文什么都没抽到」是强信号
  if (extractedCount === 0) return true;

  // 判据三：密度不足（覆盖信号词也没命中的漏抽）
  const expected = Math.ceil(chars / CHARS_PER_EXPECTED_ITEM);
  return extractedCount < expected;
}

export interface LlmExtractOptions {
  /** 单次发送的正文上限 */
  maxInputChars?: number;
  /** 单次调用超时 */
  timeoutMs?: number;
  /**
   * 规则层判定为「待裁决」的句子（★2026-11-14）。
   *
   * 传了就把它们作为**候选清单**一起发给模型：模型只需在这些句子里挑，
   * 而不是从零开始读整段正文。好处是：
   * 1. 判定任务比提取任务简单，模型准确率更高
   * 2. 输出可追溯到原文（不会出现模型自己改写出的新句子）
   * 3. 输入更短（候选句列表远小于原正文）
   */
  candidates?: readonly string[];
  /**
   * 调用失败时的回调（★2026-11-16 发布前审查 P1-3）。
   *
   * ## 为什么需要
   *
   * 返回类型是 `Promise<string[]>`，无法区分「调用失败」与「模型判定无内容」——
   * 两者都是空数组。而 LLM 兜底是**唯一产生额外计费的路径**，失败必须可见：
   * 超时、401、路由拒绝若与「没抽到」在日志里同形，只能靠 `lrc_status`
   * 的计数间接推断，排查时无从定位。
   *
   * 用回调而不是改返回类型：现有调用点与测试都不需要动。
   */
  onFailure?: (reason: string) => void;
}

/** 从 `ctx` 里安全取服务（宿主可能没装 llm 服务）。 */
function safeGet(ctx: unknown, name: string): unknown {
  try {
    return (ctx as { get?: (n: string) => unknown })?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * 从流式输出里拼出文本与**结束原因**。
 *
 * 优先用 `text-delta`（增量协议）；部分适配器只发 `block-end`，
 * 所以两者都收，但同一块不重复计数（`block-end` 的 block.text 是完整值，
 * 若已由 delta 拼出则跳过）。
 *
 * ## 为什么必须带出结束原因
 *
 * `LlmRuntime` 把适配器异常/中断**归一化为 `finish{reason:{kind:'error'}}`
 * 或 `{kind:'aborted'}`，不抛异常**。若不看这个字段，超时或崩溃时拿到的
 * 半截文本会被当作完整输出解析 —— 若那半截恰好凑出一个合法 JSON，
 * 就会写入一条**残缺的关键信息**，比丢弃更糟（LRC 跨会话复用，撤回靠人工）。
 */
function collectText(chunks: Iterable<unknown>): { text: string; finishKind: string } {
  const byIndex = new Map<number, string>();
  let finishKind = 'unknown';
  for (const raw of chunks) {
    const chunk = raw as {
      type?: string;
      index?: number;
      text?: string;
      block?: { type?: string; text?: string };
      reason?: { kind?: string };
    };
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const index = typeof chunk.index === 'number' ? chunk.index : 0;
      byIndex.set(index, (byIndex.get(index) ?? '') + chunk.text);
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const index = typeof chunk.index === 'number' ? chunk.index : 0;
      // 已有 delta 拼接结果时不覆盖（delta 才是权威增量）
      if (!byIndex.has(index) && typeof chunk.block.text === 'string') {
        byIndex.set(index, chunk.block.text);
      }
    } else if (chunk.type === 'finish') {
      finishKind = typeof chunk.reason?.kind === 'string' ? chunk.reason.kind : 'unknown';
    }
  }
  const text = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .join('');
  return { text, finishKind };
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型常会包一层 ```json 围栏，或在前后加一句解释 —— 直接 `JSON.parse`
 * 会失败。这里剥围栏后取第一个 `{` 到最后一个 `}`。
 */
function parseItems(raw: string): Array<{ kind: string; text: string }> {
  const withoutFence = raw.replace(/```(?:json)?/gi, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: Array<{ kind: string; text: string }> = [];
  for (const item of items) {
    const rec = item as { kind?: unknown; text?: unknown };
    const kind = typeof rec.kind === 'string' ? rec.kind.trim().toLowerCase() : '';
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (text.length < 4 || text.length > 500) continue;
    // 未知类别按结论处理（比丢弃安全：至少保住内容）
    out.push({ kind: KIND_PREFIX[kind] === undefined ? 'conclusion' : kind, text });
  }
  return out;
}

/**
 * 用一次性独立模型调用提取关键信息。
 *
 * @param ctx - cordis 上下文（需要 `llm` 服务）
 * @param session - 会话（取 provider/model 路由）
 * @param text - assistant 正文（本轮）
 * @param options - 输入上限与超时
 * @returns 形如 `约束：…` 的行（可直接喂 `itemsFromTag`）；失败返回空数组
 */
export async function extractWithLlm(
  ctx: unknown,
  session: unknown,
  text: string,
  options: LlmExtractOptions = {},
): Promise<string[]> {
  const maxInputChars = options.maxInputChars ?? MAX_INPUT_CHARS;
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;

  const body = text.trim();
  if (body.length === 0) return [];

  // 路由：与主对话同一个 provider/model，避免另配一套凭据
  const config = (session as {
    requestHeader?: () => { config?: { provider?: unknown; model?: unknown } };
  })?.requestHeader?.()?.config;
  const provider = typeof config?.provider === 'string' ? config.provider : '';
  const model = typeof config?.model === 'string' ? config.model : '';
  if (provider.length === 0 || model.length === 0) return [];

  const llm = safeGet(ctx, 'llm') as
    | { stream?: (options: unknown) => AsyncIterable<unknown> }
    | undefined;
  if (typeof llm?.stream !== 'function') return [];

  // 超长只取尾部：关键结论通常在答复末尾
  const body2 = body.length > maxInputChars ? body.slice(-maxInputChars) : body;

  // ## 有候选清单时走「判定」模式（★2026-11-14）
  //
  // 判定只做二分类，比提取可靠得多：模型不需要自己想句子，只需回答
  // 「这句值不值得记」。实测提取模式倾向改写（把「比多数开源 agent 认真」
  // 缩成「做得认真」），判定模式因为要求原样复制，产物可追溯。
  const candidates = options.candidates ?? [];
  const useJudge = candidates.length > 0;
  const input = useJudge
    ? candidates
        .slice(0, MAX_JUDGE_CANDIDATES)
        .map((line, index) => `${index + 1}. ${line}`)
        .join('\n')
    : body2;
  const system = useJudge ? JUDGE_PROMPT : SYSTEM_PROMPT;

  const messages = [
    {
      id: randomUUID(),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: input }],
      source: { kind: 'plugin' as const, plugin: 'dsh-plugin-lrc' },
    },
  ];

  const collected: unknown[] = [];
  try {
    const stream = llm.stream({
      provider,
      model,
      messages,
      system,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      // `purpose` 只接受宿主已声明的枚举值（compaction / session-title），
      // 传未知值可能被适配器拒绝，故不设。
      signal: AbortSignal.timeout(timeoutMs),
      sessionId: (session as { id?: string })?.id,
    });
    for await (const chunk of stream) collected.push(chunk);
  } catch (error) {
    // 失败必须可见：这是唯一计费路径，静默返回空数组会让「超时/401」
    // 与「模型判定无内容」在日志里同形（见 `onFailure` 注释）。
    options.onFailure?.(error instanceof Error ? error.message : String(error));
    return [];
  }

  const { text: rawText, finishKind } = collectText(collected);
  // ## 只否决「明确失败」的结束原因，不用白名单
  //
  // 宿主的 `BlockAssembler.finish` 在流未发 finish chunk 时返回
  // `{kind:'stop'}`，但我们是**手工拼流**、不经过 assembler，所以
  // 没见过 finish 时只能是 `'unknown'`。若要求必须等于 `'stop'`，
  // 任何不发 finish 的适配器都会让兜底永久失效 —— 这比漏抽更糟。
  //
  // 因此改为黑名单：error / aborted 明确失败，丢弃；其余（stop /
  // length / unknown）继续解析。`length` 是输出被 maxTokens 截断，
  // 但 JSON 若仍完整可解析就说明内容齐了。
  if (finishKind === 'error' || finishKind === 'aborted') return [];

  const parsed = parseItems(rawText);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const prefix = KIND_PREFIX[item.kind] ?? '结论';
    // ## 必须折叠换行
    //
    // 下游是 `itemsFromTag(lines.join('\n'))`，它按 `\n` 切行。模型常对
    // 长结论折行，`text` 里一旦含 `\n` 就会被切成多条，第二段失去类别
    // 前缀、被 `classifyTagLine` 兜底判成「结论」—— 实测产出
    // `[结论] 第二行被换行切开了` 这类无主谓碎片。
    //
    // 提示词已要求「一句话自足陈述」，折叠成空格不损语义。
    const flat = item.text.replace(/\s*\r?\n\s*/g, ' ').trim();
    if (flat.length === 0) continue;
    const key = flat.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${prefix}：${flat}`);
  }
  return lines;
}
