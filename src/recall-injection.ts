/**
 * 「用户在问历史」的语言信号（2026-11-19 六钥匙裁决）。
 *
 * ## 为什么不能靠相似度分数判断
 *
 * 实测：`recallInjectMinRawScore = 0.025`，而 LRC 单路召回的上限是
 * `1/(60+1) ≈ 0.0164`（RRF 的 `1/(k+rank)`）。语义路/深度路不可用时
 * **永远达不到阈值** ⇒ 自动注入 0 次。
 *
 * 调低阈值到 0.015 会让**所有**话题都注入（单路几乎总能拿到 0.0164），
 * 正是「全面注入污染注意力」的回归。
 *
 * ## 强信号 vs 弱信号（第三、四轮独立审查）
 *
 * 裸 `之前` / `以前` 在编码指令里是**时间介词**，不是历史指代：
 * ```
 * 在提交之前先跑一遍测试      ← 不是问历史
 * 删除之前先备份数据库        ← 不是问历史
 * 之前用 axios 没问题，现在报错 ← 不是问历史
 * 之前改的那行代码有 bug       ← 不是问历史
 * ```
 * 误触发的代价不止「多注入 2 条」：它会**绕过话题指纹去重** ⇒ 每条这类
 * 消息都发一次 recall HTTP，结果变化时还会改写注入文本、**打断前缀缓存**。
 * 那等于把「全面注入」换了个入口回归。
 *
 * ## 为什么「与动词共现」不够（第四轮审查 critical 1）
 *
 * 第三轮把弱信号写成 `之前 + (说|定|用|改|…)`，实测 20 条真实编码指令
 * 仍命中 19 条 —— 因为 `用`/`改`/`说` 恰恰是编码指令里最高频的动词，
 * 「共现」等于没设防。
 *
 * 所以改成**两道闸门**：
 * ```
 * 强信号（本身无歧义）        → 直接命中
 * 弱信号（高频歧义词）        → 必须同时出现疑问/回顾标记
 * ```
 * 疑问标记是 `吗/呢/？/什么/哪个/多少/是不是/有没有/怎么+回顾动词/为什么+选型动词`。
 * 取舍：**宁可漏触发，不可误触发**。
 */
