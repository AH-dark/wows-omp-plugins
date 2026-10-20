---
name: roadmap
description: Use for roadmap, planned rounds, target dates, stage, ADR, TODO, or /init-project work to interview for a round, classify changes, review decisions, handle overlap, and close stages with evidence through the roadmap plugin.
---

# Roadmap

Use this skill for judgment. The plugin owns document formats, numbering, indexes, and lifecycle gates. Never write managed files under `docs/roadmap/` directly, run scripts that write them, or bypass a blocked write. User edits in an editor are separate from agent writes.

Roadmap requires the `adr` plugin: ADRs under `docs/adr/` are read and written only through it (`adr_status`, `adr_manage`, `adr_check`), and its `adr` skill holds the ADR judgment and review guidance. Without it, every `roadmap_*` tool, `/roadmap` and `/init-project` refuse with an install hint; ask the user to run `omp plugin install adr@wows-omp-plugins`, enable it and restart.

Roadmap needs a local Git repository: any `git init` work tree, with no remote required. Outside one, its tools and commands refuse; it never creates a repository itself.

Read `roadmap_status` first. With `stage`, it returns the stage detail and planning handoff. The overview includes planned rounds, optional targets, actual dates and overdue unfinished work, even when no round is active, plus readiness: which planned stages of the active round can start now and which wait on unclosed dependencies. When omo-prometheus is loaded it also lists the Atlas plans of unclosed stages with their declared criteria, progress and drift. Consult relevant accepted ADRs and their successors before planning changes. Treat documents as intent, not proof of what the code does.

Use the tool-owned body subset: plain paragraphs, flat bullet or ordered lists with single-line text items, and fully closed top-level backtick or tilde fences. Ordinary punctuation is allowed: `~20%`, `snake_case`, `quantity * unit price`, URLs with underscores or tildes, and comparisons such as `x < y` and `x > y`. A `<` immediately followed by an ASCII letter, `/`, `!` or `?` is refused; a `>` cannot begin a line. Inline emphasis delimiters are allowed and matched pairs may render as formatting. Same-line inline code spans are allowed only when equal-length backtick runs close on that line; never use multiline spans. Single-line fields such as scope items, criteria and verification methods follow these punctuation and inline rules but cannot contain lists or fences. Raw HTML, comments, Markdown links and reference definitions, square brackets, backslash escapes, headings, quotes, tables, thematic breaks, nested lists, indented code, tabs outside fences and ambiguous constructs are refused without changing managed bytes. Put literal Markdown or HTML examples inside a closed fence rather than retrying container tricks. Fences have zero to three leading spaces and at least three markers; the closer uses the same marker, is at least as long, and has no info string. Use a single ASCII language token for opener info. Separate a plain paragraph after a list with a blank line; lazy list continuations are refused. After a list or at the start of a TODO body, an indented fence needs an unindented plain paragraph before it; an unindented fence is already top-level.

## Where a change belongs

- A scope or done-criterion change within an active stage belongs in `roadmap_stage` with `action: "amend"`. Record the delta and reason rather than rewriting its original commitment.
- New planned work belongs in `roadmap_stage` with `action: "add"`. Its optional `round` selects an active or planned round; omitting it selects the active round. Use `action: "edit"` only while the stage is planned. Dependencies can reference only the same or earlier rounds.
- Deferred or carried-over work belongs in `roadmap_todo`. Use `add`, `update`, `resolve`, or `move`; give each open item a source, severity, and either an unclosed stage in the active or a planned round, or a concrete trigger. Don't use a vague "later" target. New items go into the active round's TODO document. With no active round, a new item must target a planned round's stage and goes into that round's document. Planned-round documents can hold only TODOs for their own stages or TODOs with triggers.
- A hard-to-reverse, cross-stage decision with real alternatives belongs in an ADR, recorded with `adr_manage` (pass `stage` to link it to the stage it came from). A scope deviation isn't an ADR. Routine implementation choices and bug fixes aren't ADRs either.
- A failing test or broken build needs a fix now, not a TODO that hides unfinished work.

