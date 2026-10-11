# adr

[English](README.md) | 简体中文

> 留在仓库里的架构决策，代理只能通过专用工具编写和修改。

以 [MADR 4.0](https://github.com/adr/madr) 格式把架构决策记录（ADR）作为 Markdown 保存在 `docs/adr/` 中。代理根据与你的访谈起草决策，先记录为提议状态，之后只通过状态变更、取代和带日期的备注来修改。你可以在菜单中接受、拒绝或弃用决策。每个回合，代理都会收到一段待定决策的简短摘要。

## 安装

```bash
omp plugin install adr@wows-omp-plugins
```

需要 OMP 18.5.1 或更新版本，以及一个本地 Git 仓库。任何 `git init` 出来的工作树都可以，不需要远程仓库；在 Git 仓库之外，命令和工具都会拒绝。安装后请开启新会话。插件附带 `adr` 技能和固定版本的 MADR 4.0 模板。

## 快速上手

1. 在主会话中运行 `/adr init`。此时 `docs/adr/` 必须不存在或为空。查看预览后选择 `Write 1 file`（全屏预览中按 Shift+W）。
2. 运行 `/adr new`（可以附带主题，例如 `/adr new database choice`）。代理会就背景、选项和结论访谈你，展示草稿，并把它记录为提议状态的 ADR。
3. 运行 `/adr`，选中该 ADR，按 Enter，然后选择 `Accept`、`Reject` 或 `Deprecate`。

由 roadmap 插件 0.4.0 或更早版本写入 ADR 的仓库无需初始化，见[现有的 roadmap ADR](#现有的-roadmap-adr)。

## 用法

### 记录

| 字段 | 含义 |
| --- | --- |
| ID（`ADR-0001`） | 单调递增，从不重复使用。文件为 `docs/adr/0001-slug.md`。 |
| 状态 | `proposed`、`accepted`、`rejected`、`deprecated` 或 `superseded`。 |
| 取代 / 被取代 | 决策与其替代者之间的双向链接。 |
| 阶段 | 可选，关联到某个路线图阶段；需要 roadmap 插件。 |
| 决策者、咨询对象、知会对象 | 可选的参与者列表。 |

`docs/adr/README.md` 是初始化标记，其中有一张自动生成的全部决策表。钩子会阻止代理用普通方式编辑 `docs/adr/`；你仍可以在自己的编辑器中修改正文。

### 生命周期

- 新决策以 `proposed` 开始；只有在你明确同意时，代理才会直接创建已接受的决策。
- 提议状态的 ADR 可以整体修订。已接受的 ADR 不会被改写：只能被弃用、被一个新的已接受 ADR 取代，或在 More Information 下追加带日期的备注。
- 只有主会话（你，或代表你的主代理）可以接受、拒绝、弃用或取代决策。子代理可以创建提议状态的 ADR、修订它们并添加备注。
- 只有主会话可以设置、更改或清除现有 ADR 的阶段关联，任何状态（包括已被取代）都允许。此操作只改变元数据，不改变决策正文或状态。

### 命令

所有命令都在主会话中运行，并能补全子命令和 ADR ID。

| 命令 | 行为 |
| --- | --- |
| `/adr` | 打开 ADR 控制台：按状态筛选、搜索、阅读 ADR，接受、拒绝或弃用它，追加备注，取代它，发起新决策或运行检查。见 [/adr 控制台](#adr-控制台)。 |
| `/adr list [status]` | 列出 ADR，可只列某个状态。 |
| `/adr show <id>` | 显示一个 ADR 及其取代链。 |
| `/adr accept\|reject\|deprecate <id>` | 记录你的决定。 |
| `/adr note <id> <text>` | 在 More Information 下追加带日期的备注。 |
| `/adr new [topic]` | 让代理就一个新决策访谈你。 |
| `/adr supersede <id> [topic]` | 让代理就一个已接受或已弃用决策的替代方案访谈你。 |
| `/adr check [--fix]` | 检查一致性；`--fix` 重新生成索引表。 |
| `/adr init` | 确认预览后初始化 `docs/adr/`。 |
| `/adr confirm <token>` | 没有对话框可用时，确认暂存的 `/adr init` 预览。 |

### /adr 控制台

默认 `uiMenu: fullscreen` 时，`/adr` 占满终端。左侧列出 ADR 及其状态标记，右侧显示选中 ADR 的全文和取代链。

| 按键 | 作用 |
| --- | --- |
| ↑、↓、Home、End | 选择 ADR。 |
| PgUp、PgDn、鼠标滚轮 | 滚动决策正文。在列表上滚动滚轮会移动选择。 |
| Tab、Shift+Tab | 在“全部”和现有的各个状态之间切换，并显示数量。 |
| 小写字母、数字 | 按 ID、标题和状态搜索。Backspace 编辑搜索内容。 |
| Enter | 在小对话框中为选中的 ADR 选择决定。 |
| Shift+A、R、D | 在状态允许时接受、拒绝或弃用选中的 ADR。 |
| Shift+N、S | 追加备注，或取代已接受或已弃用的 ADR。 |
| Shift+O | 发起新决策。 |
| Shift+C | 运行检查。 |
| Shift+F | 运行检查并重新生成索引。 |
| Esc | 先清除搜索，再关闭。 |

接受、拒绝、弃用、追加备注和运行检查之后，控制台会重新打开并停在同一个 ADR 上，按键提示上方的一行显示结果，完整结果也会发到对话中。发起新决策或取代会关闭控制台，因为接下来由代理访谈你。如果在它们的主题对话框中取消，会回到控制台。

`/adr init` 的预览使用同样的布局：左侧是文件，右侧是选中的文件。Shift+W 写入全部文件，Esc 拒绝。

### 代理工具

| 工具 | 用途 |
| --- | --- |
| `adr_status` | 列出 ADR（可用 `status` 筛选），或按 `id` 读取单个 ADR 的全文和取代链。 |
| `adr_manage` | `create`、`revise`、`set_status`、`supersede`、`note`、`link`。`link` 必须提供 `id`；提供 `stage` 即设置或更改关联，省略即清除。 |
| `adr_check` | 一致性检查；`fix: true` 重新生成索引表。 |

在没有启用 `docs/adr/` 管理的仓库中，所有工具都会拒绝，并告诉代理请你运行 `/adr init`。

### 现有的 roadmap ADR

roadmap 插件 0.4.0 或更早版本写入的 ADR（包括其 `docs/adr/README.md` 索引）会按原样读取，因此该仓库视为已初始化。每次写入只会把它涉及的文件改写为本插件的格式，第一次写入会转换索引，并保留你在索引中写的文字。未涉及的文件保持原有字节。ADR 编号会接着 roadmap 插件的 ADR 计数器继续，该计数器只读不写。

转换是单向的：roadmap 插件 0.4.0 及更早版本无法读取转换后的文件。仍在运行这些版本的克隆必须升级 roadmap 插件并安装本插件，因此请在第一次写入之前完成升级。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-adr`。

```bash
omp plugin config set wows-omp-plugin-adr uiMenu inline
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `uiMenu` | `fullscreen` \| `inline` | `fullscreen` | `fullscreen` 打开[控制台](#adr-控制台)和全屏写入预览。`inline` 保留小型选择对话框：先选状态筛选，再选列表项，然后选单个 ADR 的操作。无效值按 `fullscreen` 处理，并在日志中记录警告。 |

该设置只在终端界面中生效，每次运行 `/adr` 命令时都会重新读取，修改后无需重启。

## 与其他插件配合

- **roadmap**：roadmap 插件依赖本插件。它通过本插件的服务契约读取 ADR、把 ADR 关联到阶段；`docs/adr/` 不存在或为空时，其 `/init-project` 会初始化它。设置或更改阶段关联需要已加载的 roadmap 插件，且阶段必须存在；清除关联不需要。
- **omo-prometheus**：执行计划时，Atlas 会与路线图工具一同放行 `adr_*` 工具。

## 不使用终端界面时

| 宿主 | 行为 |
| --- | --- |
| RPC（`--mode rpc`、`rpc-ui`）和 ACP | 不论 `uiMenu` 如何设置，都使用 inline 菜单和对话框，以 `select`、`input` 和 `editor` 请求发送。ACP 客户端可能只在日志中显示通知。 |
| 无 UI（`--no-ui`、print、JSON、SDK） | 没有对话框。不带参数的 `/adr` 会输出列表和用法；请使用子命令。`/adr init` 返回预览和令牌而不写入；用 `/adr confirm <token>` 确认。通知会变为会话消息。 |

客户端程序可以从状态快照读取 ADR 状态，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- `/adr init` 不会接管本插件未管理的非空 `docs/adr/`。
- 编辑保护是尽力而为的，对 `bash` 尤其如此，它不是沙箱。
- `check` 校验的是文档本身，而不是代码是否遵循这些决策。
- 多文件写入不是全有或全无；中断后可能留下过期的索引，可用 `/adr check --fix` 修复。
- 不同的克隆不共享编号，ID 可能冲突；同一克隆的多个工作树共享编号。
- 没有 UI 时，暂存的 `/adr init` 预览只存在于内存中，进程退出后即丢失。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍工具输入、文件格式（包括旧版 roadmap 文件）、允许的 Markdown、编辑保护、恢复与工作树、状态快照，以及供其他插件使用的服务契约。

## 许可证

MIT。随附的 MADR 模板在 `assets/madr/` 中保留各自的许可证。
