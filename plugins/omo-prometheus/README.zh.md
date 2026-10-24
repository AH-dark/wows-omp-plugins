<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-dark.png">
  <img alt="omo-prometheus" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-light.png">
</picture>

# omo-prometheus

[English](README.md) | 简体中文

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 Prometheus 规划与 Atlas 执行在 OMP 上的移植。Prometheus 会一直向你提问，直到能写出值得批准的计划。批准后，Atlas 负责执行：把每个任务委派给子代理，为每个任务记录经过验证的证据，并在宣布计划完成前运行四个独立的验证关口。

插件基于 OMP 原生的 Plan Mode 和批准流程，并增加了：

- Metis：在规划开始前检查意图和遗漏；
- Prometheus：只问会改变计划的问题；
- 可选的 Momus 和 Oracle 评审，找出计划中的阻塞性问题；Oracle 也可以就架构和高风险决策提供咨询；
- Atlas：执行者。

## 安装

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本；规划还需要启用 Plan Mode（`plan.enabled`，默认开启）。安装后重启 OMP。

如果你用过旧的 `prometheus` 插件，请先用 `omp plugin uninstall prometheus@wows-omp-plugins` 卸载。它的会话状态不会迁移过来，需要重新制定计划。

## 快速上手

```text
/prometheus add rate limiting to the public API
```

1. Prometheus 进入 Plan Mode，先咨询 Metis，然后向你提问。一直回答，直到它提出计划。
2. 审阅提案，并通过 OMP 正常的批准对话框批准。两个批准选项都会交给 Atlas 执行。
3. Atlas 会自行开始执行。编辑器上方的小组件显示进度；`/atlas` 打开完整视图。
4. 所有任务、四个最终关口以及交付任务（如果有）都通过后，计划完成。`/atlas exit` 随时可以退出 Atlas。

## 用法

### 规划

`/prometheus` 会进入 Plan Mode；如果已经在 Plan Mode 中，则升级为 Prometheus。可以在命令后直接写需求，也可以在下一条消息里描述。规划期间再次运行 `/prometheus` 会同时退出 Prometheus 和 Plan Mode。

在普通的 `/plan` 模式下，小而明确的需求仍走 OMP 的常规流程。遇到大型、跨模块或含糊的目标时，规划者会询问是否切换到 Prometheus；同意后，会话即进入同一套工作流。

计划写在 `local://` 会话产物中，并通过 OMP 的批准流程提交。如果开启了 OMP 的计划自动保存，批准后的副本还会保存在 `.omp/plans/` 下。