Use `roadmap_stage` with `action: "start"` to start a planned stage or join an active one in the active round. Stages in planned rounds cannot start or bind. Read the returned handoff before planning implementation: it carries the round's full goal, constraints and non-goals, the Delivered and Deviations text of the stage's direct predecessors (`depends_on` and `follows`), and, when omo-prometheus answers, the Atlas plans already bound to the stage with per-criterion coverage and drift. Joining doesn't grant exclusive ownership; another session may be working on the same stage. Dependencies must be closed before starting; readiness in `roadmap_status` shows which ones block. Don't bypass a refusal.

In native plan mode, which cannot commit, `start` binds a planned stage and returns its handoff without writing anything: the stage stays planned. Before implementation begins outside plan mode, call `roadmap_stage` with `action: "start"` again to start it, then commit the files it lists. Under Atlas the plugin refuses row dispatch until that start is done and committed.

## Several plans for one stage

A stage may be delivered by several Atlas plans. Each plan declares the done criteria it owns in one `Roadmap criteria: DC1, DC3` line, and its success criteria cite those ids. Before drafting, read the handoff's Plans for this stage: criteria that no plan covers yet must be covered by this plan or explicitly left for another plan. Plans live in omo-prometheus's Atlas bundles, not in `docs/roadmap/`; without omo-prometheus there is no plan section.

Drift is a notice, never a pause: a plan approved before the stage's objective, scope, done criteria or design constraints changed is flagged in the handoff, `roadmap_status` and the close reminder. Re-check such a plan against the current stage.

After a plan completes, evaluate the close in the root session: the stage closes only when every current done criterion has passing evidence, from this plan or other completed plans. Otherwise leave the stage active and report the remaining criteria. Closing while a linked plan is still unfinished is allowed, but the receipt warns and the Outcome's Deviations names the unfinished plans and their declared criteria; do it only deliberately and say why in `deviations`.

Atlas lists out-of-scope findings for triage. Record each one that should be kept as a TODO with `roadmap_todo` `action: "add"`, naming the plan and finding id in `source`, with a severity and a target stage or trigger.

## Init interview and round charter

The user starts initialization with `/init-project`. Gather facts from the repository before asking questions, and skip questions already answered. Ask focused questions rather than handing the user a questionnaire.

1. Establish project identity: name, purpose, current state, and who the work serves.
2. Define the round goal, constraints, non-goals, and principles. Principles cite ADR ids, either initial ADRs or existing ones in a managed `docs/adr/`; they never restate the decisions.
3. Identify decisions already made. Capture their context, genuine alternatives, rationale, and consequences as initial ADRs; `roadmap_init` creates them through the adr plugin in the same confirmed preview, numbered after any existing ADRs. An initial ADR's `id` is an alias that principles and stage text may cite and must not equal an existing ADR id; its `stage` names an initial stage alias. Don't invent options or approval history.
4. Break the round into stages. For each, record an objective, scope in and out, done criteria with a specific verification method, and dependencies. Separate prerequisites from work that merely follows another stage.
5. Confirm the interview summary with the user. Submit the agreed project, charter, ADRs, and stages through `roadmap_init`; let the plugin show the rendered file preview and obtain confirmation before writing. Cancellation or no answer isn't approval. Without a UI, the tool returns the preview and a `/roadmap confirm <token>` command instead of writing: show both to the user, and never run or claim the confirmation yourself. The same applies to `roadmap_round_plan`, `roadmap_round_open`, and the upgrade, drop-round and retarget command previews. When `roadmap_overlap` has no answer without a UI, ask the user and name `/roadmap overlap <stage> roadmap|free|unrelated [intent]`.

Rounds use `planned`, `active`, `closed` or `dropped`, with at most one active. Planning, revising, opening, dropping and closing rounds are user-command decisions, not autonomous agent actions. Round IDs follow creation order, never change and are never reused. No separate milestone record exists.

For future work, the user starts `/roadmap plan-round`, with or without an active round. Interview for the charter and optional target, then call `roadmap_round_plan` with `round` and optional `target`. To revise a planned round, the user runs `/roadmap plan-round R2`; include `id: "R2"` in the tool call. This flow needs an armed main session, a confirmed preview and unchanged files after confirmation. Add its stages separately through `roadmap_stage`, `action: "add"`, with `round: "R2"`; planned stages can be edited, renumbered or dropped before activation.

