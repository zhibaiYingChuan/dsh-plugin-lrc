# LRC × DSH 插件 · 开发计划

> 版本：v0.1（2026-11-06）
> 状态：**计划阶段**，未开始编码
> 仓库：`zhibaiYingChuan/dsh-plugin-lrc`（独立于 LRC 主仓）
> 目标：把 LRC 从"外部 Hook 旁路"升级为"DSH 内部上下文引擎"

---

## 一、定位

### 1.1 一句话

**用 LRC 的结构化记忆，替换 DSH 压缩时那句干瘪的摘要。**

DSH 原生压缩产出的是"前面聊了包管理器"这种摘要；LRC 要产出的是
"已确定用 pnpm（放弃 npm 因兼容问题），相关决策已归档至 LRC"这种**状态快照**。

### 1.2 与 LRC 主仓的关系

| 项 | 说明 |
|---|---|
| 代码 | 完全独立仓库，不依赖 LRC 主仓源码 |
| 依赖 | 只依赖 LRC 的 HTTP 接口（`/v1/context/*`、`/v1/memories/*`） |
| 版本 | 独立发版，与 LRC 主仓解耦 |
| 上架 | 目标上架 DSH 官方插件库 |

### 1.3 不做的事

- 不改 DSH 源码
- 不碰 `compaction/start` / `compaction/end` 的锁协议
- 不重写 `compactIfNeeded` / `compactNow` / `compactRegion`（见 §3.2）

---

## 二、为什么能接管（官方扩展点，不是黑）

DSH 的压缩子系统把"做什么"和"怎么做"拆开了：

```
CompactionEngine（抽象契约）
  ├─ compactIfNeeded   自动触发（pressure / context-overflow）
  ├─ compactNow        按需触发（/compact）
  └─ compactRegion     显式范围
        ↓ 由 BasicCompactionEngine 实现
        └─ summarize()   ← 唯一的子类钩子
```

官方注释原文：

> `summarize()` is the sole subclass customization hook; the replay and durable
> mutation strategy stays fixed so every pricing decision uses the singleton token meter.

也就是说：**选范围、写锁标记、替换表层、计价**全部固定在 `compactSurfaceRegion` 里，
子类只该改**摘要内容**。第三方插件（`dsh-compact-tuner` 等）改的是 Config 里的阈值，
LRC 改的是摘要内容本身 —— 两者都在规则内。

---

## 三、架构设计

### 3.1 组件

```
dsh-plugin-lrc/
├── src/
│   ├── index.ts              # 插件入口：注册工具 + 挂压缩后端
│   ├── lrc-client.ts         # LRC HTTP 客户端（distill / migrate / index / lifecycle）
│   ├── compaction-backend.ts # LrcCompactionEngine extends BasicCompactionEngine
│   ├── cursor.ts             # 增量游标（只提炼新增对话）
│   └── dedup.ts              # 语义查重与版本合并
├── scripts/
│   ├── smoke.ts              # 客户端冒烟（mock，不依赖真实 LRC）
│   └── e2e-compact.ts        # 三次压缩不膨胀的验收脚本
├── docs/
│   ├── PLAN.md               # 本文件
│   └── ACCEPTANCE.md         # 硬性验收标准与实测记录
├── package.json
├── cordis.patch.yml
└── README.md
```

### 3.2 关键决策：不重写 `compactIfNeeded`

**需求原文**要求"拦截 `compactIfNeeded`"。技术上不需要，也不该这么做：

| 做法 | 后果 |
|---|---|
| 重写 `compactIfNeeded` | 要自己实现选范围、写 `compaction/start` 锁、替换表层、计价 —— 任何一处偏差都会破坏**回放确定性**（DSH 靠日志重放重建会话） |
| 只重写 `summarize()` + 调 Config | 官方保证的路径，锁与回放由框架负责 |

**等价效果怎么拿到**：

| 想要的效果 | 官方给的开关 |
|---|---|
| 提前触发（20% 而不是 80%） | `Config.thresholdRatio` |
| 压缩后保留最近 20% 原文 | `Config.retainRatio` |
| 预留输出 token | `Config.headroomTokens` |
| 用哪个模型写摘要 | `Config.summarizationProvider` / `summarizationModel` |
| 重试次数 | `Config.compactionRetries` / `maxOverflowRetries` |

