# judge-dispatch

English | [简体中文](README.zh.md)

> Judge-classified subagent routing: a judge model picks the agent type for every subagent OMP spawns and rates how demanding its task is; your configuration decides what that rating changes.

Lets OMP's `judge` model role classify how `task` calls spawn subagents. By default it can replace the agent type the parent asked for. It can also rate each assignment `routine`, `standard` or `demanding`: with `judgeEffort` the rating moves the child's thinking level one step, and with `modelTiers` routine or demanding work runs on models you chose. The judge never picks a model; that mapping is yours. OMP still validates every spawn, and anything the judge is unsure about stays as requested.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Automatic routing needs a native judgment model behind the `judge` role (see [Quick start](#quick-start)); pinning one task's model does not. Restart the session after installing.

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
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · thinking medium → high (0.92) ; #3 ultrabrain kept (0.95) · model openai/gpt-6.1 → @slow (0.88)
```

## Usage

### Agent routing

With `routeAgent` on (the default), the plugin may rewrite the `agent` field of ordinary `task` calls, single or batch. Candidates are the agents listed in the live `task` tool description, which OMP has already filtered by spawn policy and disabled agents. A read-only agent is only ever replaced by another read-only agent.

These calls are left exactly as they are, thinking level and model included:

- requests for `audit-*`, `metis`, `momus` or `oracle`; ordinary requests are never routed into these workflow roles either;
- requests for an agent the plugin cannot find in the list, since its access level is unknown;
- every `task` call while an `omo-prometheus` plan is executing, because the approved plan owns those choices.

Subagents started through `eval.agent()` or `workpool()` are never routed.

### Difficulty

The judge rates how open-ended an assignment is, not how much work it involves: `routine` when the fix or steps are given, `standard` for ordinary work whose approach is mostly settled, `demanding` when causes or designs remain open. An item's `solutionSpace`, the caller's own description of how open the problem is, is part of what it reads.

The plugin asks for a rating only when the answer can change something: `judgeEffort` is on and the item sets no `effort`, or a tier is configured for the agent the item finally runs as. A rating below `minimumConfidence` counts as `standard`, which changes nothing.

### Thinking level

With `judgeEffort` on, a routine rating moves the child's thinking level one supported level down and a demanding rating one level up, starting from the level the child would run at anyway: the `:level` suffix of the agent's model selector, or else the agent's own `thinkingLevel`.

- Without a starting level, or when it is `auto`, `inherit` or `off`, nothing changes.
- The step stays within the levels the model supports, so it never reaches `off`; at either end it does nothing.
- A step up never passes `task.maxEffort`.
- An item that sets `effort` itself keeps it.

The plugin never writes the task's `effort`, which would override every configured level. The new level goes on the spawn's model selector instead (see [the reference](REFERENCE.md#thinking-steps)).

### Model tiers

`modelTiers` names the models routine and demanding work runs on:

```text
routine=@smol,demanding=@slow,ultrabrain.demanding=openai/gpt-6.1:xhigh
```

Each comma-separated entry is `[<agent>.]<routine|demanding>=<selector>`, where the selector is a model role `@<role>` or one model `provider/model[:level]`. An agent's own entry beats the entry for every agent. Standard work always runs on the agent's own model.

When a confident rating has a tier, the child spawns on the tier's model with that tier's fallback chain: the role's `retry.fallbackChains` entry, or the `default` chain. The thinking step then does not apply; the tier selector's own `:level`, or else the agent's `thinkingLevel`, does. A tier that resolves to the agent's own model at the same thinking level changes nothing; one that names the agent's model at another level applies that level. A tier that cannot apply, such as an unknown role or a model without credentials, keeps the agent's model, and the status line says why; it never blocks the call.

### Retrying and escalating

The plugin tells the parent agent to retry or escalate a task by dispatching it again under the same `name`. It then raises that one dispatch:

- After a child's final output starts with the line `ESCALATE: deep-high`, the next dispatch under its name counts as `demanding`.
- After a child fails on a route the plugin lowered (a routine tier or a step down), the next dispatch counts one difficulty higher, which is `standard`: the agent's own model and level.

The raised dispatch keeps the agent the parent asked for and is not judged. Each record serves one dispatch and lives in memory for the session. The status line shows `escalated to demanding after ESCALATE: deep-high` or `raised to standard after a failed lowered run`.

### Pin a model role or model for one task

To run one subagent on another model role without creating a new agent type, tell the parent agent so, for example "run the review on the abliterated role". The plugin adds a short guidance to the system prompt that teaches the parent to write the task item's agent as `<agent>@<role>`:

```text
task({"name":"ReviewLogic","agent":"deep-low@abliterated","task":"Review the logic"})
```

`<agent>@<provider>/<model>` pins one concrete model instead, such as `scout@provider/model:high`. The role must exist in OMP's `modelRoles`; a concrete model must resolve to an enabled model with credentials.

The plugin removes the pin before OMP runs the call, so the child runs as `deep-low` on the role's primary model, with that role's fallback chain (or the `default` chain when the role has none). A pinned item gets no tier and no thinking step; agent routing still applies, and pins work when the `judge` role is unavailable. Task `effort` still takes precedence over a selector's thinking suffix, as everywhere in OMP.

A pinned child gets a unique id such as `ReviewLogic_jd0123456789ab`, so no queued or later task that reuses the name can take its model. OMP shows and keeps the rewritten call, so the plugin also tells the parent agent which pins it applied; the task result returns the new id, and the parent should address the child by it.

A pin that cannot apply refuses the whole call and says why, rather than running on the agent's own model: an unknown role, a model that does not resolve, a workflow-owned agent such as `metis`, or any pin while an approved Prometheus plan executes. Without this plugin, OMP itself rejects `deep-low@abliterated` as an unknown agent. A pin replaces the model list, not OMP's role identity, so OMP's credential fallback and higher-priority retry rules still apply. A pin with no fallback chain of its own is refused at spawn if OMP would otherwise retry it on the agent's original role chain. See [the reference](REFERENCE.md#from-a-pinned-agent-to-spawn).

### What you see

While the judge runs, the working message reads `judge-dispatch: routing N tasks…`. Then each routed call prints the status line shown above, with the judge's confidence for every decision: the agent, `thinking <from> → <to>`, `model <agent's model> → <tier>` or why the agent's model stays, or the bare `difficulty` when it changed nothing. An item kept without a usable judgment names the reason: `judge unavailable`, `judge failed`, `timed out`, `no alternatives`, `no confident choice`, or `workflow-owned or unknown agent`. A call that could not be judged at all gets a line starting `kept the requested agent:`.

The status line is for you only: OMP neither sends it to the model nor saves it, so it does not come back after `/resume`. Set `indicator` to `false` to hide it and the working message.

### What the judge sees

A judgment request contains the assignment, the item's `solutionSpace`, the optional shared context, the requested agent, and short candidate descriptions with their source and read-only status. Models, prices, the conversation and the system prompt are never sent.

### When judging fails

Anything short of a legal choice at or above `minimumConfidence` keeps the original agent, thinking level and model, and nothing is blocked. That includes a missing judge, low confidence, rejected credentials and network errors. Routing gives up after eight seconds.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-judge-dispatch`.

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelTiers "routine=@smol,demanding=@slow"
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `routeAgent` | boolean | `true` | Lets the judge replace the requested agent type. |
| `judgeEffort` | boolean | `false` | Moves each spawn's thinking level one step by the judged difficulty. |
| `modelTiers` | text | empty | `[<agent>.]<routine\|demanding>=<@role or provider/model[:level]>` entries separated by commas. |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Confidence needed to replace the agent or to act on a difficulty rating. |
| `includeSharedContext` | boolean | `true` | Sends the `task` call's shared `context` with the request. |
| `indicator` | boolean | `true` | Shows the working message and status line. Routing works the same either way. |

User settings merge with project overrides. They are read on every `task` call, so changes apply without a restart. An invalid value, such as a malformed `modelTiers` entry, makes the plugin keep every call as requested and log a warning. Stored settings the plugin no longer has are ignored, with a warning once per session.

## Working with other plugins

- `audit-goal`: its reserved `audit-*` agents are never routed.
- `omo-prometheus`: `metis`, `momus` and `oracle` are never routed, and nothing is routed while an approved plan executes. Routing resumes once Prometheus is idle or planning again.
- `omo-toolkit`: its `deep-low` agent answers `ESCALATE: deep-high` when a consequential choice is open. Dispatched again under the same name, the task counts as demanding.

## Without the terminal UI

Routing, thinking steps and tiers work the same in RPC, ACP editors, the SDK and headless runs. RPC clients receive the status as notification frames; ACP editors may only log them. Without a UI the indicators are skipped. The plugin has no dialogs or commands.

## Known limitations

- `eval.agent()` and `workpool()` children are not routed, because OMP's `before_subagent_spawn` hook can change a child's model but not its agent type.
- Only `task` items can pin a model: OMP checks the agent name of an `eval.agent()` or `workpool()` child before any plugin hook runs, so `scout@abliterated` fails there as an unknown agent.
- A pinned child's id carries a `_jd…` suffix instead of the name you gave it.
- OMP folds consecutive status lines into one, so several `task` calls in one turn may show only the last line.
- Retry and escalation records are lost on restart, and only a dispatch under the same name finds them.
- Thinking steps need the supported thinking levels from OMP's model registry; a model without them keeps its level.

## Reference

[REFERENCE.md](REFERENCE.md) covers how tiers expand, the thinking step rules, the retry and escalation records, how decisions reach the spawn, and timeouts.

## License

MIT.
