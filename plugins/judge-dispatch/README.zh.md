# judge-dispatch

[English](README.md) | 简体中文

> 智能模型路由：由判断模型为 OMP 派生的每个子代理挑选合适的代理类型、思考强度和模型。

让 OMP 的 `judge` 模型角色决定 `task` 调用如何派生子代理。默认情况下，它可以替换父代理请求的代理类型；还可以选择性地为每个子代理设置思考强度，并从该代理配置的所有模型中挑选一个。每次派生仍由 OMP 校验，judge 拿不准的地方一律保持原样。

## 安装

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

需要 OMP 18.5.1 或更高版本。自动路由需要 `judge` 角色背后是原生判断模型（见[快速上手](#快速上手)）；按任务显式绑定模型不需要。安装后重启会话。

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
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92) · model openai/gpt-6.1 → anthropic/claude-opus (fit 0.71)
```

## 用法

### 代理路由

`routeAgent` 开启时（默认），插件可能改写普通 `task` 调用（单个或批量）的 `agent` 字段。候选代理来自实时 `task` 工具描述中的代理列表，OMP 已经按派生策略和禁用设置过滤过。只读代理只会被替换成另一个只读代理。

以下调用保持原样，思考强度和模型也不变：

- 请求 `audit-*`、`metis`、`momus` 或 `oracle` 的调用；普通请求也不会被改派到这些工作流角色；
- 请求了插件在列表中找不到的代理，因为无法确定它的权限级别；
- `omo-prometheus` 计划执行期间的所有 `task` 调用，因为这些选择由已批准的计划决定。

通过 `eval.agent()` 或 `workpool()` 启动的子代理永远不会被路由。

### 思考强度

开启 `judgeEffort` 后，judge 会评估任务的开放程度（`routine`、`standard` 或 `demanding`），插件据此把 `effort` 设为 `lo`、`med` 或 `hi`。OMP 再把它映射为子代理模型支持的最低、中间或最高思考级别，并受 `task.maxEffort` 限制。置信度低于 `minimumConfidence` 时，保留父代理设置的强度。

### 模型选择

开启 `selectModel` 后，插件从代理的模型池中为每个子代理挑选模型。模型池包括该代理的 `task.agentModelOverrides` 条目或 frontmatter 中的 `model` 列表，以及其中所列角色的回退链。第一项是主模型。没有凭据、评分或价格的模型永远不会被选中。

在 `task` 工具仍提供 `model` 字段的 OMP 版本中，调用时指定的模型优先；代理类型和思考强度仍可路由。

`modelBudget` 决定最多可以比主模型低多少。比主模型强的模型以及主模型本身始终可选。

| 预算 | Routine | Standard | Demanding |
| --- | --- | --- | --- |
| `max` | 不低于主模型评分 | 同左 | 同左 |
| `balanced` | 不低于主模型评分的 80% | 不低于 90% | 不低于主模型评分 |
| `minimum` | 模型池中任意模型 | 任意 | 任意 |

难度评估的置信度低于 `minimumConfidence` 时按 demanding 处理，所以预算不会因为猜测而降级。

`modelPick` 决定在可选模型中怎么挑。`best` 取适配度 × 提供商权重最高的模型，所以低预算只是放宽了选择范围，并不强制选更便宜的模型。`weighted` 随机抽取一个，预算越低越偏向便宜的模型，多次调用后工作会分散到整个模型池。`providerWeights` 例如 `openai=2` 会按比例提高该提供商模型的胜出概率，但不会让不符合条件的模型变得可选。

选中的模型会排到这次派生的选择器最前面，模型池的其余部分成为它的重试链。

### 为单个任务显式指定模型角色或模型

无需新建代理类型：让父代理先调用 `judge_dispatch_model`，等待成功结果后，在下一轮工具调用中派发同名的 `task`：

```text
judge_dispatch_model({"name":"ReviewLogic","role":"abliterated"})
task({"name":"ReviewLogic","agent":"deep-low","task":"Review the logic"})
```

角色必须存在于 OMP 的 `modelRoles` 中；也可以使用 `{"name":"ReviewLogic","model":"provider/model:thinking"}` 指定具体模型。`role` 和 `model` 必须二选一。绑定仅存于当前会话，按不含点号的任务名称精确匹配；下一次匹配的派发占用绑定，派生时消费。批量派发时，已绑定名称不得重复。代理类型仍可正常路由，`judgeEffort` 仍生效。显式绑定只跳过 judge 的**模型选择**，用目标角色的首选模型和已配置的回退选择器替换原代理的模型池。`judge` 角色不可用时也能使用。同一进程内切换出去再返回会话会保留待用绑定，但不含绑定调用的对话分支不能使用它，需要在该分支重新绑定。

可用 `judge_dispatch_model({"op":"clear","name":"ReviewLogic"})` 清除未使用的绑定。若任务调用结束时既未派生子代理也未留下后台任务，绑定会恢复为待用状态，供重试使用。清除操作不会改变已派发任务的显式模型。先前已绑定派发尚未启动时，不带新绑定的重试会被拒绝；若后台任务失败或被取消，先重新绑定该名称再重试。为避免排队任务或重复名称取走错误绑定，插件会给每次绑定派发分配唯一名称，例如 `ReviewLogic_jd0123456789ab`；后续交互请使用 OMP 返回的实际子代理 ID。

根据 OMP 的正常规则，任务的 `effort`（包括 judge 路由的强度）优先于模型选择器的思考强度后缀。即使绑定 `provider/model:high`，任务使用 `effort: "lo"` 时也不会强制高思考强度。

未知角色、无法解析的模型、冲突绑定、同名歧义或工作流专属任务会被明确拒绝，不会悄悄改用原代理模型；已批准的 Prometheus 计划执行期间不能使用。这里覆盖的是模型列表，**不会改变 OMP 记录的角色身份**：若直接指定的模型没有自己的回退链，运行时仍可能继承原代理的链；若目标角色显式配置了空链而原角色有回退链，插件会拒绝派生，避免借用错误的链。OMP 自身仍可能执行凭据回退或更高优先级的重试规则。详见[参考](REFERENCE.zh.md#从显式绑定到派生)。

### 你会看到什么

judge 运行期间，工作提示显示 `judge-dispatch: routing N tasks…`。之后每个被路由的调用会打印上面那样的状态行，每一项都带有 judge 的置信度。没有得到可用判断而保留原样的项会注明原因：`judge unavailable`、`judge failed`、`timed out`、`no alternatives`、`no confident choice` 或 `workflow-owned or unknown agent`。完全没能判断的调用会打印一行以 `kept the requested agent:` 开头的状态。

状态行只给你看：OMP 既不会把它发给模型，也不会保存它，所以 `/resume` 后不会再出现。把 `indicator` 设为 `false` 可以同时隐藏状态行和工作提示。

### judge 能看到什么

一次判断请求包含任务内容、可选的共享上下文、原本请求的代理、候选代理的简短描述及其模型池；开启 `selectModel` 时还包括每个池中模型的评分和价格。对话内容和系统提示词永远不会发送。

### 判断失败时

只要没有得到置信度不低于 `minimumConfidence` 的合法选择，就保留原来的代理、思考强度和模型，也不会阻塞任何调用。这包括没有 judge、置信度不足、凭据被拒绝和网络错误等情况。路由最多等待八秒。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-judge-dispatch`。

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch selectModel true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget minimum
omp plugin config set wows-omp-plugin-judge-dispatch providerWeights "openai=2,anthropic=1"
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `routeAgent` | boolean | `true` | 允许 judge 替换请求的代理类型。 |
| `selectModel` | boolean | `false` | 从代理的模型池中为每次派生挑选模型。 |
| `modelBudget` | `minimum` \| `balanced` \| `max` | `balanced` | 相对于主模型，`selectModel` 可以使用哪些池中模型。 |
| `modelPick` | `best` \| `weighted` | `best` | 取 judge 认为最合适的模型，或按偏向便宜模型的权重随机抽取。 |
| `providerWeights` | 文本 | 空 | `provider=weight` 键值对，用逗号或换行分隔。权重必须大于 0；未列出的提供商权重为 1。 |
| `judgeEffort` | boolean | `false` | 允许 judge 设置每次 `task` 调用的思考强度。 |
| `minimumConfidence` | 0 到 1 之间的数字 | `0.70` | 替换代理或思考强度、或采信难度评估所需的置信度。 |
| `includeSharedContext` | boolean | `true` | 随请求一起发送 `task` 调用的共享 `context`。 |
| `indicator` | boolean | `true` | 显示工作提示和状态行。不影响路由本身。 |

