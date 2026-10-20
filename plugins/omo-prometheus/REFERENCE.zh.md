# omo-prometheus 参考

[English](REFERENCE.md) | 简体中文

## 规划交接

只有规划者通过 `ask` 提出的、标题为 `Prometheus` 且第二个选项指名 Prometheus 的那个问题，才算同意把普通 `/plan` 会话切换到 Prometheus。

Prometheus 计划的两个批准选项都会交给 Atlas。“Approve and execute”会开启一个新会话；为了让交接在切换后仍然有效，插件会在提出计划时把一个标记写入 `local://prometheus/<slug>.proposal.json`，OMP 会把它和计划一起复制到新会话。普通 Plan Mode 批准的计划没有这个标记，插件不会处理它们。

## 计划语法

- `## Tasks`：从 `T1` 开始编号的 `- [ ] T<n>. <title>` 行，每行带缩进的 `Agent:`、`Depends on:`、`Acceptance:`，以及可选的 `Tier: LIGHT | HEAVY`（不区分大小写）。缺少 tier 即为 LIGHT，旧计划行为不变。其他取值或重复字段都是解析错误。
- `## Final gates`：恰好 F1–F4，标题固定。
- `Delivery: direct | pr | ship`：在第 0 列的一行普通文本，位于代码块、列表、`## Tasks` 和 `## Final gates` 之外。重复、未知取值，或者出现在上述章节里的 `Delivery:` 行都是解析错误。没有这一行即为 `direct`。

计划只写 T 行和 F 行，D、X 和 P1 行由 Atlas 追加。`delivery` 设置（`ask | direct | pr | ship`，默认 `ask`）以 `<delivery-policy mode=...>` 的形式注入规划者；执行以计划中的 `Delivery:` 行为准。

## Atlas 工具守卫

守卫只放行观察会话或修改宿主自有状态的工具；除 `atlas_git commit` 外，这些工具都不会写入工作区。它不会启用任何工具：会话中本来没有的工具，仍然不可用。

| 工具 | 在 Atlas 父会话中允许 |
| --- | --- |
| `task`、`wait`、`todo`、`think`、`web_search`、`atlas_ledger`、`atlas_release` | 始终 |
| `ask` | 仅当没有进行中或可派发的行时（见下文的 ask 守卫） |
| `atlas_git` | 始终：`status`、`diff`、`log`、`show`，以及按文件名 `commit`（见下文） |
| `read`、`find`、`glob`、`grep`、`ast_grep` | 始终；`read` 拒绝 `ssh://` |
| `lsp` | 只读操作，以及不带 `apply` 的 `code_actions` |
| `github` | `repo_view`、`file_read`、`search_*`、`run_watch` |
| `debug` | 仅状态检查（`threads`、`stack_trace`、`scopes`、`variables`、`output` 等），不允许 `launch`、`continue` 或断点 |
| `ida` | `list` |
| `recall`、`reflect`、`retain`、`memory_edit`、`learn`、`manage_skill` | 始终：它们写入的是记忆后端和托管技能，不是工作区 |
| `goal`、`context_notes`、`new_context` | 始终 |
| `write` | `agent://` 同伴消息、`proc://<id>/kill`，以及对任何已放行工具的 `xd://` 调用 |

其他工具一律屏蔽，包括 `bash`、`eval`、`edit`、`ast_edit`、文件写入、`security_scan` 以及 `checkpoint`/`rewind`（回退会让会话树分叉，脱离证明已完成行的回执）。其他扩展或 MCP 服务器注册的工具即使与原生工具同名也会被屏蔽，下表列出的除外。

`atlas_git` 是 Atlas 会话唯一的 git 入口，背后没有 shell。Atlas 只在两种情况下用它提交：路线图或 ADR 步骤改动的文件，以及子代理完成后遗漏提交的工作。`commit` 需要给出具体文件和由 Atlas 撰写的提交信息，所以你在 `RULES.md` 里的提交约定同样适用。它只暂存并提交这些文件，拒绝目录和 pathspec 魔法写法，并且在任何绑定的子代理任务仍在运行时拒绝提交。查看类操作不会运行外部 diff 驱动、textconv 过滤器或分页器；提交钩子照常运行，钩子失败时这些文件保持暂存状态。该工具只在 Atlas 执行期间激活，并拒绝执行中的 Atlas 主会话以外的任何调用方。

