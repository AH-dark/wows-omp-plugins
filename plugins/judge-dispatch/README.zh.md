<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-dark.png">
  <img alt="judge-dispatch" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-light.png">
</picture>

# judge-dispatch

[English](README.md) | 简体中文

> 由判断模型分类的子代理路由：判断模型为 OMP 派生的每个子代理挑选代理类型，并评估任务的难度；难度改变什么，由你的配置决定。

让 OMP 的 `judge` 模型角色对 `task` 调用如何派生子代理进行分类。默认情况下，它可以替换父代理请求的代理类型。它还可以把每项任务评为 `routine`、`standard` 或 `demanding`：开启 `judgeEffort` 后，评级会把子代理的思考级别调整一级；配置 `modelTiers` 后，routine 或 demanding 的任务会使用你指定的模型。judge 从不挑选模型，这个映射由你决定。每次派生仍由 OMP 校验，judge 拿不准的地方一律保持原样。

## 安装

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。自动路由需要 `judge` 角色背后是原生判断模型（见[快速上手](#快速上手)）；为单个任务固定模型不需要。安装后重启会话。

## 快速上手

插件既不保存凭据，也不维护自己的模型列表；它调用的是 OMP `judge` 角色解析到的那个模型。该模型必须是原生判断模型，即 OMP 通过判断 API（如 TypeSafe 或 OpenRouter decisions）提供的模型，因为 `minimumConfidence` 依赖这些 API 返回的校准置信度。TypeSafe 的 Jev 只是其中之一，OMP 的 `judge` 角色支持的其他判断模型同样适用。

最快的配置方式是使用 TypeSafe 凭据，这样 `judge` 角色默认解析到 Jev（`providers.judgmentProvider: auto`）：

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

要使用其他判断模型，在 OMP 配置中把它指定给 `judge` 角色即可。如果该角色解析到的是聊天模型或本地模型，或者缺少凭据，插件会保留所有请求的代理，并在每个会话中警告一次。

配置生效后，每个被路由的 `task` 调用会打印一行暗色状态：

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · thinking medium → high (0.92) ; #3 ultrabrain kept (0.95) · model openai/gpt-6.1 → @slow (0.88)
```

## 用法

### 代理路由

`routeAgent` 开启时（默认），插件可能改写普通 `task` 调用（单个或批量）的 `agent` 字段。候选代理来自实时 `task` 工具描述中的代理列表，OMP 已经按派生策略和禁用设置过滤过。只读代理只会被替换成另一个只读代理。

以下调用保持原样，思考级别和模型也不变：

- 请求 `audit-*`、`metis`、`momus` 或 `oracle` 的调用；普通请求也不会被改派到这些工作流角色；
- 请求 OMP 内置 `seance` 的调用；它通过原生 `sourceSession` 和可选的 `model` 字段查阅已保存的会话，普通请求也不会被改派给它；
- 请求了插件在列表中找不到的代理，因为无法确定它的权限级别；
- `omo-prometheus` 计划执行期间的所有 `task` 调用，因为这些选择由已批准的计划决定。

通过 `eval.agent()` 或 `workpool()` 启动的子代理永远不会被路由。

### 难度

judge 评估的是任务的开放程度，而不是工作量：修复方法或步骤已经给定时为 `routine`，做法基本确定的常规工作为 `standard`，原因或设计仍不明确时为 `demanding`。任务条目的 `solutionSpace` 是调用方自己对问题开放程度的描述，也在 judge 的参考范围内。

只有当评级能改变某些东西时，插件才会询问难度：开启了 `judgeEffort` 且条目没有自行设置 `effort`，或者为该条目最终使用的代理配置了档位。置信度低于 `minimumConfidence` 的评级按 `standard` 处理，不做任何改变。

### 思考级别

开启 `judgeEffort` 后，routine 评级会把子代理的思考级别下调一个受支持的级别，demanding 评级上调一级。起点是子代理本来就会使用的级别：代理模型选择器上的 `:level` 后缀；没有后缀时，使用代理自身的 `thinkingLevel`。

- 没有起始级别，或者起始级别为 `auto`、`inherit` 或 `off` 时，不做改变。
- 调整只在模型支持的级别范围内进行，所以永远不会降到 `off`；已经处于两端时不做改变。
- 上调永远不会超过 `task.maxEffort`。
- 条目自行设置了 `effort` 时保留它。

插件从不写入任务的 `effort`，因为它会覆盖所有已配置的级别。新的级别会写到这次派生的模型选择器上（见[参考](REFERENCE.zh.md#思考级别调整)）。

### 模型档位

`modelTiers` 指定 routine 和 demanding 任务使用的模型：

```text
routine=@smol,demanding=@slow,ultrabrain.demanding=openai/gpt-6.1:xhigh
```

每个以逗号分隔的条目形如 `[<agent>.]<routine|demanding>=<selector>`，其中选择器是模型角色 `@<role>` 或单个模型 `provider/model[:level]`。针对某个代理的条目优先于适用于所有代理的条目。standard 任务始终使用代理自己的模型。

置信评级对应了某个档位时，子代理会以该档位的模型派生，并使用该档位的回退链：角色在 `retry.fallbackChains` 中的条目，或者 `default` 链。此时思考级别不再调整，适用的是档位选择器自己的 `:level`，没有时使用代理的 `thinkingLevel`。解析到代理自身模型且思考级别相同的档位不做任何改变；指定代理自身模型但级别不同的档位会应用该级别。无法生效的档位（例如未知角色或没有凭据的模型）会保留代理的模型，并在状态行中说明原因；它永远不会阻塞调用。

### 重试与升级

插件会告诉父代理：要重试或升级某个任务，就用同一个 `name` 再派发一次。插件随后会提升这一次派发：

- 子代理最终输出的第一行是 `ESCALATE: deep-high` 时，下一次使用该名称的派发按 `demanding` 处理。
- 子代理在插件降低过的路由上（routine 档位或思考级别下调）失败时，下一次派发提高一个难度，即 `standard`：代理自己的模型和级别。

被提升的派发保留父代理请求的代理，也不经过 judge 判断。每条记录只作用于一次派发，并且只在本会话的内存中保存。状态行会显示 `escalated to demanding after ESCALATE: deep-high` 或 `raised to standard after a failed lowered run`。

### 为单个任务固定模型角色或模型

想让某个子代理改用另一个模型角色，又不想为此新建代理类型时，直接告诉父代理即可，例如"用 abliterated 角色跑这次审查"。插件会在系统提示中加一段简短说明，教父代理把任务条目的 agent 写成 `<agent>@<role>`：

```text
task({"name":"ReviewLogic","agent":"deep-low@abliterated","task":"Review the logic"})
```

写成 `<agent>@<provider>/<model>` 则固定一个具体模型，例如 `scout@provider/model:high`。角色必须存在于 OMP 的 `modelRoles` 中；具体模型必须能解析到一个已启用且有凭据的模型。

插件会在 OMP 执行调用前去掉固定标记，所以子代理仍以 `deep-low` 运行，但使用该角色的首选模型和该角色的回退链（角色没有回退链时使用 `default` 链）。被固定的条目不使用档位，也不调整思考级别；代理路由照常生效，`judge` 角色不可用时也能固定。与 OMP 其他地方一样，任务的 `effort` 仍优先于选择器的思考强度后缀。

被固定的子代理会得到唯一 ID，例如 `ReviewLogic_jd0123456789ab`，因此排队中或之后复用同名的任务都拿不走它的模型。OMP 会显示并保存改写后的调用，所以插件还会告诉父代理应用了哪些固定；任务结果会返回新 ID，父代理应当用它指代该子代理。

固定无法生效时，插件会拒绝整次调用并说明原因，而不是改用代理自己的模型运行。这些情况包括：未知角色、无法解析的模型、`metis` 这类工作流专属代理，以及已批准的 Prometheus 计划执行期间的任何固定。未安装本插件时，OMP 自身会把 `deep-low@abliterated` 当作未知代理拒绝。固定替换的是模型列表，不是 OMP 记录的角色身份，所以 OMP 的凭据回退和更高优先级的重试规则仍会生效。若固定目标自己没有回退链，而 OMP 会改用代理原角色的回退链重试，插件会在派生时拒绝。详见[参考](REFERENCE.zh.md#从固定代理到派生)。

`seance@<role>` 和 `seance@<provider>/<model>` 也会被拒绝：OMP 内置的 `seance` 会绕过应用固定的派生钩子。请把选择器写入该条目的原生 `model` 字段，或省略该字段，使用源会话保存的模型。

### 你会看到什么

judge 运行期间，工作提示显示 `judge-dispatch: routing N tasks…`。之后每个被路由的调用会打印上面那样的状态行，每项决定都带有 judge 的置信度：代理、`thinking <from> → <to>`、`model <代理的模型> → <档位>` 或保留代理模型的原因；难度没有带来任何改变时，只显示 `difficulty`。没有得到可用判断而保留原样的项会注明原因：`judge unavailable`、`judge failed`、`timed out`、`no alternatives`、`no confident choice` 或 `workflow-owned or unknown agent`。完全没能判断的调用会打印一行以 `kept the requested agent:` 开头的状态。

状态行只给你看：OMP 既不会把它发给模型，也不会保存它，所以 `/resume` 后不会再出现。把 `indicator` 设为 `false` 可以同时隐藏状态行和工作提示。

### judge 能看到什么

一次判断请求包含任务内容、条目的 `solutionSpace`、可选的共享上下文、原本请求的代理，以及候选代理的简短描述及其来源和只读状态。模型、价格、对话内容和系统提示词永远不会发送。

### 判断失败时

只要没有得到置信度不低于 `minimumConfidence` 的合法选择，就保留原来的代理、思考级别和模型，也不会阻塞任何调用。这包括没有 judge、置信度不足、凭据被拒绝和网络错误等情况。路由最多等待八秒。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-judge-dispatch`。

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelTiers "routine=@smol,demanding=@slow"
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `routeAgent` | boolean | `true` | 允许 judge 替换请求的代理类型。 |
| `judgeEffort` | boolean | `false` | 按评定的难度把每次派生的思考级别调整一级。 |
| `modelTiers` | 文本 | 空 | 以逗号分隔的 `[<agent>.]<routine\|demanding>=<@role 或 provider/model[:level]>` 条目。 |
| `minimumConfidence` | 0 到 1 之间的数字 | `0.70` | 替换代理或采信难度评级所需的置信度。 |
| `includeSharedContext` | boolean | `true` | 随请求一起发送 `task` 调用的共享 `context`。 |
| `indicator` | boolean | `true` | 显示工作提示和状态行。不影响路由本身。 |

用户设置会与项目覆盖合并。插件在每次 `task` 调用时读取设置，所以修改后无需重启。任何无效值（例如格式错误的 `modelTiers` 条目）都会让插件原样保留所有调用并记录警告。插件已不再支持的已存设置会被忽略，并在每个会话中警告一次。

## 与其他插件配合

- `audit-goal`：它的保留代理 `audit-*` 永远不会被路由。
- `omo-prometheus`：`metis`、`momus` 和 `oracle` 永远不会被路由；已批准计划执行期间也不进行任何路由。Prometheus 回到空闲或规划状态后恢复路由。
- `omo-toolkit`：它的 `deep-low` 代理在有重大选择悬而未决时会回答 `ESCALATE: deep-high`。用同一个名称再次派发后，该任务按 demanding 处理。

## 不使用终端界面时

在 RPC、ACP 编辑器、SDK 和 headless 模式下，路由、思考级别调整和档位的行为相同。RPC 客户端会以通知帧的形式收到状态；ACP 编辑器可能只把它们写进日志。没有 UI 时不显示指示信息。插件没有对话框，也没有命令。

## 已知限制

- `eval.agent()` 和 `workpool()` 的子代理不会被路由，因为 OMP 的 `before_subagent_spawn` 钩子只能更改子代理的模型，不能更改代理类型。
- 只有 `task` 条目能固定模型：OMP 会在任何插件钩子运行前检查 `eval.agent()` 或 `workpool()` 子代理的代理名，所以 `scout@abliterated` 在那里会被当作未知代理而失败。
- 被固定的子代理 ID 会带上 `_jd…` 后缀，而不是你给的名字。
- OMP 会把连续的状态行折叠成一行，所以同一轮中的多个 `task` 调用可能只看得到最后一行。
- 重试与升级记录在重启后丢失，并且只有使用同一名称的派发才能找到它们。
- 思考级别调整依赖 OMP 模型注册表提供的受支持思考级别；没有这些信息的模型保持原级别。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍档位如何展开、思考级别调整规则、重试与升级记录、判断结果如何作用到派生，以及超时。

## 许可证

MIT。
