# judge-dispatch

English | [简体中文](README.zh.md)

> Intelligent model routing: a judge model picks the right agent, thinking effort and model for every subagent OMP spawns.

Lets OMP's `judge` model role decide how `task` calls spawn subagents. By default it can replace the agent type the parent asked for. Optionally it also sets each child's thinking effort and picks its model from every model configured for that agent. OMP still validates every spawn, and anything the judge is unsure about stays as requested.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Requires OMP 18.5.1 or newer. Automatic routing needs a native judgment model behind the `judge` role (see [Quick start](#quick-start)); explicit per-task model binding does not. Restart the session after installing.

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

### Explicit model role or model for one task

To use a different model role without creating a new agent type, ask the parent agent to call `judge_dispatch_model`, wait for its successful result, then dispatch a named `task` in the next tool round:

```text
judge_dispatch_model({"name":"ReviewLogic","role":"abliterated"})
task({"name":"ReviewLogic","agent":"deep-low","task":"Review the logic"})
```

The role must exist in OMP's `modelRoles`. Alternatively, use `{"name":"ReviewLogic","model":"provider/model:thinking"}` for a concrete model. Supply exactly one of `role` and `model`. The binding is session-local, matches one exact task name (without dots), and is claimed by the next matching dispatch, then consumed at spawn. In a batch, bound names must be unique. The agent type remains eligible for normal routing; `judgeEffort` still applies. Explicit binding bypasses only judge **model selection** and replaces the original agent's model pool with the selected role's primary model and configured fallback selectors. It works even when the `judge` role is unavailable. Pending bindings survive switching away and back within the process, but cannot be used on a conversation branch that does not contain their binding call; bind again on that branch.

Use `judge_dispatch_model({"op":"clear","name":"ReviewLogic"})` to remove an unused binding. A task call that ends without spawning or leaving a background job returns its binding for retry. Clearing never changes a task already dispatched with an explicit model. An unbound retry is refused while an earlier bound dispatch has not started; if the background task failed or was cancelled, bind the name again before retrying. To prevent queued tasks or reused names from taking the wrong binding, the plugin gives each bound dispatch a unique name such as `ReviewLogic_jd0123456789ab`; use the actual child ID returned by OMP for later interaction.

Task `effort`, including a judge-routed effort, takes precedence over a model selector's thinking suffix under OMP's normal rules. Binding `provider/model:high` does not force high thinking if the task uses `effort: "lo"`.

The plugin rejects unknown roles, unresolved models, conflicting bindings, ambiguous names and workflow-owned tasks rather than silently using the agent's original model. During an approved Prometheus plan, explicit binding is unavailable. This is a model-list override, not an OMP role-identity change: a concrete model without its own fallback chain may still inherit the original agent's runtime retry chain. When a role has an empty chain but the original role has fallbacks, the spawn is refused rather than borrowing that chain. OMP can still apply its own auth fallback or higher-priority retry rules. See [the reference](REFERENCE.md#from-explicit-binding-to-spawn).

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
- OMP folds consecutive status lines into one, so several `task` calls in one turn may show only the last line.
- Model selection needs scores and prices from OMP's model registry; a primary model without a score keeps its configured model.

## Reference

[REFERENCE.md](REFERENCE.md) covers how the model pool is built, the `weighted` formula, how decisions reach the spawn, timeouts and compatibility with older settings.

## License

MIT.
