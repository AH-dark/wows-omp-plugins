<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banners/root-dark.png">
  <img alt="wows-omp-plugins" src=".github/banners/root-light.png">
</picture>

# wows-omp-plugins

[English](README.md) | 简体中文

一个个人维护的 [omp](https://omp.sh) 插件市场。其中几个插件移植自 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的工作流。

## 插件

| 插件 | 说明 |
| --- | --- |
| [`adr`](plugins/adr/README.zh.md) | 以 MADR 格式记录架构决策，通过代理工具和 `/adr` 管理 |
| [`audit-goal`](plugins/audit-goal/README.zh.md) | `/audit`：反复进行独立的审计与修复，每轮记入审计记录 |
| [`judge-dispatch`](plugins/judge-dispatch/README.zh.md) | 由 OMP 的 judge 角色为 `task` 调用选择子代理类型并评定难度，难度可调整思考级别或选用你配置的模型档位 |
| [`omo-prometheus`](plugins/omo-prometheus/README.zh.md) | OmO 的 Prometheus 规划与 Atlas 计划执行 |
| [`omo-toolkit`](plugins/omo-toolkit/README.zh.md) | OmO 的分类与调研代理、工作流技能和文档类 MCP 服务器 |
| [`omo-ultrawork`](plugins/omo-ultrawork/README.zh.md) | OmO 的 Ultrawork 模式、`mass-ulw`、`/hyperplan` 和 `/ulw-research` |
| [`omp-herdr-dag`](plugins/omp-herdr-dag/README.zh.md) | 在 Herdr 侧边窗格中实时展示待办、计划、Atlas 和子代理的关系图 |
| [`roadmap`](plugins/roadmap/README.zh.md) | 通过代理工具管理项目的轮次、阶段和 TODO，并通过 adr 插件关联阶段的 ADR |

每个插件都可以单独安装，只是 roadmap 需要同时安装 adr 插件。

## 安装

需要 OMP 18.10.4 或更高版本。先添加一次插件市场，之后按名字安装插件：

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

在 OMP 会话里，可以用 `/marketplace add`、`/marketplace discover` 和 `/marketplace install` 完成同样的操作。`omp plugin discover wows-omp-plugins` 会列出全部插件。

插件默认安装到当前用户。加上 `--scope project` 则只安装到当前项目。

安装后运行 `/reload-plugins` 可以加载新的技能和斜杠命令。新的工具、钩子和扩展要重启会话才会生效。

## 更新

```bash
omp plugin marketplace update wows-omp-plugins
omp plugin upgrade <name>@wows-omp-plugins
```

## 不使用终端界面时

这些插件也能在 `omp --mode rpc`、`rpc-ui`、ACP 编辑器、SDK 和 headless 模式下运行。终端专用的界面会改用普通对话框，所有交互操作也都有对应的命令写法。各插件 README 里都有一小节专门说明。

带工作流状态的插件还会把状态发布成 JSON 快照，详见 [REFERENCE.zh.md](REFERENCE.zh.md)。

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

除非插件另有说明，为本仓库编写的代码和内容均采用 MIT 许可证。三个 `omo-*` 插件包含经过修改的 OmO 提示词资源，适用 Sustainable Use License 1.0；详见各插件的 README 和许可证文件。
