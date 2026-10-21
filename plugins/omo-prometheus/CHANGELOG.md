# Changelog

## Unreleased

### Features

- Plans name a `Tier: LIGHT | HEAVY` per task and an optional plan-level `Delivery: direct | pr | ship` line. LIGHT rows finish on their own child's evidence; a HEAVY row finishes only after a distinct fresh verifier child returns a structured `PASS` through the new `atlas_ledger verify` action, and a `FAIL` reopens it with the verifier's summary for the next attempt.
- `atlas_ledger discover` records in-scope defects found mid-execution as `D` rows that every gate waits for (refused once a gate has started), and out-of-scope findings as deferred entries for the final report.
- `Delivery: pr` and `ship` add a `P1` row after every gate and fix row; a child pushes and opens the pull request (and for `ship` waits for CI and merges). `atlas:completed` follows P1 and carries an optional `delivery` summary.
- Atlas may spawn read-only research children without a ledger row; read-only capability comes from each agent's live definition, and their output never counts as evidence.
- Under host `task.isolation.enabled`, every T, D, X and P1 dispatch must pass `isolated: true`. A host `task.isolation.merge: patch` would leave each child's work uncommitted and drop its commits, so Atlas switches it to `branch` as a runtime override while it executes and restores it on exit; the saved setting is never written.
- Since omp 18.10.2 the `task` tool drops `outputSchema` and `schemaMode` unless `task.structured` is on (default off), which left every gate and HEAVY verifier undispatchable. Atlas now turns `task.structured` on as a runtime override while it executes and restores it on exit; the saved setting is never written.
- Atlas gains `atlas_git`, its only git surface: `status`, `diff`, `log` and `show`, plus `commit` of explicitly named files with a message Atlas writes. Atlas uses it to commit files a roadmap step changed and finished work a child left uncommitted. Commits refuse directories, pathspec magic and any call while a bound child is still running; the tool is active only during Atlas execution and refuses every caller but the executing Atlas main session.
- Workspaces that are not Git repositories are supported end to end: planning, review and execution are told the workspace has no Git, plans use `Commit: none` and `Delivery: direct`, children are told never to commit or run `git init`, `atlas_git` refuses with an explanation, and host isolation is no longer demanded there, since the host cannot isolate outside Git and every implementation dispatch used to be refused.
- The Atlas prompt follows upstream ulw-execute: structured done-claims judged against a checklist (existing tests first, reproduction before a fix, no tests-only or `--dry-run` evidence, tier-scaled adversarial classes, cleanup receipts), a blast-radius rule for discovered work, a stop after three materially different failed attempts, and read-only gates with an F2 severity scale, artifact-backed F3 passes, and an F4 that approves unless a success criterion or ideal-state row is cited as failed. Gate reruns get the prior rejection and the diff since; two failed reruns of one gate ask the user.
- Ledger version 5 and checkpoint version 2 upgrade earlier bundles on load: rows become LIGHT, discoveries and deferred findings start empty, and delivery is derived from the approved plan, so in-flight plans resume without fresh approval. Herdr DAG rows gain `discovered` and `delivery` kinds with `tier` and `verification`, the todo mirror adds `Atlas discovered` and `Atlas delivery` phases, and the state sidecar adds tier, verification, discoveries, the deferred count, and the delivery mode.
- Atlas progress guard: every changed-row `atlas_ledger` result opens with the `todo` call that redraws the host HUD and shows a compact ledger (`status` keeps the full table). While `todo` is active, `task`, `wait` and `atlas_release` are refused until that call is made, and a row whose child already has a final result must be recorded (`done`, `block`, `reopen`) or given a replacement child before Atlas dispatches other work or waits.

### Fixed

- Bind execution to the exact approved plan, retain acceptance criteria, reject dependency cycles, and pause on unavailable or invalid ledgers instead of falling back to unguarded execution.
- Authenticate completion with native owned-child results and persistent receipts; require distinct fresh structured gate verifiers, with F1–F4 running together and a rejecting gate rerunning alone after its fix rows.
- Reopen and block affect only the named row, serialize ledger updates with atomic file replacement, and reopen historical completions lacking proof on resume.
- Require final native task success after isolation postprocessing; reject early completion events and invalidate older receipts without final-result proof.
- Accept a gate or verifier `outputSchema` sent as JSON text, the only form models on strict tool-schema providers such as OpenAI Responses can send; every such dispatch used to be refused.