const STRONG_SIGNAL = new RegExp(
  [
    // ── 本身无歧义 ──
    //
    // `上次`/`当初` 在中文里**只指过去**，不存在「当前指令」用法：
    // 「上次部署失败了，这次注意点」「当初那个 bug 又出现了」都是需要
    // 历史上下文的真实场景，不是误触发（第五轮审查 critical 1 判断有误）。
    '上次',
    '当初',
    '继续上次',
    // 「接着之前的代码往下写」是续写指令 ⇒ 必须带回顾宾语
    '接着(?:上次|之前)(?:的)?(?:那个|方案|决定|结论|进度|问题|讨论|思路|重构|工作)',
    // 「这个参数不是定了 5 秒吗」是确认当前配置 ⇒ 必须带选型宾语
    '不是定(?:过|了)(?:要|用|的|吗|呢|？|\\?)',
    // 「还记得要加 try-catch」「记不记得要加 try-catch」都是叮嘱
    // ⇒ 必须带回顾宾语或疑问（第五轮审查 critical 2：两种说法口径必须一致）
    '(?:你|还|记不)记得(?:我们|之前|上次|那个|当时|吗|什么|怎么|为什么|是)',
    // 「那个方案」必须带疑问/回顾词：「按那个方案实现就行」是当前指令。
    '那个方案(?:是什么|怎么样|后来|是啥|呢|吗)',
    // 「我们决定过」是回顾；「我们决定用 pnpm 吧」「我们约定一下接口格式」
    // 是当前决策 ⇒ 必须有「过」（第五轮审查 critical 3）。
    '我们(?:决定过|定过|说好过|约定过)',
    // 「之前不是这样的」「之前不是这个报错」是当前排障 ⇒ 必须带回顾动词
    // （第五轮审查 major 5）。
    '之前不是(?:说|定|讲|提|约定|商量)',
    '之前(?:提|聊|讨论|讲)过',
    // 「我提过 PR 了」是当前动作 ⇒ 第一人称必须带「之前/以前」
    '(?:我们|你)(?:讨论|聊|讲)过|我(?:之前|以前)(?:提|讲)过',
    '前面说过',
    // 「翻一下之前的记录」「查一下历史记录」是明确的回顾请求
    '(?:之前|以前)的(?:记录|纪要|对话|讨论|决定|方案|结论|工作|进展|思路|历史)',
    // 「清空 git 历史记录」是 git 操作 ⇒ 必须带回顾动词
    // ⚠ `历史记录表/字段/索引/列` 是数据库对象名，不是回顾（第四轮审查 major 2）
    '(?:查|翻|看|找)(?:一下)?历史(?:记录|纪要|对话)(?!表|字段|索引|列)',
    '回忆(?:一下|当时|之前)',
    // ## 「回顾 / 梳理」——实测漏判（2026-11-19）
    //
    // 真实提示词「回顾梳理我们前面所有的方案和项目的状态，查看还有哪些需要
    // 补齐的地方」是**典型的回顾请求**，但旧信号表一条都不命中。
    //
    // ## 为什么只认「历史专属名词」（两轮独立审查 M1/M-a/M-c）
    //
    // `之前/以前/项目/方案/状态/整个/所有` 都**不是**历史专属：
    // 「回顾一下之前改的那行代码」「回顾一下项目结构」「回顾一下整个流程」
    // 「梳理一下所有依赖关系」全是当前工作。中文里无法用正则区分
    // 「回顾之前的方案」（历史）与「回顾之前的改动」（当前）—— 故按
    // 「宁可漏触发」原则，只保留高精度形态，其余交给模型主动调 lrc_recall。
    //
    // `历史` 也必须排除定语用法：「历史数据迁移」「历史订单」「历史提交」
    // 是当前任务，只有「历史上/历史中/历史的记录」才是回顾。
    '回顾(?:一下|梳理)?(?:历史(?:上|中|(?:记录|纪要|对话)(?!表|字段|索引|列)|的(?:对话|记录|纪要|讨论|决定|方案|结论|工作|进展))|过往|做过的|走过的|历程)',
    // 「回顾梳理我们前面所有的方案」是连用形态。
    // ⚠ `我们` 与 `所有/整个` 都不构成消歧（第三/四轮审查）：
    // 「回顾一下我们之前那个报错」「梳理一下我们前面所有的接口」都是当前工作
    // ⇒ 必须 `我们前面 + 所有/整个 + 历史宾语白名单`。
    '回顾(?:一下|梳理)?我们前面(?:所有|整个)(?:的)?(?:方案|决定|结论|讨论|工作|进展|思路)',
    // `梳理` 同理；`前面` 必须接 `所有/整个` + 历史宾语（第四轮审查 major 1）
    '梳理(?:一下)?(?:我们)?(?:前面(?:所有|整个)(?:的)?(?:方案|决定|结论|讨论|工作|进展|思路)|历史(?:上|中|(?:记录|纪要|对话)(?!表|字段|索引|列)|的(?:对话|记录|纪要|讨论|决定|方案|结论|工作|进展))|过往)',
    // 「git diff 看看改过什么」「看看我改了什么」是看工作区 ⇒ 必须有「之前/以前」
    // （第五轮审查 critical 4）。
    '(?:我们|你|我)(?:之前|以前)(?:改过什么|改了什么)',

    // ## 「为什么 + 设计/用/选」必须带设计名词**且收在句末/停顿处**
    //
    // 「为什么用这个方案」是问决策理由（查历史有益）；
    // 「为什么用这个锁会死锁」「为什么用这个 API 会 404」是当前故障排查。
    // ⚠ 只限定宾语类别挡不住后者（`锁`/`数据库`/`接口` 正是故障句高频宾语），
    // 必须再要求它后面没有继续接谓语。
    '为什么(?:这么|这样)(?:设计|用|选)(?:呢|吗|？|\\?|$|，|,)',
    '为什么(?:设计|用|选)(?:这个|那个|这种|那种)' +
      '(?:方案|库|框架|技术|架构|做法|思路|方式|工具|语言|数据库|锁|结构|设计|接口|协议|模式)' +
      '(?:呢|吗|？|\\?|$|，|,)',
  ].join('|'),
);

