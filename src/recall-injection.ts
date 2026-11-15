/**
 * 上下文注入：把"该让模型看到的记忆"组装成一段可注入文本。
 *
 * ## 为什么需要这个模块
 *
 * 真实事故（2026-11-12，session-3b497669）：模型在整个 379 步里**从未想起**
 * 调用 `lrc_recall` —— 不是权衡后放弃，是压根没进入候选集。
 * 系统提示里明明写着"涉及历史先调 lrc_recall"，工具也注册了，但模型
 * 注意力全在"把视频做出来"上，记忆检索在它眼里不是必要前置。
 *
 * 结论：不依赖模型主动"拉"，由插件把**相关**记忆推进去。
 *
 * ## 「推」必须是软的，不是命令
 *
 * 注入的历史若被写成"这是事实"，模型会为了迎合它而改变当前做法 ——
 * 哪怕那段历史来自别的项目、或早已被废弃的方案（真实风险：上下文偏移与幻觉）。
 * 所以注入段落必须自带**来源与时效性声明**：它是历史，可能与当前任务无关，
 * 判断权在正在工作的模型手里。
 *
 * ## 但"推"有三个硬约束
 *
 * 1. **缓存**：宿主按前缀复用 KV。每轮注入不同内容会打断复用。
 *    实测基线（0.2.4，611 次请求）：命中率 92.2%，P50 96.6%。
 *    注入策略不能让命中率显著低于 85%。
 *
 * 2. **噪音**：无关话题时注入等于污染上下文。宁可什么都不注入。
 *
 * 3. **长度**：实测"只给计数"33 字符 vs "给全文"51 字符，差 18 字符 ——
 *    全文并不比计数贵多少，所以**优先给内容而不是给指针**：
 *    让模型直接看到记忆，比让它"为了看记忆而调工具"可靠得多。
 *
 * ## 与"沉淀快照"的分工
 *
 * - **沉淀快照**（`[LRC 状态]`）：上一轮写进了什么。低频变化，缓存友好。
 * - **召回注入**（本模块）：和当前话题相关的历史。按话题变化触发。
 *
 * 两者拼进同一个 `systemPrompt.context`，但更新时机不同：
 * 快照跟沉淀走，召回跟**话题指纹**走 —— 同一话题内文本完全不变，
 * 从而把"破坏缓存"控制在该话题首次进入时的一次性代价。
 */

/** 一条要注入的记忆。 */
export interface InjectedMemory {
  id: string;
  content: string;
  memory_type?: string;
  /** 融合原始分（绝对相关度，LRC RRF 实测量级 0.016–0.032） */
  score?: number;
  /** 相对 top1 归一化的展示分（top1 恒为 1.0） */
  score_norm?: number;
}

/** 注入策略参数。 */
export interface RecallInjectionOptions {
  /** 最多注入几条（0 = 关闭注入） */
  maxItems: number;
  /** 单条内容截断长度（字符） */
  maxCharsPerItem: number;
  /** 整段注入的字符上限 */
  maxTotalChars: number;
  /**
   * 相对分下限（0–1，`score_norm`）。
   *
   * 它只能筛掉「同批候选里明显掉队的那几条」，**不能**单独当相关性判据：
   * top1 恒为 1.0，任何情况下都会放行一条。真正的准入由 `minRawScore` 决定。
   */
  minScore: number;
  /**
   * 绝对分下限（`score`，RRF 融合分）。
   *
   * ## 这个字段的真实含义（★独立审查纠正了我的错误归因）
   *
   * RRF 分 = Σ 1/(k + rank)，`k=60`。所以它的值域是 `(0, 2/61]`，
   * **只与"命中几条检索通路、各排第几"有关，与语义相关度无关**。
   * 实测 24 条查询的 top1 绝对分只有三个离散簇：
   *
   * | 取值 | 含义 |
   * |---|---|
   * | `0.0164` | 单路 rank1（`1/61`） |
   * | `0.0301` | 双路命中（`1/61 + 1/62` 等） |
   * | `0.0328` | 双路都在前列 |
   *
   * 没有中间值。它是个**名次信号，不是相似度信号**。
   *
   * ## 那它凭什么能用
   *
   * 因为"多路同时命中"在实践中与"查询有实词可匹配"高度相关：
   * 实测 12 条项目内查询 **12/12** 过线，12 条生活类无关查询 **2/12** 过线
   * （误放的是"红烧肉怎么做""量子纠缠退相干"—— 它们碰巧在库里撞到了
   * 高频字面）。作为**粗筛**足够，作为**相关性证明**不够。
   *
   * ## 0.025 取值的由来
   *
   * 落在单路簇（0.0164）与双路簇（0.0301）之间，等价于「要求至少两路命中」。
   * 不要改成 0.016 以下 —— 那样单路也能过，等于关掉这道闸门。
   */
  minRawScore: number;
}

