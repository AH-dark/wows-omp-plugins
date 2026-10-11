# AGENTS.md

High-signal notes for working in this repo.

Official omp mechanics — commands, catalog schema, loader behavior — live in the
bundled docs (`omp://marketplace.md`, `omp://skills/authoring-marketplaces.md`,
`omp://extension-loading.md`) and move with each release. Look them up there.
This file records only what those docs cannot: decisions specific to this repo,
and behavior verified by hand in it.

## What this repo actually is

An **omp marketplace**, not an application. It is a Git repository whose catalog
at [.omp-plugin/marketplace.json](file:///./.omp-plugin/marketplace.json) lists
plugins that users install with `omp plugin install <name>@wows-omp-plugins`.

It is deliberately **not** a monorepo: no workspaces, no shared runtime package.
Plugins are plain directories under [plugins/](file:///./plugins/). The catalog
and the directory layout are the only coupling between them.

```
.omp-plugin/marketplace.json   the catalog — source of truth for what ships
plugins/<name>/                one plugin, copied verbatim to the user's machine
src/                           repo tooling and tests; never shipped to users
REFERENCE*.md                  plugin-state snapshot envelope shared by plugins
```

## Commands

| Want to                       | Run                    |
| ----------------------------- | ---------------------- |
| Install dev dependencies      | `bun install`          |
| Lint + format check           | `bun run check`        |
| Lint + format, writing fixes  | `bun run check:fix`    |
| Type check                    | `bun run check-types`  |
| Verify catalog matches `plugins/` | `bun run check-catalog` |
| Run tests                     | `bun run test`         |

## CI and releases

- `.github/workflows/ci.yml` runs lint, the catalog check, type check, and tests
  on every push and PR. Types and tests run twice: against the omp version in
  `bun.lock` and against 18.5.1, the oldest host the plugins support. Raise
  that matrix entry only together with the documented floor. Types and tests
  are skipped for the release PR, for its `chore: release main` merge, and for
  changes that touch only `README*.md`, `REFERENCE*.md`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, or `AGENTS.md`, since no test reads those files. If a
  test starts reading one, narrow the filter in the `scope` job.
- `.github/workflows/release.yml` runs release-please on `main`. Versions come
  from Conventional Commits scoped by path: a `feat`/`fix` touching
  `plugins/<name>/` bumps that plugin only. The release PR updates the plugin's
  `package.json`, `.omp-plugin/plugin.json`, its catalog entry, and its
  `CHANGELOG.md` together, so never bump versions by hand. Merging the PR tags
  `<name>@<version>` and publishes a GitHub Release.
- The release PR is pushed with `GITHUB_TOKEN`, which triggers no workflows, so
  `release.yml` calls `ci.yml` on the PR branch itself, running lint and the
  catalog check only. Before merging, check that run and the `main` CI run for
  the commit the release PR was cut from; the PR shows no status checks.
- Plugin JSON manifests and `.release-please-manifest.json` are formatted with
  expanded arrays (`biome.json` override) because release-please rewrites them
  that way.

## The constraint that governs everything

Marketplace installation **copies the plugin directory and symlinks it** into
`~/.omp/plugins/node_modules/` (or the project plugin root). It never runs
`bun install` for the plugin. Consequences, all load-bearing:

- A plugin **must not declare runtime `dependencies`**. Bare imports of
  third-party packages will fail on the user's machine. Only `@oh-my-pi/*` host
  packages resolve, and only because the loader rewrites them.
- A plugin **must not rely on the repo-level `@/*` tsconfig alias**. `tsconfig.json`
  stays here; the copied plugin never sees it.
- Cross-plugin shared code is a trap for the same reason. Duplicate it, or accept
  that a workspace symlink only exists on this machine.

Inside a plugin, alias imports go through its own `package.json` `imports` map,
which travels with the copy:

```json
"imports": { "#src/*": "./src/*" }
```

Node rejects keys that are exactly `#` or start with `#/`, so the alias needs a
name segment — `#src/*`, not `#/*`.

## Path aliases

- `@/*` → `./src/*` — repo tooling only (`src/check-catalog.ts` etc.)
- `#src/*` → `./src/*` — inside each plugin, declared per plugin

## Adding a plugin

1. Create `plugins/<name>/` (lowercase, digits, hyphens, dots; must start and
   end alphanumeric; max 64 chars).
2. Add `.omp-plugin/plugin.json` and `package.json`. Keep the versions in both
   equal to the catalog entry — `bun run check-catalog` fails on drift. Start at
   `0.1.0`.
3. Add content in the conventional directories: `skills/<name>/SKILL.md`,
   `commands/*.md`, `agents/*.md`, `hooks/pre|post/`, `tools/`, `.mcp.json`.
4. Declare a TypeScript extension entry in `package.json` under `omp.extensions`.
   Content-only plugins omit `omp.extensions`.
5. Write `plugins/<name>/README.md` and `README.zh.md` for the installing user,
   following the shared outline (what it does, install, quick start, usage,
   settings, working with other plugins, without the terminal UI, known
   limitations, reference, license). Put schemas, event contracts, storage formats and
   other maintainer or client-author detail in `plugins/<name>/REFERENCE.md`
   (and `.zh.md`), linked from the README. English is the source; the Chinese
   file mirrors its sections. Both ship with the plugin.
6. Add the entry to [.omp-plugin/marketplace.json](file:///./.omp-plugin/marketplace.json)
   with `"source": "./<name>"` — `metadata.pluginRoot` already prepends `./plugins`.
7. Add a row to the root README plugin table pointing at the new plugin README.
8. Register the plugin with release-please: a `packages` entry in
   `release-please-config.json` (copy an existing one; its extra-files keep
   `plugin.json` and the catalog entry in step) and its version in
   `.release-please-manifest.json`.
9. Run `bun run check-catalog && bun run check-types && bun run check`.

[plugins/judge-dispatch/](file:///./plugins/judge-dispatch/) illustrates a
dependency-free extension with manifest-backed settings;
[plugins/omo-prometheus/](file:///./plugins/omo-prometheus/) illustrates
runtime assets and agents.

## Extension authoring gotcha

`registerTool` infers `Static<TParams>` as `unknown` for schemas built with the
injected `pi.zod` builder. Declare the schema separately and annotate `execute`:

```ts
const parameters = z.object({ text: z.string().describe("Text to count") });

pi.registerTool({
  // ...
  parameters,
  async execute(_id, params: typeof parameters.infer) { /* ... */ },
});
```

`pi.typebox.Type.Object(...)` infers without the annotation if you prefer it.

Any `tool_call`, `tool_result` or `tool_approval_*` handler turns off the host's
speculative batch `task` launch and speculative reads for the whole session
(omp 18.4.3+). Register them only when the plugin must block or rewrite a call;
a plugin that only observes results listens to `tool_execution_end` instead, as
omp-herdr-dag does. Guidance for the model after a tool runs goes through the
`tool_result` `additionalContext` return, not an extra `sendMessage`.

Since omp 18.4.12 the host tells subagents not to run builds or tests unless
their assignment explicitly says so. Prompts that dispatch children whose work
is accepted on their own evidence (Atlas rows, audit fixers, ultrawork lanes)
must name the checks in every assignment.

`judge-dispatch` routes agent type and effort only by rewriting `task` tool calls. OMP's
`before_subagent_spawn` hook can replace a child's model patterns but not its agent
type or role identity, and its `spawnKey` is the child id the host allocates from
the item's `name`. A per-task model pin therefore rides in the `agent` string
(`deep-low@abliterated`): strict tool schemas and the host's `"+": "delete"` item
schema leave no room for an extra field, `agent` is the field that names what
spawns, and without the plugin OMP refuses `x@role` as an unknown agent instead of
silently dropping the pin. The plugin renames the pinned item to a unique spawn
name. Do not move the pin to a separate tool or an extra item field: that
reintroduces cross-round state or breaks under strict schemas. `eval.agent()` and
`workpool()` remain unrouted and cannot be pinned.
OMP 18.5.0 introduced a per-item `task.model` field, but 18.8.2 removed it; older
hosts keep that field pinned when present. The plugin never changes the user's
global model roles or fallback settings.
An earlier "enhanced" mode used a hypothetical routing API that no OMP release
shipped and was removed. Build only on host surfaces exposed by released OMP.

It derives its legal agent set from the live `task` tool description and reads
its settings on every call from `ctx.cwd` (never `process.cwd()`), because plugin
settings are project-scoped and several sessions can share one process.

Its runtime floor, like every plugin's, is omp 18.5.1; the locked dev dependency
tracks a newer release, so CI covers both ends. The SDK harness uses
`CreateAgentSessionOptions.cacheWarming`, introduced in 18.3.5, to prevent
background provider requests during isolated tests. Before relying on a new host
API, type-check a throwaway copy against the floor
(`bun add -d @oh-my-pi/pi-coding-agent@18.5.1`). If the floor lacks an API,
raise the CI matrix entry and documented requirements instead of adding a shim.

Judging goes through OMP's `judge` role (`resolveJudge`); the plugin keeps no
credentials or provider settings of its own. It judges only when the chain's
first usable candidate is native (a judgment API, calibrated confidence), never
calls a chat-model fallback. Automatic routing fails open: a missing native judge
keeps the requested agent and warns once per session. A pin that cannot apply
must instead refuse the call; never run a pinned task on the agent's own model.

## Host prompt text is not a byte channel

The host renders every `task` assignment and batch `context`, and the native
plan-approval handoff, through `prompt.render` → `prompt.format`
(`@oh-my-pi/pi-utils` `src/prompt.ts`). Before a model sees the text, it trims
trailing whitespace, deletes runs of two or more blank lines, compacts Markdown
table rows (`| A | B |` → `|A|B|`), and trims the whole text. Lines starting
with ```` ``` ```` or `~~~` toggle a protected region without matching fence
length or character, so wrapping a document that has its own code blocks in a
longer fence still exposes the inner blocks. Indentation survives. Tool-call
arguments that plugin hooks receive (`tool_call` input) are raw.

So no prompt or code may require content to arrive byte-identical through
those channels, and no prompt may ask a model to compare inline text with a
file exactly; a model cannot do that reliably anyway. Pass the absolute path
and let the file be the authority, as F1 and the Momus/Oracle plan reviews do.
Code that matches host-rendered text compares against `prompt.format` output
(`inlinesApprovedPlan` in omo-prometheus), and its tests render the real host
template with a plan containing tables, trailing spaces and blank runs.

## Persisted plugin state must survive upgrades

Users upgrade plugins while work is in flight, so any state a plugin writes to
disk (omo-prometheus's Atlas bundle: `ledger.json`, `checkpoint.json`,
`approval.json`, `evidence/`) must stay loadable by the next release without
fresh approval or manual repair:

- A format change bumps that file's `version` and ships an upgrade on load from
  every earlier version still in use, keeping verified progress. Refusing an old
  version is a breaking change and needs the user's explicit sign-off.
- The same change adds a test that writes the previous format to disk and
  resumes the plan through `AtlasStore` (see "a bundle written by the previous
  ledger version" in `src/omo-prometheus-atlas-store.test.ts`).
- Relaxing a validation rule must not make formerly valid data fail, and
  outputs written by older releases (for example, gate JSON with extra fields)
  must still verify.

## Testing a plugin locally

Two marketplaces, one per purpose:

|Name|Source|Scope|Use|
|---|---|---|---|
|`wows-omp-plugins`|`TheOrdinaryWow/wows-omp-plugins` (GitHub)|user|released versions, same as any installing user|
|`wows-omp-plugins-dev`|`.omp/dev-marketplace/` (local copy)|project|this working tree|

Never register the release marketplace from a local path: `omp plugin upgrade`
then reads the local catalog, which lags GitHub until you pull, and ships
unreleased edits as if they were released.

`bun run dev:plugins [name…]` copies `plugins/` and the catalog into
`.omp/dev-marketplace/`, registers or refreshes `wows-omp-plugins-dev`, and
force-reinstalls the plugins at project scope. Rerun it after every edit and
restart the session. `bun run dev:plugins --remove` uninstalls them and drops the
dev marketplace. Facts behind this design, verified on omp 18.3.5 (the host
code behind them is unchanged through 18.5.1):

- omp rejects plugin sources that resolve outside the marketplace root, so the
  dev marketplace must be a real copy; a symlink to `plugins/` fails to install.
- Two installs sharing a runtime package name cannot live in the same scope.
  Project scope avoids the clash, and an enabled project install shadows the
  user install, so sessions in this repo run the dev copy while every other
  directory keeps the released one.
- Installation caches another copy under `~/.omp/plugins/cache/plugins/`.
  Verify against that cached path, never the source tree. Failures that only
  appear once the plugin has left this repo — an invalid `imports` key, a stray
  runtime dependency — are invisible from here. That is how the `#/*` breakage
  above was found.
- That cached copy can disappear while the project link and lock entry
  remain; a forced reinstall then fails with "Runtime package name ...
  conflicts with installed package". `dev:plugins` removes such a dead link
  and its `.omp/plugins/omp-plugins.lock.json` entry before installing.
- `omp plugin link` is not a substitute: it registers an npm-style plugin at
  user scope, overriding the release install everywhere.

## Linter / formatter (Biome only)

[biome.json](file:///./biome.json): line width **140**, 2-space indent, LF,
double quotes, semicolons always, trailing commas everywhere except JSON.
Import organization is on, grouped bun/node → packages → alias → relative.

## Catalog details worth knowing

- omp reads `.omp-plugin/marketplace.json` first and falls back to
  `.claude-plugin/marketplace.json`. This repo publishes only the former —
  it does not target Claude Code.
- `metadata.pluginRoot` is `./plugins`, so catalog `source` values are relative
  to that (`"./judge-dispatch"`, not `"./plugins/judge-dispatch"`).
- `bun run check-catalog` catches the common drift cases (unlisted directory,
  version mismatch between catalog and manifests, bad `source`) before a user
  hits them.
