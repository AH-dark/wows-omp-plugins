<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-dark.png">
  <img alt="omp-herdr-dag" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-light.png">
</picture>

# omp-herdr-dag

[English](README.md) | 简体中文

在 Herdr 侧边窗格中以实时图的形式展示 OMP 正在做的事：原生待办、已批准计划的执行、`omo-prometheus` 的 Atlas 计划及其依赖关系，以及每个子代理的工具、输出、模型和费用。查看器只负责观察，从不调度工作、完成待办或修改 Atlas 执行记录。

## 安装

```bash
omp plugin install omp-herdr-dag@wows-omp-plugins
```

需要：

- OMP 18.10.4 或更高版本，并在 Herdr 中以交互方式运行（必须设置 `HERDR_ENV`、`HERDR_PANE_ID` 和 `HERDR_SOCKET_PATH`）；
- `PATH` 中有 `herdr` CLI；
- Bun：`PATH` 中有 `bun`，或在 `viewerRuntime` 中指定路径。

支持 Linux。macOS 使用相同的代码，但尚未验证。不支持 Windows。安装后重启 OMP。

## 快速上手

使用默认设置时，已批准的计划开始执行后，窗格会自动打开。随时手动打开：

```text
/dag-pane          # toggle
/dag-pane open
/dag-pane close
```

在窗格中，用方向键在节点间移动，Enter 展开节点，`t` 切换到任务视图，`o` 查看子代理的对话记录，`?` 查看帮助。

## 用法

### 窗格何时打开

`displayTiming` 控制自动打开：

| 值 | 何时打开 |
| --- | --- |
| `never` | 从不自动打开；请用 `/dag-pane`。 |
| `any-todo` | 原生待办、已批准计划的待办或 Atlas 计划。 |
| `plan-execution`（默认） | 批准原生计划后的执行，或 Atlas 计划。 |
| `atlas-only` | 仅 Atlas 计划。 |

仅有子代理活动不会打开窗格。用 `q` 或 `/dag-pane close` 关闭后，在当前这次运行中它不会再打开；出现新的运行，或执行 `/dag-pane open`，会重新打开。`/new` 和切换会话时会复用同一个窗格。

### 如何读图

每次运行按来源着色：

| 来源 | 颜色 | 含义 |
| --- | --- | --- |
| 原生待办 | 蓝色 `#4f8cff` | 待办阶段构成横带。阶段之间的虚线分隔表示顺序，不表示依赖。 |
| 计划执行 | 紫色 `#a371f7` | 你批准原生计划后出现的第一份新待办列表。 |
| Atlas | 绿色 `#3fb950` | `omo-prometheus` 的任务、新发现工作、修正、最终关口和交付，带有真实的依赖边。 |

节点状态的颜色跟随 OMP 主题：

| 图标 | 状态 |
| --- | --- |
| `○` | 待处理 |
| `◐` | 运行中 |
| `✔` | 已完成 |
| `✖` | 失败 |
| `⊘` | 阻塞 |
| `⊖` | 已放弃 |

实线连接表示正向依赖；选中节点的边会以该运行的颜色加粗显示。点线连接表示修正边和反向依赖（标注 `↑ after <label>`）。默认情况下，如果一条更长的路径已经体现了同样的先后顺序，就隐藏这条边；按 `e` 显示所有边。页脚始终列出选中节点的直接依赖。

按 `p` 高亮关键路径，即按已用时间计算的、由显式依赖构成的最长链。按 `c` 折叠已完成的层。

运行中的节点如果其子代理超过 `stalledAfterSeconds` 没有进展，会以警告色标记为 `stalled`。子代理失败不会把对应的待办或执行记录行标记为失败。

### 任务与对话记录

任务视图（`t`）列出所有直接子代理，来源包括 `task`、`eval` 代理和 `workpool`，在 OMP 提供数据时显示当前工具及参数、最近输出、模型、重试、已用时间、token 和费用。子代理会挂到它启动时正在进行的那个待办上。缺失的指标显示为缺失，绝不显示为零。

在任务上，或在挂有子代理的节点上按 `o`，可以查看其对话记录：助手文本、工具调用和简短的结果预览，从现有的会话文件中读取。

### 查看器按键

| 按键 | 操作 |
| --- | --- |
| `q`、Ctrl+C | 退出并关闭窗格。 |
| `t` | 在 DAG 和任务视图之间切换；在对话记录中按下时，切到另一个主视图。 |
| `h` | 显示或隐藏上一份待办列表（只保留一份）。 |
| `[` / `]` | 上一个 / 下一个运行。 |
| Tab | 切换方向键的作用：选择节点（`NODES`）或平移视图（`PAN`）。 |
| 方向键、`j` / `k` | 选择最近的节点、平移视图、在任务间移动或滚动对话记录。 |
| PgUp / PgDn | 按页浏览节点、任务或对话记录。 |
| Enter | 展开或收起选中的节点或任务。 |
| `c` | 折叠已完成的层。 |
| `p` | 高亮关键路径。 |
| `e` | 显示所有依赖边。 |
| `f` | 跳到下一个运行中的节点。 |
| `o` | 打开选中子代理的对话记录。 |
| Esc | 离开对话记录或关闭帮助。 |
| `?` | 帮助。 |

也可以用鼠标：滚轮滚动，Shift+滚轮横向滚动，单击选中节点，双击打开它的对话记录。查看器运行期间，直接拖动不再能选中文本；大多数终端按住 Shift 仍可选择。

### 显式的待办依赖

默认情况下，图只知道阶段顺序。要在待办之间画出真实的依赖，代理可以给 `todo` 传入 `edges`，用任务的原文指名：