/**
 * 弱信号：在编码指令里高频出现，**必须与疑问/回顾标记共现**才算问历史。
 *
 * 反例（全部不该命中）：
 * ```
 * 记录当时的时间戳 / 当时是 3 秒超时，改成 5 秒
 * 把先前版本的字段名迁移过来 / 先前那个 bug 复现一下
 * 在之前我写的函数里加日志 / 之前你写的函数加个日志
 * 查一下 git 历史上这个文件谁改的
 * 照旧跑一遍测试
 * ```
 */
const WEAK_SIGNAL = new RegExp(
  ['当时', '先前', '早先', '之前', '以前', '历史上', '按?老规矩', '照旧'].join('|'),
);

/**
 * 疑问/回顾标记：弱信号必须与它共现。
 *
 * ⚠ **不能**放裸 `怎么` / `为什么`（第五轮审查 major 8）：
 * 「之前怎么没报错」「以前为什么没问题」是当前排障，不是问历史。
 * 必须限定为「怎么 + 回顾动词」或「为什么 + 选型动词」。
 *
 * ⚠ `什么` 必须用负向后顾排除「为什么」里的那个「什么」，
 * 否则「以前为什么没问题」会被 `什么` 放行。
 *
 * ⚠ **不能**放 `吗` / `呢` / `？`（第六轮审查）：它们是**是非问**，
 * 「之前那个接口改好了吗」问的是当前进度，不是历史内容。
 * 弱信号只认**内容疑问**（什么/哪个/怎么+动词）。
 */
const QUESTION_MARK =
  /(?<!为)什么|啥|哪个|哪些|多少|哪次|哪回|如何|是不是|有没有|在哪|怎么(?:改|做|写|配|定|选|用|弄|搞|处理|修|查|解决|约定|商量|谈|来|产生)|为什么(?:选|用|定|改|做)/;

/**
 * 否定信号：出现即**不是**问历史，直接短路。
 *
 * 「之前用什么库都行，你定」是授权选型，不是回顾。
 */
const NOT_HISTORY = /都行|随便|你定|你来定|无所谓|看着办/;

/**
 * 这条用户消息是否在问历史（命中语言信号）。
 *
 * 命中时调用方应：① 绕过话题指纹去重（强制刷新）；② 放宽分数闸门。
 * 理由见 `STRONG_SIGNAL` / `WEAK_SIGNAL` 的注释。
 */
export function isHistoryQuery(text: string): boolean {
  if (NOT_HISTORY.test(text)) return false;
  if (STRONG_SIGNAL.test(text)) return true;
  return WEAK_SIGNAL.test(text) && QUESTION_MARK.test(text);
}

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
  /**
   * 重要性（1–10）。
   *
   * 用于「短记忆豁免」：实测 dsh 项目 2037 条未折叠碎片里，
   * 1231 条 ≤40 字，其中只有 3 条 importance ≥9 —— 那 3 条恰恰是
   * 用户约束（「以后所有图标按艺术绘画风格」）和关键路径（`H:\xjz\666\`）。
   * 所以短不等于无价值，必须给高重要性留豁免口。
   */
  importance?: number;
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
  /**
   * 碎片前缀判据（正则源码）。命中即视为「脱离上下文无法理解的残句」。
   *
   * ## 为什么不用长度（2026-11-19 六钥匙裁决，实测否决）
   *
   * 最初想用「<40 字」当质量代理，实测**误伤严重**：
   * ```
   * 用户偏好纸质拼贴风格，不要渐变        ← 16 字，完整且高价值
   * 视频时长确定为 60 秒                  ← 12 字，完整
   * 浅色模式必须另配一套灰度值            ← 14 字，完整
   * ```
   * 而真正的碎片长这样：
   * ```
   * 改成实心的裂痕                        ← 8 字，没有主语
   * 现在让 .post 的抖动不被全局规则清掉    ← 没有主语
   * 只保留框架和两根贴边竖栏              ← 没有主语
   * ```
   * 区别不在长度，在**有没有主语**。而「以悬空词开头」是主语缺失的
   * 最可靠表面特征 —— 中文里完整陈述句极少以「改成/先/再/但」开头。
   *
   * 空串 = 关闭过滤。
   */
  fragmentPrefixes: string;
  /**
   * 碎片豁免的重要性门槛。
   *
   * 短 ≠ 无价值：`[事实] 文件位于 H:\xjz\666\`（importance 10）
   * 和 `[约束] 以后所有图标按艺术绘画风格`（importance 9）都必须放行。
   */
  fragmentExemptImportance: number;
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
  // 只收「无主语改写句」这一种最确定的形态。实测 dsh 项目 2037 条未折叠
  // 碎片里命中 58 条（2.8%），全部是真残句（「改用 edit 工具」「改成逐行状态机处理」）。
  //
  // ⚠ 不要加 `先|再|现在|但|不过|而|并且|这是|这个|那个|它`：
  // 实测会把「先确认宿主如何处理 assistant/message」「现在改写探针脚本，
  // 让基线日志合法」这类**完整句子**一起挡掉（宽口径误伤 344 条）。
  fragmentPrefixes: '^(?:改成|改用|换成|改为|换掉|删掉|去掉|只保留)',
  // 9：只豁免「用户约束」和「关键路径」这类高价值短句
  fragmentExemptImportance: 9,
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

