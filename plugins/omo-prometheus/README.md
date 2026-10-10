# omo-prometheus

English | [简体中文](README.zh.md)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO)'s Prometheus planning and Atlas execution, ported to OMP. Prometheus interviews you until it can write a plan worth approving. After approval, Atlas executes that plan by delegating every task to subagents, records verified evidence for each one, and runs four independent verification gates before it calls the plan done.

The plugin builds on OMP's native Plan Mode and approval flow and adds:

- Metis, which checks intent and gaps before planning starts;
- Prometheus, which asks only questions that can change the plan;
- optional Momus and Oracle reviews that look for blocking problems in the plan; Oracle can also be consulted on architecture and high-risk decisions;
- Atlas, the executor.

## Install

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

Requires OMP 18.5.1 or newer, with Plan Mode enabled for planning (`plan.enabled`, on by default). Restart OMP after installing.

If you used the older `prometheus` plugin, uninstall it first with `omp plugin uninstall prometheus@wows-omp-plugins`. Its session state does not carry over, so start a new plan.

## Quick start

```text
/prometheus add rate limiting to the public API
```

1. Prometheus enters Plan Mode, consults Metis and asks its questions. Answer them until it proposes a plan.
2. Review the proposal and approve it through OMP's normal approval dialog. Either approval choice hands off to Atlas.
3. Atlas starts executing on its own. The widget above the editor shows progress; `/atlas` opens the full view.
4. When all tasks, the four final gates and any delivery task pass, the plan is complete. `/atlas exit` leaves Atlas at any time.

## Usage

### Planning

`/prometheus` enters Plan Mode, or upgrades a Plan Mode session that is already active. Describe the request inline or in your next message. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode.

In ordinary `/plan` mode, small and well-defined requests stay on OMP's normal path. For large, cross-cutting or ambiguous goals, the planner asks whether to switch to Prometheus. Accepting that question moves the session into the same workflow.

The plan is written as a `local://` session artifact and submitted through OMP's approval flow. With OMP plan autosave on, the approved copy is also saved under `.omp/plans/`.

