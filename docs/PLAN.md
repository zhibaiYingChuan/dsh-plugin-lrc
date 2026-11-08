# LRC × DSH 插件 · 开发计划

> 版本：v0.2（2026-11-06，架构修正）
> 状态：**计划阶段**，未开始编码
> 仓库：`zhibaiYingChuan/dsh-plugin-lrc`（独立于 LRC 主仓）
> 目标：**让 DSH 的上下文不再需要压缩** —— 对话边聊边卸载进 LRC 长期记忆

---

## 〇、v0.1 → v0.2 的架构修正

v0.1 把插件设计成"压缩时调外部 LRC 服务"的薄客户端。**这是错的**：

| 维度 | v0.1（错） | v0.2（对） |
|---|---|---|
| LRC 在哪 | 外部服务，用户自己装 | **插件内置**，随插件启动 |
| 何时迁移 | 只在压缩触发时 | **持续卸载**，每轮/每 N 轮 |
| 上下文 | 还是会涨，只是压缩时抢救 | **始终很小**，因为一直在往外搬 |
| 压缩的角色 | 主路径 | **兜底**（万一还是涨到阈值） |

一句话：**不是"压缩时抢救"，是"根本不让它涨到需要压缩"。**

---

## 一、核心思路

### 1.1 线性纪要 → 长期记忆

```
对话（线性、易失）
   ↓ 每轮增量提炼
结构化记忆（决策 / 约束 / 结论 / 报错）
   ↓ 语义查重后写入
LRC 长期记忆库（持久、可检索）
   ↓ 回填一行状态快照
上下文（始终很小）
```

**关键**：搬走的是"结论"，留下的是"索引"。
AI 看到的不再是几十轮原文，而是：

```
[LRC 状态] 已确定用 pnpm（放弃 npm 因兼容问题）；端口纪律 3099/3111；
           迁移分块 20 条 + 10s 预算。细节在 LRC，需要时 recall。
```

### 1.2 诚实说明：压缩不会"消失"，只会"变少变便宜"

严格说，上下文仍会增长（用户消息、工具输出）。插件做的是：

- 把**结论性内容**持续搬走，让上下文增速降到原来的 1/5 ~ 1/10
- 让 DSH 的压缩**很少触发**；即使触发，摘要也是 LRC 状态快照而非干瘪概括

**不承诺"永不压缩"**，承诺"压缩频率大幅下降 + 压缩质量大幅提升"。

---

## 二、插件内置 LRC

### 2.1 为什么必须内置

用户不该为了用插件先装一个 LRC 桌面端。插件要开箱即用。

### 2.2 运行时管理（`src/runtime.ts`）

```
启动插件
  ↓
① 探测本地 LRC
   ├─ 环境变量 LRC_BASE 指向的服务可用？ → 直接用（用户已有实例）
   ├─ 3099 端口有 LRC？ → 直接用
   └─ 都没有 → 进入 ②
  ↓
② 检查内置二进制
   $DSH_HOME/cache/lrc-plugin/bin/lrc-sidecar-<platform>-<arch>[.exe]
   ├─ 存在且可执行 → 进入 ③
   └─ 不存在 → 下载（见 2.3）
  ↓
③ 启动隔离实例
   lrc-sidecar --port <随机空闲端口> --data-dir $DSH_HOME/cache/lrc-plugin/data
  ↓
④ 健康检查（/health，最多等 15s）
   ├─ 成功 → 记录 baseUrl，插件就绪
   └─ 失败 → 降级为"纯客户端模式"（只调外部 LRC，没有就静默跳过）
```

**数据隔离**：插件自己的实例用独立数据目录，**不碰**用户 `~/.loong-recall/global/data`。
避免插件把测试数据写进用户的生产记忆库。

### 2.3 二进制分发策略（已定：方案 B）

| 方案 | 包体积 | 体验 | 风险 |
|---|---|---|---|
| A. 随 npm 包分发全平台二进制 | ~300MB+ | 开箱即用 | npm 安装慢；包体积劝退 |
| **B. 首次运行按平台下载（✅ 已选）** | ~1MB | 首次需联网 | 需要托管地址；离线不可用 |
| C. 只支持"用户已装 LRC" | ~1MB | 需先装 LRC | 与"内置"目标冲突 |

**方案 B 的四个要求**：

