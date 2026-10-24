<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-dark.png">
  <img alt="audit-goal" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-light.png">
</picture>

# audit-goal

[English](README.md) | 简体中文

> 住进 OMP 的 CodeRabbit：边审边修，一轮接一轮，直到审计收敛。

`/audit <target>` 会启动一个 OMP 目标（goal），按轮次审计并修复代码。每一轮里，只读的审计子代理负责找问题，主代理对照源码核实它们的发现，再由修复子代理修好确认的问题。每轮结果都记入审计记录；只有代理记录下结论，或者你主动停止，目标才会结束。

## 安装

```bash
omp plugin install audit-goal@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本，并启用目标模式（`goal.enabled`，默认开启）。安装后重启会话。

## 快速上手

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

审计目标是自由文本：一份计划、一个分支、一项功能，任何你想检查的东西都行。页脚会显示进度，例如 `Audit 2/5 · standard`。用 `/goal` 暂停、恢复或查看审计，用 `/goal drop` 停止。

## 用法

### 一轮审计

1. 代理把代码库划分成若干审计领域（服务端、worker、数据库……），给每个领域派一个只读的 `audit-auditor`。
2. 对照源码核实每条发现，驳回不成立的。
3. 派 `audit-fixer` 子代理修复其余问题，各修复通道之间不会改同一个文件。
4. 运行项目的完整检查，确认工作区干净，然后记录本轮结果。

发现按 Critical、Major、Minor、Picky 分级。审计记录的每一轮会列出审计模型、覆盖范围、运行过的检查、带源码证据的已核实发现、对早先发现的修复，以及驳回的理由。严重度计数只统计新发现，仍未关闭的发现单独列出。

### 强度

|  | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| 审计报告范围 | 明显的问题：正常使用下的错误行为、失败的检查、明显偏离计划 | 在完整端到端链路上、有可信生产触发条件的问题 | 另外还包括工具链、依赖和宿主边界，以及触发条件明确但少见的潜在 bug |
| 会修复 | Critical、Major | Critical、Major、Minor | 所有级别 |
| 收敛条件 | 一轮没有 Critical 或 Major | 连续两轮没有 Critical 或 Major | 连续两轮没有 Critical、Major 或 Minor |

### 审计如何结束

代理必须先记录以下三种结论之一，才能完成目标：

- `threshold-convergence`：满足了当前强度的退出条件。这只说明审计没再找到问题，并不证明代码没有 bug。早先的 Critical 或 Major 发现要等记录了修复才会关闭。
- `capability-saturation`：在不限轮数时，同一批审计模型从不同审计角度完成了至少三轮可比的审计，代理引用观察说明再审一轮也不太可能有新发现。未关闭的 Critical 和 Major 发现保持未关闭。单凭发现数量不足以判定饱和。
- `stop`：有限的轮数上限用完时仍未收敛。代理会说明情况，并询问你是增加轮数、取消上限还是停止。停止时会记录原因和剩余发现。取消这个问题则保持待决状态。

无论哪种结论，都不代表接受被审计的工作；是否接受由你决定。

修复有时会引入新机制，下一轮又得审计这些机制，循环就一直停不下来。插件会在审计开始时记录 git `HEAD`，单独统计这类由循环自身引起的发现，并要求代理简化或撤回它加入的东西。

`/goal budget` 限制的是 token，不是轮数。要限制轮数请用 `maxRounds`。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-audit-goal`。

```bash
omp plugin config list wows-omp-plugin-audit-goal
omp plugin config set wows-omp-plugin-audit-goal intensity strict
omp plugin config set wows-omp-plugin-audit-goal maxRounds 5
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | 审计深度、修复哪些级别，以及何时可以收敛。 |
| `maxRounds` | 数字或留空 | 留空 | 每次 `/audit` 的轮数上限。留空表示不限。 |
| `maxParallelLanes` | 数字或留空 | 留空 | 同时运行的审计和修复子代理数量。留空表示插件不做限制。 |

`maxParallelLanes` 还受 OMP 的 `task.maxConcurrency` 约束：设置为 10、宿主上限为 3 时，实际运行三个通道。

## 与其他插件配合

`judge-dispatch` 不会改派 `audit-auditor` 或 `audit-fixer`，也不会把其他请求改派给它们。

## 不使用终端界面时

`/audit <target>` 在 RPC、ACP 编辑器、SDK 和 headless 模式下启动的是同一个审计，区别在于由谁发起下一轮：

- TUI 默认会无人值守地继续循环。
- RPC 只有在 OMP 的 `goal.continuationModes` 设置包含 `"rpc"` 时才会自动继续，例如 `["interactive", "rpc"]`。默认值是 `["interactive"]`，此时由客户端发起每一轮。
- 在 ACP、SDK 和 print 模式下，每一轮都由客户端发起。

其他差异：

- RPC 会显示轮次状态行，ACP 会忽略它。
- 到达轮数上限时，RPC 和 ACP 客户端会以选择对话框的形式询问增加、取消上限还是停止。没有 UI 时，审计会记录一次非交互式停止。
- 没有 UI 时，用法错误和拒绝信息会以可见的会话消息显示。

客户端程序可以从状态快照读取审计进度，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- `audit-auditor` 和 `audit-fixer` 会出现在每个会话的 `task` 代理列表中，因为 OMP 无法隐藏插件代理。不在 `/audit` 运行期间时，插件会拒绝派发它们。
- 在 Plan Mode 或 vibe 模式下、另一个目标尚未完成时，或者已有审计正在运行时，`/audit` 不会启动。
- 如果最新的审计记录条目损坏，审计既无法继续也无法完成。运行 `/goal drop` 后重新开始审计。
- 审计遵循被审计项目自己上下文文件里的提交约定和规则。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍状态快照的结构，以及插件如何驱动审计循环。

## 许可证

MIT。