用户设置会与项目覆盖合并。插件在每次 `task` 调用时读取设置，所以修改后无需重启。任何无效值（例如格式错误的 `providerWeights` 条目）都会让插件原样保留所有调用并记录警告。

## 与其他插件配合

- `audit-goal`：它的保留代理 `audit-*` 永远不会被路由。
- `omo-prometheus`：`metis`、`momus` 和 `oracle` 永远不会被路由；已批准计划执行期间也不进行任何路由。Prometheus 回到空闲或规划状态后恢复路由。

## 不使用终端界面时

在 RPC、ACP 编辑器、SDK 和 headless 模式下，路由和模型选择的行为相同。RPC 客户端会以通知帧的形式收到状态；ACP 编辑器可能只把它们写进日志。没有 UI 时不显示指示信息。插件没有对话框，也没有命令。

## 已知限制

- `eval.agent()` 和 `workpool()` 的子代理不会被路由，因为 OMP 的 `before_subagent_spawn` 钩子只能更改子代理的模型，不能更改代理类型。
- OMP 会把连续的状态行折叠成一行，所以同一轮中的多个 `task` 调用可能只看得到最后一行。
- 模型选择依赖 OMP 模型注册表提供的评分和价格；主模型没有评分时，保留原先配置的模型。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍模型池的构建方式、`weighted` 公式、判断结果如何作用到派生、超时，以及与旧版设置的兼容。

## 许可证

MIT。