1. **镜像加速**：优先 GitHub Release，失败回退国内镜像（可配 `LRC_MIRROR`）
2. **SHA256 校验**：下载后必须校验，不匹配即删除并报错
3. **失败降级**：下载失败 → 提示用户手动安装 LRC，插件进入纯客户端模式
4. **缓存复用**：已下载的二进制存 `$DSH_HOME/cache/lrc-plugin/bin/`，不重复下载

---

## 三、持续卸载（核心机制）

### 3.1 触发时机

DSH 的 `BasicCompactionEngine` 用 `ctx.on('agent/pre-step', ...)` 做压力检查。
插件用同一套事件做**增量卸载**：

| 事件 | 用途 |
|---|---|
| `session/event`（`assistant/message`） | 累计本轮新增文本 |
| `agent/pre-step` | 若累计超过阈值（默认 8 轮或 6000 字符），执行一次卸载 |
| `agent/status`（`idle`） | 会话空闲时补一次卸载，避免残留 |

### 3.2 卸载流程

```
① 增量游标：取上次之后的新增对话
② POST /v1/context/distill   → 结构化记忆
③ POST /v1/context/migrate   → 语义查重后写入（dedup）
④ 生成状态快照（一行索引）
⑤ 把快照注入下一轮上下文（通过 agent/pre-step 的附加上下文能力）
```

### 3.3 与压缩的关系

| 场景 | 行为 |
|---|---|
| 正常对话 | 持续卸载，上下文增速降到 1/5~1/10 |
| 仍触发压缩 | **走 DSH 原生摘要**，本插件不接管 |
| LRC 不可用 | 静默跳过卸载，对话不受影响 |

**为什么不做压缩兜底（2026-11-06 结论）**

原计划重写 `summarize()` 返回 LRC 状态快照。实测 DSH 0.2.2-rc.1 的架构后放弃：

1. `dsh-web-app` 的 patch 已把宿主层 `compaction-basic` 关掉（`disabled: true`）；
2. 真正的实例在 `standard` / `minimal` / `ptc` 三个 preset 里，各自包在
   `isolate: { compaction: true }` 的组中 —— agent 用的是**组内**服务，
   宿主层插件注册的 `compaction` 它看不见；
3. 三个 preset 共用同一套 id（`compaction` / `compaction-basic`），
   而 DSH 的 patch 按 id 索引，同名 id 会互相覆盖，按 id 关不掉指定的那一个；
4. 唯一可靠做法是整组重写 `config` 列表，DSH 升级 preset 结构即静默失效。

结论：**不做**。`src/compaction-backend.ts` 已删除，相关 peer 依赖一并移除。

---

## 四、三个硬性验收标准（去重）

> 这三条是"解决上下文压缩问题"的**硬性验收标准**，不达标不算完成。

### 标准 1：增量游标 —— 只提炼新增对话

```ts
interface CursorState {
  sessionId: string;
  lastLine: number;      // 已处理到第几行
  lastHash: string;      // 该行内容哈希（校验 transcript 是否被重写）
  updatedAt: number;
}
```

- 存储：`$DSH_HOME/cache/lrc-plugin/cursor.json`
- 哈希不匹配（transcript 被截断/重写）→ 游标失效，退回全量并记 `warn`
- 卸载成功后推进游标

**验收**：连续 3 次卸载，第 2、3 次送进 `distill` 的字符数 < 第 1 次的 50%。

### 标准 2：migrate 必须语义查重，绝不盲目 insert

`migrate` 增加 `dedup` 参数（默认开启）：

```json
{
  "items": [...],
  "project": "dsh",
  "dedup": { "enabled": true, "similarityThreshold": 0.85, "onConflict": "supersede" }
}
```

| 策略 | 行为 | 何时用 |
|---|---|---|
| `merge` | 合并进已有记忆（并集 tags、取较大 importance） | 同一结论的不同表述 |
| `supersede` | 新记忆写入，旧记忆打 `mark_superseded` | 决策被推翻（"改用 npm" → "改回 pnpm"） |
| `skip` | 丢弃新记忆 | 完全重复 |

**验收**：同一批 items 连续 migrate 3 次，库内总数不增长；
`merged + superseded + skipped` 等于第 2、3 次的 `items.length`。

### 标准 3：三次卸载不线性膨胀

`scripts/e2e-offload.ts`：

