# roadmap

English | [简体中文](README.zh.md)

New to the plugin? Start with the [guide](GUIDE.md).

> The planning layer above your plans and tasks: rounds, stages and decisions that stay in your repository across sessions.

Keeps a project roadmap in your repository as Markdown, maintained by the agent through dedicated tools. It records build rounds, the stages in each round with verifiable done criteria, deferred TODOs and the evidence that closed each stage, and links stages to the architecture decisions the [adr plugin](../adr/README.md) keeps. Implementation plans stay out of it.

## Install

```bash
omp plugin install roadmap@wows-omp-plugins
```

Requires OMP 18.5.1 or newer, a local Git repository and the `adr` plugin (`omp plugin install adr@wows-omp-plugins`); enable both and start a new session after installing. Any `git init` work tree works and no remote is needed; outside a Git repository the commands and tools refuse. Without the adr plugin, `/roadmap`, `/init-project` and every `roadmap_*` tool refuse with that install hint, while edits to `docs/roadmap/` stay blocked. In a repository with a roadmap, the main session also shows the hint once per session, and each turn's roadmap context is replaced by one line saying roadmap is unavailable until the adr plugin is installed. The plugin ships the `roadmap` skill.

## Quick start

1. Run `/init-project` in the main session. `docs/roadmap/` must not exist yet; `docs/adr/` may be absent, empty or already managed by the adr plugin.
2. Answer the agent's interview: project description; the first round's goal, constraints, non-goals and principles; decisions already made; and the stages with objectives, scope, done criteria and dependencies.
3. Review the preview and pick `Write N files`. Nothing is written before you confirm.
4. Ask the agent to start a stage. It gets a handoff with the round's goal, constraints and non-goals, the stage's objective, scope, criteria, TODOs and relevant ADRs, what its predecessor stages delivered, and any plans already made for it, and plans the work from there.
5. When the work is done, the agent closes the stage with evidence for every criterion. Once every stage in the round is closed or dropped, run `/roadmap close-round`.

`/roadmap` opens the roadmap console at any time.

## Usage

### Concepts

| Record | Purpose |
| --- | --- |
| Round (`R1`) | A build cycle with a goal, constraints, non-goals and principles citing ADRs. Rounds are `planned`, `active`, `closed` or `dropped`; at most one is active. |
| Stage (`S01`) | An objective, scope and verifiable done criteria. Stages go from `planned` to `active` to `closed`, or are `dropped`. Dependencies must be closed before a stage starts. |
| Done criterion (`DC1`) | What must pass and how to verify it. |
| TODO (`T001`) | Deferred work with a source, a severity (`high`, `normal`, `low`) and either a target stage or a trigger. |
| ADR (`ADR-0001`) | A decision in MADR format, kept by the adr plugin. Roadmap cites ADRs in principles, shows them in stage handoffs and links them to stages. ADRs outlive rounds. |

Roadmap documents live under `docs/roadmap/`; ADRs live under `docs/adr/` and belong to the adr plugin. The agent changes roadmap files only through the roadmap tools, and a hook blocks ordinary edits to them (the adr plugin protects `docs/adr/` the same way). You can still edit body text in your own editor.

While a round is active, the agent sees a short roadmap status in every turn, including which stage the session is bound to.

### Working on a stage

Starting a stage binds the session to it and returns the handoff. Starting a stage that is already active joins it instead, with a warning that another session may be working on it. `roadmap_status` and the per-turn status show which planned stages can start now and which still wait on unclosed dependencies.

Scope or criterion changes on an active stage are recorded with `amend` and a reason. Later work goes into TODOs and decisions into ADRs through `adr_manage`.

A stage closes only from `active`, and only when:

- every current criterion has evidence with `result: "pass"`, the method actually used and a summary;
- every open TODO targeting the stage is resolved with a reference or moved to another target;
- no ADR linked to the stage is still proposed. Close refuses and lists them; the main session accepts or rejects them with `adr_manage` first. The Outcome records the linked ADRs' statuses.

The plugin checks that the evidence is complete, not that it is true; the agent has to run the checks it reports. A closed stage never reopens. For corrective work, add a new stage that `follows` it.