所以"调参"和"换内容"是两件正交的事，各用各的开关。

### 3.3 数据流

```
DSH 触发压缩
   ↓
BasicCompactionEngine 选出待压缩区间
   ↓
LrcCompactionEngine.summarize(input, agent, signal)
   ├─ ① 从 input.messages 抽纯文本
   ├─ ② 增量游标：只取上次之后的新增部分
   ├─ ③ POST /v1/context/distill   → 结构化记忆（决策/约束/结论/报错）
   ├─ ④ POST /v1/context/migrate   → 语义查重后写入（update / superseded / insert）
   ├─ ⑤ 调 super.summarize()       → 模型摘要（保留原有质量）
   └─ ⑥ 把 LRC 状态快照拼到摘要最前面
   ↓
DSH 用我们的摘要替换旧区间
```

**为什么还要调 `super.summarize()`**：LRC 的提炼是规则式的，能抓决策与约束，
但抓不住"当前正在做什么"。模型摘要补这一块。两者拼起来才是完整的状态快照。

**失败策略**：LRC 不可达 → 记 `warn`，返回模型原始摘要，**不阻断压缩**。

---

## 四、三个硬性验收标准（去重）

> 这三条是"解决上下文压缩问题"的**硬性验收标准**，不达标不算完成。

### 标准 1：增量游标 —— 只提炼新增对话

**问题**：每次压缩都把整段 transcript 重新提炼一遍，同一句话被反复写入。

**设计**：

```ts
interface CursorState {
  sessionId: string;
  lastLine: number;      // 已处理到第几行
  lastHash: string;      // 该行内容的哈希（校验 transcript 是否被重写）
  updatedAt: number;
}
```

- 存储位置：`$DSH_HOME/cache/lrc-plugin/cursor.json`
- 每次 `summarize()` 前读游标，只取 `lines[lastLine..]`
- **哈希校验**：若 `lines[lastLine-1]` 的哈希与记录不符（transcript 被截断/重写），
  游标失效，退回全量提炼并记 `warn`
- 压缩成功后推进游标

**验收**：连续 3 次压缩，第 2、3 次送进 `distill` 的字符数应显著小于第 1 次
（预期 < 50%），且 `distill` 返回的 `count` 递减。

### 标准 2：migrate 必须语义查重，绝不盲目 insert

**问题**：`migrate` 目前走 `prepare_remember` 的相似度合并，但**没有显式阈值**，
也没有"被取代"语义 —— 同一决策的旧版本会和新版本并存。

**设计**：给 `migrate` 增加 `dedup` 参数（默认开启）：

```json
{
  "items": [...],
  "project": "demo",
  "dedup": {
    "enabled": true,
    "similarityThreshold": 0.85,
    "onConflict": "supersede"   // supersede | merge | skip
  }
}
```

三种冲突处理：

| 策略 | 行为 | 何时用 |
|---|---|---|
| `merge` | 合并进已有记忆（并集 tags、取较大 importance） | 同一结论的不同表述 |
| `supersede` | 新记忆写入，旧记忆打 `mark_superseded` | 决策被推翻（"改用 npm" → "改回 pnpm"） |
| `skip` | 丢弃新记忆 | 完全重复 |

**依赖**：LRC 侧需要
1. `migrate` 支持 `dedup` 参数并返回 `{written, merged, superseded, skipped}`
2. 复用既有 `/v1/memories/lifecycle` 的 `mark_superseded`

**验收**：同一批 items 连续 migrate 3 次，库内总数不增长；
`merged + superseded + skipped` 应等于第 2、3 次的 `items.length`。

### 标准 3：三次压缩不线性膨胀

**验收脚本** `scripts/e2e-compact.ts`：

```
1. 起 mock LRC（记录所有写入）
2. 构造 3 段递进的对话（第 2、3 段包含第 1 段结论的复述）
3. 依次触发 3 次 summarize()
4. 断言：
   - 第 1 次：written = N1
   - 第 2 次：written + merged + superseded + skipped = N2，且库内总数 = N1
   - 第 3 次：同上，库内总数仍 = N1
   - 去重率 = (N2 + N3 - 新增) / (N2 + N3) ≥ 80%
```