| 集成 | 放行的工具 |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) | `ctx_reduce`、`ctx_expand`、`ctx_search`、`ctx_memory`、`ctx_note`，仅限由扩展注册的；同名 MCP 工具仍被屏蔽 |
| 包装 `todo` 的扩展，例如 [omp-herdr-dag](../omp-herdr-dag/README.zh.md) 支持依赖边的 `todo` | 由扩展重新注册的 `todo`；MCP 提供的 `todo` 仍被屏蔽 |
| [roadmap](../roadmap/README.zh.md) | `roadmap_*`，可直接调用或以 `write xd://roadmap_*` 调用，仅限来自经路线图绑定握手验证过的扩展源路径（见[路线图契约](#路线图契约)） |
| [adr](../adr/README.zh.md) | `adr_*`，可直接调用或以 `write xd://adr_*` 调用，仅限来自经 ADR 绑定握手验证过的扩展源路径（见[ADR 契约](#adr-契约)）；与 `roadmap` 无关 |

## 任务派发

Atlas 父会话的每次 `task` 调用，要么是绑定调用，要么是调研调用：

- **绑定调用**的每个任务恰好带一行 `atlas_assignment`。`{"rows": {...}}` 绑定已开始的 T、D、X、F 或 P1 尝试；`{"verify": {"T3": "…"}}` 绑定一个 HEAVY 行的验证尝试。每个关口和每个验证者都需要单独的子代理，并使用 `atlas_ledger` 给出的 `outputSchema` 和 `schemaMode: "strict"`。实现已记录的行会拒绝再次派发实现。
- **调研调用**不带 `atlas_assignment` 行。每个任务指定的代理必须在当前列表中，且其定义把工具限制在 `read`、`find`、`grep`、`glob`、`ast_grep` 和 `web_search`（外加宿主自动添加的 `yield`）；没有 `tools` 列表的代理会被拒绝。额外的 `tools` 会被拒绝，`metis` 和 `momus` 仍只在规划阶段可用，调研同样需要有效的执行记录。调研子代理在执行记录中没有对应的行，也不能完成任何一行。在同一次调用里混用绑定任务和调研任务会被拒绝。

隔离跟随宿主设置。`task.isolation.enabled` 开启时，每次派发 T、D、X 和 P1 都必须传入 `isolated: true`；关口、验证者和调研子代理可以隔离，也可以不隔离。宿主的 patch 合并会把隔离子代理的改动以未提交状态放进工作区，并丢掉它的提交，所以 `task.isolation.merge` 为 `patch` 时，第一次隔离派发会以运行时覆盖的方式把它切到 `branch`，并提示一次。退出 Atlas、切换到不在执行中的会话、会话关闭时都会恢复原值，已保存的设置不会被改写。

关口和验证者通过宿主的结构化任务结果返回结论。`task` 工具只在 `task.structured` 开启时才提供 `outputSchema` 和 `schemaMode`，而它默认关闭，所以 Atlas 执行期间会以运行时覆盖的方式开启 `task.structured`，并提示一次。上述同样的时机会恢复原值。schema 可以是对象，也可以是它的 JSON 文本，由宿主解析；使用严格工具 schema 的提供方（例如 OpenAI Responses）上的模型只能发送文本形式。

## 代理回退

Prometheus 根据会话 `task` 工具列出的代理制定计划，Momus 也按同一份列表评审。用户自定义代理只有出现在列表中才有效。

派发时先尝试请求的代理，再依次尝试其回退，只选当前列表中的代理：

| 请求的代理 | 回退链 |
| --- | --- |
| `deep-low`、`deep-high`、`ultrabrain`、`architect`、`visual-engineering`、`artistry`、`writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`、`momus`、`oracle` | `reviewer` → `task` |
| `sonic`、`scout`、`reviewer`、`security-reviewer` | `task` |
| `task` | 无 |

回退只改变代理；各代理的模型角色链见 [omo-toolkit README](../omo-toolkit/README.zh.md#代理)。如果整条链都无法派生，执行记录会显示 `unavailable`，Atlas 在开始该行时从当前列表中挑选最合适的代理（`atlas_ledger start` 带上 `agent`）；只有该列表为空时才会报告阻塞。验证者默认使用 `deep-high`（回退为 `task`）；`atlas_ledger verify` 带上 `agent` 可以改选列表中除 `metis` 和 `momus` 以外的代理。

## 计划匹配

计划参数可以匹配显示名称、原始名称，或去掉 `-plan` 后缀的任一名称；重名时请用完整 ID。名称以子命令单词开头的计划，仍可以通过 ID 或 `/atlas start` 选中。

## 计划包

原生批准会在 `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/` 创建计划包，通常位于 `~/.omp/agent/sessions/<working-dir>/atlas/`。移动会话不会一并移动它的 `atlas/` 目录。

```text
plan.md          exact approved plan
approval.json    source approval, workspace, plan identity and roadmap stage (version 3)
ledger.json      row progress and deferred findings (version 6), plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings, including verification attempts (version 2)
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

Atlas 持有计划期间，会话的计划引用是 `atlas://<plan-id>/plan.md`，它是批准时 `plan.md` 的只读视图，供子代理加载。其他会话无法读取；如果计划内容发生变化，这个引用就无法再解析。

## 执行记录

执行记录保存每一行的验收标准、依赖、状态、请求的代理与实际使用的代理、tier、尝试和证据回执，以及计划的 SHA-256、交付方式和范围外发现（按记录顺序编号为 `O1`、`O2`……，分诊后附带处置）。各行按以下顺序排列：

| 行 | 来源 | 等待 |
| --- | --- | --- |
| `T1…` | 已批准的计划 | 各自 `Depends on:` 中的行 |
| `D1…` | 任何关口开始之前的 `discover` scope `in`；每行注明是哪个 T 或 D 行的工作发现了它 | 无 |
| `X1…` | 关口否决后的 `fix` | 无 |
| `F1`–`F4` | 已批准的计划 | 所有 T 行和 D 行，以及各自的 X 行 |
| `P1` | `Delivery: pr` 或 `ship` | 所有关口和所有 X 行 |

Atlas 通过 `atlas_ledger` 驱动执行记录：

| 操作 | 效果 |
| --- | --- |
| `status` | 所有行、带编号和分诊结果的范围外发现、交付方式和可派发的行。 |
| `start` | 预留一个前置条件已完成的开放行并返回尝试绑定；关口还会得到 `outputSchema`，HEAVY 行会得到上一次验证失败。 |
| `done` | 记录子代理的真实最终结果。LIGHT 行、关口和 P1 随即完成。HEAVY 行只记录实现，仍保持进行中；其验证者的 `PASS` 完成该行，`FAIL` 带着摘要重新打开该行，`INCONCLUSIVE` 不改变任何状态。 |
| `verify` | 针对实现已记录的 HEAVY 行：绑定一个不同的全新验证者，返回其 `{"verify": …}` 绑定和严格的 `outputSchema`（`rowId`、`planSha256`、`attempt`、`verdict`、`summary`、`evidence`）。再次调用会替换尚未完成的验证者。 |
| `discover` | `scope: "in"` 追加一个 D 行（标题、验收、原因，可选代理和 tier），一旦有关口开始或存在修正行即被拒绝；`scope: "out"` 记录下一条不建行的范围外发现 `O<n>`，任何时候都可以。 |
| `triage` | 记录 `id` 指定的范围外发现的去向，引用写在 `evidence` 中；再次分诊会替换之前的结果。`todo`：路线图 TODO 编号（`T` 加至少三位数字），仅当路线图在本仓库中可用时允许。`duplicate`：与什么重复。`wontfix`：原因。`report`：仅当本仓库中没有可用的路线图时允许，引用可省略。是否可用取自一次新的路线图绑定回复中的 `usable` 标志；没有回复表示没有路线图，旧版路线图的回复不带这个标志时，`todo` 和 `report` 都接受。 |
| `fix` | 为否决的关口追加一个 X 行（可选 tier），并只重新打开该关口。 |
| `block`、`reopen` | 只影响指定的行；依赖它的已完成行保留各自的证明。 |

只有子代理真实最终结果提供的证明才能把一行标记为完成；失败的、不属于本计划的或仍在运行的子代理，以及手写的引用，都不能完成工作。HEAVY 行还需要一份通过的验证者回执，验证者必须是验证开始之后创建的另一个子代理。验证状态（`pending`、`running`、`passed`、`failed`）由行推导，从不存储。`atlas_release` 要求每一行都有有效回执、HEAVY 行都有验证者回执、每条范围外发现都已分诊（拒绝时会列出未分诊的发现），并且需要你明确确认。计划完成和 `atlas:completed` 从不等待分诊。

子代理的输出会被复制到 `evidence/` 并按摘要重新校验，因此删除原会话后，已验证的进度仍然保留。只保存子代理自己的输出（不含它链接的文件），未通过的验证者输出也不归档。某行的证明丢失或被改动时，该行会重新打开，旧的会话分支也无法回滚共享进度。恢复时，HEAVY 行保留已记录的实现，只丢弃尚未完成的验证者绑定。

继续执行的消息是一条隐藏的 `<atlas-continuation>`，其中包含执行记录摘要；你每发一条消息最多发送八次，连续两次没有进展时，循环停止并通知你。当所有未完成的行都已阻塞或在等待阻塞的行、没有你就无法推进时，继续执行消息会列出每个阻塞行及其记录的原因，并要求 Atlas 用 `ask` 询问你，让会话等待你的回答，而不是只在聊天中留下问题就结束。

旧版本写入的执行记录会在加载时升级，并保留已验证的进度：版本 6 之前的范围外发现按记录顺序获得 `O1`、`O2`……编号，且尚未分诊；版本 5 之前各行均为 LIGHT，发现行和范围外发现为空，交付方式取自计划中的 `Delivery:` 行，没有则为 `direct`；版本 1 的检查点升级到版本 2；版本 4 之前没有记录 Git 基线，所以 F1 以最早记录的行开始时间推定。版本 1 和 2 的批准文件原样加载、从不改写，因为检查点绑定了它们的原始字节。把执行记录存放在会话内的旧版本计划不会迁移，需要重新批准。`prometheus_ledger` 和 `prometheus_release` 已改名为 `atlas_ledger` 和 `atlas_release`，不保留别名。

`timeline.jsonl` 只用于展示：时间线缺失或损坏都不影响批准、所有权、回执或进度。旧版本的计划包显示从执行记录推导出的历史，推导出的事件从不写回。崩溃导致截断的最后一行，以及未知的未来事件类型或版本都会被忽略。

## 最终关口的输入

F1 读取经哈希校验的 `plan.md`（插件在 F1 开始时打印其路径）、执行记录摘要，以及从计划基线提交以来以只读方式收集的 Git 证据（`git diff --stat`、`git log --oneline`、`git status --short`），无法获取时写明“unavailable”。`momus` 以 `review_kind: compliance` 运行 F1。只有格式匹配的结构化 `PASS` 才算通过。关口子代理只报告、从不修复。

## 所有权

原生子代理工作运行期间，所在会话会一直持有计划，直到该工作报告最终结果；其他会话在此期间无法写入计划。子代理完成任务后被其他代理唤醒、且这一轮没有调用 `yield` 就结束时，宿主不会给出原生结果：宿主报告这一轮结束后，它就不再占用计划，但这一轮的输出永远不能作为证据。如果持有计划的会话可以证明已经结束，计划可以被恢复；所有权不明确或属于另一个宿主时，拒绝恢复。无法确认子代理是否已结束时（例如它的唤醒任务被取消），计划会一直被持有，直到原 OMP 进程退出。调研子代理从不持有所有权。当有活动会话持有计划或仍有原生工作未完成时，拒绝删除该计划。

## 会话集成

- 待办镜像：Atlas 根据校验过的执行记录，按行的顺序维护会话的待办阶段：`Atlas tasks`、存在时的 `Atlas discovered` 和 `Atlas fixes`、`Atlas final gates`，以及计划需要交付时的 `Atlas delivery`。其他阶段保持不变；请不要手动编辑 Atlas 阶段。
- 进度守卫：宿主只在模型调用 `todo` 时重绘待办 HUD，所以每个改动了行的 `atlas_ledger` 结果都以需要执行的 `todo` 调用开头，随后给出精简的执行记录（只列出改动行的验收和证据；`status` 显示所有行）。`todo` 可用时，在一次非 view 的 `todo` 调用成功之前，`task`、`wait` 和 `atlas_release` 都会被拒绝；一次调用覆盖之前的所有执行记录改动。另外，某行当前尝试的子代理已有最终结果而该行仍为 `in_progress` 时，`wait` 和不带该行 `atlas_assignment` 绑定的 `task` 调用都会被拒绝，直到 Atlas 用 `done`、`block` 或 `reopen` 记录该行，或者用该行当前的绑定派发替代子代理。两者都只保存在内存中：重启后的会话不带这些状态。
- ask 守卫：`ask` 会让整个会话一直等到你回答，期间不会记录已完成的子代理，也不会派发任何行。只要还有进行中或可派发的行，Atlas 的 `ask` 就会被拒绝，并列出仍可推进的行。拒绝只是推迟提问，不会降低问题的级别：只要某种合理的回答会改变交付内容、验收方式、范围或不可逆的步骤，问题就要用 `block` 记录在对应的行上；只有每种回答都不影响计划的问题，才由 Atlas 写进回复并注明据以推进的假设。等所有未完成的行都已阻塞或在等待阻塞的行时，`ask` 才可用。执行记录不可用时，`ask` 不受限制。
- 会话标题：Atlas 请 OMP 的标题生成器生成一个以“Atlas”开头的标题，没有结果时命名为 `Atlas: <plan name>`。用 `/rename` 设置的名称永远不会被替换，`PI_NO_TITLE` 会关闭这一功能。
- 没有 UI 时，裸 `/atlas` 打印计划列表，或打印正在运行的计划及其各行；进入计划失败时，会话保持暂停，直到运行 `/atlas exit`，Atlas 永远不会退化为仅靠提示词的执行。输出以 `wows-omp-omo-prometheus.command-status` 消息送达。在 RPC 中，Atlas 激活时裸 `/atlas` 显示一个摘要，提供 Keep running、View details（只读 `editor` 对话框，显示计划文本）和 Exit；小组件文本行最多每秒发送两次。

## 状态快照

主会话会用共享的快照外层结构发布 `omo-prometheus.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。既不在规划也不在执行 Atlas 时，`state` 为 `null`。否则为：

```json
{
  "kind": "omo-prometheus/state",
  "version": 1,
  "phase": "planning | awaiting-approval | executing",
  "planFilePath": "local://… (planning only)",
  "atlas": {
    "planId": "…", "name": "…", "paused": "reason, when execution is paused",
    "status": "In progress 1/6", "done": 1, "total": 6, "startedAt": 1760000000000, "runningChildren": 1,
    "rows": [{ "id": "T1", "title": "…", "status": "open | in_progress | done | blocked",
               "kind": "task | discovered | fix | gate | delivery", "agent": "task", "dependsOn": [], "attempt": "…",
               "startedAt": 0, "evidence": "…", "origin": "F1", "tier": "light | heavy",
               "verification": { "status": "pending | running | passed | failed" },
               "child": { "id": "…", "status": "running", "currentTool": "read" } }],
    "gates": [{ "id": "F1", "title": "…", "status": "done", "evidence": "…" }],
    "discoveries": [{ "id": "D1", "title": "…", "status": "open", "origin": "T2" }],
    "deferred": 1,
    "delivery": "direct | pr | ship"
  }
}
```

`awaiting-approval` 指从提出计划到作出批准选择之间的时段。`atlas` 只在执行时出现；暂停的计划可能只带 `planId` 和 `paused`。状态为 `done` 的关口表示已通过。`tier` 只出现在 T、D、X 行，`verification` 只出现在 HEAVY 行。切换会话和关闭时，正在执行的会话的文件保持原样。

## Herdr DAG 契约

启用 `herdrDag` 时，`omp-herdr-dag` 通过 `pi.events` 观察本会话绑定的 Atlas 计划。所有负载都是带 `v: 1` 的普通 JSON，不会改变 Atlas 计划包的格式。

| 事件 | 方向与负载 |
| --- | --- |
| `herdr-dag:hello` | 查看器发给生产者：`{v:1, sessionId, requestId}`。 |
| `atlas:hello` | 同步回复，保留 `requestId`；有绑定计划时附带其标识（`id`、`name`、`planFilePath`、`cwd`）；未绑定的会话启动或切换时也会主动发送。 |
| `atlas:snapshot` | 在每个带绑定计划的 hello 之后以及每次实时更新时发送：计划标识、执行记录状态和总数、带依赖与来源信息的各行、每行的子代理进度、最近 50 条时间线事件。 |
| `atlas:released` | 解除绑定，`reason` 为 `"exit"`、`"session-switch"` 或 `"shutdown"`，随后发送一个不带计划的 hello。 |

快照中每一行的 `kind` 由 id 推导：`task`（T）、`discovered`（D）、`fix`（X）、`gate`（F）或 `delivery`（P）。`origin` 对 X 行指否决的关口，对 D 行指发现它的行。各行可能带 `tier` 和 `verification: {status}`；验证者的摘要不会发布。HEAVY 行接受验证期间，该行的 `attempt` 是验证尝试。时间线另有 `discovered`、`implemented`、`verify_started`、`verify_passed` 和 `verify_failed`。

启动顺序无关紧要。不支持的版本和未知会话会被忽略。某行完成后，最后已知的子代理进度仍然可见，开始新的尝试时清除。释放只表示计划不再显示在视图中。`herdrDag: false` 时不发送任何事件，包括 hello 回复。

## 路线图契约

安装了 `roadmap` 时，Prometheus 使用独立于 `herdrDag` 的 `pi.events` 契约。所有载荷都带 `v: 1`。请求携带 `sessionId` 和新生成的 `requestId`；只有在请求内同步到达、且会话和请求都匹配的回复才算数，格式不对的回复会被丢弃。没有回复说明路线图插件不存在或版本较旧。

1. 绑定。检查提案时和记录提案时，Prometheus 都会发送 `roadmap:binding-request {v, sessionId, requestId}`，接受带有 `repoRoot`、`toolSourcePath`、可选已绑定阶段 `{id, title, round, criteria?, revision?}` 以及可选布尔值 `usable` 的 `roadmap:binding` 回复。已绑定阶段处于活动状态；如果规划会话是在 Plan Mode 中开始它的（这时只会绑定），则仍处于计划状态。`criteria` 是该阶段当前完成标准的编号；`revision` 是路线图计算的规划依据哈希，Prometheus 不解析它。`usable` 表示路线图工具（包括 `roadmap_todo`）此刻能否在本仓库中工作：Git 工作树中有已初始化的路线图，并已连上 adr 插件。延后发现分诊时会重新询问并以它为准。`criteria`、`revision` 和 `usable` 都不发送的旧版本回复照常接受。
2. 覆盖声明。绑定阶段带有 `criteria` 时，计划必须有且仅有一行计划级声明，例如 `Roadmap criteria: DC1, DC3`（位于第 0 列，在 `## Tasks`、`## Final gates` 和代码块之外），列出的编号不重复且都是当前完成标准。缺少这一行、写了多行、没有列出标准、格式错误、位置不对或列出其他编号时，`write xd://propose` 调用会在批准对话框打开之前被拒绝，拒绝信息会列出当前编号。没有绑定阶段，或绑定中没有 `criteria` 时，这一行可写可不写，既不校验也不保存。
3. 存储。提案标记（版本 4）和批准文件（版本 3）记录 `roadmapStage: {repoRoot, id, criteria?, revision?}`：只有针对带标准的绑定作出声明时才记录 `criteria`，绑定带有 `revision` 时就记录它。版本 3 的提案标记以及版本 1、2 的批准文件仍可加载和恢复。
4. 工具。只有当 `roadmap_*` 工具（包括 `roadmap_upgrade`）的扩展源路径与 `toolSourcePath` 一致时，Atlas 才会放行；拒绝信息会说明是缺少握手，还是工具来自其他来源。在此范围内，计划需要的所有路线图操作都允许。
5. 计划查询。对于自己的主会话，Prometheus 用 `atlas:plans {v, sessionId, requestId, plans}` 回复 `atlas:plans-request {v, sessionId, requestId, repoRoot, stage?}`，同步读取共享计划存储，不加锁也不写入。每个计划包含 `planId`、`name`、`repoRoot`、`stage`，已记录时还有声明的 `criteria` 和批准时的 `revision`，以及 `status`（`unfinished` 或 `complete`）、`done`、`total`、`gates`（经过验证的关口结论和摘要，完成前为空）、P1 完成后的 `delivery: {mode, summary}`、`deferred`（`id`、`title`，分诊后还有 `disposition` 和 `reference`）和计划包目录 `directory`。只列出批准中记录了该 `repoRoot`（给定 `stage` 时还要求是该阶段）的计划包；无法读取的计划包会被跳过并记录警告，没有会话目录的会话回复空列表。只在完成时才绑定阶段的计划不会列出。
6. 漂移。用 `/atlas <计划>` 进入计划（或切换到执行过它的会话来恢复）时，以及计划完成时，Prometheus 发送 `roadmap:stage-request {v, sessionId, requestId, repoRoot, stage}`，接受可选 `stage` 中带有 `id`、`title`、`round`、`status`、当前 `criteria` 和 `revision` 的 `roadmap:stage` 回复。该 revision 与批准时不同时，用户会看到一条提示，写明阶段及其当前完成标准；完成时的 `atlas_ledger` 结果也会重复这条提示，供最终报告使用。漂移从不暂停执行；没有记录 revision 的批准不会产生提示。
7. 启动。批准中记录了阶段的计划，每次派发绑定计划行的 `task` 之前，Atlas 都会发送同样的 `roadmap:stage-request`。如果 `stage.activation` 为 `{action: "start"}`（阶段仍为计划状态）或 `{action: "commit", files}`（阶段已是活动状态，但开始操作未提交；`files` 为非空的相对仓库根目录路径），派发会被拒绝，拒绝信息会写明需要执行的 `roadmap_stage` 开始操作或 `atlas_git commit`。在此期间不会拦下 `ask`，这样开始操作被拒绝时可以交给用户处理。`activation` 格式错误时整个回复无效；没有回复或回复中不带 `activation`，表示无需处理。
8. 完成。在首次使绑定阶段的计划完成的那次执行记录写入之后，Prometheus 发送 `atlas:completed {v:1, sessionId, planId, roadmapStage: {repoRoot, id}, gates, delivery?, at}`，附带经过验证的关口结论和摘要。只有所有行都完成，计划才算完成：`Delivery: pr` 或 `ship` 时，事件在 P1 行之后发送，并带上 `delivery: {mode, summary}`；`direct` 时事件在关口之后发送。批准时没有绑定阶段的计划，使用执行会话在那一刻绑定的阶段；`atlas:plans` 不会列出这种计划，所以路线图的关闭提醒把它的完成计为一个覆盖未声明的已完成计划。路线图会记录一条待关闭提醒，阶段仍由会话自己评估并关闭。

完成事件只在每个生产者实例内去重，所以重启后重新打开并再次完成计划，可能会再次发送。路线图在每个接收会话内按 `planId` 对待关闭条目去重。

## ADR 契约

安装了 `adr` 时，Atlas 通过 ADR 自己的 `pi.events` 握手放行 ADR 工具，与 `roadmap` 和 `herdrDag` 无关：

1. Atlas 调用 `adr_*` 工具（直接调用或以 `write xd://adr_*` 调用）时，Prometheus 发送 `adr:binding-request {v:1, sessionId, requestId}`，只接受 `v: 1`、会话与请求都匹配、且带绝对路径 `toolSourcePath` 的同步 `adr:binding` 回复。确认过的回复在本会话内缓存，会话关闭时丢弃；没有回复时，下一次调用会重新请求。
2. Prometheus 只使用 `toolSourcePath`。回复中的 `api` 对象供 `roadmap` 使用，Prometheus 从不读取或调用它。
3. 只有当 `adr_*` 工具的扩展源路径与 ADR 的 `toolSourcePath` 一致时，Atlas 才会放行；拒绝信息会说明是缺少握手（请检查 adr 插件是否已安装并启用），还是工具来自其他来源。每类工具只通过自己的握手验证：路线图绑定不会放行 `adr_*` 工具，ADR 绑定也不会放行 `roadmap_*` 工具。