A stage can be delivered by several plans, each owning some of its done criteria (see [Working with other plugins](#working-with-other-plugins)). Closing it while one of those plans is unfinished is allowed: the close warns and adds a line naming the unfinished plans and their criteria to the Outcome's Deviations.

### Free work and overlap

Work outside the roadmap does not need a stage. When the agent notices that a request overlaps an unclosed stage, it asks once per stage and session whether to use the roadmap, log the request as free work, or treat it as unrelated. Logging adds one line to the stage's Free-work log and claims nothing about its criteria.

### Closing a round

`/roadmap close-round` needs every stage closed or dropped and no document errors. It asks how the round's goal turned out (`achieved`, `partial`, `not_achieved` or `cancelled`, plus a summary) and records that in the round's Outcome; format-2 repositories require it. In a format-1 repository it first offers the one-step format-2 upgrade; skip it to close without an outcome. The upgrade is written together with the close, so a refused close leaves the repository at format 1 and offers the choice again. It then asks you how to dispose of each remaining open TODO: `resolved` with a reference, `wontfix` (recorded under Known limitations) or `carried` to a later round. Open TODOs targeting stages of a planned round move there automatically with the same ID. Closing freezes the round's directory in place.

`/roadmap new-round` then interviews you for the next round's charter, or activates the next planned round. It can import carried TODOs from earlier rounds.

### Planning future rounds

`/roadmap plan-round` drafts a future round, with or without an active round; `/roadmap plan-round R2` revises one. Add its stages with `roadmap_stage` (`action: "add"`, `round: "R2"`). They cannot start until their round is active, and planned rounds activate in order.

Rounds and stages can carry an optional `target` date (`YYYY-MM-DD`). Status views show it next to the actual dates and flag unfinished work past its target. Targets never block anything.

Planned rounds, target dates and round goal outcomes need repository format 2. `/init-project` creates a format-2 repository, which **roadmap 0.2.3 and earlier cannot read**. Repositories initialized by earlier releases are format 1 until you upgrade them. In a format-1 repository the main session asks you each time you enter a session (start or switch) whether to upgrade now; Yes writes the upgrade at once, No changes nothing. Without dialogs you get one notice naming `/roadmap upgrade` instead. `/roadmap upgrade`, the first `/roadmap plan-round` preview and the round-close dialog offer it too, and the agent can ask with `roadmap_upgrade`. After it, **roadmap 0.2.3 and earlier can no longer read the repository**. The upgrade changes only the root marker; existing files keep format 1 until a write needs a format-2 field, and closed history is never rewritten. Format-1 repositories that never use these features stay at format 1 byte for byte.

`/roadmap drop-round R2 <reason>` drops an unneeded planned round and its stages, keeping the files as history. Move or resolve TODOs targeting its stages first.

### Confirmation

Initialization and every round-level change (planning, opening, dropping, retargeting) need an explicit command from you and a confirmed preview. The plugin rechecks the files after you confirm and refuses a stale preview. Cancelling writes nothing. The format-2 upgrade is written only after you answer Yes in its dialog or confirm the `/roadmap upgrade` preview.

### Commands

All commands run in the main session and complete subcommands, stage IDs and round IDs.

| Command | Behavior |
| --- | --- |
| `/init-project` | Check prerequisites and start the initialization interview. |
| `/roadmap` | Console: the active round's stages, all rounds and open TODOs with their details, dates and the actions available now. With `uiMenu` set to `inline`, a status menu instead. |
| `/roadmap stage <id>` | Show a stage and its handoff without starting it. |
| `/roadmap check [--fix]` | Check document consistency; `--fix` regenerates generated blocks. |
| `/roadmap upgrade` | Adopt repository format 2. |
| `/roadmap plan-round [id]` | Draft a planned round, or revise one. |
| `/roadmap new-round` | Activate the next planned round, or create a new one when none is planned. |
| `/roadmap drop-round <id> <reason>` | Drop a planned round and its stages. |
| `/roadmap retarget <round-or-stage> <YYYY-MM-DD\|none>` | Set or clear a target date (format 2). |
| `/roadmap close-round [outcome=<assessment>:<summary>] [<todo>=<disposition>[:<reference>] …]` | Close the active round; arguments answer the dialogs, e.g. `outcome=partial:"checkout shipped, refunds moved" T001=resolved:abc1234 T002=wontfix:"out of scope" T003=carried`. Format 2 needs the outcome. |
| `/roadmap overlap <stage> roadmap\|free\|unrelated [intent]` | Answer the overlap question for this session. |
| `/roadmap confirm <token>` | Confirm a held preview when no dialog was available. |

### Agent tools

| Tool | Purpose |
| --- | --- |
| `roadmap_status` | Rounds, stages and open TODOs; with `stage`, its full detail and handoff. |
| `roadmap_stage` | `add`, `edit`, `amend`, `start`, `close`, `drop`, `renumber`. |
| `roadmap_todo` | `add`, `update`, `resolve`, `move`. |
| `roadmap_check` | Document consistency check; `fix: true` regenerates generated blocks. |
| `roadmap_overlap` | Ask the overlap question. |
| `roadmap_init`, `roadmap_round_plan`, `roadmap_round_open` | Write the previews prepared by `/init-project`, `/roadmap plan-round` and `/roadmap new-round`. |
| `roadmap_upgrade` | Ask you, in the same dialog as at session start, whether to upgrade a format-1 repository; writes only on Yes. Main session only. |

Subagents can use the tools too, but are never prompted. ADRs are managed with the adr plugin's `adr_status`, `adr_manage` and `adr_check`.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-roadmap`.

```bash
omp plugin config set wows-omp-plugin-roadmap uiMenu inline
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `uiMenu` | `fullscreen` \| `inline` | `fullscreen` | How `/roadmap` and write previews look in the terminal. |

With `fullscreen`, `/roadmap` opens a console that fills the terminal. Tab switches between stages, rounds and open TODOs, and typing searches the list. The right pane shows the selected item in full: status, dates, dependencies, linked ADRs, open TODOs and its text. With `omo-prometheus` installed it also shows which Atlas plans cover each done criterion. Enter jumps between related items: a stage to its round, a round to its stages, a TODO to its stage. The stage list shows the active round until you open another round's stages this way.

| Key | Action |
| --- | --- |
| Shift+X | Close the selected active stage (the agent does it). |
| Shift+R | Close the active round. |
| Shift+N | Open a new round, or activate the next planned one. |
| Shift+P | Plan a new round. |
| Shift+E | Revise the selected planned round. |
| Shift+D | Drop the selected planned round. |
| Shift+T | Change the target date of the selected round or stage. |
| Shift+U | Upgrade a format-1 repository to format 2. |
| Shift+C | Run the check. |
| Esc | Clear the search, then close the console. |

Checks, round closes, drops, target dates and upgrades finish in the console. Once you answer the write preview, the console comes back on the same item with a one-line result, and the full result also goes to the chat. Closing a stage, opening a round and planning or revising one need the agent, so the console closes and you carry on in the chat. For a stage close, a notice tells you what to ask for. Short answers, like a date, a drop reason or the round-close questions, stay small dialogs.

Write previews list the files on the left and show the selected one on the right; Space switches between rendered and raw text. Shift+W or the Write row writes every file. Esc or Cancel writes nothing.

With `inline`, the console and previews are the select menus of earlier releases. RPC and ACP clients always get those menus. The setting is read on each use, so a change applies the next time without a restart. An unknown value falls back to `fullscreen` with a warning in the log.

## Working with other plugins

With `omo-prometheus`, a plan proposed while a stage is bound remembers that stage. A stage can be delivered by several plans: each plan declares the done criteria it owns with a `Roadmap criteria: DC1, DC3` line, which Prometheus checks against the stage's current criteria before you approve. Roadmap asks omo-prometheus for the plans of a stage whenever it builds a handoff, a status view, a close reminder or a stage close; plan records stay in the Atlas bundles, not in `docs/roadmap/`. The handoff lists each plan's progress, which criteria complete plans, only unfinished plans or no plan cover, and drift: a plan approved before the stage's objective, scope, criteria or design constraints changed. Drift is a notice and never pauses work.

During execution Atlas may use the roadmap tools. When a plan completes, the session is reminded to evaluate the stage close, with the final gate results as evidence candidates, coverage across every plan for the stage, unfinished and undeclared plans, drift and untriaged out-of-scope findings, which Atlas files as roadmap TODOs. PR and ship plans complete only after delivery, and the reminder shows their delivery mode and summary. Older completions and approvals without these fields still work. The stage never closes automatically. Without omo-prometheus, roadmap shows no plan information.

## Without the terminal UI

| Host | Behavior |
| --- | --- |
| RPC (`--mode rpc`, `rpc-ui`) and ACP | The same dialogs, sent as `select`, `input` and `editor` requests. ACP clients may show notices only in their log. |
| No UI (`--no-ui`, print, JSON, SDK) | No dialogs. Bare `/roadmap` prints status and usage. Previews return a token without writing anything; confirm with `/roadmap confirm <token>`. Answer overlaps with `/roadmap overlap` and round closing with `/roadmap close-round` arguments, including the goal outcome. Entering a format-1 session shows one notice naming `/roadmap upgrade`, and `roadmap_upgrade` refuses. |

Client programs can read the roadmap status from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Initialization needs a fresh `docs/roadmap/`; an existing roadmap or a non-empty `docs/adr/` that the adr plugin does not manage cannot be adopted.
- Planned rounds cannot be skipped or renumbered, and dropped round IDs are not reused.
- Overlap detection depends on the agent noticing the overlap.
- The edit protection is best effort, especially for `bash`, and is not a sandbox.
- Joining an active stage warns about other sessions but does not reserve the stage.
- `check` verifies the documents, not whether the code matches them.
- A multi-file write is not all-or-nothing, and previewed IDs can be used up by a declined preview, leaving gaps.
- Separate clones do not share numbering, so their IDs can collide; worktrees of one clone do share it.
- Without a UI, a held preview lives only in memory and is lost when the process exits.

## Reference

[REFERENCE.md](REFERENCE.md) covers every tool action, the allowed Markdown in tool-written text, edit protection, recovery and worktrees, carry-over rules, the state snapshot, the Prometheus contract and the directory format.

## License

MIT.