## [0.22.4](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.22.3...omo-prometheus@0.22.4) (2026-10-21)


### Bug Fixes

* **omo-prometheus:** make Atlas start and commit a planning-bound stage before dispatching rows ([3e93978](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3e9397880b2e23565411a8d550384d6c8af8ede0))
* **omo-prometheus:** tell Atlas to send dispatch after the todo refresh, not beside it ([aa6f0a4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/aa6f0a44175c79620e1650f46e63adc77daed732))

## [0.22.3](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.22.2...omo-prometheus@0.22.3) (2026-10-16)


### Bug Fixes

* **omo-prometheus:** stop idle children woken by a peer from blocking Atlas commits and plan release ([90d60a9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/90d60a91e76e238bb6ca6fbb850a0407226a4182))

## [0.22.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.22.1...omo-prometheus@0.22.2) (2026-10-14)


### Bug Fixes

* **omo-prometheus:** accept gate and verifier output schemas sent as JSON text ([12de784](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/12de78423745fbabd53c0c6dd8b91bb09d3ff15c))
* raise supported OMP floor to 18.10.4 ([9bdda2e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9bdda2ea3a1c547f8cd3447439819654ba448182))

## [0.22.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.22.0...omo-prometheus@0.22.1) (2026-10-13)


### Bug Fixes

* **omo-prometheus:** turn on structured task results while Atlas executes ([9a1ceb0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9a1ceb07c36e035427a21dea731ea244d8185e57))

## [0.22.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.21.0...omo-prometheus@0.22.0) (2026-10-11)


### Features

* **omo-prometheus:** add an opt-in progressReports setting for Atlas ([743e4e7](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/743e4e79e37d1c7c63805757242ad2ae7cda4d6e))
* **omo-prometheus:** give Atlas progress reports a fixed field layout ([fbefd7c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/fbefd7ccada0675aa8bf7625a8c6bc3f51f334f9))
* **omo-prometheus:** hold Atlas questions until only blocked rows remain, then ask ([ae7c04e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ae7c04ed8802288f609e43bc9a59802b666f4bc0))


### Bug Fixes

* **omo-prometheus:** keep Atlas from treating blocking questions as optional to avoid asking ([4fde398](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/4fde398b062771626d5b3c381f84bbaf88fc7253))

## [0.21.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.20.1...omo-prometheus@0.21.0) (2026-10-10)


### Features

* **omo-prometheus:** make Atlas refresh todos and record finished children before moving on ([a9ebcf9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a9ebcf9fd20f25091a49c265cc3a20d21c45564c))

## [0.20.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.20.0...omo-prometheus@0.20.1) (2026-10-10)


### Bug Fixes

* make command completions distinct and name command arguments ([74a4cc2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/74a4cc2686e61492ba8d3f0210c1b8042b7cf9c7))

## [0.20.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.19.0...omo-prometheus@0.20.0) (2026-10-10)


### Features

* **omo-prometheus:** declare roadmap criteria per plan, answer atlas:plans and notice stage drift ([80bfe90](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/80bfe9058df210d3f818335998d370fef421de18))
* **omo-prometheus:** let Atlas use adr plugin tools through their own provenance handshake ([792b691](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/792b6913bc8ed50477c9cf6dcc19698c52b41b64))
* **omo-prometheus:** number deferred findings and require their triage before atlas_release ([bc38756](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/bc387567ae816f3bf1046a571c8b25c17e743a97))


### Bug Fixes

* **omo-prometheus:** judge batch children by their own results and drop pre-18.5 host fallbacks ([be8f0a5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/be8f0a5e6fd534c148b43ac5490a17ab176ad36a))
* **omo-prometheus:** keep Git out of planning and execution in workspaces without a repository ([3a0894b](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3a0894b31c8e18962c5bb4ab0fc732c2ef22c46f))
* **omo-prometheus:** triage deferred findings by whether the roadmap is usable in the repository ([636adc8](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/636adc89a1d4faa374d12aa30f709646fd1d976e))
* raise supported OMP floor to 18.5.1 ([217da70](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/217da70c138e3a5bd0ccaa0f7e1b3fb03b7d1b0f))

