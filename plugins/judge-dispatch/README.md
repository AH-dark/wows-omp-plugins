# judge-dispatch

English | [简体中文](README.zh.md)

> Intelligent model routing: a judge model picks the right agent, thinking effort and model for every subagent OMP spawns.

Lets OMP's `judge` model role decide how `task` calls spawn subagents. By default it can replace the agent type the parent asked for. Optionally it also sets each child's thinking effort and picks its model from every model configured for that agent. OMP still validates every spawn, and anything the judge is unsure about stays as requested.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Requires OMP 18.5.1 or newer. Automatic routing needs a native judgment model behind the `judge` role (see [Quick start](#quick-start)); pinning one task's model does not. Restart the session after installing.

## Quick start

The plugin keeps no credentials and no model list of its own; it asks whatever model OMP's `judge` role resolves to. That model must be a native judgment model, one OMP serves through a judgment API such as TypeSafe or OpenRouter decisions, because `minimumConfidence` relies on the calibrated confidence those APIs return. TypeSafe's Jev is one such model; any other judgment model OMP supports for the `judge` role works the same way.

The quickest setup is a TypeSafe credential, which makes the `judge` role resolve to Jev by default (`providers.judgmentProvider: auto`):

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

To use a different judgment model, assign it to the `judge` role in your OMP configuration. If the role resolves to a chat model or an on-device model, or has no credential, the plugin keeps every requested agent and warns once per session.

Once it works, each routed `task` call prints a dim status line:

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92) · model openai/gpt-6.1 → anthropic/claude-opus (fit 0.71)
```

## Usage

### Agent routing

With `routeAgent` on (the default), the plugin may rewrite the `agent` field of ordinary `task` calls, single or batch. Candidates are the agents listed in the live `task` tool description, which OMP has already filtered by spawn policy and disabled agents. A read-only agent is only ever replaced by another read-only agent.

These calls are left exactly as they are, effort and model included:

- requests for `audit-*`, `metis`, `momus` or `oracle`; ordinary requests are never routed into these workflow roles either;
- requests for an agent the plugin cannot find in the list, since its access level is unknown;
- every `task` call while an `omo-prometheus` plan is executing, because the approved plan owns those choices.

Subagents started through `eval.agent()` or `workpool()` are never routed.

### Thinking effort

With `judgeEffort` on, the judge rates how open-ended the assignment is (`routine`, `standard` or `demanding`), and the plugin sets `effort` to `lo`, `med` or `hi`. OMP maps that to the lowest, middle or highest thinking level the child's model supports, capped at `task.maxEffort`. A rating below `minimumConfidence` leaves the parent's effort unchanged.

### Model selection

With `selectModel` on, the plugin picks each child's model from the agent's model pool: its `task.agentModelOverrides` entry or frontmatter `model` list, plus the fallback chains of the roles named there. The first entry is the primary model. Models without credentials, a score or a price are never chosen.

On OMP versions whose `task` tool exposes a `model` field, a model supplied there takes precedence; agent and effort routing still apply.

`modelBudget` sets how far below the primary the choice may go. Stronger models and the primary itself are always eligible.

| Budget | Routine | Standard | Demanding |
| --- | --- | --- | --- |
| `max` | at least the primary's score | same | same |
| `balanced` | at least 80% of the primary's score | at least 90% | at least the primary's score |
| `minimum` | any pool model | any | any |

A difficulty rating below `minimumConfidence` counts as demanding, so the budget never trades down on a guess.

`modelPick` decides among eligible models. `best` takes the highest fit × provider weight, so a low budget widens the choice without forcing a cheaper model. `weighted` draws one at random, favoring cheaper models more at lower budgets, which spreads work across the pool over many calls. `providerWeights` such as `openai=2` make a provider's models proportionally more likely to win, but never make an ineligible model eligible.

The chosen model goes to the front of the spawn's selectors and the rest of the pool becomes its retry chain.

### Pin a model role or model for one task

To run one subagent on another model role without creating a new agent type, tell the parent agent so, for example "run the review on the abliterated role". The plugin adds one line to the system prompt that teaches the parent to write the task item's agent as `<agent>@<role>`:

```text
task({"name":"ReviewLogic","agent":"deep-low@abliterated","task":"Review the logic"})
```

`<agent>@<provider>/<model>` pins one concrete model instead, such as `scout@provider/model:high`. The role must exist in OMP's `modelRoles`; a concrete model must resolve to an enabled model with credentials.

The plugin removes the pin before OMP runs the call, so the child runs as `deep-low` on the role's primary model, with that role's fallback chain (or the `default` chain when the role has none). A pin bypasses only judge **model selection**: agent routing and `judgeEffort` still apply, and pins work when the `judge` role is unavailable. Task `effort` still takes precedence over a selector's thinking suffix, as everywhere in OMP.

A pinned child gets a unique id such as `ReviewLogic_jd0123456789ab`, so no queued or later task that reuses the name can take its model. OMP shows and keeps the rewritten call, so the plugin also tells the parent agent which pins it applied; the task result returns the new id, and the parent should address the child by it.

A pin that cannot apply refuses the whole call and says why, rather than running on the agent's own model: an unknown role, a model that does not resolve, a workflow-owned agent such as `metis`, or any pin while an approved Prometheus plan executes. Without this plugin, OMP itself rejects `deep-low@abliterated` as an unknown agent. A pin replaces the model list, not OMP's role identity, so OMP's credential fallback and higher-priority retry rules still apply. A pin with no fallback chain of its own is refused at spawn if OMP would otherwise retry it on the agent's original role chain. See [the reference](REFERENCE.md#from-a-pinned-agent-to-spawn).

### What you see

While the judge runs, the working message reads `judge-dispatch: routing N tasks…`. Then each routed call prints the status line shown above, with the judge's confidence for every item. An item kept without a usable judgment names the reason: `judge unavailable`, `judge failed`, `timed out`, `no alternatives`, `no confident choice`, or `workflow-owned or unknown agent`. A call that could not be judged at all gets a line starting `kept the requested agent:`.

The status line is for you only: OMP neither sends it to the model nor saves it, so it does not come back after `/resume`. Set `indicator` to `false` to hide it and the working message.

### What the judge sees

A judgment request contains the assignment, the optional shared context, the requested agent, short candidate descriptions with their model pools and, with `selectModel` on, each pool model's score and price. The conversation and system prompt are never sent.

### When judging fails

Anything short of a legal choice at or above `minimumConfidence` keeps the original agent, effort and model, and nothing is blocked. That includes a missing judge, low confidence, rejected credentials and network errors. Routing gives up after eight seconds.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-judge-dispatch`.

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch selectModel true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget minimum
omp plugin config set wows-omp-plugin-judge-dispatch providerWeights "openai=2,anthropic=1"
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `routeAgent` | boolean | `true` | Lets the judge replace the requested agent type. |
| `selectModel` | boolean | `false` | Picks each spawn's model from the agent's model pool. |
| `modelBudget` | `minimum` \| `balanced` \| `max` | `balanced` | Which pool models `selectModel` may use, relative to the primary. |
| `modelPick` | `best` \| `weighted` | `best` | The judge's best fit, or a weighted draw that favors cheaper models. |
| `providerWeights` | text | empty | `provider=weight` pairs separated by commas or newlines. Weights must be above 0; unlisted providers weigh 1. |
| `judgeEffort` | boolean | `false` | Lets the judge set each `task` call's thinking effort. |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Confidence needed to replace the agent or effort, or to trust the difficulty rating. |
| `includeSharedContext` | boolean | `true` | Sends the `task` call's shared `context` with the request. |
| `indicator` | boolean | `true` | Shows the working message and status line. Routing works the same either way. |

User settings merge with project overrides. They are read on every `task` call, so changes apply without a restart. An invalid value, such as a malformed `providerWeights` entry, makes the plugin keep every call as requested and log a warning.

## Working with other plugins

- `audit-goal`: its reserved `audit-*` agents are never routed.
- `omo-prometheus`: `metis`, `momus` and `oracle` are never routed, and nothing is routed while an approved plan executes. Routing resumes once Prometheus is idle or planning again.

## Without the terminal UI

Routing and model selection work the same in RPC, ACP editors, the SDK and headless runs. RPC clients receive the status as notification frames; ACP editors may only log them. Without a UI the indicators are skipped. The plugin has no dialogs or commands.

## Known limitations

- `eval.agent()` and `workpool()` children are not routed, because OMP's `before_subagent_spawn` hook can change a child's model but not its agent type.
- Only `task` items can pin a model: OMP checks the agent name of an `eval.agent()` or `workpool()` child before any plugin hook runs, so `scout@abliterated` fails there as an unknown agent.
- A pinned child's id carries a `_jd…` suffix instead of the name you gave it.
- OMP folds consecutive status lines into one, so several `task` calls in one turn may show only the last line.
- Model selection needs scores and prices from OMP's model registry; a primary model without a score keeps its configured model.

## Reference

[REFERENCE.md](REFERENCE.md) covers how the model pool is built, the `weighted` formula, how decisions reach the spawn, timeouts and compatibility with older settings.

## License

MIT.
