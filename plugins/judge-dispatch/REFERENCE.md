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

A rewrite changes only `agent` when `routeAgent` is on, `effort` when `judgeEffort` is on, and `name` when a model switch needs one.

On OMP versions exposing the `task.model` field, the plugin leaves that selector pinned and skips model judging for the item; newer OMP versions no longer expose that field.

## From explicit binding to spawn

`judge_dispatch_model` validates a configured `role` or concrete `model` against scoped OMP settings and enabled models, then keeps the requested task name in the current session only. Bind alone, wait for success, and dispatch in a later tool round; same-round binding and dispatch are refused in either order. The next ordinary `task` call with that exact name claims the binding before judge routing and rewrites its name to a unique `<name>_jd<12 hex>` spawn name. Model judgment is skipped for that item; agent and effort judgment remain independent. A plugin-instance registry correlates the unique spawn name with its model patterns even if a background task starts after a session switch. At `before_subagent_spawn`, the claim is consumed and the hook replaces the model patterns. Other tasks reusing the requested name cannot take it. A malformed or conflicting dispatch is blocked and leaves the binding available. Final task results restore unused claims to their original session; background results retain claims until spawn. Clearing removes only requested bindings, never dispatched claims. A cancelled background job that never spawns can retain a claim until the plugin instance is unloaded; bind again before retrying, with either the same requested name or a new name.

For a role, the submitted patterns are the expanded `modelRoles[role]` selectors followed by `retry.fallbackChains[role]`, or by the `default` chain if the role has no entry. For a concrete model, the submitted pattern is that model followed by the configured `default` chain. The plugin does not select one of those fallback models. If the target role's chain is empty and the agent's original role would supply a nonempty fallback chain, the hook blocks the spawn: OMP retains the original `modelRole` and would otherwise attach the wrong chain. This hook cannot change the saved role identity or fully override OMP's credential fallback and retry precedence; concrete model overrides without a default chain may inherit the original role's retry chain. A cold revival may use the original agent's role again. For durable full role semantics, the host needs a first-class role override.

## Timeouts and failure

Routing gives up after eight seconds and always finishes at least one second before the session's tool-call handler timeout. If no time is left, it skips routing. Requests, credentials and usage journaling go through OMP's `judge` role; the plugin stores no keys and does not touch the process environment.

## State

The plugin saves no routing state in the session and publishes no plugin-state snapshot. Pending judge model choices and explicit task-name bindings live only in the current process and are consumed at spawn; they are lost on restart. Older transcript records are still rendered and filtered.

## Older settings

Releases before 0.6 had only `modelBudget`, with an `off` value. A stored `modelBudget: off` still reads as `selectModel: false`, and any other stored budget turns `selectModel` on unless `selectModel` is set explicitly.