```
1. 起 mock LRC（记录所有写入）
2. 构造 3 段递进对话（第 2、3 段复述第 1 段结论）
3. 依次触发 3 次卸载
4. 断言：
   - 第 1 次：written = N1
   - 第 2、3 次：库内总数仍 = N1
   - 第 2、3 次：本地 Jaccard 查重确实拦下了复述块（deduped > 0）
```

**通过标准**：3 次卸载后库内总数 **≤ 第 1 次的 1.2 倍**。

> 2026-11-07 调整：复述现在在**插件端**就被 Jaccard 拦下，不再送进 `distill`。
> 因此"去重率"不再按 distill 产出计算，改看「库内不膨胀 + 本地查重生效」两处。

---

## 四之二、三层过滤（2026-11-07 架构定调）

**LRC 只存不筛。** 筛选、提炼、决定"什么该存"全部在插件端完成，
LRC 端不加任何 LLM，保持毫秒级写入。

| 层 | 位置 | 做什么 |
|---|---|---|
| 1. 硬规则 | `src/memory-filter.ts` `hardFilter()` | 丢寒暄、代码围栏、正常日志、过短且无关键词的行 |
| 2. 宿主 LLM 提炼 | `src/index.ts` 系统提示段落 + `extractMemoryTag()` | 要求模型在回答末尾输出 `<lrc_memory>决策/约束/结论</lrc_memory>`，正则抠出 |
| 3. 本地查重 | `src/memory-filter.ts` `isDuplicate()` | Jaccard ≥ 0.85 视为复述，连 HTTP 都不发 |

**触发条件**（三者任一）：

- 累计 20 步（`offloadSteps`）—— 长任务里正文很少，靠步数兜底
- 累计 8 轮正文（`offloadTurns`）
- 累计 6000 字符（`offloadChars`）
- **外加 `turn/end` 无条件兜底**：最终报告只在 turn 末尾出现一次，
  没有 pre-step 可等，必须在这里收走

**为什么必须加步数与 turn/end**：实测一次 88 步的长任务，
88 条 assistant 消息里只有 1 条有正文（5269 字符），
按"正文消息数"计数永远到不了阈值，最终报告也等不到下一次 pre-step。

### 2026-11-07 定向测试修复

| 级别 | 问题 | 修复 |
|---|---|---|
| P0 | 游标在 `distill` 之前推进，失败即永久丢内容 | 改为 `distill` + `migrate` 都成功后才 `commitCursor()` |
| P1 | `hardFilter` 逐物理行调用，`stripCodeFences` 状态失效，围栏内代码透传 | 改为按**消息**整段过滤（`lines.slice(fromLine).map(hardFilter)`） |
| P1 | `hasPending()` 不认步数，步数兜底在"只有工具调用"的任务上失效 | 加入 `pendingSteps > 0` |
| P1 | `<lrc_memory>` 写成可选项时模型从不输出 | 改为强制契约：每轮必须输出，空轮写 `无新增`；并加命中率日志 |
| P1 | 标签内容被 LRC 的 `distill` 二次过滤（`DECISION_WORDS` 无「决策」） | 标签内容由 `itemsFromTag()` 直接构造条目走 `migrate`，**绕过 distill** |

**关于第二层的定性**：它不是"可选增强"，而是**依赖模型配合的软约束**。
因此硬规则必须始终是兜底路径，不能假设标签一定存在。
命中率日志（每 20 条 assistant 消息打一次）用于判断这一层是否真的生效。

---

## 五、组件结构

```
dsh-plugin-lrc/
├── src/
│   ├── index.ts              # 插件入口：注册工具 + 挂卸载器
│   ├── runtime.ts            # LRC 运行时管理（探测/下载/启动/健康检查）
│   ├── lrc-client.ts         # HTTP 客户端（distill / migrate / index / lifecycle）
│   ├── offloader.ts          # 持续卸载器（事件订阅 + 阈值 + 快照注入）
│   ├── cursor.ts             # 增量游标
│   ├── session-text.ts       # 会话事件 → 纯文本行（过滤推理/技能目录/工具输出）
│   ├── memory-filter.ts      # 三层过滤：硬规则 / <lrc_memory> 提取 / Jaccard 查重
│   └── dedup.ts              # 语义查重与版本合并
├── scripts/
│   ├── smoke.ts              # 客户端冒烟（mock）
│   ├── e2e-offload.ts        # 三次卸载不膨胀
│   └── e2e-runtime.ts        # 运行时管理（探测/启动/降级）
├── docs/
│   ├── PLAN.md               # 本文件
│   └── ACCEPTANCE.md         # 硬性验收标准与实测记录
├── package.json
├── cordis.patch.yml
└── README.md
```