/**
 * 注入段落的表头。
 *
 * 必须显式声明「这是历史、可能过时」：模型对注入内容有天然的顺从倾向，
 * 一句"这是事实"就足以让它在冲突时放弃自己的判断。加上时效性声明后，
 * 它才有权说"这条与当前任务无关"。
 */
const INJECTION_HEADER = '[LRC 历史记忆（可能过时，与当前任务无关时请忽略）]';

export const DEFAULT_RECALL_INJECTION: RecallInjectionOptions = {
  // 2 条足够覆盖"用户偏好 + 关键决定"这类最常见场景，再多就是噪音
  maxItems: 2,
  maxCharsPerItem: 80,
  // 与快照 220 字符同量级，避免单次注入就把上下文撑大
  maxTotalChars: 240,
  // 相对分只用于筛掉同批里的掉队项（top1 恒为 1.0，单靠它等于永远放行）
  minScore: 0.85,
  // RRF 分：单路 ≈0.0164 / 双路 ≈0.0301。0.025 等价于「要求至少两路命中」。
  // 注意它是名次信号而非相关度，见字段注释里的实测数据。
  minRawScore: 0.025,
};

/**
 * 单条记忆是否够格注入（双闸门）。
 *
 * # 为什么必须是两道
 *
 * 1. **绝对分**决定"这一批值不值得看"：单路命中（0.0164）说明查询只有一个
 *    检索通路撞上，多半是字面偶然；只用相对分会放行 top1（恒 1.0），
 *    把噪音灌进上下文。
 * 2. **相对分**决定"同批里哪几条还算同档"：绝对分达标但明显掉队的第 3、4 条
 *    （如 0.0315 → 0.0164）不该跟着进来，它们只是单路近邻，不是同一件事。
 *
 * 缺任何一道都会退化：只有绝对分 → 一强三弱全进来；只有相对分 → 永远进来一条。
 *
 * # `score` 缺失时怎么办
 *
 * 退回「只过更严的相对闸门」（0.85 而非历史默认 0.5）。这是兼容旧版 LRC 的
 * 最低成本兜底，但它**不等于**原来的行为：原来的 0.5 会放行一堆相对分 0.5
 * 的噪音，0.85 只放行同批里几乎并列的那几条。
 *
 * `null` 与 `undefined` **必须同等对待**。`typeof null === 'object'`，
 * 若只判 `typeof === 'number'` 就漏掉 null；而 LRC 侧序列化 null 是常规操作，
 * 那会让插件在服务端字段降级时静默回到「任何话题都注入一条」。
 */
function isRelevant(memory: InjectedMemory, options: RecallInjectionOptions): boolean {
  const norm =
    typeof memory.score_norm === 'number' && Number.isFinite(memory.score_norm)
      ? memory.score_norm
      : 1;
  if (norm < options.minScore) return false;

  const raw = absoluteScore(memory);
  if (raw === null) return true;
  return raw >= options.minRawScore;
}

/**
 * 取绝对分；缺失（含 `null` / `NaN` / 字符串）时返回 `null`。
 *
 * `isRelevant` 与排序必须共用这一个取值函数：两边口径不一致时，
 * 排序会拿 `score_norm`（0–1 量级）去和真实 RRF 分（0.03 量级）比，
 * 把混合格式的批次顺序彻底打乱。
 */
function absoluteScore(memory: InjectedMemory): number | null {
  const raw = memory.score;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}