/** 碎片前缀正则缓存：避免每条记忆都重新编译（一次召回最多 6 条，但每轮都跑）。 */
let fragmentReCache: { source: string; re: RegExp | null } = { source: '\u0000', re: null };

function fragmentRegex(source: string): RegExp | null {
  if (fragmentReCache.source === source) return fragmentReCache.re;
  let re: RegExp | null = null;
  try {
    re = new RegExp(source);
  } catch {
    re = null;
  }
  fragmentReCache = { source, re };
  return re;
}

/**
 * 这条记忆是否「能独立理解」（不是脱离上下文的残句）。
 *
 * ## 为什么用「悬空词开头」而不是长度
 *
 * 长度是坏代理：`用户偏好纸质拼贴风格，不要渐变`（16 字）完整且高价值，
 * 而 `改成实心的裂痕`（8 字）是残句。区别在**有没有主语**。
 *
 * 中文里完整陈述句极少以「改成/先/再/但/现在」开头 —— 这些词是
 * 承接上文的连接成分，单独出现说明主语被切掉了。
 *
 * ## 为什么必须留豁免口
 *
 * 短 ≠ 无价值。实测 ≤40 字里 importance ≥9 的只有 3 条，但每条都关键：
 * ```
 * [事实] 文件位于 H:\xjz\666\              ← importance 10，关键路径
 * [约束] 以后所有图标按艺术绘画风格制作      ← importance 9，用户约束
 * ```
 */
