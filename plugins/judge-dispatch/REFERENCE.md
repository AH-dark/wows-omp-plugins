# judge-dispatch reference

English | [简体中文](REFERENCE.zh.md)

## Agent discovery

Candidates come from the agent list in the live `task` tool description. If that list is missing, unreadable or empty, the plugin does not judge. The `task` tool revalidates any agent name the plugin writes. Read-only status comes from OMP's agent tool metadata.

The judge assesses difficulty even when only one agent type is eligible. OMP applies a judged effort whether or not `task.enableEffort` shows the field to the parent.

## The model pool

The pool flattens everything the agent may run on, in order:

1. the agent's model selectors: its `task.agentModelOverrides` entry, or else its frontmatter `model` list, with role aliases such as `@smol` expanded to the role's model;
2. the `retry.fallbackChains` entry of every role alias among those selectors;
3. for a single selector, the fallback chain OMP itself would give the child (its role's chain, or `default`).

Entries resolving to the same `provider/id` count once; the first one wins, including its thinking suffix. OMP's model registry resolves every entry, with prices from models.dev and intelligence scores from OMP's live model catalog. It maps custom and proxy provider ids to scored catalog entries, so the plugin keeps no model data of its own.

Your configuration decides what the primary model means: it can be your strongest model, a cheaper second choice, or a "good enough" model with stronger and weaker ones behind it. The budget only sets a lower bound relative to it.

## How a model is chosen

The judge receives the pool models with their scores and prices and returns how well each fits the assignment.

- `best` picks the eligible model with the highest fit × provider weight. When the judge gives no model answer, the primary stays.
- `weighted` draws one eligible model at random, weighted by fit × provider weight × cheapness. Cheapness ranks the eligible models by price, with the less capable model first on equal prices, and weighs rank `r` (0 = cheapest) as $1/(1+r)^k$:

| Budget | Routine `k` | Standard `k` | Demanding `k` |
| --- | --- | --- | --- |
| `max` | 0 | 0 | 0 |
| `balanced` | 1 | 0.5 | 0 |
| `minimum` | 2 | 1 | 0.5 |

With `k = 0`, price does not matter.

Price is the weighted average of input and output prices at a 3:1 ratio. `providerWeights` multiplies a model's weight by its provider's value.

## From decision to spawn

OMP's `before_subagent_spawn` event carries no assignment, so the plugin links the decision to the spawn through the task item's `name`. When the parent gave no name, the plugin writes one (`<agent>-<8 hex>`). If two pending calls share a name, or the host resolves a different primary model at spawn time, the spawn keeps its configured model. The model is chosen while the `task` call is judged and applied when the child spawns; any failure at that point keeps the configured model. OMP shows the routing note next to the child's resolved model.

A rewrite changes only `agent` when `routeAgent` is on or the item pins a model, `effort` when `judgeEffort` is on, and `name` when a model switch or pin needs one.

## From a pinned agent to spawn

The task schema has no per-item model field, and strict tool schemas keep a model from adding one, so the pin rides in the `agent` string: `<agent>@<role>` when the part after `@` has no `/`, otherwise `<agent>@<provider>/<model>`. At `tool_call`, before judging, the plugin validates every pin in the call against scoped OMP settings and enabled models. It then rewrites each pinned item's `agent` to the bare agent and its `name` to a unique `<name or agent>_jd<12 hex>` spawn name, keyed to the pin's model patterns. One invalid pin refuses the whole call, and an unpinned item whose name already has that `_jd` shape is refused, so such a spawn name always means a pin. Model judgment is skipped for pinned items; agent and effort judgment still run, and a routing failure afterwards still returns the pinned rewrite. OMP displays and persists the rewritten call, so the result also carries `additionalContext` telling the parent which item now runs under which spawn name and model; without it, a parent reading its own call would take the rewrite for a mistake and dispatch again. `before_subagent_spawn` finds the pin by that spawn name and replaces the model patterns. The registry belongs to the plugin instance, so a background job that starts after a session switch still finds its pin. A task call that settles without a background job drops its unused pins. Past 256 waiting pins the oldest are evicted; a spawn whose pinned name has no pin left is refused rather than started on the agent's own model.

For a role, the submitted patterns are the expanded `modelRoles[role]` selectors followed by `retry.fallbackChains[role]`, or by the `default` chain if the role has no entry. For a concrete model, they are that selector followed by the `default` chain. The plugin never picks among these fallbacks. OMP keeps the agent's original `modelRole` and retries a lone pattern on that role's chain (or `default`), so when a pin resolves to a single pattern while that inherited chain is nonempty, the spawn is refused instead of borrowing it. The hook cannot change the saved role identity or OMP's credential fallback, and a cold revival of a parked child may resolve the agent's own role again.

## Timeouts and failure

Routing gives up after eight seconds and always finishes at least one second before the session's tool-call handler timeout. If no time is left, it skips routing. Requests, credentials and usage journaling go through OMP's `judge` role; the plugin stores no keys and does not touch the process environment.

## State

The plugin saves no routing state in the session and publishes no plugin-state snapshot. Pending judge model choices and pins live only in the current process and are consumed at spawn; they are lost on restart. Older transcript records are still rendered and filtered.

## Older settings

Releases before 0.6 had only `modelBudget`, with an `off` value. A stored `modelBudget: off` still reads as `selectModel: false`, and any other stored budget turns `selectModel` on unless `selectModel` is set explicitly.