/**
 * 把外部传入的注入参数规范化。
 *
 * # 为什么必须有这一层
 *
 * 配置来自宿主（`cordis.patch.yml` / 测试桩），**新字段不会被老 patch 补齐**。
 * Schema 的 `default()` 只在宿主真的走 Schema 解析时生效；测试桩与某些加载
 * 路径传的是裸对象，缺字段就是 `undefined`。而 `undefined` 参与比较的结果
 * 会**静默反转语义**：
 *
 * - `maxItems: undefined` → `slice(0, undefined)` = 取全部 ⇒ 「最多 2 条」失效；
 * - `minScore: undefined` → `score >= undefined` 恒为 false ⇒ **永不注入**；
 * - `maxCharsPerItem: undefined` → `length > undefined` 恒为 false ⇒ 不截断。
 *
 * 三种都不会报错、日志也正常 —— 与 `recoverable.ts` 里 NaN 退避是同一类缺陷。
 * 故在此统一兜底，不依赖调用方守规矩。
 */
export function normalizeRecallOptions(input: unknown): RecallInjectionOptions {
  const raw = (input ?? {}) as Partial<RecallInjectionOptions>;
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  return {
    // 0 是合法值（显式关闭），负数一律归 0
    maxItems: Math.max(0, Math.floor(num(raw.maxItems, DEFAULT_RECALL_INJECTION.maxItems))),
    maxCharsPerItem: Math.max(
      1,
      Math.floor(num(raw.maxCharsPerItem, DEFAULT_RECALL_INJECTION.maxCharsPerItem)),
    ),
    maxTotalChars: Math.max(
      1,
      Math.floor(num(raw.maxTotalChars, DEFAULT_RECALL_INJECTION.maxTotalChars)),
    ),
    // 相对分必须落在 [0,1]，否则过滤条件会恒真或恒假
    minScore: Math.min(1, Math.max(0, num(raw.minScore, DEFAULT_RECALL_INJECTION.minScore))),
    // 绝对分是 RRF 分（值域 (0, 2/61]），**不能**夹到 [0,1]：
    // 夹上限到 1 会让所有候选都被判为不相关 ⇒ 永不注入。
    // 夹下限到 0 则是「显式关闭绝对闸门」，这是合法配置，不做拦截。
    minRawScore: Math.max(0, num(raw.minRawScore, DEFAULT_RECALL_INJECTION.minRawScore)),
  };
}

/**
 * 把召回结果组装成注入文本。
 *
 * 返回空串表示「不该注入」——调用方据此保持原文本不变，
 * 这是缓存友好性的关键：没内容时**连一个字符都不变**。
 */
export function formatRecallInjection(
  memories: InjectedMemory[],
  options: RecallInjectionOptions = DEFAULT_RECALL_INJECTION,
): string {
  if (options.maxItems <= 0) return '';

  const picked = memories
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    .filter((m) => isRelevant(m, options))
    // 按绝对分从高到低：LRC 已按融合分排序，这里再排一次是为了
    // 「同一批被过滤后」仍保持最强证据在最前（模型对首条注意力最高）。
    .sort((a, b) => sortScoreOf(b) - sortScoreOf(a))
    .slice(0, options.maxItems);

  if (picked.length === 0) return '';

  const render = (list: InjectedMemory[]): string => {
    const lines = list.map((m) => {
      const body = m.content.trim().replace(/\s+/g, ' ');
      const cut =
        body.length > options.maxCharsPerItem
          ? `${body.slice(0, options.maxCharsPerItem)}…`
          : body;
      return `- ${cut}`;
    });
    return `${INJECTION_HEADER}\n${lines.join('\n')}`;
  };

  let text = render(picked);

  // 超总长时逐条裁剪，保证不会因为一条长记忆吃掉整个预算
  while (text.length > options.maxTotalChars && picked.length > 1) {
    picked.pop();
    text = render(picked);
  }

  if (text.length > options.maxTotalChars) {
    // 只剩一条但仍超长：直接截断，不返回空（内容本身有价值）
    text = `${text.slice(0, options.maxTotalChars - 1)}…`;
  }

  return text;
}

/** 取排序用分数：绝对分优先，缺失时用相对分（两者不可混比，故只在同批内退化）。 */
function sortScoreOf(memory: InjectedMemory): number {
  const raw = absoluteScore(memory);
  if (raw !== null) return raw;
  const norm = memory.score_norm;
  return typeof norm === 'number' && Number.isFinite(norm) ? norm : 0;
}