**通过标准**：3 次压缩后库内总数 **≤ 第 1 次的 1.2 倍**（允许少量真实新增）。

---

## 五、Phase 协议（探索项，M3）

**想法**：不在对话中途硬压，而是在任务阶段结束时主动"接力"。

**待调研**（M3 第一件事）：

1. DSH 是否有 phase / stage 概念？事件名是什么？
2. 能否在 phase 边界主动触发 `compactNow()`？
3. 能否在压缩后注入"下一阶段的前置条件"？

**如果 DSH 没有 phase 协议**：降级为"按 token 阈值 + 任务关键词"启发式触发，
并在 README 里明确说明这是启发式，不是官方协议。

> 这一项**不阻塞** M1/M2。先做能确定的部分。

---

## 六、里程碑

| 阶段 | 内容 | 交付物 | 验收 |
|---|---|---|---|
| **M0** | 仓库与计划 | 本文件 + README + package.json | 仓库可 clone，`npm run smoke` 可跑 |
| **M1** | 客户端 + 压缩后端 | `lrc-client.ts` / `compaction-backend.ts` | 冒烟 11 项通过；DSH 里 `/compact` 后记忆数增加 |
| **M2** | 去重三件套 | `cursor.ts` / `dedup.ts` / `e2e-compact.ts` | **§4 三条硬性标准全过** |
| **M3** | Phase 接力 | 调研报告 + 实现（若可行） | 阶段切换时自动归档并注入前置条件 |
| **M4** | 上架 | 发布包 + 文档 | 进入 DSH 官方插件库 |

**M2 是硬门槛**：三条标准不过，不进入 M3/M4。

---

## 七、风险与未决问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 处于 Developer Preview，API 会变 | 插件随时可能失效 | 锁版本；`peerDependencies` 用 `*` 但 README 标注已验证版本 |
| `summarize()` 的 `input.messages` 结构变化 | 抽文本失败 | 防御式解析（字符串 / 数组 / 未知块都跳过），失败则退回原始摘要 |
| 增量游标与 transcript 重写冲突 | 漏提炼或重复提炼 | 哈希校验 + 失效退回全量 |
| 语义查重阈值难调 | 该合并的没合并 / 该保留的被合并 | 阈值可配；默认 0.85；`onConflict` 可切 |
| LRC 侧 `migrate` 尚不支持 `dedup` 参数 | 标准 2 无法验收 | **需要先改 LRC 主仓**（见 §8） |
| Phase 协议不存在 | M3 无法按原计划做 | 降级为启发式，明确标注 |

---

## 八、对 LRC 主仓的依赖（需要先做）

标准 2 依赖 LRC 侧改动，**这是本仓库的前置条件**：

| 改动 | 位置 | 说明 |
|---|---|---|
| `migrate` 支持 `dedup` 参数 | `src/v1_api.rs` | `{enabled, similarityThreshold, onConflict}` |
| 返回 `superseded` / `skipped` 计数 | 同上 | 当前只有 `written` / `merged` / `failed` |
| 冲突时调 `mark_superseded` | 同上 | 复用既有 `/v1/memories/lifecycle` 逻辑 |

**建议顺序**：先在 LRC 主仓做这三处（约半天），再开始 M2。

---

## 九、验收清单（总）

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 增量游标 | 第 2、3 次送进 distill 的字符数 < 第 1 次的 50% |
| 2 | 语义查重 | 重复 migrate 3 次，库内总数不增长 |
| 3 | 不线性膨胀 | 3 次压缩后总数 ≤ 首次的 1.2 倍，去重率 ≥ 80% |
| 4 | 不阻断压缩 | LRC 不可达时压缩仍成功，摘要退回模型原文 |
| 5 | 状态快照质量 | 压缩后的上下文含 `[LRC 状态]` 行，且列出关键决策 |
| 6 | 可回滚 | 删掉 `cordis.patch.yml` 的 insert 段即恢复官方后端 |

---

## 十、下一步

1. 在 LRC 主仓实现 §8 的三处改动（`dedup` 参数）
2. 本仓库 M0：补齐 README / package.json / .gitignore
3. 本仓库 M1：迁移 `lrc-client.ts` 与 `compaction-backend.ts`（已有可复用实现）
4. 本仓库 M2：实现游标与去重，跑通三条硬性标准
