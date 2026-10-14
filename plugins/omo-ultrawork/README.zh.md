# omo-ultrawork

[English](README.md) | 简体中文

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 ultrawork 工作流在 OMP 上的移植。在消息里输入 `ulw`，代理就会切换到以结果为先的执行方式：把请求端到端做完，并用在真实界面上观察到的证据支撑每一条成功标准。插件还提供按依赖顺序分发任务的 `mass-ulw`、对抗式规划 `/hyperplan`，以及生成带引用调研报告的 `/ulw-research`。

## 安装

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。`/ulw-research` 还需要 `PATH` 中有 `node` 才能生成报告。安装后重启会话。

## 快速上手

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-research compare SQLite WAL and rollback journal for our workload
```

进入 ultrawork 模式后，第一条回复以 `ULTRAWORK MODE ENABLED!` 开头，页脚显示 `Ultrawork armed` 或 `Ultrawork mode`。

## 用法

### Ultrawork 模式

把 `ulw` 或 `ultrawork` 作为独立的词输入，插件会在你的消息前注入隐藏的 ultrawork 指令。同一会话里之后再触发，只会追加一段简短提醒，因为指令仍在上下文中；压缩之后，下一次触发会重新注入完整指令。行内代码、代码块和斜杠命令里的关键词不算数。

会话忙碌时，隐藏指令或提醒会以 aside 发送，并明确说明从你的下一条／排队消息开始生效，而不适用于当前正在进行的工作。触发后，首次成功的 todo `init` 或 `append` 会通过工具结果的可信上下文附带一次分发提醒；压缩后会重新启用该提醒。

`/ultrawork` 或 `/ulw` 会开启持续模式，此后每条消息都无需关键词即进入 ultrawork。再次运行任一命令即可关闭。`/ultrawork <request>` 会开启模式，并把请求作为你的下一条消息发出。

持续模式开启时，页脚显示 `Ultrawork mode`；由关键词触发后显示 `Ultrawork armed`。模式和触发状态保存在会话中，恢复、切换、分支和树导航时都会还原。

原版说明见 OmO 文档：[Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy)。

### 不要与 `orchestrate` 混用

OMP 内置的 `orchestrate` 关键词会注入它自己的规则，在提交、验证和委派方面与 ultrawork 相互矛盾。当消息里出现 OMP 会响应的 `orchestrate` 时，本插件不会为这条消息注入任何内容，并显示警告；持续模式从下一条消息起恢复。`/ultrawork orchestrate …` 会拒绝开启持续模式。如果你经常使用 ultrawork，建议关闭内置关键词：

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` 是一个技能，通过 `eval` 运行由子代理任务（`{ id, prompt, agent, dependsOn?, label? }`）组成的依赖图。启动任何任务前，它会先校验 id、依赖关系和环；每次运行一批已就绪的节点，读完它们的报告再启动下一批。最后还有一步验证来检查证据，因为子代理跑完并不等于工作已被接受。状态和报告在内核重置后仍会保留。

输入 `mass ulw`、`mass-ulw`、`ulw-mass`、`mulw` 或 `meth` 会把代理引向这个技能；其中 `mulw` 和 `meth` 本身不会触发 ultrawork。没有依赖关系的独立工作，用一次普通的 `task` 批量调用更简单。

原版说明见 OmO 文档：[Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw)。

### /hyperplan

`/hyperplan <request>` 让五个评审角色进行三轮对抗式辩论，每个角色只从一个角度挑战草案：多余的复杂度与范围膨胀、集成缺口与边界情况、未经验证的假设、架构缺陷，以及被忽略的替代方案。随后由独立的规划者把辩论结果写成计划。第一行输出为 `HYPERPLAN MODE ENABLED!`。

原版说明见 OmO 文档：[Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan)。

### /ulw-research

`/ulw-research <request>` 通过扩展检索和反向检索构建论断图，写出带引用的综述，按顺序运行 QA 关口，并检查最终交付物。临时文件写到 `<tmpdir>/ulw-research/` 或 `researchScratchDir`；最终报告放在你指定的位置。第一行输出为 `ULW-RESEARCH MODE ENABLED!`。

原版说明见 OmO 文档 [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets) 中的 `ulw-research`。

这两个命令都会拒绝空请求，并且只能在主会话中运行。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-ultrawork`。

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | 为 false 时，输入关键词不会触发 ultrawork。`mass-ulw` 引导和各命令仍然可用。 |
| `keywords` | 逗号分隔的字符串 | `ulw,ultrawork` | 不区分大小写的整词触发词。设为空字符串则关闭关键词触发。 |
| `researchScratchDir` | 字符串 | 空（`<tmpdir>/ulw-research`） | 调研临时文件的根目录。相对路径相对于会话的工作目录解析。 |

设置在会话启动和切换会话时读取，修改后请重启会话。

## 与其他插件配合

- 安装了 `omo-toolkit` 时，`/hyperplan` 和 `/ulw-research` 会使用它的分类代理（`deep-low`、`ultrabrain`、`artistry`、`librarian`、`writing`）；没有安装时回退到 `task` 和 `scout`，所有命令照常可用。
- 安装了 `omo-prometheus` 时，如果已有经 `/prometheus` 批准的计划，ultrawork 会以该计划为准，不再另写计划。

## 不使用终端界面时

关键词和所有命令都可以在 RPC、ACP 编辑器、SDK 和 headless 模式下使用，都不需要对话框。没有 UI 时，用法错误和模式变化会以可见的会话消息显示。

客户端程序可以从状态快照读取当前模式，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- 扩展生成的消息和子会话中的关键词会被忽略。
- `/hyperplan` 和 `/ulw-research` 的流程是私有提示词，不是技能，所以你和模型都无法通过 `skill://` 或 `/skill:` 打开它们。`mass-ulw` 是本插件唯一公开的技能。
- 升级插件会删除正在运行的会话所加载的那份安装副本，所以在重启 OMP 之前，`/ulw-research` 会提示其脚本已不存在。其他提示词在插件加载时就已读入，不受影响。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍关键词与指令投递规则、各命令使用的代理、`mass-ulw` 的持久化方式以及状态快照。

## 许可证

扩展代码和原创打包部分采用 MIT 许可证。修改后的提示词资源和随附的调研脚本采用 SUL-1.0。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