/**
 * 是否是「续接式」的短指令（"继续"、"然后呢"、"好"、"接着做"）。
 *
 * 为什么单独判：实测同话题里用户常只说两个字（"继续"/"然后呢"），
 * 这类输入**不携带新话题**，若让它算出新指纹，就会触发一次无意义的重注入，
 * 把缓存打断。而长任务里这类输入占比很高。
 *
 * 判定必须**严格**：只有「极短 + 几乎只由续接词构成」才算。
 * 宽松判定（"包含续接词即算"）会把
 * 「继续之前那个视频，但改用数据库主题」也当成续接，从而注入**过时记忆**
 * ——这比多查一次危害大得多。
 */
const CONTINUATION_HINTS = [
  '继续', '接着', '然后', '往下', '下一步', '再来', '好的', '好', '行', '可以',
  'go on', 'continue', 'next', 'ok', 'okay', 'proceed', 'carry on',
];

export function isContinuation(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[\s\p{P}\p{S}]+/gu, '');
  // 严格：去掉标点后不超过 8 个字符，才可能是纯续接指令
  // （"继续"=2、"然后呢"=3、"下一步吧"=4，"接着做这个"=5）
  if (t.length === 0 || t.length > 8) return false;

  // 必须**整句**由续接词构成（去掉命中的词后剩余不超过 2 字符）
  // 否则像"修改视频"这种短句会被误判
  for (const h of CONTINUATION_HINTS) {
    const stripped = t.replace(h, '');
    if (stripped.length !== t.length && stripped.length <= 2) return true;
  }
  return false;
}

/**
 * 话题指纹：用来判断「要不要重新注入」。
 *
 * 为什么不能直接用 query 原文对比：用户措辞会微变（"继续"、"然后呢"、
 * "现在做这个"），逐字比较几乎每轮都变 → 每轮重注入 → 缓存全废。
 *
 * # 中文的特殊处理
 *
 * 中文没有空格，`split(' ')` 拿到的是一整句 ⇒ 指纹几乎没有区分度
 * （"做视频" 与 "做视频吧" 会得到两个不同指纹，但语义完全相同）。
 * 所以中文按**字符二元组（bigram）**取特征，这是无分词库时的标准做法。
 *
 * @param previous 上一次的指纹。当前文本若判定为「续接式短指令」，
 *   直接沿用 `previous`，避免"继续"这类输入打断缓存。
 */
export function topicFingerprint(text: string, previous?: string): string {
  // 续接词：沿用上一指纹（这是缓存友好的关键路径）
  if (previous !== undefined && previous.length > 0 && isContinuation(text)) {
    return previous;
  }

  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();

  if (normalized.length === 0) return '';

  const STOP = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'you', 'can', 'please',
    '然后', '继续', '现在', '这个', '那个', '帮我', '一下', '可以', '怎么',
    '什么', '还是', '就是', '已经', '需要', '的', '了', '吗', '呢',
  ]);

  // 英文/数字：按空格切词；中文：按二元组
  const tokens: string[] = [];
  for (const part of normalized.split(' ')) {
    if (part.length === 0) continue;
    if (/^[a-z0-9_.-]+$/.test(part)) {
      if (part.length >= 2 && !STOP.has(part)) tokens.push(part);
      continue;
    }
    // 含中文的片段：滤掉单字虚词后取二元组
    const cleaned = [...part].filter((ch) => !STOP.has(ch)).join('');
    if (cleaned.length === 1) tokens.push(cleaned);
    for (let i = 0; i + 2 <= cleaned.length; i += 1) tokens.push(cleaned.slice(i, i + 2));
  }

  const uniq = [...new Set(tokens)].sort();

  // 长度分桶：把微小长度差异抹平，避免"多说一个字就重注入"
  const bucket = Math.floor(normalized.length / 20);

  if (uniq.length === 0) return `len:${bucket}`;
  // 取前 6 个（bigram 数量多，多取几个才有区分度）
  return `len:${bucket}|${uniq.slice(0, 6).join(',')}`;
}
