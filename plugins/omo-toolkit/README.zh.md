<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

[English](README.md) | 简体中文

从 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）移植到 OMP 的分类代理、一个调研代理、若干工作流技能和两个文档类 MCP 服务器。安装后，这些代理会出现在 `task` 工具的代理列表中，技能可以通过 `/skill:` 使用。

## 安装

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。安装后重启会话。

## 快速上手

合适的时候，主代理会自己选用这些代理。你也可以直接点名，例如“让 `ultrabrain` 设计一下加锁方案”，或者直接运行技能：

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

如果想让设计和写作代理使用专门的模型，在 `/models` 中为 `designer` 和 `writer` 角色指定模型。

## 用法

### 代理

分类代理以 OMP 内置 `task` 代理的同一份工作者提示词为基础，再加上 OmO 的分类指导。

| 代理 | 适用于 | 默认模型角色 | 思考强度 |
| --- | --- | --- | --- |
| `deep-low` | 单一交付物，常规决策可以从证据推出；遇到重大的未决选择时，以 `ESCALATE: deep-high` 交还给父代理 | `@task` | `medium` |
| `deep-high` | 升级后的推理与实现，前提是重大选择已获授权；否则返回选项和建议 | `@slow` | `xhigh` |
| `ultrabrain` | 目标明确的复杂逻辑与架构推理 | `@slow` | `max` |
| `architect` | 只读的系统设计比较与建议 | `@slow` | `max` |
| `visual-engineering` | UI/UX、样式、动画、前端和设计系统 | `@designer`，然后 `@task` | `xhigh` |
| `artistry` | 有创意、不走寻常路的问题求解 | `@task` | `xhigh` |
| `writing` | 文档、文章和技术写作 | `@writer`，然后 `@task` | `low` |
| `librarian` | 只读的开源调研，附 GitHub 永久链接和官方文档 | `@tiny`，然后 `@smol` | `off` |

工作者遇到你尚未批准的取舍时，会交还给父代理，不会自行拍板，也不会直接问你。

原版分类说明见 OmO 文档：[Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories)。

### 代理选择规程

每轮开始前，插件会在主代理的系统提示词末尾追加一段简短的代理选择规程，改编自 OmO 的分类选择规程。只有当 `task` 工具处于启用状态、且其代理列表中至少有一个 omo-toolkit 代理时才会追加，并且只提及列表中出现的 omo-toolkit 代理。它告诉主代理：

- 每个列出的代理负责哪类工作；拿不准时选 `deep-low`；相互独立的目标拆成并行的 `task` 条目；
- 子代理结果首行为 `ESCALATE: deep-high` 时：若你已记录过相应决定就照此执行，否则把同一目标重新派给 `deep-high`（未列出 `deep-high` 时则询问你），并保持任务的 `name` 不变；
- `deep-high` 返回 `ESCALATE: parent` 时询问你。

点名某个代理的显式工作流指令（例如已批准的计划或审计循环）优先于该规程。若要关闭它，请禁用你不想提供的 omo-toolkit 代理，或卸载本插件。

### 技能

| 技能 | 适用于 |
| --- | --- |
| `git-master` | 已授权的提交、rebase、历史改写和历史调查；已批准的提交节奏不需要再次确认 |
| `review-work` | 实现后的真实界面 QA，外加一次独立的关口评审 |
| `remove-ai-slops` | 在不改变行为的前提下清理最近的改动 |
| `refactor` | 以契约为依据、规模与改动相称的重构和简化 |
| `debugging` | 基于证据的诊断，在真实界面上做修复前后的检查 |
| `frontend` | Web UI、UX、样式、布局、动画、无障碍、SEO 和前端性能 |
| `visual-qa` | 检查渲染后的网页、终端输出和分页文档 |
| `init-deep` | 生成或刷新分层的 `AGENTS.md` 文件；支持 `--create-new` 和 `--max-depth=N` |

用 `/skill:<name>` 运行技能，模型则通过 `skill://<name>` 读取。部分技能会用 `node`、`bun`、`python3` 或 `uv` 运行辅助脚本，具体见各技能的说明。

原版技能说明见 OmO 文档：[Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets)。

### MCP 服务器

`.mcp.json` 注册了两个 HTTP MCP 服务器，分别以 `omo-toolkit:context7` 和 `omo-toolkit:grep_app` 的名字出现：

- `context7`（`https://mcp.context7.com/mcp`）用于查询库文档。设置 `CONTEXT7_API_KEY` 可使用带密钥的访问；不设置则匿名访问。
- `grep_app`（`https://mcp.grep.app`）用于匿名搜索公开代码。

OMP 启动时会连接这两个服务器。不需要的话，可以在 OMP 的 MCP 设置中禁用。

原版服务器说明见 OmO 文档：[Built-in MCPs](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-mcps)。

## 设置

插件本身没有设置项。代理使用的模型来自你的 OMP `modelRoles`，角色列表按顺序尝试。插件会把 `designer` 和 `writer` 加进 `/models`，但不为它们指定模型；在你指定之前，相关代理使用 `@task`。如果你为这两个角色配置了 `modelTags`，它会覆盖插件提供的标签。

如果只想改某一个代理的模型而不修改插件文件，可以在 `~/.omp/agent/config.yml` 中设置 `task.agentModelOverrides`：

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

OmO 如何为代理和分类匹配模型，见其 [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md)。OmO 在 `omo.json` 中配置模型；在 OMP 中请使用上面的模型角色和覆盖设置。

## 与其他插件配合

- 安装了本插件时，`omo-prometheus` 和 `omo-ultrawork` 会使用这些代理，否则回退到 `task`；`librarian` 依次回退到 `scout`、`task`。
- 在 `omo-prometheus` 中，最终的代码质量、真实界面 QA 和证据关口由全新的 `deep-high` 或 `deep-low` 子代理执行（回退为 `task`）。

## 不使用终端界面时

代理、技能和 MCP 服务器在 OMP 的所有模式下行为相同。

## 已知限制

- `librarian` 需要能调用工具的聊天模型。它使用 `@tiny`，未设置 `tiny` 时回退到 `@smol`。如果 `tiny` 指向本地的 `local/` 标题生成模型，请把 `librarian` 覆盖为 `@smol`。

## 许可证

原创的打包部分采用 MIT 许可证。移植的代理、技能和代理选择规程（`src/selection-protocol.ts`）是 OmO 修订版 `fe427efeed97e95f009dc6ca7fb17a3ac857f79f` 的衍生作品，适用 Sustainable Use License 1.0。前端设计参考资料在 `skills/frontend/` 中保留了 Apache License 2.0 署名。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
