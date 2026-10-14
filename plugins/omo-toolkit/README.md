# omo-toolkit

English | [简体中文](README.zh.md)

Category agents, a research agent, workflow skills and two documentation MCP servers, adapted from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) for OMP. Once installed, the agents show up in the `task` tool's agent list and the skills under `/skill:`.

## Install

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Restart the session after installing.

## Quick start

The main agent picks these agents on its own when they fit. You can also name one, for example "have `ultrabrain` work out the locking scheme", or run a skill directly:

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

To give the design and writing agents their own models, assign the `designer` and `writer` roles in `/models`.

## Usage

### Agents

Category agents start from the same worker prompt as OMP's bundled `task` agent and add OmO's category guidance.

| Agent | Use for | Default model role | Thinking |
| --- | --- | --- | --- |
| `deep-low` | One deliverable whose routine decisions follow from evidence; hands consequential open choices back to its parent as `ESCALATE: deep-high` | `@task` | `medium` |
| `deep-high` | Escalated reasoning and implementation once a material choice is authorized; otherwise returns options and a recommendation | `@slow` | `xhigh` |
| `ultrabrain` | Hard logic and architecture reasoning with clear goals | `@slow` | `max` |
| `architect` | Read-only system design comparison and recommendation | `@slow` | `max` |
| `visual-engineering` | UI/UX, styling, animation, frontend and design-system work | `@designer`, then `@task` | `xhigh` |
| `artistry` | Creative, unconventional problem solving | `@task` | `xhigh` |
| `writing` | Documentation, prose and technical writing | `@writer`, then `@task` | `low` |
| `librarian` | Read-only open-source research with GitHub permalinks and official docs | `@tiny`, then `@smol` | `off` |

Workers pass trade-offs you have not approved back to their parent instead of settling them or asking you directly.

OmO documents the original categories in [Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories).

### Skills

| Skill | Use for |
| --- | --- |
| `git-master` | Authorized commits, rebases, history rewrites and history investigation; an approved commit cadence needs no second confirmation |
| `review-work` | Real-surface QA after implementation, plus one independent gate review |
| `remove-ai-slops` | Cleaning up recent changes without changing behavior |
| `refactor` | Refactors and simplification traced to their contracts and sized to the change |
| `debugging` | Diagnosis from evidence, with before/after checks on the real surface |
| `frontend` | Web UI, UX, styling, layout, animation, accessibility, SEO and frontend performance |
| `visual-qa` | Checking rendered web pages, terminal output and paginated documents |
| `init-deep` | Generating or refreshing hierarchical `AGENTS.md` files; supports `--create-new` and `--max-depth=N` |

Run a skill with `/skill:<name>`; models read it through `skill://<name>`. Some skills run helper scripts with `node`, `bun`, `python3` or `uv`, as each skill documents.

OmO documents the original skills in [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets).

### MCP servers

`.mcp.json` registers two HTTP MCP servers, exposed as `omo-toolkit:context7` and `omo-toolkit:grep_app`:

- `context7` (`https://mcp.context7.com/mcp`) for library documentation. Set `CONTEXT7_API_KEY` for keyed access; without it, access is anonymous.
- `grep_app` (`https://mcp.grep.app`) for anonymous public code search.

OMP connects both at startup. Disable either in OMP's MCP settings if you do not want it.

OmO documents the original servers in [Built-in MCPs](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-mcps).

## Settings

The plugin has no settings of its own. Agent models come from your OMP `modelRoles`, and a role list is tried in order. The plugin adds `designer` and `writer` to `/models` without assigning a model; until you assign one, those agents use `@task`. A `modelTags` entry you configured for either role takes precedence over the plugin's label.

To change one agent's model without editing plugin files, set `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

For how OmO matches models to agents and categories, see its [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md). OmO configures models in `omo.json`; in OMP, use the model roles and overrides above.

## Working with other plugins

- `omo-prometheus` and `omo-ultrawork` use these agents when they are installed and fall back to `task` otherwise; `librarian` falls back to `scout`, then `task`.
- Under `omo-prometheus`, the final code-quality, real-surface QA and evidence gates run on fresh `deep-high` or `deep-low` children (fallback `task`).

## Without the terminal UI

Agents, skills and MCP servers work the same in every OMP mode.

## Known limitations

- `librarian` needs a chat model that can call tools. It uses `@tiny`, falling back to `@smol` when `tiny` is unset. If `tiny` points at an on-device `local/` title model, override `librarian` to `@smol`.

## License

Original packaging is MIT. The ported agents and skills are Sustainable Use License 1.0 derivatives of OmO revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. The frontend design references keep their Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
