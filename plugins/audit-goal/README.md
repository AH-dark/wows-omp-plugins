<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-dark.png">
  <img alt="audit-goal" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-light.png">
</picture>

# audit-goal

English | [简体中文](README.zh.md)

> CodeRabbit-style review that lives in OMP, fixes what it finds, and keeps looping until the audit converges.

`/audit <target>` starts an OMP goal that audits and fixes the code in rounds. Each round, read-only auditor subagents look for problems, the main agent checks their findings against the source, and fixer subagents repair the confirmed ones. Every round goes into a ledger, and the goal ends only when the agent records a conclusion or you stop it.

## Install

```bash
omp plugin install audit-goal@wows-omp-plugins
```

Requires OMP 18.10.4 or newer with goal mode enabled (`goal.enabled`, on by default). Restart the session after installing.

## Quick start

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

The target is free text: a plan, a branch, a feature, anything you want checked. The footer shows progress, for example `Audit 2/5 · standard`. Use `/goal` to pause, resume or inspect the audit, and `/goal drop` to stop it.

## Usage

### A round

1. The agent splits the codebase into audit domains (server, worker, database, …) and sends a read-only `audit-auditor` into each.
2. It checks every reported finding against the source and rejects the false ones.
3. It sends `audit-fixer` subagents to fix the rest, in lanes that never share files.
4. It runs the project's full checks, confirms a clean tree and records the round.

Findings are graded Critical, Major, Minor or Picky. Each ledger round lists the auditor models, coverage, checks run, verified findings with source evidence, repairs of earlier findings and reasons for rejected claims. Severity counts cover new findings; findings still open are listed separately.

### Intensity

|  | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| Auditors report | visible problems: wrong behavior under normal use, failing checks, clear plan deviations | findings with a credible production trigger, across the full end-to-end chain | also toolchain, dependency and host boundaries, and rare latent bugs with a concrete trigger |
| Fixed | Critical, Major | Critical, Major, Minor | every level |
| Converges after | one round with no Critical or Major | two consecutive rounds with no Critical or Major | two consecutive rounds with no Critical, Major or Minor |

### How an audit ends

The agent cannot complete the goal until it has recorded one of three conclusions:

- `threshold-convergence`: the intensity's exit condition was met. The audit stopped finding problems, which does not prove the code is bug free. Earlier Critical or Major findings stay open until a recorded repair closes them.
- `capability-saturation`: with unlimited rounds, the same auditor models completed at least three comparable rounds across different audit angles, and the agent cites observations showing another round is unlikely to find more. Open Critical and Major findings stay open. Finding counts alone do not justify saturation.
- `stop`: a finite round limit ran out before convergence. The agent says so and asks whether to add rounds, remove the limit or stop. Stopping records the reason and the remaining findings. Cancelling the question leaves the choice pending.

None of these accepts the audited work; whether to accept it is your decision.

Fixes sometimes add new mechanisms that the next round then has to audit, which keeps the loop going. The plugin records the git `HEAD` when the audit starts and tracks such loop-induced findings separately, and the agent is told to simplify or revert what it added.

`/goal budget` limits tokens, not rounds. Use `maxRounds` to cap rounds.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-audit-goal`.

```bash
omp plugin config list wows-omp-plugin-audit-goal
omp plugin config set wows-omp-plugin-audit-goal intensity strict
omp plugin config set wows-omp-plugin-audit-goal maxRounds 5
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | Audit depth, which severities get fixed, and when the audit may converge. |
| `maxRounds` | number or empty | empty | Round limit per `/audit`. Empty means unlimited. |
| `maxParallelLanes` | number or empty | empty | Audit and fix subagents running at once. Empty means no plugin limit. |

`maxParallelLanes` is also capped by OMP's `task.maxConcurrency`: a setting of 10 with a host limit of 3 runs three lanes.

## Working with other plugins

`judge-dispatch` never reroutes `audit-auditor` or `audit-fixer`, and never routes other requests to them.

## Without the terminal UI

`/audit <target>` starts the same audit in RPC, ACP editors, the SDK and headless runs. What differs is who starts each next turn:

- The TUI continues the loop unattended by default.
- RPC continues it only when OMP's `goal.continuationModes` setting includes `"rpc"`, for example `["interactive", "rpc"]`. The default is `["interactive"]`, which leaves RPC to the client.
- In ACP, the SDK and print mode, the client drives every turn.

Other differences:

- RPC shows the round status line; ACP ignores it.
- At a round limit, RPC and ACP clients get the add/remove/stop choice as a select dialog. Without a UI, the audit records a noninteractive stop.
- Without a UI, usage errors and refusals appear as visible session messages.

Client programs can read the audit's progress from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- `audit-auditor` and `audit-fixer` appear in every session's `task` agent list, because OMP cannot hide plugin agents. The plugin refuses to dispatch them outside a running `/audit`.
- `/audit` does not start in Plan Mode or vibe mode, while another goal is unfinished, or while an audit is already running.
- If the latest ledger entry is malformed, the audit cannot continue or complete. Run `/goal drop` and start a new audit.
- The audit follows the audited project's own commit conventions and rules from its context files.

## Reference

[REFERENCE.md](REFERENCE.md) covers the state snapshot schema and how the plugin drives the loop.

## License

MIT.
