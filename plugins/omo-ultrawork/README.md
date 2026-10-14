# omo-ultrawork

English | [简体中文](README.zh.md)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO)'s ultrawork workflow, adapted for OMP. Typing `ulw` in a message switches the agent into outcome-first execution: it delivers the request end to end and backs each success criterion with evidence observed on the real surface. The plugin also adds `mass-ulw` for dependency-ordered fan-out, `/hyperplan` for adversarial planning, and `/ulw-research` for cited research reports.

## Install

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. `/ulw-research` also needs `node` on `PATH` to build its report. Restart the session after installing.

## Quick start

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-research compare SQLite WAL and rollback journal for our workload
```

The first reply in ultrawork mode starts with `ULTRAWORK MODE ENABLED!`, and the footer shows `Ultrawork armed` or `Ultrawork mode`.

## Usage

### Ultrawork mode

Typing `ulw` or `ultrawork` as a standalone word injects the hidden ultrawork directive ahead of your message. Later triggers in the same session add only a short reminder, since the directive is still in context; after compaction the full directive comes back on the next trigger. Keywords inside inline code, fenced blocks and slash commands do not count.

If the session is busy, the hidden directive or reminder is sent as an aside that explicitly applies from your next/queued message, not the work already in progress. After the first successful todo `init` or `append` while armed, the fan-out reminder is attached to the tool result as trusted context once; compaction rearms it.

`/ultrawork` or `/ulw` turns on persistent mode, so every message gets ultrawork without a keyword. Run either command again to turn it off. `/ultrawork <request>` turns the mode on and sends the request as your next message.

The footer shows `Ultrawork mode` while persistent mode is on and `Ultrawork armed` after a keyword trigger. Mode and arming are saved in the session and restored on resume, switching, branching and tree navigation.

OmO documents the original in [Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy).

### Do not combine with `orchestrate`

OMP's built-in `orchestrate` keyword injects its own rules, which contradict ultrawork on commits, verification and delegation. When a message contains an `orchestrate` that OMP would act on, this plugin injects nothing for that message and shows a warning; persistent mode resumes with the next message. `/ultrawork orchestrate …` refuses to turn on persistent mode. If you use ultrawork regularly, disable the built-in keyword:

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` is a skill for running a dependency graph of subagent tasks (`{ id, prompt, agent, dependsOn?, label? }`) through `eval`. It validates ids, dependencies and cycles before launching anything, runs one batch of ready nodes at a time, and reads their reports before the next batch. A final verification step checks the evidence, since a finished child is not yet accepted work. Status and reports survive a kernel reset.

Typing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw` or `meth` points the agent at the skill; `mulw` and `meth` do not arm ultrawork on their own. For independent work without dependencies, one plain `task` batch is simpler.

OmO documents the original in [Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw).

### /hyperplan

`/hyperplan <request>` runs a three-round adversarial debate among five critics, each attacking the draft from one side: needless complexity and scope creep, integration gaps and edge cases, unverified assumptions, architectural flaws, and missed alternatives. A separate planner then turns the outcome into a plan. Its first line is `HYPERPLAN MODE ENABLED!`.

OmO documents the original in [Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan).

### /ulw-research

`/ulw-research <request>` builds a claim graph through expansion and counter-search, writes a cited synthesis, runs ordered QA gates and checks the deliverable. Scratch files go to `<tmpdir>/ulw-research/` or `researchScratchDir`; the final report goes wherever you asked. Its first line is `ULW-RESEARCH MODE ENABLED!`.

OmO documents the original under `ulw-research` in [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets).

Both commands reject an empty request and run only in the main session.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-ultrawork`.

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | When false, typed keywords do not trigger ultrawork. The `mass-ulw` pointer and the commands still work. |
| `keywords` | comma-separated string | `ulw,ultrawork` | Case-insensitive whole-word triggers. An empty string disables keyword triggering. |
| `researchScratchDir` | string | empty (`<tmpdir>/ulw-research`) | Root for research scratch files. Relative paths resolve against the session's working directory. |

Settings are read at session start and on session switch, so restart the session after changing them.

## Working with other plugins

- With `omo-toolkit` installed, `/hyperplan` and `/ulw-research` use its category agents (`deep-low`, `ultrabrain`, `artistry`, `librarian`, `writing`); without it they fall back to `task` and `scout`, and every command still works.
- With `omo-prometheus` installed, ultrawork defers to an approved `/prometheus` plan instead of writing its own.

## Without the terminal UI

The keyword and all commands work in RPC, ACP editors, the SDK and headless runs; none of them needs a dialog. Without a UI, usage errors and mode changes appear as visible session messages.

Client programs can read the mode from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Keywords in messages generated by extensions, and in child sessions, are ignored.
- The `/hyperplan` and `/ulw-research` procedures are private prompts, not skills, so neither you nor the model can open them through `skill://` or `/skill:`. `mass-ulw` is the only skill this plugin exposes.
- Upgrading the plugin removes the installed copy a running session loaded, so `/ulw-research` reports that its scripts are gone until you restart OMP. The other prompts are read when the plugin loads and keep working.

## Reference

[REFERENCE.md](REFERENCE.md) covers keyword and delivery rules, the agents each command uses, `mass-ulw` persistence and the state snapshot.

## License

Extension code and original packaging are MIT. Modified prompt assets and the vendored research scripts are SUL-1.0. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