For later rounds, the user uses `/roadmap new-round`. If planned rounds exist, `roadmap_round_open` must activate the lowest-numbered one; optional `activate` must name it. Its charter can be retained or replaced with optional `round`. Don't draft a new round or skip ahead while a planned round remains. With none planned, provide the new `round` charter. Discuss `import_todos` with the user: only eligible trigger-based carried items are import candidates, get fresh IDs and keep their origins. Same-ID automatic carry-over is not importable again. Frozen prior rounds stay untouched.

The user can confirm `/roadmap drop-round <id> <reason>` for a planned round. Its planned stages become dropped, files remain frozen, and the drop date and reason are recorded. Move or resolve open TODOs targeting those stages and remove dependencies from other rounds before trying it. Never substitute deletion or renumbering.

### Optional targets and lazy format upgrade

Rounds and stages may have `target` dates in `YYYY-MM-DD` form. Don't invent or require dates. Overdue means a `planned` or `active` item's target is earlier than today's UTC date; completed or dropped items aren't overdue. A target doesn't replace actual opened, started or closed dates and doesn't bypass any close gate.

Initialization writes format 2, so a new repository needs no upgrade. Repositories initialized by earlier releases are format 1; updating the plugin or running `check --fix` doesn't upgrade them. New features require repository format 2, confirmed by the user. In a format-1 repository the main session asks the user once each time a session is entered (start or switch) with a one-step Yes/No dialog; without a dialog it shows one notice naming `/roadmap upgrade` instead. The user can also run `/roadmap upgrade` or accept the warning in the first `/roadmap plan-round` preview. When a task needs a format-2 feature mid-session, call `roadmap_upgrade`: it opens the same dialog, writes the upgrade only on Yes, reports a No without writing, and refuses without a dialog or in a subagent. Explain the warning that **roadmap plugin 0.2.3 and earlier can no longer read the repository**. Other agent tools refuse new features in format 1 with upgrade guidance; never change the marker yourself, and don't re-ask after the user said No in this session.

The upgrade changes the root marker and directory explanation, not every managed file. Existing files retain format 1 unless a later write needs a format-2-only field. Frozen/closed history isn't rewritten. A format-2 repository can contain both formats; each file's managed comment must match its own format.

Use optional `target` on stage `add`, planned-stage `edit` or active-stage `amend`; an amendment still needs its reason. The user can also confirm `/roadmap retarget <round-or-stage> <YYYY-MM-DD|none>` for unclosed work in a format-2 repository. `none` clears the date. Without a UI, upgrade, drop and retarget require the user's `/roadmap confirm <token>` response like other held previews.

## ADRs

ADR judgment, review and every ADR mutation belong to the adr plugin: read its `adr` skill and use `adr_manage`. Roadmap reads ADRs through that plugin for principle citations, the handoff's Cited ADRs and close gates, and moves stage links when a planned stage is renumbered. ADRs remain available between rounds.

## Close a stage or round

1. Read the current stage with `roadmap_status`. Compare its amended scope and criteria with the actual code and delivered behavior.
2. Gather evidence for every done criterion: criterion id, `pass` or `fail`, method, observed summary, and a commit reference when useful. A general "tests passed" statement doesn't prove unrelated criteria. Failed or missing evidence means the stage isn't ready to close.
3. Disposition every open TODO targeting the stage: resolve it with a reference, or move it to another valid target or trigger. Record carry-over honestly rather than marking it resolved.
4. Have the main agent settle every proposed ADR linked to the stage with `adr_manage` (`set_status` accepted or rejected). Close refuses and lists them while any is proposed; a subagent cannot settle them and must return to the main agent.
5. Call `roadmap_stage` with `action: "close"`, delivered work, deviations, per-criterion evidence and TODO dispositions. The Outcome records the linked ADRs' statuses. The hard gate decides whether closure succeeds; don't replace it with direct edits or claim success after a refusal.

If a completion reminder appears after an Atlas plan completes, its gate verdicts are evidence candidates: map each relevant result to a criterion and verify gaps. The reminder also shows per-criterion coverage across every plan for the stage, unfinished plans, plans with undeclared coverage, drift and untriaged deferred findings, and whether a complete plan declares every current criterion. Plan completion never closes the stage by itself.