`reviewLevel`（见[设置](#设置)）决定提案前由 Momus 单独评审，还是由 Momus 和 Oracle 一起评审。

OmO 文档把原版称为 [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner)（`/ulw-plan`）和 [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute)。本插件保留 `/prometheus` 和 `/atlas` 命令，并跟进这些内核；固定的修订版本记录在 `NOTICE` 中。

### 计划格式

每份计划都以两个机器可读的章节结尾。任务是从 `T1` 开始编号的复选框行，每行带有 `Agent:`、`Depends on:`、`Tier:` 和 `Acceptance:`：

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Tier: LIGHT
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Tier: LIGHT
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Prometheus 会为每个任务分配会话 `task` 工具中最专门的代理，优先使用 `omo-toolkit` 的代理。如果执行时某个代理不存在，Atlas 会尝试它的回退代理，再从当前列表中挑最合适的，不需要你重新批准。

为已绑定的[路线图](#与其他插件配合)阶段编写的计划，还要有一行计划级声明，列出本计划交付的阶段完成标准，例如 `Roadmap criteria: DC1, DC3`。只要路线图插件报告了该阶段的完成标准，Prometheus 就会在请你批准之前拒绝这样的提案：缺少这一行、写了多行、没有列出标准，或者列出的编号不是当前的完成标准。计划没有列出的标准留给其他计划。

### 执行

批准后，主会话变成 Atlas。Atlas 自己不改文件：插件会在父会话中屏蔽实现类工具（`bash`、`eval`、`edit`、文件写入等），所以每个任务都通过 `task` 交给子代理。

Atlas 用执行记录跟踪计划。只有拿到子代理真实最终结果作为证明，任务才会被标记为完成，在计划文件里勾选复选框不算数。任务按依赖顺序执行，依赖关系中有环的计划会在执行前被拒绝。HEAVY 任务（安全、迁移、公共 API、数据丢失风险等）还需要另一个全新的子代理独立验证。子代理在改动影响范围内发现的缺陷会在最终关口之前成为发现任务（`D1`、`D2`……）。范围外的缺陷记为延后发现（`O1`、`O2`……），由 Atlas 逐条分诊：登记为它创建的路线图 TODO、标为重复、不予处理，或者在仓库中没有可用的路线图时只列入报告。最终报告会列出每条发现及其处置供你审阅；还有未分诊的发现时，Atlas 无法被释放。具体约定见[参考文档](REFERENCE.zh.md#执行记录)。

Atlas 停下时若还有未完成的任务，会被推动继续。如果执行记录或计划文件缺失、损坏，或者与批准的计划不一致，Atlas 会暂停，等你恢复这些文件，或者用 `/atlas exit` 退出后重新批准修改过的计划。

任务需要你介入时，Atlas 会把它标为阻塞，继续做不依赖它的工作。不影响结果的问题只写在回复里，无人值守时不会因此卡住。等到别的都做不下去了，它才弹出对话框问你，并一直等你回答。真正的阻塞它不会当成可选项绕过去，自己做过的假设会列在最终报告里。

如果你自己解决了阻塞（比如在另一个会话里），告诉 Atlas 是哪个提交或哪些文件。它会重新打开这个任务，派新的子代理核实后再标为完成。如果解决方式改变了计划的要求，先 `/atlas exit`，再用 `/prometheus` 规划这项改动。

Atlas 会把计划同步到待办列表，并把会话重命名为以“Atlas”开头的标题，除非你自己起过名字。每次执行记录改动后，它必须先刷新待办列表才能继续派发或等待；每个子代理结束后，它必须先记录结果才能往下走，否则插件会拒绝下一次派发。它遵循宿主的 `task.isolation` 设置，只有一个例外：`merge: patch` 时，执行期间会把合并方式切到 `branch`，让子代理的提交保留下来，退出时恢复你的设置。子代理自己提交工作；Atlas 只通过受限的 `atlas_git` 工具提交路线图和 ADR 文档，以及子代理完成后漏提交的工作。

工作区不是 Git 仓库时，谁都不会使用或创建 Git：计划写 `Commit: none`，交付方式为 `direct`，子代理会被告知不提交、不运行 `git init`，不要求隔离，F1 在没有 Git 历史的情况下检查计划。需要提交的话，请在规划前自己运行 `git init`。

### 最终关口

所有任务完成后，Atlas 会并行运行四个关口，每个都在一个全新的子代理上执行，子代理只报告，从不修复。

| 关口 | 代理 | 检查内容 |
| --- | --- | --- |
| F1. Plan compliance review | `momus`（回退 `reviewer`） | 根据计划、执行记录和计划期间的 Git 历史，检查改动是否符合批准的计划 |
| F2. Code quality review | `deep-high`（回退 `task`） | 正确性、范围、可维护性、测试价值和回归风险；任何 CRITICAL 或 HIGH 发现都会判为失败 |
| F3. Real-surface QA | `deep-low`（回退 `task`） | 实际运行每个验证场景，每个通过都有产物支撑 |
| F4. Success-criteria fidelity | `deep-high`（回退 `task`） | 对照每条成功标准和理想状态行检查结果；除非能证明其中某条未达成，否则通过 |

每个关口返回结构化的 `PASS`、`FAIL` 或 `INCONCLUSIVE`；只有 `PASS` 才算通过。关口失败时，Atlas 会添加修正行（`X1`、`X2`……），并只重跑这个关口。同一关口重跑两次仍失败后，Atlas 会把该关口标为阻塞并询问你如何处理。

### 交付

`delivery` 设置决定完成的工作如何离开仓库：`direct` 让提交留在当前工作分支，`pr` 在关口之后由子代理推送分支并创建拉取请求，`ship` 还会等待 CI 并合并。设为 `ask`（默认）时，仓库有远程仓库，Prometheus 就会询问；固定值会直接使用，没有远程仓库时 `pr` 或 `ship` 会变成 `direct`，你也可以在对话中覆盖。执行以计划中的 `Delivery:` 行为准，推送和合并始终由子代理完成。

### `/atlas` 命令

```text
/atlas                          # inactive: open Atlas Dispatch; active: open the running plan's view
/atlas <plan-name-or-id>        # enter a plan in this session and start executing
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display label
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

除了裸 `/atlas` 和 `exit`，其他子命令只能在 Atlas 未激活时使用；要换计划，先退出。计划按名称或 ID 匹配（见[计划匹配](REFERENCE.zh.md#计划匹配)）。

Atlas Dispatch 列出当前工作区中未完成的计划；按 Tab 显示所有计划，包括已完成、无效和其他工作区的计划，但只能查看。

| 按键 | 操作 |
| --- | --- |
| 直接输入 | 模糊搜索名称、ID 或状态 |
| Enter | 立即开始执行选中的计划 |
| Space、Shift+I | 打开全屏计划视图 |
| Shift+R | 在已执行过该计划的会话中恢复 |
| Backspace、Delete | 编辑搜索内容；搜索为空时按 Backspace，或任何时候按 Delete，删除计划 |
| Shift+N | 修改显示名称 |
| Esc | 关闭 |

在非空会话中开始计划时，会询问使用新会话还是当前会话。之后 Atlas 会自己发出第一条执行消息。

Atlas 激活时，裸 `/atlas` 打开一个实时只读视图，显示每一行的状态、正在运行的子代理及其模型、当前工具和用量，按 Tab 可查看时间线。Shift+X 退出 Atlas，Esc 关闭视图。编辑器上方的小组件可以通过 `atlasWidget` 关闭。

### 在另一个会话中继续

计划及其证据保存在你的 OMP 会话目录中，不属于任何单个会话。会话 A 做到一半退出后，会话 B 可以用 `/atlas <name>` 接着做，只要两者使用同一个会话目录和工作区。Shift+R 或 `/atlas resume` 则切回曾经执行过该计划的会话，处于 Atlas 模式，等待你发下一条消息。

同一时间只有一个会话能执行某个计划。退出会释放计划，但不会取消正在运行的子代理，也不会把工作标记为完成；还有子代理在运行的会话会一直持有计划，直到子代理报告。

升级插件后，已有计划无需重新批准即可继续执行。

### 模型

Metis、Oracle 和 Momus 使用 OMP 的 `@slow` 角色。Atlas 在主会话中运行；插件注册了一个 `atlas` 模型角色，可以在 `/model` 中指定：

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

Prometheus 提案等待批准时，批准滑块也会提供 `atlas`；把它从 `default` 移开即可用这个角色执行。`/atlas <plan>` 在指定了 `atlas` 角色时会切换过去。这个角色不在 Ctrl+P 的轮换中。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-prometheus`。

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | 提案前的计划评审。 |
| `reviewRoundLimit` | 不小于 0 的整数 | `5` | 每份计划最多的评审轮数；`0` 或留空（`""`）表示不设限。 |
| `delivery` | `ask` \| `direct` \| `pr` \| `ship` | `ask` | 完成的工作如何离开仓库，见[交付](#交付)。 |
| `atlasWidget` | boolean | `true` | Atlas 执行时在编辑器上方显示进度小组件。 |
| `progressReports` | boolean | `false` | 每批派发前和每个任务结束后，Atlas 在对话里贴一小段汇报：进度、目标或结果、怎么核实的、遇到的问题和下一步。子代理的任务说明不方便你阅读时有用。 |
| `herdrDag` | boolean | `true` | 向 `omp-herdr-dag` 查看器发布 Atlas 进度。 |

评审级别：

- `ask`：每份计划都由 Momus 评审。你要求高精度，或工作不简单且不清晰时，由 Momus 和 Oracle 一起评审；工作清晰时会让你选一次。
- `standard`：每份计划都由 Momus 评审；明确要求时仍会加上 Oracle。
- `high-accuracy`：始终由 Momus 和 Oracle 一起评审。
- `off`：不做 Momus 或 Oracle 评审，即使你要求也不做。Metis 仍会运行，Atlas 也仍会运行 F1 合规关口。

评审轮数由插件自己统计：每派一次 Momus，或一起派 Momus 和 Oracle，算一轮，没能读到计划的那一轮也算。计划达到 `reviewRoundLimit` 时，你可以选择只为这份计划增加轮数，或者就此打住；打住后 Prometheus 会按计划当前的样子提交审批，并列出仍未解决的阻塞问题，供你在审批时权衡。没有可交互的用户时，评审在达到上限时停止。

用户设置会与项目覆盖合并。设置在会话启动时读取，修改后请重启会话。

## 与其他插件配合

- `omo-toolkit`：计划优先使用它的分类代理，F2、F3、F4 三个关口运行在 `deep-high` 和 `deep-low` 上。
- `judge-dispatch`：计划执行期间不改派任何调用，也从不改派 `metis`、`momus` 或 `oracle`。
- `omp-herdr-dag`：以实时依赖图显示 Atlas 的任务、发现任务、修正、关口和交付。
- `roadmap`：在绑定了路线图阶段时提出的计划会记住该阶段及其声明的完成标准。一个阶段可以由多个计划共同交付；路线图插件会向 Atlas 查询某个阶段有哪些计划、各自覆盖哪些标准、进展到哪一步。Atlas 可以使用路线图工具；路线图在仓库中可用时（Git 工作树中有已初始化的路线图，并装有 `adr` 插件），它会为每条延后发现创建路线图 TODO。如果批准后阶段的目标、范围、完成标准或设计约束发生变化，`/atlas <计划>` 和计划完成时都会显示提示，但执行不会因此暂停。计划完成后（`pr` 和 `ship` 计划在交付之后），会话会收到提醒，评估是否关闭该阶段：只有每条当前完成标准都有某个计划的通过证据时才关闭，阶段也不会被自动关闭。
  由于 Plan Mode 无法提交，规划期间开始阶段只会绑定它；Atlas 会在第一个任务之前开始该阶段并提交，完成之前拒绝派发任务。
- `adr`：Atlas 可以使用 ADR 工具，与是否安装 `roadmap` 无关。ADR 的接受、拒绝和取代由 Atlas 通过 `adr_manage` 完成，子代理无权决定；阶段还有提议中的 ADR 时无法关闭，需要先处理这些 ADR。
- [Magic Context](https://github.com/cortexkit/magic-context)：它的 `ctx_*` 工具在 Atlas 中保持可用。

## 不使用终端界面时

| 宿主 | `/atlas` 的行为 |
| --- | --- |
| RPC（`--mode rpc`、rpc-ui） | Atlas Dispatch 变为一系列选择对话框（先选计划，再选 Start、Resume、View details、Rename、Delete 或 Back）。小组件以文本行发送。 |
| ACP 编辑器 | 通过表单征询显示相同的对话框。不显示小组件。 |
| SDK、`--no-ui`、print | 没有对话框，请使用子命令。删除需要 `--yes`。`/atlas resume` 只能在唯一执行过该计划的会话中使用；否则它会列出应该打开的会话。 |

Prometheus 规划需要 Plan Mode 的交互式批准，所以只能在 TUI、RPC 和 ACP 中运行。

客户端程序可以从状态快照读取规划和执行状态，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- Atlas 需要基于文件的会话，且所在本地文件系统支持硬链接、原子重命名以及文件和目录同步。会话存储在内存中或只在远端时，Atlas 会拒绝运行。会话目录不同的会话看不到彼此的计划。
- 在共享执行记录之前的版本中执行的计划无法恢复，需要重新批准。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍 Atlas 工具守卫、计划包与执行记录、计划匹配、所有权、状态快照，以及与 `omp-herdr-dag`、`roadmap` 和 `adr` 的事件契约。

## 许可证

Prometheus、Metis、Oracle、Momus 和 Atlas 的提示词资源是 OmO 的修改衍生作品；`NOTICE` 记录了上游仓库、固定的修订版本、早期 fork 历史和修改声明。

扩展代码和原创打包部分采用 MIT 许可证（`LICENSE-MIT`）。`agents/`、`assets/` 和 `skills/prometheus/` 下的衍生提示词资源仍适用上游的 Sustainable Use License 1.0（`LICENSE-SUL-1.0`），允许内部商业使用、个人使用和非商业使用，仅允许出于非商业目的免费分发。