`reviewLevel` (see [Settings](#settings)) controls whether Momus, or Momus and Oracle together, review the plan before it is proposed.

OmO documents the original as the [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner) (`/ulw-plan`) and [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute). This plugin keeps the `/prometheus` and `/atlas` commands and tracks those kernels; `NOTICE` records the pinned revision.

### Plan format

Every plan ends with two machine-readable sections. Tasks are checkbox rows numbered from `T1`, each with `Agent:`, `Depends on:`, `Tier:` and `Acceptance:` lines:

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Tier: LIGHT
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Tier: LIGHT
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Prometheus assigns each task the most specific agent your `task` tool offers, preferring `omo-toolkit` agents. If one is missing at execution time, Atlas tries its fallbacks, then the best fit from the live list, without asking you to re-approve.

A plan for a bound [roadmap](#working-with-other-plugins) stage also carries one plan-level line naming the stage's done criteria it delivers, such as `Roadmap criteria: DC1, DC3`. While the roadmap plugin reports the stage's criteria, Prometheus refuses, before you are asked to approve, a proposal whose line is missing, repeated, empty or names an id that is not a current criterion. Criteria a plan does not list stay open for another plan.

### Execution

After approval the main session becomes Atlas. Atlas does not edit files itself: the plugin blocks implementation tools (`bash`, `eval`, `edit`, file writes and so on) in the parent session, so every task goes to a child agent through `task`.

Atlas tracks the plan in a ledger. A task is done only with proof from its child's actual final result, never from a ticked box in the plan file. Tasks run in dependency order, and a dependency cycle is rejected before anything runs. A HEAVY task (security, migrations, public API, data-loss risk and similar) also needs a second, fresh child to verify it. A defect a child finds inside the change's reach becomes a discovered task (`D1`, `D2`, …) before the final gates. One outside it becomes a deferred finding (`O1`, `O2`, …) that Atlas triages: a Roadmap TODO it files, a duplicate, won't fix, or, when no roadmap is usable in the repository, report only. The final report lists every finding with its disposition for you to review, and Atlas cannot be released while one is untriaged. See the [reference](REFERENCE.md#ledger) for the contracts.

Atlas is nudged to continue unfinished work. If the ledger or plan files are missing, damaged or no longer match the approved plan, Atlas pauses until you restore them, or exit with `/atlas exit` and get a changed plan approved.

If a task needs you, Atlas marks it blocked and keeps going with everything that doesn't depend on it. Questions that wouldn't change the work go in its reply, so an unattended run doesn't stall on them. Once nothing else can move, Atlas asks you in a dialog that waits for your answer. It won't treat a real blocker as optional just to keep going, and the final report lists every assumption it made.

If you fix a blocker yourself, for example in another session, tell Atlas which commit or files did it. Atlas reopens the task and has a new child check it before marking it done. If the fix changes what the plan asks for, run `/atlas exit` and plan the change with `/prometheus`.

Atlas mirrors the plan into your todo list and titles the session "Atlas …" unless you named it. After every ledger change it must refresh the todo list before it dispatches or waits, and it must record each finished child before it moves on; the plugin refuses the next dispatch until it does. It follows the host's `task.isolation` settings, except that with `merge: patch` it switches merges to `branch` while it executes so each child's commits survive, and restores your setting on exit. Children commit their own work; Atlas commits only roadmap and ADR documents and work a finished child left uncommitted, through its guarded `atlas_git` tool.

In a workspace that is not a Git repository, nobody uses or creates Git: plans say `Commit: none`, delivery is `direct`, children are told not to commit or run `git init`, isolation is not required, and F1 checks the plan without Git history. Run `git init` yourself before planning if you want commits.

### Final gates

Once every task is done, Atlas runs four gates in parallel, each on a fresh child that only reports and never fixes.

| Gate | Agent | Checks |
| --- | --- | --- |
| F1. Plan compliance review | `momus` (fallback `reviewer`) | the changes match the approved plan, using the plan, the ledger and the plan's Git history |
| F2. Code quality review | `deep-high` (fallback `task`) | correctness, scope, maintainability, test value and regression risk; any CRITICAL or HIGH finding fails |
| F3. Real-surface QA | `deep-low` (fallback `task`) | every verification scenario run for real, each pass backed by an artifact |
| F4. Success-criteria fidelity | `deep-high` (fallback `task`) | the result against each success criterion and ideal-state row; it passes unless one is shown to fail |

Each gate returns a structured `PASS`, `FAIL` or `INCONCLUSIVE`; only `PASS` counts. A failed gate adds correction rows (`X1`, `X2`, …) and reruns only that gate. After two failed reruns, Atlas blocks the gate and asks you how to proceed.

### Delivery

`delivery` sets how finished work leaves the repository: `direct` keeps commits on the working branch, `pr` has a child push the branch and open a pull request after the gates, and `ship` also waits for CI and merges. With `ask` (the default), Prometheus asks when the repository has a remote; a fixed value is used without asking, `pr` or `ship` without a remote becomes `direct`, and you can override it in conversation. The plan's `Delivery:` line governs execution, and pushes and merges are always done by a child.

### The `/atlas` command

```text
/atlas                          # inactive: open Atlas Dispatch; active: open the running plan's view
/atlas <plan-name-or-id>        # enter a plan in this session and start executing
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display label
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

Everything except bare `/atlas` and `exit` works only while Atlas is inactive; to switch plans, exit first. Plans match by name or ID (see [plan matching](REFERENCE.md#plan-matching)).

Atlas Dispatch lists unfinished plans in the current workspace; Tab shows all plans, including finished, invalid and other-workspace ones, for viewing only.

| Key | Action |
| --- | --- |
| type | fuzzy-search names, IDs or status |
| Enter | start the highlighted plan right away |
| Space, Shift+I | open the fullscreen plan view |
| Shift+R | resume in a session that already executed the plan |
| Backspace, Delete | edit the search; delete the plan when the search is empty (Backspace) or always (Delete) |
| Shift+N | rename the display label |
| Esc | close |

Starting a plan in a non-empty session asks whether to use a new session or this one. Atlas then sends the first execution message itself.

While Atlas is active, bare `/atlas` opens a live, read-only view with each row's status, running children with their model, current tool and usage, and a timeline (Tab). Shift+X exits Atlas, Esc closes the view. Disable the widget above the editor with `atlasWidget`.

### Continuing in another session

Plans and their evidence live in your OMP session directory, outside any one session. Session A can stop partway and session B continue with `/atlas <name>`, as long as both share the session directory and workspace. Shift+R or `/atlas resume` returns to a session that already ran the plan, in Atlas mode, and waits for your next message.

A plan runs in one session at a time. Exiting releases it but neither cancels running children nor marks work complete; a session with a running child keeps the plan until the child reports.

Updating the plugin keeps existing plans runnable without re-approval.

### Models

Metis, Oracle and Momus run on OMP's `@slow` role. Atlas runs in the main session; the plugin registers an `atlas` model role you can assign in `/model`:

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

While a proposal waits for approval, the approval slider also offers `atlas`; move it off `default` to execute with that role. `/atlas <plan>` applies the role when it is assigned. It is not in the Ctrl+P cycle.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-prometheus`.

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Plan review before the proposal. |
| `reviewRoundLimit` | whole number ≥ 0 | `5` | Most plan-review rounds per plan; `0` or empty (`""`) means unlimited. |
| `delivery` | `ask` \| `direct` \| `pr` \| `ship` | `ask` | How finished work leaves the repository; see [Delivery](#delivery). |
| `atlasWidget` | boolean | `true` | Show the progress widget above the editor while Atlas executes. |
| `herdrDag` | boolean | `true` | Publish Atlas progress for the `omp-herdr-dag` viewer. |

Review levels:

- `ask`: Momus reviews every plan. Momus and Oracle together review when you ask for high accuracy or the work is nontrivial and unclear; for clear work you get a one-time choice.
- `standard`: Momus reviews every plan; an explicit request still adds Oracle.
- `high-accuracy`: Momus and Oracle always review.
- `off`: no Momus or Oracle review, even on request. Metis still runs, and Atlas still runs the F1 compliance gate.

The plugin counts review rounds itself: each dispatch of Momus, or of Momus and Oracle together, is one round, including one that could not read the plan. When a plan reaches `reviewRoundLimit`, you choose between adding rounds for that plan only and stopping; stopping makes Prometheus propose the plan as it stands, listing the blockers still open so you can weigh them at approval. Without an interactive user, review stops at the limit.

User settings merge with project overrides. Settings are read at session start, so restart the session after changing them.

## Working with other plugins

- `omo-toolkit`: plans prefer its category agents, and gates F2, F3 and F4 run on `deep-high` and `deep-low`.
- `judge-dispatch`: does not reroute anything while a plan executes, and never reroutes `metis`, `momus` or `oracle`.
- `omp-herdr-dag`: shows Atlas tasks, discovered tasks, fixes, gates and delivery as a live dependency graph.
- `roadmap`: a plan proposed while a roadmap stage is bound remembers that stage and the criteria it declares. A stage may be delivered by several plans; the roadmap plugin asks Atlas which plans exist for a stage, what they cover and how far they got. Atlas may use the roadmap tools and, when the roadmap is usable in the repository (an initialized roadmap in a Git work tree, with the `adr` plugin), files a Roadmap TODO for each deferred finding. If the stage's objective, scope, criteria or design constraints change after approval, `/atlas <plan>` and plan completion show a notice; execution never pauses for it. When the plan completes (after delivery, for `pr` and `ship`) the session is reminded to evaluate the stage close: the stage closes only when every current criterion has passing evidence from some plan, and never by itself.
- `adr`: Atlas may use the ADR tools, with or without `roadmap`. ADR acceptance, rejection and supersession are Atlas's own `adr_manage` steps, never a child's; a stage with proposed ADRs cannot close until they are disposed of.
- [Magic Context](https://github.com/cortexkit/magic-context): its `ctx_*` tools stay available to Atlas.

## Without the terminal UI

| Host | `/atlas` behavior |
| --- | --- |
| RPC (`--mode rpc`, rpc-ui) | Atlas Dispatch becomes a chain of select dialogs (pick a plan, then Start, Resume, View details, Rename, Delete or Back). The widget is sent as text lines. |
| ACP editors | The same dialogs through form elicitation. No widget. |
| SDK, `--no-ui`, print | No dialogs; use the subcommands. Deleting needs `--yes`. `/atlas resume` works only from the one session that executed the plan; otherwise it names the sessions to open. |

Prometheus planning needs Plan Mode's interactive approval, so it runs in the TUI, RPC and ACP only.

Client programs can read planning and execution state from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Atlas needs file-backed sessions on a local filesystem that supports hard links, atomic rename and file and directory sync. In-memory or remote-only session storage makes it refuse to run. Sessions with different session directories cannot see each other's plans.
- Plans run with versions before the shared ledger cannot be resumed; get them approved again.

## Reference

[REFERENCE.md](REFERENCE.md) covers the Atlas tool guard, plan bundle and ledger, plan matching, ownership, the state snapshot, and the event contracts with `omp-herdr-dag`, `roadmap` and `adr`.

## License

The Prometheus, Metis, Oracle, Momus and Atlas prompt assets are modified derivatives of OmO; `NOTICE` records the upstream repository, the pinned revision, earlier fork history and the modification notice.

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/` and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal and non-commercial use, and free distribution only for non-commercial purposes.