## [0.19.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.18.0...omo-prometheus@0.19.0) (2026-10-09)


### Features

* **omo-prometheus:** give Atlas a guarded git tool for inspection and named-file commits ([33a181e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/33a181e645ed1a5ec98567f0da0c5ae0aac1c136))


### Bug Fixes

* **omo-prometheus:** run isolated Atlas children with branch merges so their commits land ([288b53c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/288b53c2ab47cba11ef90f4dac966ef496849754))

## [0.18.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.17.1...omo-prometheus@0.18.0) (2026-10-09)


### Features

* **omo-prometheus:** add a delivery setting that picks the plan delivery mode or asks ([f3e60de](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/f3e60ded11cb49029677db090867084f657ddcd9))
* **omo-prometheus:** add ledger v5 with tiers, HEAVY verification, discovered rows, and PR delivery ([798ddf2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/798ddf2c7478c8f287f851563fb7b5302e5132a0))
* **omo-prometheus:** anchor planning on the affected user's ideal state with tiered tasks, QA contracts and delivery mode ([8cf7c45](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8cf7c45105e8fa068eeea08075daab6c4c070e8a))
* **omo-prometheus:** enforce a configurable plan-review round limit ([824dc62](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/824dc620c423a38fe66b31718778659a2c00bde2))


### Bug Fixes

* **omo-prometheus:** bind plan reviews to the plan file instead of an inline copy ([532229d](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/532229d362234086dae40d98813986e3ab6a49d1))

## [0.17.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.17.0...omo-prometheus@0.17.1) (2026-10-09)


### Bug Fixes

* **omo-prometheus:** read prompt assets at load so plugin upgrades don't break running sessions ([2a3ad79](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/2a3ad794dbde92d783340b9b6ab844eee5edd606))

## [0.17.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.16.0...omo-prometheus@0.17.0) (2026-10-09)


### Features

* **omo-prometheus:** retitle the session through the host title generator when Atlas enters a plan ([b59debe](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/b59debebedf8185c63ac4deeb895cabeb47b5138))


### Bug Fixes

* **omo-prometheus:** complete /atlas subcommands with descriptions ([d0bb424](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/d0bb42452b9b094b9afaaf0e832d0edfba95a83c))

## [0.16.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.15.1...omo-prometheus@0.16.0) (2026-10-08)


### Features

* **omo-prometheus:** show the atlas model role as ATLAS in green ([6bccd6e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6bccd6e1df4c46dc75b40508bd808231c53770e5))

## [0.15.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.15.0...omo-prometheus@0.15.1) (2026-10-08)


### Bug Fixes

* **omo-prometheus:** bind F1 to the approved plan file instead of an inline copy ([173285f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/173285fd97c3d9924fe7cc41f80d3230c8e84302))

## [0.15.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.14.0...omo-prometheus@0.15.0) (2026-10-08)


### Features

* **omo-prometheus:** let Atlas pick a listed agent when a plan's agent is gone ([e2a06b3](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e2a06b3a5879eeebd541b9d693c0dd852a2bbf66))

## [0.14.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.13.1...omo-prometheus@0.14.0) (2026-10-07)


### Features

* **omo-prometheus:** collect read-only git evidence for the F1 compliance gate ([a708bcd](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a708bcdaab0391dbee0ec3ab7aa349178ec987fe))


### Bug Fixes

* **omo-prometheus:** let Atlas use authenticated roadmap devices and bind late-started stages ([6829cb1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6829cb14fe30f4c31c2249f61c8184d80fb301ac))

## [0.13.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.13.0...omo-prometheus@0.13.1) (2026-10-07)


### Bug Fixes

* write plugin state sidecars to a private runtime directory instead of the session directory ([ad085bc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ad085bce8fe43c78de16625d9a3e821d6f69e16d))

