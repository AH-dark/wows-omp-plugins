<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banners/root-dark.png">
  <img alt="wows-omp-plugins" src=".github/banners/root-light.png">
</picture>

# wows-omp-plugins

English | [简体中文](README.zh.md)

A personal marketplace of [omp](https://omp.sh) plugins. Several of them port workflows from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO).

## Plugins

| Plugin | Description |
| --- | --- |
| [`adr`](plugins/adr/README.md) | Architecture decision records in MADR format, managed through agent tools and `/adr` |
| [`audit-goal`](plugins/audit-goal/README.md) | `/audit`: repeated independent audit and fix rounds, recorded in a ledger |
| [`judge-dispatch`](plugins/judge-dispatch/README.md) | OMP's judge role picks the subagent type for `task` calls and rates their difficulty, which can step thinking or select your model tiers |
| [`omo-prometheus`](plugins/omo-prometheus/README.md) | OmO's Prometheus planning and Atlas plan execution |
| [`omo-toolkit`](plugins/omo-toolkit/README.md) | OmO's category and research agents, workflow skills and documentation MCP servers |
| [`omo-ultrawork`](plugins/omo-ultrawork/README.md) | OmO's ultrawork mode, `mass-ulw`, `/hyperplan` and `/ulw-research` |
| [`omp-herdr-dag`](plugins/omp-herdr-dag/README.md) | Live todo, plan, Atlas and subagent graph in a Herdr side pane |
| [`roadmap`](plugins/roadmap/README.md) | Project rounds, stages and TODOs managed through agent tools, with stage-linked ADRs through the adr plugin |

Each plugin installs on its own, except that roadmap requires the adr plugin.

## Install

You need OMP 18.10.4 or newer. Add the marketplace once, then install plugins by name:

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

Inside an OMP session, `/marketplace add`, `/marketplace discover` and `/marketplace install` do the same. `omp plugin discover wows-omp-plugins` lists every plugin.

Plugins install for your user. Add `--scope project` to install one only for the current project.

After installing, `/reload-plugins` loads new skills and slash commands. New tools, hooks and extensions need a session restart.

## Update

```bash
omp plugin marketplace update wows-omp-plugins
omp plugin upgrade <name>@wows-omp-plugins
```

## Without the terminal UI

The plugins also run in `omp --mode rpc`, `rpc-ui`, ACP editors, the SDK and headless runs. Terminal-only screens fall back to plain dialogs, and every interactive action has a command form. Each README has a short section on this.

Plugins with workflow state also publish it as a JSON snapshot; see [REFERENCE.md](REFERENCE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code and content written for this repository are MIT unless a plugin says otherwise. The three `omo-*` plugins include modified OmO prompt assets under the Sustainable Use License 1.0; each plugin's README and license files give the details.