For abandoned planned or active work, use `roadmap_stage` with `action: "drop"` and a reason after moving or resolving its targeted TODOs. Don't pretend it was delivered. Use `action: "renumber"` only for planned stages; don't evade refusals involving closed or frozen references.

The user closes a round with `/roadmap close-round` only after every stage is closed or dropped and document checks pass. Open TODOs targeting planned-round stages are carried automatically into those rounds' TODO documents with the same IDs and targets. The destination records `carried_from`; the source becomes `carried` with a reference to that round. These items don't appear in the disposition dialog and cannot be imported again. The same ID can continue through later rounds, such as `R1 → R2 → R3`; check validates each link and allows only one non-carried occurrence.

Closing a round records how its goal turned out: an assessment (`achieved`, `partial`, `not_achieved` or `cancelled`) and a summary, written into the round's Outcome. Format-2 repositories require it. In a format-1 repository the close dialog first offers the one-step format-2 upgrade; skipping it closes the round without an outcome. Earlier closed and dropped rounds are never rewritten.

Each remaining open TODO needs a disposition: resolved with a reference, explicitly wontfix, or carried for later consideration. Trigger-based carried imports get fresh IDs through `roadmap_round_open`. Closure freezes the round directory in place. Without a UI, supply `/roadmap close-round outcome=<assessment>:<summary> <todo>=<disposition>[:<reference>] ...`, with the outcome required in format 2 and dispositions only for the items needing manual ones; quote text with spaces.

When moving an open item out of a planned round's TODO document to another round, the tool leaves the old item as `moved` referencing a fresh TODO ID in the destination document. The new item records the old ID and origin in `carried_from` and keeps the requested target. A move to another planned round goes directly to that round even if another round is active. Treat it as linked history, not an in-place retarget or another same-ID carry hop.

## Overlap and free work

In a free session, the main agent calls `roadmap_overlap` with the candidate stage and the user's intent when a request appears to match an unclosed stage. Overlap detection depends on the agent noticing; it isn't a classifier. Closed and dropped stages aren't candidates.

The plugin asks once per stage per session, and remembers the answer across compaction:

- **Use the roadmap** starts or joins the stage, binds the session, and returns its handoff. In plan mode it only binds a planned stage, as `start` does there.
- **Free work** leaves the session outside that stage and appends a line to its Free-work log. When the stage is later started, verify in code what already exists before planning duplicate work. The log isn't completion evidence.
- **Unrelated** records the false positive without binding the session.

An already-bound stage returns in-system with its handoff, without a dialog or free-work entry, even without a UI; its binding takes precedence over an earlier free/unrelated answer. A stage bound in plan mode and still planned starts when the overlap is answered again outside plan mode. Otherwise don't re-ask after a stored answer. Without a UI, no answer is recorded; don't choose for the user. Subagents don't conduct this overlap dialog.

## Consistency and recovery

Use `roadmap_check` for document consistency, or `/roadmap check`. **Check cannot detect code/document drift.** Compare actual code and behavior at stage boundaries and during closure; a clean check doesn't prove delivery. Cross-clone id collisions are detected, not prevented.

Writes are atomic per file, not per operation. An interrupted multi-file operation can leave intact individual files but stale indexes. Check reports the inconsistency. Use `roadmap_check` with `fix: true`, or `/roadmap check --fix`, to regenerate generated blocks and indexes; it doesn't repair arbitrary content or touch frozen rounds. Restore other damage with `git`, preserving unrelated work and user edits. Never bypass the tools to repair managed files.

## Status surfaces

Turn context stays bounded and is injected only while a round is active, with up to 12 stages, one readiness line naming startable and blocked planned stages, and compact planned-round summaries. With no active round, consult `roadmap_status` rather than assuming no planned work exists. Only stages in the active round can bind to a session or participate in the Prometheus binding contract; that contract stays version 1 and its stage answer additively carries the current criterion ids and planning-basis revision.

The output-only `roadmap/status` sidecar stays version 1. Additive fields include repository `format`, `plannedRounds` entries with ID, title, target, overdue, stage count and open TODO count, active-round target/opened/overdue, stage target/started/closed/overdue, and derived stage readiness (`dependsOn`, `blockedBy`, `startable`). Read managed documents through the tools for decisions; don't edit the sidecar or treat it as an input store.