```json
{
  "op": "init",
  "list": [
    { "phase": "Implementation", "items": ["Build parser", "Connect viewer"] },
    { "phase": "Verification", "items": ["Check rendered output"] }
  ],
  "edges": [
    { "task": "Connect viewer", "after": ["Build parser"] },
    { "task": "Check rendered output", "after": ["Connect viewer"] }
  ]
}
```

插件会先去掉 `edges`，再把调用交给原生 `todo`，所以待办本身的行为不变。未知的、指向自身的或成环的边会被丢弃，并附上一条 `Herdr DAG edges:` 警告，待办的修改照常生效。插件从不根据措辞或阶段顺序猜测依赖。

### 窗格位置

窗口为横向时，窗格放在 OMP 右侧；为纵向时放在下方（列数少于行数的两倍即为纵向）。窗口方向改变时，插件会在新位置重建窗格。两种方向的位置和大小都可以分别配置。

OMP 退出时，窗格也会关闭（`finishBehavior: close-with-omp`）。设为 `keep-open` 时，窗格保持打开，显示断开连接的横幅，并每秒重试一次连接。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omp-herdr-dag`。

```bash
omp plugin config wows-omp-plugin-omp-herdr-dag
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `displayTiming` | `never` \| `any-todo` \| `plan-execution` \| `atlas-only` | `plan-execution` | 何时自动打开窗格。 |
| `finishBehavior` | `close-with-omp` \| `keep-open` | `close-with-omp` | OMP 退出时如何处理窗格。 |
| `landscapePosition` | `left` \| `right` \| `top` \| `bottom` | `right` | 横向窗口中窗格的位置。 |
| `portraitPosition` | `left` \| `right` \| `top` \| `bottom` | `bottom` | 纵向窗口中窗格的位置。 |
| `landscapeSize` | 0.15 到 0.6 之间的数字 | `0.35` | 横向时窗格所占比例。 |
| `portraitSize` | 0.15 到 0.6 之间的数字 | `0.4` | 纵向时窗格所占比例。 |
| `followOrientation` | boolean | `true` | 窗口方向改变时移动窗格。 |
| `focusPane` | boolean | `false` | 创建窗格时让它获得焦点。 |
| `stalledAfterSeconds` | 10 到 900 之间的数字 | `90` | 子代理多少秒没有进展后，将任务标记为停滞。 |
| `todoDependencies` | boolean | `true` | 接受 `todo` 上的显式 `edges`。原生待办操作不受影响。 |
| `atlasIntegration` | boolean | `true` | 显示 `omo-prometheus` 的 Atlas 计划。 |
| `followTheme` | boolean | `true` | 跟随 OMP 主题变化。 |
| `colorTodo` | `#rrggbb` | `#4f8cff` | 待办运行的颜色。 |
| `colorPlan` | `#rrggbb` | `#a371f7` | 计划运行的颜色。 |
| `colorAtlas` | `#rrggbb` | `#3fb950` | Atlas 运行的颜色。 |
| `retentionDays` | 1 到 365 之间的数字 | `14` | 会话启动时，删除超过此天数的会话所对应的插件文件。 |
| `layoutAlign` | `centered` \| `left` | `centered` | 图在窗格中居中，或靠左紧凑排列。 |
| `viewerRuntime` | 路径或留空 | `""` | 查看器使用的 Bun 可执行文件；留空则自动查找 `bun`。 |

设置会在启动、切换会话和每次执行命令时，按会话的工作目录读取。无效字段回退到默认值并给出警告。位置、大小和颜色的修改会在下次打开窗格或图更新时生效，不会重启正在运行的查看器。

## 与其他插件配合

当本插件的 `atlasIntegration` 和 Prometheus 的 `herdrDag` 设置都开启时（默认如此），`omo-prometheus` 的 Atlas 计划会以绿色运行显示。横带依次为 Tasks、Discovered、Fixes、Final gates、Delivery。行中提供分级和验证信息时，会显示 LIGHT/HEAVY 徽标及验证状态。显示 Atlas 计划期间，Atlas 镜像的待办阶段（`Atlas tasks`、`Atlas discovered`、`Atlas fixes`、`Atlas final gates`、`Atlas delivery`）不会出现在蓝色待办视图中，以免同一份工作显示两次。

## 不使用终端界面时

窗格只在 Herdr 内的交互式 TUI 会话中运行。RPC、ACP、SDK 和 headless 会话即使设置了 Herdr 变量，也不会打开窗格。`todo` 包装及其 `edges` 字段在所有模式下都可用。

## 已知限制

- 仅支持 Herdr；不支持其他终端复用器，也不支持 Windows。
- 子代理的子代理只以状态卡片显示，标记为 `activity unavailable`，没有实时工具、输出或用量。
- 升级插件会删除正在运行的 OMP 所加载的那份安装副本，所以在重启 OMP 之前无法再打开 DAG 面板。插件会给出提示，而不是打开一个损坏的面板；已经打开的面板不受影响。
- 指标和对话记录取决于 OMP 报告了什么。
- 如果 OMP 在创建窗格和记录窗格之间崩溃，可能留下孤立的窗格。插件会给出警告，但从不关闭不属于它的窗格；请手动关闭。
- 插件的本地文件可能包含任务描述、工具参数、输出片段、错误信息和本地路径。请像对待会话数据一样对待它们。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍计划执行的识别方式、布局与窗格位置的细节、Atlas 事件契约以及本地存储。

## 许可证

MIT。本插件是 [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag) 的改进移植，参考的修订版本为 `a093cdf5da96e28dfe50348965d9f3bafb1c9531`。上游的版权和许可声明保留在 [NOTICE](NOTICE) 中；本插件的许可证见 [LICENSE](LICENSE)。