function isSubstantial(memory: InjectedMemory, options: RecallInjectionOptions): boolean {
  if (options.fragmentPrefixes.length === 0) return true;

  const body = typeof memory.content === 'string' ? memory.content.trim() : '';
  // 剥掉 `[决策] ` / `[结论] ` 这类类型前缀，否则判据永远看不到真正的开头
  const stripped = body.replace(/^\[[^\]]{1,6}\]\s*/, '');
  // 只剩类型前缀、没有正文 ⇒ 残句（否则会注入一行 `- [决策]`）。
  // ⚠ 必须在豁免判断**之前**：importance 再高，空正文也没有信息量。
  if (stripped.length === 0) return false;

  const importance =
    typeof memory.importance === 'number' && Number.isFinite(memory.importance)
      ? memory.importance
      : 0;
  if (importance >= options.fragmentExemptImportance) return true;

  const re = fragmentRegex(options.fragmentPrefixes);
  // 配置写错正则时**放行**而不是全挡：宁可多注入一条，也不要静默关闭整个功能
  if (re === null) return true;
  // 只测前 200 字符：正文可达 2~3K 字，用户自定义正则存在 ReDoS 风险
  return !re.test(stripped.slice(0, 200));
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
    // ## 碎片前缀判据的规范化（独立审查 major 2）
    //
    // 三种输入必须区分：
    // - `undefined`（老 patch 没这个字段）⇒ 落默认（开启）
    // - `null` / `''`（显式关闭）⇒ 空串
    // - 字符串 ⇒ trim 后**必须以 `^` 开头**，否则落默认
    //
    // 为什么强制 `^`：`new RegExp(' ')` 能编译成功，但会匹配任何含空格的
    // 正文 ⇒ 几乎全库被挡；`'改成'`（漏写 `^`）会挡掉句中含该词的完整句。
    // 这与「配置写错就放行」的 fail-open 原则相反，必须在入口拦住。
    fragmentPrefixes: (() => {
      if (raw.fragmentPrefixes === undefined) return DEFAULT_RECALL_INJECTION.fragmentPrefixes;
      if (raw.fragmentPrefixes === null) return '';
      if (typeof raw.fragmentPrefixes !== 'string') return DEFAULT_RECALL_INJECTION.fragmentPrefixes;
      // 只有**精确的空串**才算「显式关闭」；纯空白是配置笔误 ⇒ 落默认
      if (raw.fragmentPrefixes === '') return '';
      const trimmed = raw.fragmentPrefixes.trim();
      if (trimmed.length === 0) return DEFAULT_RECALL_INJECTION.fragmentPrefixes;
      return trimmed.startsWith('^') ? trimmed : DEFAULT_RECALL_INJECTION.fragmentPrefixes;
    })(),
    // 夹到 [0,10]：超出范围会让豁免恒真或恒假
    fragmentExemptImportance: Math.min(
      10,
      Math.max(
        0,
        num(raw.fragmentExemptImportance, DEFAULT_RECALL_INJECTION.fragmentExemptImportance),
      ),
    ),
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

  const survivors = memories
    .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
    // ## 会话纪要**不进注入**（2026-11-17 独立审查 M2）
    //
    // 纪要单条 2~3K 字符，而注入侧 `maxCharsPerItem = 80`。让它进注入
    // 只会得到：
    // ```
    // - 【会话纪要】session-95eaf7e3 时间：2026-11-14 11:27 → 2026-11-…
    // ```
    // —— 纯噪音，还占掉 2 个注入槽位之一。纪要的正确用法是模型主动
    // 调 `lrc_recall` 取全文，不是被动注入片段。
    .filter((m) => (m.memory_type ?? '') !== 'conversation')
    // ## 无主语残句不进注入（2026-11-19 六钥匙裁决）
    //
    // 实测 dsh 项目 92% 的记忆是未折叠碎片。它们不会「灌满」上下文
    // （注入只取 2 条），但会**挤占 top2 槽位** —— 一条 8 字的
    // 「改成实心的裂痕」排到第 1，就把真正有用的纪要挤掉了。
    .filter((m) => isSubstantial(m, options));

  // ## 剔除碎片后必须**重算相对分**（独立审查 major 3）
  //
  // LRC 的 `score_norm` 是相对**未过滤的 top1** 归一化的。若 top1 恰好是
  // 碎片，过滤后剩下的记忆相对分可能只有 0.5，被 `minScore: 0.85` 挡掉
  // ⇒ 槽位空着 —— 正是「碎片挤占 top2」的场景，只解决了一半。
  //
  // ⚠ **只在真的过滤掉东西时才重算**（复审建议）：
  // LRC 有「近重复折叠」，可能把原 top1 折掉，此时返回首项的 `score_norm`
  // 本就小于 1。无条件重算会把它抬到 1.0，让原本 0.8 的次项越过 0.85 ——
  // 那是把「掉队项」重新放进来，与 `minScore` 的语义相反。
  const filtered = survivors.length < memories.length;
  const maxRaw = filtered
    ? survivors.reduce<number>((max, m) => {
        const raw = absoluteScore(m);
        return raw !== null && raw > max ? raw : max;
      }, 0)
    : 0;
  const rescored =
    filtered && maxRaw > 0
      ? survivors.map((m) => {
          const raw = absoluteScore(m);
          return raw === null ? m : { ...m, score_norm: raw / maxRaw };
        })
      : survivors;

  const picked = rescored
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