## [0.13.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.12.0...omo-prometheus@0.13.0) (2026-10-07)


### Features

* **omo-prometheus:** run /atlas without the terminal UI and publish workflow state for clients ([479ad22](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/479ad2213c7ac909cad4a1bd16cd0e4549b19c56))

## [0.12.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.11.1...omo-prometheus@0.12.0) (2026-10-06)


### Features

* **roadmap:** prometheus binding and completion contract ([f68c4eb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/f68c4ebe7c6ce9d18f2486394dc7c3ff05220d0c))


### Bug Fixes

* **omo-prometheus:** permit authenticated roadmap stage closure ([ac8e81f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ac8e81f4edcea32a16ed1b5eaa8e06f7566c4238))

## [0.11.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.11.0...omo-prometheus@0.11.1) (2026-10-06)


### Bug Fixes

* **omo-prometheus:** let Atlas use extension-wrapped todo ([6966256](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6966256caf877a15c71eb4b8b6b482cac6c624dd))

## [0.11.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.10.0...omo-prometheus@0.11.0) (2026-10-04)


### Features

* **omo-prometheus:** publish session-scoped Atlas DAG events ([fb642ae](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/fb642aee6612253bf12b3b50ad62cdc1cc719e2e))


### Bug Fixes

* raise supported OMP floor to 18.3.5 ([3872df5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3872df5c97904b74f5e42a35d9c79efdb881ff64))

## [0.10.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.3...omo-prometheus@0.10.0) (2026-10-01)


### Features

* **omo-prometheus:** let Atlas use read-only and memory native tools ([ccf05d6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ccf05d65fe0c783a330bba3666c69c490ae2de81))


### Bug Fixes

* **omo-prometheus:** let Atlas use Magic Context memory tools ([1c28643](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1c2864398737130d6ec97b07ac5a06f6d2e62b46))

## [0.9.3](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.2...omo-prometheus@0.9.3) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** scroll the Atlas view with the mouse wheel ([3f2b9a5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3f2b9a54b66557549e2201d50683c5f6e4e3eee4))

## [0.9.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.1...omo-prometheus@0.9.2) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** refuse proposals whose plan Atlas cannot execute ([35fd468](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/35fd468bf560cd1e21d743ebac9949c0899a49aa))

## [0.9.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.0...omo-prometheus@0.9.1) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** don't treat compaction after Save and quit as plan approval ([1a1d3f1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1a1d3f1468f69ccebadfb1d08792eb63f110a417))
* **omo-prometheus:** keep Prometheus planning when the host restores plan mode ([1fb9e0f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1fb9e0fcb2d52f2aed3257a7a3f0d487718b6aca))

## [0.9.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.8.0...omo-prometheus@0.9.0) (2026-09-30)


### Features

* **omo-prometheus:** persist Atlas observation timeline ([76fed51](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/76fed5161ee9b3699541f45b7bcf1280d6031ddd))
* **omo-prometheus:** render live Atlas plan activity ([9658f05](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9658f05d2f7ba268ccda1b1be18ab1208bc31b2f))
* **omo-prometheus:** show configurable Atlas status widget ([d17bcbf](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/d17bcbfcfe285eedf8139360a99b18c9f32c1ffe))


### Bug Fixes

* **omo-prometheus:** keep Atlas live page scroll per body and list waiting rows in the widget ([1625908](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/162590850b1e7db0c70dd3fa6ab96f3dbd828f52))
* **omo-prometheus:** preserve Atlas todos through HUD refresh ([09a6286](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/09a6286b24c0dccbd75ad5a3b1b0c318f67844fd))
* **omo-prometheus:** render Atlas row evidence and acceptance as Markdown ([80b5ea2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/80b5ea244eb3c9fbbb1943383e6dcd76ed849c3c))
* **omo-prometheus:** synchronize Atlas ledger with session todos ([e0cf6cb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e0cf6cb31bbdaf8965a2c1ae7bd3ab38cd6a21e3))

## [0.8.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.7.0...omo-prometheus@0.8.0) (2026-09-30)


### Features

