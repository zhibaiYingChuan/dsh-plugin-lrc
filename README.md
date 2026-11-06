# dsh-plugin-lrc

把 [LRC](https://github.com/zhibaiYingChuan/LRC) 的结构化记忆接进 DeepSeek Harness（DSH）的上下文压缩流程。

> **状态：计划阶段。** 开发计划见 [docs/PLAN.md](docs/PLAN.md)。

## 它解决什么

DSH 压缩上下文时，原生摘要会丢掉关键约束：

```
原生摘要：  "前面聊了包管理器。"
LRC 快照：  "已确定用 pnpm（放弃 npm 因兼容问题）。相关决策已归档至 LRC。"
```

本插件在压缩发生时，先把这段对话提炼成结构化记忆（决策 / 约束 / 结论 / 报错日志）
写入 LRC，再把 LRC 的状态快照拼到摘要最前面。

## 为什么能接管

DSH 的 `BasicCompactionEngine` 留了一个官方子类钩子：

> `summarize()` is the sole subclass customization hook; the replay and durable
> mutation strategy stays fixed so every pricing decision uses the singleton token meter.

所以本插件**只重写 `summarize()`**，不碰锁协议、不碰表层替换、不碰计价 ——
那些是官方契约，改了就破坏回放确定性。

## 三条硬性验收标准

| # | 标准 | 通过条件 |
|---|---|---|
| 1 | 增量游标 | 第 2、3 次送进 distill 的字符数 < 第 1 次的 50% |
| 2 | 语义查重 | 重复 migrate 3 次，库内总数不增长 |
| 3 | 不线性膨胀 | 3 次压缩后总数 ≤ 首次的 1.2 倍，去重率 ≥ 80% |

详见 [docs/PLAN.md §4](docs/PLAN.md)。

## 安装（M1 完成后可用）

```bash
dsh plugin --profile web add github:zhibaiYingChuan/dsh-plugin-lrc
dsh --profile web --dump-config | grep dsh-plugin-lrc
```

## 配置

| 环境变量 | 缺省 | 说明 |
|---|---|---|
| `LRC_BASE` | `http://127.0.0.1:3099` | LRC 服务地址 |
| `LRC_TOKEN` | 空 | 服务端设了 `LRC_API_TOKEN` 时必填 |
| `LRC_PROJECT` | `dsh` | 记忆归属项目 |
| `LRC_MAX_ITEMS` | `40` | 单次迁移最多条数 |

## 许可

待定（上架前确定）。