---

## 六、里程碑

| 阶段 | 内容 | 交付物 | 验收 |
|---|---|---|---|
| **M0** | 仓库与计划 | 本文件 + README + package.json | 仓库可 clone |
| **M1** | 运行时 + 客户端 | `runtime.ts` / `lrc-client.ts` | 能探测/启动/降级；冒烟 11 项通过 |
| **M2** | 持续卸载 | `offloader.ts` / `cursor.ts` | 对话中上下文增速显著下降；快照正确注入 |
| **M3** | 去重三件套 | `dedup.ts` / `e2e-offload.ts` | **§4 三条硬性标准全过** |
| **M4** | 压缩兜底 | ~~`compaction-backend.ts`~~ | **已取消**，见 §3.3 |
| **M5** | 上架 | 发布包 + 文档 | 进入 DSH 官方插件库 |

**M3 是硬门槛**：三条标准不过，不进入 M5。

---

## 七、风险与未决问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 处于 Developer Preview，API 会变 | 插件随时失效 | 锁版本；README 标注已验证版本 |
| 内置二进制体积大 | 安装体验差 | 倾向"首次下载"（§2.3） |
| 下载源不可用 | 首次启动失败 | 降级为"提示用户装 LRC" |
| 持续卸载打断对话节奏 | 体验差 | 卸载在 `spawn_blocking` 等价路径异步执行；失败静默 |
| 快照注入占用上下文 | 与目标相反 | 快照限 1~3 行，且只在有新增结论时注入 |
| 语义查重阈值难调 | 该合并的没合并 | 阈值可配，默认 0.85 |
| LRC 侧 `migrate` 尚不支持 `dedup` | 标准 2 无法验收 | **需先改 LRC 主仓**（§8） |

---

## 八、对 LRC 主仓的依赖（需要先做）

| 改动 | 位置 | 说明 |
|---|---|---|
| `migrate` 支持 `dedup` 参数 | `src/v1_api.rs` | `{enabled, similarityThreshold, onConflict}` |
| 返回 `superseded` / `skipped` 计数 | 同上 | 当前只有 `written` / `merged` / `failed` |
| 冲突时调 `mark_superseded` | 同上 | 复用既有 `/v1/memories/lifecycle` |
| 提供可独立分发的 sidecar 二进制 | 构建产物 | 插件内置运行时需要 |

**建议顺序**：先在主仓做前三处（约半天），再开始 M3。

---

## 九、需要你拍板的两个决策

### 决策 1：二进制怎么分发

| 方案 | 包体积 | 首次体验 | 离线可用 |
|---|---|---|---|
| A. 随包分发全平台 | ~300MB+ | 开箱即用 | ✅ |
| **B. 首次运行按平台下载（推荐）** | ~1MB | 需联网一次 | ❌（可降级） |
| C. 只支持已装 LRC | ~1MB | 需先装 | ✅ |

### 决策 2：卸载频率

| 方案 | 上下文增速 | 开销 |
|---|---|---|
| 每轮卸载 | 最低 | 每轮一次 HTTP + 提炼 |
| **每 8 轮或 6000 字符（推荐）** | 低 | 可忽略 |
| 只在空闲时 | 中 | 最低 |

---

## 十、验收清单（总）

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 增量游标 | 第 2、3 次送进 distill 的字符数 < 第 1 次的 50% |
| 2 | 语义查重 | 重复 migrate 3 次，库内总数不增长 |
| 3 | 不线性膨胀 | 3 次卸载后总数 ≤ 首次的 1.2 倍，去重率 ≥ 80% |
| 4 | 内置运行时 | 无本地 LRC 时能自动启动隔离实例；失败能降级 |
| 5 | 不阻断对话 | LRC 不可用时对话正常，卸载静默跳过 |
| 6 | 快照质量 | 注入的 `[LRC 状态]` 行能列出关键决策，且 ≤ 3 行 |
| 7 | 可回滚 | 删掉 `cordis.patch.yml` 的 insert 段即恢复官方行为 |