* **omo-prometheus:** fix gate rejections with new rows instead of reopening finished work ([ab922ec](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ab922ec1e25b3ee4f12eebe2e12d7ce744db23d2))
* **omo-prometheus:** show the running plan on /atlas and move exit to /atlas exit or Shift+X ([5b68764](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5b68764a422b1c8e54fce5018923195e07827da7))

## [0.7.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.6.0...omo-prometheus@0.7.0) (2026-09-29)


### Features

* **omo-prometheus:** frame the /atlas menu with native OMP panel chrome and aligned progress ([08391df](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/08391df63180fde929ccfd7c728920b566ceb468))
* **omo-prometheus:** turn /atlas into Atlas Dispatch with auto-start, session resume and a fullscreen plan view ([39e63db](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/39e63db946caf292a8cd31d8a489fb380455c771))


### Bug Fixes

* **omo-prometheus:** refuse /prometheus when OMP plan mode is disabled in settings ([49fd2b7](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/49fd2b77ad85a57ab52b94288d43de95e1ad102f))
* **omo-prometheus:** render /atlas menu glyphs from the active OMP symbol preset ([293b46b](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/293b46b7d20cff57ebf89fd28c994e0e4cfb29e4))

## [0.6.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.5.0...omo-prometheus@0.6.0) (2026-09-29)


### Features

* **omo-prometheus:** add an interactive /atlas plan menu with search, rename and delete ([0d190bc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0d190bc4fcb80a98e5f0308ae2e4e13e1e568876))
* **omo-prometheus:** confirm early Atlas exit and refuse plan switching while active ([7aa47e4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7aa47e45a47fb04b67c46af5f420f51233ebc8e3))


### Bug Fixes

* **omo-prometheus:** hand off approved Atlas plans through a scoped URL ([8ee69b5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8ee69b565cd36b1eff4eaf0037521ff8673c32d5))
* **omo-prometheus:** keep the atlas tier out of Ctrl+P while approval shows it ([a63bad9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a63bad94120d5238939f2090f9d58e7cca0fd63e))

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.4.0...omo-prometheus@0.5.0) (2026-09-29)


### Features

* **omo-prometheus:** add an atlas model role for approval and /atlas entry ([aeceec8](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/aeceec8a9eef73757a9acac06983692aad861ca4))


### Bug Fixes

* **omo-prometheus:** accept host-formatted approval handoffs and plan file names in /atlas ([da2d285](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/da2d285a3346e80883faabefae4de1f51b040b07))

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.2...omo-prometheus@0.4.0) (2026-09-29)


### Features

* add shared Atlas execution and cross-session resume ([c2d64d2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c2d64d27c59519387779687599f2078df2aa6e3f))


### Bug Fixes

* restore approved plan reference when resuming a session ([7956033](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7956033c8789230748ba9f6e392d39811ce7befe))

## [0.3.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.1...omo-prometheus@0.3.2) (2026-09-29)


### Bug Fixes

* **omo-prometheus:** let Atlas message and cancel child agents ([8788bc0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8788bc0ebcaf3550e595efe7cd5c2bf5be03250e))

## [0.3.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.0...omo-prometheus@0.3.1) (2026-09-28)


### Bug Fixes

* **omo-prometheus:** bind completion to verified child evidence ([b5856b9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/b5856b9d02f676af05c88d54de432608a47dd92e))
* **omo-prometheus:** require final native execution success ([516c1ea](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/516c1eae01d04eefab8cb45866acb0a72c47d2a2))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.2.0...omo-prometheus@0.3.0) (2026-09-28)


### Features

* **omo-prometheus:** run final gates on fresh children and gate metis and momus to planning ([5ae80f9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5ae80f9dbd5d4a3ba33f1ce4208679beb3fe4662))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.1.0...omo-prometheus@0.2.0) (2026-09-28)


### Features

* **omo-prometheus:** add configurable plan review level ([63cf177](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/63cf1773d9b3115c46b600be16f64d85998816f9))
* **omo-prometheus:** resolve plan agents against installed agents ([4c204aa](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/4c204aaa6cb3e988932abf04b8bc9c41c0cfa497))
