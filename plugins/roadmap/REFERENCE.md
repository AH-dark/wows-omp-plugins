# roadmap reference

English | [简体中文](REFERENCE.zh.md)

## Context injection

While a round is active, the plugin reads the checked-out documents on each turn and injects bounded status into main and subagent context, including one readiness line (planned stages of the active round that can start now, and the others with the unclosed dependencies they wait on) and compact planned-round summaries with IDs, titles, targets and stage counts. The stage list is capped at 12, with a pointer to `roadmap_status` for the rest. With no active round, nothing is injected and free work continues normally; `roadmap_status` still lists planned rounds. Nothing is injected when the adr plugin is not loaded. Edit protection stays active in an initialized repository either way.

Roadmap needs a local Git repository (any `git init` work tree; no remote is needed). Outside one, every command and tool refuses.

The overlap answer is stored per stage and session and reused. A stage already bound to the session returns in-system with its handoff, without a dialog or free-work entry, even headless. Subagents are never prompted.

## Tools

Mutating tools use write approval; `roadmap_status` uses read approval.

| Tool | Inputs or actions |
| --- | --- |
| `roadmap_status` | No parameters for rounds, targets, actual dates, overdue flags, stages with dependencies, readiness of the active round's planned stages, the Atlas plans of unclosed stages (when omo-prometheus answers) and open TODOs by target or trigger; optional `stage` for full detail and handoff. |
| `roadmap_stage` | `add`, `edit`, `amend`, `start`, `close`, `drop`, `renumber`. `add` accepts optional `round` and `target`; `edit` and `amend` also accept `target`. `start` and `close` ask omo-prometheus for the stage's Atlas plans. |
| `roadmap_todo` | `add`, `update`, `resolve`, `move`. |
| `roadmap_check` | Optional `fix: true`. Checks documents, not code/document drift. |
| `roadmap_overlap` | `stage` and `intent`. |
| `roadmap_init` | `project`, `round`, initial `adrs` and `stages`; needs `/init-project` authorization and a confirmed preview. Initial ADRs are created through the adr plugin (see [ADRs through the adr plugin](#adrs-through-the-adr-plugin)). |
| `roadmap_round_plan` | `round` charter, optional `id` to revise a planned round, optional `target`; needs `/roadmap plan-round [id]` authorization and a confirmed preview. |
| `roadmap_round_open` | `import_todos` IDs and an optional `round` charter or `activate` round ID; needs `/roadmap new-round` authorization and a confirmed preview. When planned rounds exist, the lowest-numbered one is activated. |
| `roadmap_upgrade` | No parameters. Main session only. In a format-1 repository it opens the same one-step Yes/No dialog as session entry: Yes writes the `/roadmap upgrade` change (only `docs/roadmap/README.md`), No reports that format 1 was kept and writes nothing, no answer writes nothing. Format 2 reports that it is already upgraded. Without a dialog, or in a subagent, it refuses and names `/roadmap upgrade`. |

Authorization comes from an explicit user command arming the main session. A successful write consumes it; cancellation or an unavailable answer does not authorize a write.

### Stage actions

| Action | Rules |
| --- | --- |
| `add` | Create a planned stage in the active round, or in an active or planned round given by `round`. Supply `title`, `objective`, `scope_in`, `scope_out` and `done_criteria` entries with `statement` and `verify`; `target`, dependencies and design constraints are optional. Dependencies may only be in the same or an earlier round. |
| `edit` | Replace supplied fields, including `target`, of a planned stage. Use `amend` once active. |
| `amend` | Append a dated delta with a required `reason` to an active stage. `amendments` can add, modify or remove criteria and add or remove in/out scope items; `target` records a date change. |
| `start` | Requires the stage to belong to the active round, closed dependencies and no check errors; activates and binds it and returns a planning handoff. On an already active stage it joins without changing the document. |
| `close` | Takes `id`, a `delivered` summary, optional `deviations`, and `evidence` and `todos` as described below. Refused while an ADR linked to the stage is proposed. Records the Outcome, including the linked ADRs' statuses under `### ADRs`, and the closure hash, and freezes the stage. Unfinished linked Atlas plans do not block it: the receipt warns, and a line naming them (name, plan ID, declared criteria) is appended to the Outcome's Deviations text. |
| `drop` | Drop a planned or active stage with a required `reason`, after resolving or moving every open TODO targeting it. |
| `renumber` | Renumber a planned stage with `new_id` and rewrite mutable references, including ADR stage links through the adr plugin. Refused when closed history holds a reference that would need changing. |

Stage close inputs:

- `evidence`: one entry per current criterion with `criterion`, `result: "pass"`, the actual `method` and a `summary`; `commit` is optional. Missing or failed evidence refuses the close.
- `todos`: each open TODO targeting the stage is `resolved` with a `reference` or `moved` to another valid target (a move leaves it open). A trigger can be given as the target `trigger: <text>`.
- ADRs: close reads the ADRs linked to the stage through the adr plugin. While any of them is `proposed`, close refuses and lists them; the main session accepts or rejects them with `adr_manage` first, since subagents cannot. Close also refuses while ADR files cannot be parsed, because a proposed link could hide in them.

The handoff contains the round charter (goal, constraints, non-goals in full), the objective, scope and done criteria, the stage's Atlas plans when omo-prometheus answers, design constraints, risks, amendments, its direct predecessors (`depends_on` and `follows`: ID, title, status and stage document; for closed ones the Delivered and Deviations text of their Outcome, each cut at about 800 characters), targeted TODOs, cited ADRs, the free-work log and closing guidance.

### Plans for a stage

A stage may be delivered by several Atlas plans. Each plan declares the criteria it owns in a `Roadmap criteria:` line, checked by Prometheus before approval. Roadmap keeps no plan records; it asks omo-prometheus with `atlas:plans-request` whenever it renders a handoff, `roadmap_status`, the close reminder or a stage close. The handoff's Plans for this stage section lists each plan's status and progress and whether its coverage is declared, then each current criterion as covered by a complete plan, covered only by unfinished plans, or uncovered. A plan whose recorded planning-basis revision differs from the stage's current one is flagged as drift: the objective, scope, done criteria or design constraints changed after approval. Drift is a notice only. Without omo-prometheus, the section is omitted.

Readiness is derived on every read and never stored: a planned stage of the active round is startable when every dependency is closed, otherwise blocked by the unclosed dependency IDs. Other stages are neither startable nor blocked.

### TODO actions

`add` requires `title`, `source`, `severity`, and either `target` or `trigger`; `body` is optional. Targets can be any unclosed stage in the active or a planned round. New items go into the active round's TODO document, even when they target a planned round. With no active round, a new item must target a planned-round stage and goes into that round's document. A planned round's document holds only items targeting its own stages or items with a trigger.

`update` changes supplied fields of an open item in an active or planned round. `resolve` requires a `reference`. `move` replaces the target or trigger and refuses a closed or dropped target stage. Moving an item out of a planned round's document to another round leaves the old item as `moved`, pointing at a fresh TODO ID in the destination, which keeps the requested target and records the old ID and round in `carried_from`. A move to another planned round goes directly to that round's document even when an active round exists.

### ADRs through the adr plugin

ADRs belong to the [adr plugin](../adr/README.md) (`adr_status`, `adr_manage`, `adr_check`, `/adr`); roadmap never parses or writes `docs/adr/`. It requests the adr service (`adr:binding-request` v1, see the adr plugin's REFERENCE "Service contract") for its own session at session start and again lazily, and registers a stage resolver that accepts any stage of the repository's roadmap, so `adr_manage` can link an ADR to a stage. The resolver is unregistered at shutdown and on rebuild. When the repository has a roadmap and the service still cannot be bound at the start of a turn, that turn's injection is a single `[Roadmap status]` line giving the reason and the install hint, and the main session notifies the user once per session with the same reason and hint.

- Round principles (`/init-project`, `/roadmap plan-round`, `/roadmap new-round`) must cite ADRs the adr plugin reports. An unreadable ADR file or an uninitialized `docs/adr/` refuses with guidance.
- `/init-project` previews initial ADRs with a dry run of the adr plugin's `createMany` (initializing `docs/adr/` when absent or empty, or adding to an already managed one), shows the ADR files in the same preview and creates them after confirmation, before writing any roadmap file. Initial ADR `id`s are aliases that principles and stage text may cite; they must not equal an existing ADR id. An initial ADR's `stage` names an initial stage alias.
- `renumber` relinks ADR stage links after writing the roadmap files. The two writes are not one transaction: if the relink fails, the refusal lists the committed roadmap files and the ADRs still linked to the old id; restore `docs/roadmap/` and `docs/adr/` with git and renumber again.
- The ADR id counter key in `<git common dir>/roadmap/counters.json` is kept as is; roadmap no longer allocates ADR ids.

The directory explanation written into `docs/roadmap/README.md` (formats 1 and 2) still says that ADRs change through roadmap tools; it is stored text that is kept byte-for-byte. ADRs are managed by the adr plugin.

## Markdown in tool-written text

Tool-owned body text supports plain paragraphs, flat bullet or ordered lists with single-line text items, and fully closed top-level fenced code blocks. Bullet markers are `-`, `+` or `*`; ordered markers have one to nine digits followed by `.` or `)`, with one space after the marker. Nested lists and indented list continuations are refused.

Ordinary punctuation is allowed, including `~20%`, `snake_case`, `quantity * unit price`, URLs with underscores or tildes, and `x < y` or `x > y`. A `<` immediately followed by an ASCII letter, `/`, `!` or `?` is refused, since it can begin HTML, an autolink, a comment or a processing instruction. A `>` cannot begin a line.

Inline emphasis delimiters are allowed, and matched pairs may render as formatting. Square brackets, backslash escapes and table pipes are unsupported outside code. Same-line inline code spans are allowed; each opening backtick run must close with an equal-length run on that line. A multiline span cannot hide HTML or a fence on another line. Put literal unsupported syntax in code, or use entities such as `&lt;script&gt;`.

Fences use at least three backticks or tildes with zero to three leading spaces. The optional info string is one language token of ASCII letters, digits, `_`, `+`, `.` or `-`. A closer uses the same marker, is at least as long as the opener, has zero to three leading spaces, only spaces or tabs after it, and no info string. Fence contents are literal.

Fences cannot begin inside lists or quotes. After a list, use an unindented fence, or a blank line and an unindented paragraph before an indented fence; this also applies after a TODO body's metadata list. Paragraphs after a list need a blank line; lazy list continuations are refused.

Outside fences and code spans, the tools refuse raw HTML and comments, Markdown links and reference definitions, ATX and Setext headings, block quotes, tables, thematic breaks, indented code, tabs, malformed or unclosed fences and ambiguous constructs, returning a repair hint before changing any managed bytes.

Single-line fields such as scope items, criterion statements and verification methods follow the same punctuation and inline rules but cannot contain lists or fences. Tools reparse the rendered document to check that IDs, metadata, body boundaries and fixed headings survive.

## Round close and carry-over

At round close, open TODOs targeting stages in planned rounds are carried automatically into those rounds' TODO documents. They keep the same IDs and targets; the destination records `carried_from`, and the frozen source becomes `carried` with a reference to the destination round. They are not shown in the disposition dialog and cannot be imported again through `import_todos`.

Closing a round records its goal outcome in the round's `## Outcome`: `### Assessment` (`achieved`, `partial`, `not_achieved` or `cancelled`) and `### Summary`. A format-2 repository refuses to close without it; a format-1 repository refuses an outcome, because only a format-2 round file can hold that section. The close dialog asks for the assessment and summary; in format 1 it first offers the one-step upgrade (Yes upgrades and records the outcome, skip closes without one). The upgrade is part of the close write, after the same outcome, TODO and staleness validation, so a refused close writes nothing and leaves the repository at format 1. The closing round file becomes format 2 only when it records an outcome. Rounds closed or dropped earlier keep their bytes and frozen hashes.

The same ID can continue through later rounds (`R1 → R2 → R3`). `check` validates every hop: exactly one occurrence is not `carried`; every other occurrence is `carried`, references the next round and matches that item's `carried_from`. Other duplicate IDs are errors.

The close dialog authorizes closing only the round and file snapshot reviewed before it opened; from the status menu or the console, the snapshot is taken when it appears, and the console takes a fresh one each time it reopens. If the round closes, another round opens, or any of its files change while the menu, console or dialog is pending, the close is refused as stale and writes nothing.

`/roadmap new-round` can import selected trigger-based carried TODO IDs from frozen rounds. Imported items get fresh IDs, keep their origin and start with a trigger; the old target stage does not carry over, and the old round stays untouched. You cannot skip the lowest-numbered planned round or create a brand-new round while any planned round remains.

`/roadmap drop-round` also refuses while stages in other rounds depend on the round's stages.

## Edit protection

After initialization, a tool-call hook protects `docs/roadmap/**` in main and subagent sessions, whether or not the adr plugin is loaded; `docs/adr/**` is protected by the adr plugin. The hook finds the target's git work tree, checks lexical and resolved paths (including dangling symlink destinations) and blocks edits with guidance to use the roadmap tools. For existing file targets, it compares device and inode against multiply linked managed files in the session and target worktrees, so native `write` and `edit` cannot change a managed file through a hardlink alias, inside or outside the repository.

Repositories without the initialization marker are unaffected. A validation, path-resolution or file-identity error in the hook refuses the call.

| Surface | Coverage |
| --- | --- |
| `write` | Its `path`, including `[path#TAG]` headers copied from read output and existing hardlink aliases. |
| `edit`, `apply_patch` | Every native `edit` call projects the `hashline`, `replace`, `patch`, `apply_patch` and `sloppy` grammars; `apply_patch` uses its own grammar. Any managed source or destination, or existing hardlink alias, is blocked. Unknown grammars or modes are refused. |
| `ast_edit` | `paths` use the native scope helpers (trim, strip outer double quotes, expand delimiter-separated entries, normalize backslashes) before projecting directories or globs. Invalid scopes are refused. Coverage includes directories outside the worktree that contain its managed roots, and the directory of the first glob segment: `docs/roadm*/**/*.ts` projects to `docs`; `/work/re*/docs/roadmap/*.ts` projects to `/work` and is blocked when the repository is below it. |
| `lsp` | File-named `rename` and applied `code_actions` via `file`; `rename_file` via both `file` and `new_name`. Symbol-rename `new_name` is an identifier, not a path. Files inside a cross-file workspace edit are not inspected individually. |
| `bash` | Best-effort static detection of paths after redirections (`>`, `>>`), `tee`, `mv`, `cp`, `rm`, in-place `sed` and `truncate`. |

The hook does not intercept `eval`, `ctx_execute*`, editors launched from bash, or other programs that write files. Shell variables, substitutions and indirect writes can evade the bash matching, and broad directory or glob candidates can be blocked conservatively. Hardlink checks cover existing named targets only; they do not enumerate aliases inside an unrelated directory or glob, or anticipate a link created by a later shell statement.

When you edit body text yourself, keep the front matter, managed comment, fixed headings and generated-block delimiters. `check` reports unsupported stored HTML, reference definitions, Setext and thematic-break lines, quotes, container fences and ambiguous indentation as structure errors it cannot fix, with a repair hint. Closed top-level fences are masked when locating fixed headings; an unclosed fence is a structure error.

Hash checks detect changes to closed stages and frozen rounds. Closure hashes are verified whenever they are kept, even if the status was changed, and a status that contradicts kept closure metadata is an error. Fixes and mutations refuse these integrity errors; restore the history with git.

## Recovery and worktrees

Writes take one repository lock and atomically replace each file. A multi-file operation is not a transaction: if interrupted, it can leave complete files but stale generated indexes or a partly applied operation. Cancellation stops before the next temporary write or rename and removes uncommitted temporary files; files already written stay. A cancelled operation reports them with recovery guidance and does not bind a stage, consume preview authorization or store an overlap answer.

1. Run `/roadmap check` or `roadmap_check`.
2. Run `/roadmap check --fix` or `roadmap_check` with `fix: true` for stale generated blocks. This never repairs authored content, recomputes closure hashes or changes frozen rounds.
3. Restore other damage with git and check again.

Commit the documents according to your project's rules. The checked-out Markdown is the source of truth on each branch. Worktrees share only the lock and versioned ID counters under the git common directory's `roadmap/`; IDs are allocated above both the stored counter and IDs on disk.

## Without a UI

A held preview's token covers exactly the shown files and lasts until the session is rebuilt (start, switch, branch, tree) or a newer preview of the same kind replaces it; any other reply declines it. `roadmap_overlap` reports no answer and names `/roadmap overlap`. `/roadmap close-round` without arguments lists the open TODOs that still need a disposition, and in format 2 asks for `outcome=<assessment>:<summary>`. Entering a format-1 session shows one notice naming `/roadmap upgrade`; `roadmap_upgrade` refuses. Notices and errors become displayed session messages.

## Format-2 upgrade prompt

In an initialized format-1 repository the main session asks once per session entry (`session_start` and `session_switch`; never on branch or tree changes, never in subagents) whether to upgrade. The dialog states that roadmap 0.2.3 and earlier can no longer read an upgraded repository and that closed history is not rewritten. Yes writes the upgrade immediately; No closes the dialog and changes nothing until the next session entry. The dialog opens after the host's session-start handlers return, so the session is usable while it is open, and it is cancelled at shutdown or when another session is entered. A repository that is already format 2, or whose roadmap cannot be read, is not asked.

## State snapshot

The main session publishes `roadmap.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)). `state` is the `roadmap/status` payload, version 1, derived from files on disk, or `null` when the repository has no initialized roadmap. Planned-round, date and readiness fields were added without changing the version.

The file is rewritten at session start, switch, branch and tree, after every `roadmap_*` tool call and `/roadmap` command, and at the start of each agent turn, so it also reflects changes by subagents and external edits.

| Field | Content |
| --- | --- |
| `kind`, `version` | `"roadmap/status"`, `1` |
| `format` | Repository marker format, `1` or `2`. |
| `repoRoot` | Git work tree root of the roadmap. |
| `project` | Project title from `docs/roadmap/README.md`. |
| `activeRound` | `{ id, title, target, opened, overdue }`, or `null`; dates are strings or `null`. |
| `plannedRounds` | ID-ordered `{ id, title, target, overdue, stageCount, openTodos }`; `stageCount` excludes dropped stages, `openTodos` counts open items stored in that round's document or targeting its stages, including items stored in the active round's document. |
| `stages` | Every stage as `{ id, title, status, round, target, started, closed, overdue, dependsOn, blockedBy, startable }`. `dependsOn` lists its `depends_on` IDs; `startable` and `blockedBy` are the derived readiness above (`false` and `[]` outside the active round's planned stages). |
| `openTodos` | `{ total, byStage, untargeted }`: open TODOs across rounds, counts per target stage, and those with a trigger instead. |
| `boundStage` | The stage this session is bound to while it is active, or `null`. |

`overdue` is true only for planned or active work whose target is earlier than today's UTC date.

## Prometheus contract

The events are defined in the [omo-prometheus reference](../omo-prometheus/REFERENCE.md#roadmap-contract). On the roadmap side:

- Roadmap answers `roadmap:binding-request` synchronously with the session, request, repository, trusted tool source and optional bound active stage. The stage carries `id`, `title`, `round` and, additively, `criteria` (the current DC IDs in document order, removed criteria excluded) and `revision`. It still answers, without a stage, when the bound stage document cannot be read. No answer means roadmap is absent.
- `revision` is the lowercase SHA-256 hex of the stage's planning basis, `JSON.stringify([objective, scope_in, scope_out, done_criteria, design_constraints ?? ""])` over the parsed sections (`planningRevision` in `src/documents.ts`). Dates, status, title, dependencies, risks, the amendment and free-work logs and the Outcome do not change it. Consumers treat it as opaque.
- Roadmap answers `roadmap:stage-request` `{ v: 1, sessionId, requestId, repoRoot, stage }` for its own session when `repoRoot` is the git work tree root of the session's working directory, synchronously, with `roadmap:stage` `{ v: 1, sessionId, requestId, repoRoot, stage? }`. `stage` is `{ id, title, round, status, criteria, revision }` for any status, and absent when the repository has no roadmap, the stage is unknown or the documents are unreadable. Malformed requests get no answer.
- Roadmap sends `atlas:plans-request` `{ v: 1, sessionId, requestId, repoRoot, stage? }` and reads the synchronous `atlas:plans` answer. It accepts an answer only for its session and request ID and drops the whole answer when any plan entry is malformed (every field is type-checked: IDs, `DC` criteria without duplicates, a 64-hex revision, `unfinished` or `complete`, `done` not above `total`, gate, delivery and deferred-finding shapes, an absolute `directory`). Extra fields are ignored, and plans of another repository or stage are left out. No answer means no plan information.
- Atlas admits only `roadmap_*` tools whose provenance is an extension with the handshake's source path; a same-named tool from another extension or MCP server is not admitted. Every roadmap tool declares that path, the realpath of the loaded `src/index.ts`, as its own source, so installs reached through a symlink (the marketplace layout) still match.
- On `atlas:completed` v1 (unchanged), roadmap stores a pending-close entry for the executing session and adds a reminder on its next turn while the stage is active. The reminder names the completed plan, lists its gate results as evidence candidates and, from a fresh `atlas:plans` answer for the stage, per-criterion coverage across every plan, unfinished plans, plans with undeclared coverage, drift, deferred findings without a triage disposition, and whether a complete plan declares every current criterion. It stays bounded; without an answer it shows only the completion. Optional `delivery: { mode: "pr" | "ship"; summary: string }` is type-checked, its summary normalized to one line and truncated to 180 characters, persisted with the pending close, and shown as `Delivery (<mode>): <summary>`. Invalid delivery fields reject the completion; absent delivery is accepted, including previously persisted v1 entries. A plan with neither a proposal-time nor an executing-session binding is not attached to any stage.
- Pending-close entries are deduplicated by `planId` within the receiving session.

## Directory format

The text below is `HOW_THIS_DIRECTORY_WORKS_V2` from `src/documents.ts`. `/init-project` writes it into the project's `docs/roadmap/README.md`, which is also the initialization marker and generated index, and a confirmed format-2 upgrade replaces the format-1 version that earlier releases wrote.

> This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.
>
> The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on in creation order and are never renumbered; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.
>
> This README carries roadmap: { format: 2 }, the repository format; roadmap plugin 0.2.3 and earlier cannot read a format 2 repository. Every managed file has format: 1 or format: 2 front matter and a managed-by comment naming the same format. Format 1 files keep their bytes until a write needs a format 2 field: a target date, a planned or dropped round, or a round outcome. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages, Known limitations and, for a dropped round or a round closed with its goal outcome, Outcome. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.
>
> Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with `<!-- roadmap:generated:<name> -->` and `<!-- /roadmap:generated -->`. The tools own numbering, metadata, headings and generated indexes.
>
> Rounds are planned, active, closed or dropped. A planned round is drafted ahead with its charter, planned stages and TODOs; only the lowest-numbered planned round can be activated, and an unneeded planned round is dropped together with its planned stages. Stages are planned, active, closed or dropped; only stages of the active round start. A stage depends only on stages in its own or an earlier round. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Closing a round records how its goal turned out in Outcome: an assessment (achieved, partial, not_achieved or cancelled) and a summary. Open TODOs need severity, source and either an unclosed target stage in the active or a planned round, or a trigger. A planned round's TODO.md holds only TODOs for its own stages or with a trigger. When a round closes, its open TODOs that target a planned round's stage continue in that round's TODO.md with the same ID and a Carried from line, and the original is marked carried to that round. Rounds and stages may carry an optional target date; status views compare it with the actual dates and flag unfinished work past its target. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.
>
> Same-ID carry-over may continue through multiple later rounds: every earlier occurrence is carried to the next round with matching Carried from metadata, and only one occurrence is not carried. These continuations cannot be imported again with import_todos. Moving a TODO out of a planned round to another round leaves a moved record naming a fresh ID; the destination keeps the target and records Carried from with the original ID and round.
>
> Closed stages carry closed_sha256; closed and dropped rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.
>
> Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies, a closed round or a dropped round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.
>
> Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
