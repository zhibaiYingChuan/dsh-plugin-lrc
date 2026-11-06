# 插件用户配置指南

> 5 分钟装完。装完你的 DSH 会边聊边把结论存进 LRC，上下文不再越聊越卡。

---

## 一、装之前确认

| 项 | 要求 |
|---|---|
| DSH 版本 | `0.1.0-rc.5` 及以上（`dsh --version` 查看） |
| Node.js | ≥ 20 |
| 磁盘 | 约 200MB（含 LRC 运行时与数据） |
| 网络 | 首次启动需联网下载 LRC 运行时（约 30~60MB） |

---

## 二、安装（3 步）

```bash
# 1) 装插件
dsh plugin --profile web add github:zhibaiYingChuan/dsh-plugin-lrc

# 2) 确认真的进了插件树（这步不能省）
dsh --profile web --dump-config | grep dsh-plugin-lrc

# 3) 重启 DSH
```

> 第 2 步没输出 = 没装上。最常见原因是 `package.json` 缺 `dsh.bundle.patch`，
> 包会被当成普通 npm 依赖装上，但不会进入插件树。

---

## 三、首次启动会发生什么

插件第一次启动时会自动准备 LRC 运行时。你会看到这样的提示：

```
[lrc] 正在准备 LRC 运行时（首次需要下载，约 30~60MB）…
[lrc] 下载 https://github.com/zhibaiYingChuan/LRC/releases/latest/download/lrc-sidecar-windows-x64.exe
[lrc] SHA256 校验通过
[lrc] 已启动隔离实例：http://127.0.0.1:52341（数据目录 ~/.dsh/cache/lrc-plugin/data）
[lrc] 卸载器就绪（managed）
```

**这段提示的含义**：

| 行 | 说明 |
|---|---|
| 正在准备 | 首次启动，需要下载 |
| 下载 … | 从 GitHub Release 拉取（失败会自动换镜像） |
| SHA256 校验通过 | 文件完整，可以信任 |
| 已启动隔离实例 | 用的是**独立数据目录**，不会碰你的生产记忆库 |
| 卸载器就绪 | 开始工作 |

**第二次启动**会跳过下载，直接复用缓存：

```
[lrc] 卸载器就绪（managed）：http://127.0.0.1:52341
```

---

## 四、三种运行模式

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `external` | 你已有 LRC（`LRC_BASE` 或 3099 端口） | 直接复用，不下载、不启动 |
| `managed` | 没有现成 LRC | 下载并启动隔离实例 |
| `degraded` | 下载失败 / 启动失败 | **静默跳过卸载**，对话照常，不报错 |

`degraded` 时你会看到一行 warn：

```
[lrc] 未启用卸载：LRC 二进制不可用：没有 windows-x64 的二进制清单。请手动安装 LRC 桌面端，或设置 LRC_BASE 指向已有实例。
```

**这不是故障**，只是插件退化成"不工作"。装个 LRC 桌面端或设 `LRC_BASE` 就能恢复。

---

## 五、配置项

在 `cordis.patch.yml` 里改：

```yaml
- insert:
    - id: dsh-plugin-lrc
      name: dsh-plugin-lrc
      baseUrl: ''          # 留空 = 自动探测/启动
      token: ''            # 服务端设了 LRC_API_TOKEN 时填
      project: dsh         # 记忆归属项目
      offloadTurns: 8      # 每 8 轮卸载一次
      offloadChars: 6000   # 或累计 6000 字符卸载一次
      maxItems: 40         # 单次最多提炼条数
```

也可以用环境变量：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `LRC_BASE` | 空 | 指向已有 LRC 实例 |
| `LRC_TOKEN` | 空 | Bearer Token |
| `LRC_MIRROR` | 空 | 自定义下载镜像（优先于内置镜像） |
| `DSH_HOME` | `~/.dsh` | 缓存与数据根目录 |

---

## 六、怎么确认它在工作

### 6.1 看日志

正常工作时每 8 轮会有一行：

```
[lrc] 已卸载 3 条（新增 1 / 合并 2）
```

### 6.2 看记忆数

```bash
curl -s http://127.0.0.1:52341/v1/memories/stats
```

（端口看日志里的 `已启动隔离实例` 那一行）

### 6.3 看上下文

卸载后，下一轮对话里会出现一行：

```
[LRC 状态] 已确定用 pnpm（放弃 npm 因兼容问题）；端口纪律 3099/3111。细节在 LRC，需要时 recall。
```

看到这行就说明接管成功。

---

## 七、常见问题

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 装完没反应 | 没进插件树 | `dsh --profile web --dump-config \| grep dsh-plugin-lrc` |
| 日志里没有 `[lrc]` | 插件没加载 | 重启 DSH；确认 `package.json` 有 `dsh.bundle.patch` |
| 一直 `degraded` | 下载失败 | 设 `LRC_MIRROR` 换镜像，或手动装 LRC 后设 `LRC_BASE` |
| 记忆数不涨 | 对话里没有决策/约束类句子 | 正常。提炼只收结论，不收闲聊 |
| 记忆数涨太快 | 阈值太低 | 调大 `offloadTurns` / `offloadChars` |
| 上下文里没有 `[LRC 状态]` | 卸载了但没注入 | 检查 DSH 版本是否支持 `agent/pre-step` 附加上下文 |

---

## 八、卸载

```bash
dsh plugin --profile web remove dsh-plugin-lrc
```

再删掉 `cordis.patch.yml` 里的 insert 段。

**已存进 LRC 的记忆不会自动删除**。要清就删 `~/.dsh/cache/lrc-plugin/data`。

---

## 九、自己验证一遍

不需要真的开 DSH：

```bash
git clone https://github.com/zhibaiYingChuan/dsh-plugin-lrc
cd dsh-plugin-lrc
node scripts/smoke.ts        # 客户端 11 项
node scripts/e2e-offload.ts  # 三条硬性验收标准 12 项
```

两个都应该是「全部通过」。
