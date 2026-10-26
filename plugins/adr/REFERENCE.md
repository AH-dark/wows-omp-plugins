# adr reference

English | [简体中文](REFERENCE.zh.md)

## Context injection

In a repository whose `docs/adr/` is managed (by this plugin's marker or a legacy roadmap ADR index), the plugin reads the checked-out files at the start of every agent turn and appends a short block to the system prompt of main and subagent sessions:

```text
ADRs in docs/adr: 2 proposed, 5 accepted, 1 superseded.
Proposed: ADR-0007 Use a queue; ADR-0009 Cache reads.
Read decisions with adr_status (an id gives the full text); change them only through adr_manage.
```

Counts list only nonzero statuses. At most five proposed ADRs are named, in ID order, followed by `and N more`; titles are cut at 80 characters. A line reports files that failed to parse. Uninitialized repositories get nothing.

## Tools

`adr_status` uses read approval; `adr_manage` and `adr_check` use write approval. Every tool declares the same `sourcePath` (the realpath of the loaded `src/index.ts`), which the service contract reports as `toolSourcePath`.

| Tool | Inputs |
| --- | --- |
| `adr_status` | No arguments: counts and every ADR. `status`: only that status. `id`: metadata, file, supersession chain and the full MADR body. |
| `adr_manage` | `action` plus the fields below. |
| `adr_check` | Optional `fix: true`. |

If `docs/adr/` is absent or empty, every tool refuses with "ADR management is not initialized in this repository" and the hint to ask the user for `/adr init`. A non-empty `docs/adr/` without a marker is refused as unmanaged. Outside a git work tree the tools refuse.

### `adr_manage` actions

| Action | Fields | Rules |
| --- | --- | --- |
| `create` | `title`, `sections`, optional `status`, `stage`, `decision_makers`, `consulted`, `informed` | `sections` needs `context`, a nonempty `options` list and `outcome`; `drivers`, `consequences`, `confirmation`, `pros_cons` and `more_info` are optional. `status` defaults to `proposed`; a subagent always gets `proposed`, with a warning when it asked for another status. |
| `revise` | `id`, `sections`, optional `title` | Only a proposed ADR. Replaces the whole body; metadata stays. |
| `set_status` | `id`, `status` | Main agent only. `accepted`, `rejected` or `deprecated`; refused for a superseded ADR. |
| `supersede` | `id` and the `create` fields | Main agent only. The ADR must be accepted or deprecated. Creates an accepted successor with `supersedes: [id]` and sets the old ADR to `superseded` with `superseded_by`. |
| `note` | `id`, `text` | Appends `### YYYY-MM-DD` and the text under More Information, adding that section if missing. Any actor. |
| `link` | Required `id`, optional `stage` | Main session only, at any ADR status, including superseded. Sets or changes the stage link; omitting `stage` clears it without needing a resolver. Leaves the body, status and supersession links unchanged. |

`stage` is accepted only by `create`, `supersede` and `link`. Setting or changing a stage link needs a stage resolver registered through the service contract (the roadmap plugin registers one); without it the call is refused with "Stage links need the roadmap plugin". With one, the resolver must accept the stage ID. Clearing an existing link with `link` needs no resolver.

If an existing ADR ends inside an unterminated fence, `note` refuses without changing it. Repair the file in your editor and retry.

## File formats

### ADR files

`docs/adr/NNNN-slug.md`, where `NNNN` is the ADR number (at least four digits) and the slug comes from the title.

```markdown
---
format: 1
id: "ADR-0003"
status: "accepted"
date: "2026-10-10"
supersedes: ["ADR-0001"]
superseded_by: "ADR-0005"
stage: "S04"
decision-makers: ["Project owner"]
consulted: ["Platform team"]
informed: ["Support"]
---
<!-- Managed by the adr OMP plugin (format v1). Change it through adr_* tools. Format: docs/adr/README.md -->

# Title

## Context and Problem Statement
…
```

`format`, `id`, `status` and `date` are always present, in that order. The optional keys follow in the order shown and are omitted when absent or empty; `null` is not part of this format. The body is the vendored MADR 4.0 template (`assets/madr/adr-template.md`): Context and Problem Statement, Considered Options and Decision Outcome are required, the other headings are optional and keep the template order. Confirmation replaces MADR's Verification.

### Index and marker

`docs/adr/README.md` marks the directory as managed:

```markdown
---
format: 1
adr: { format: 1 }
---
<!-- Managed by the adr OMP plugin (format v1). Change it through adr_* tools. Format: docs/adr/README.md -->

# Architecture Decision Records

<conventions paragraph>

## Decisions

<!-- adr:generated:index -->
| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| ADR-0001 | Use Postgres | superseded by ADR-0003 | 2026-10-01 |
<!-- /adr:generated -->
```

The table is regenerated on every write. Text you add to the Decisions section outside the generated block is kept. A README that claims management (an `adr:` key or a managed-by comment) but does not parse is an error, never an unmanaged directory.

### Legacy roadmap files

The roadmap plugin 0.4.0 and earlier wrote ADR files with all ten keys always present (`supersedes`, `superseded_by`, `stage`, `status`, `date`, `decision-makers`, `consulted`, `informed` after `format` and `id`), `null` for an absent stage or successor, `format: 1` or `format: 2`, and the comment `<!-- Managed by the roadmap OMP plugin (format vN). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->`. Its index had only `format` in its front matter and the block `<!-- roadmap:generated:adrs -->` … `<!-- /roadmap:generated -->`.

The managed-by comment decides how a file is read, and its format must match the file's own `format`. Legacy files are read transparently and count as initialized. A write rewrites only the files it touches in this plugin's format; a legacy index is converted on the first write (or by `check --fix` when its table is stale), replacing the roadmap conventions paragraph (only while it still has the roadmap plugin's exact text) and the block delimiters and keeping every other line of authored text. Untouched files keep their exact bytes, and nothing is rewritten on read. `adr_status` and the state snapshot report how many files are still legacy.

The conversion is one-way. The roadmap plugin 0.4.0 and earlier cannot read a converted index or converted ADR files, so once the converted files are committed, every clone or worktree that still runs one of those versions fails to read `docs/adr/`. Upgrade the roadmap plugin and install this plugin in every environment before the first write.

## Markdown in tool-written text

The tools accept the same body subset as the roadmap plugin. Body sections support plain paragraphs, flat bullet or ordered lists with single-line text items, and fully closed top-level fenced code blocks. Bullet markers are `-`, `+` or `*`; ordered markers have one to nine digits followed by `.` or `)`, with one space after the marker. Nested lists and indented list continuations are refused.

Ordinary punctuation is allowed, including `~20%`, `snake_case`, `quantity * unit price`, URLs with underscores or tildes, and `x < y` or `x > y`. A `<` immediately followed by an ASCII letter, `/`, `!` or `?` is refused, since it can begin HTML, an autolink, a comment or a processing instruction. A `>` cannot begin a line.

Inline emphasis delimiters are allowed. Square brackets, backslash escapes and table pipes are unsupported outside code. Same-line inline code spans are allowed; each opening backtick run must close with an equal-length run on that line.

Fences use at least three backticks or tildes with zero to three leading spaces. The optional info string is one language token of ASCII letters, digits, `_`, `+`, `.` or `-`. A closer uses the same marker, is at least as long as the opener, and has no info string. Fences cannot begin inside lists; after a list, use an unindented fence. Paragraphs after a list need a blank line.

Considered options, titles and participant names are single-line and cannot contain lists or fences. The tools reparse every rendered file and refuse a write whose body would change the ID, metadata or fixed headings, before changing any bytes.

## Consistency check

`adr_check` and `/adr check` report:

| Rule | Meaning |
| --- | --- |
| `structure`, `format` | A file that does not parse, an unsupported format, a missing index, or an `NNNN-slug.md` name that does not match the ID. |
| `duplicate-id` | Two files with one ID, for example from separate clones or branches. |
| `dangling-reference` | `supersedes` or `superseded_by` naming a missing ADR. |
| `supersession` | Links that are not reciprocal, or a `superseded` status without a successor (or the reverse). |
| `generated` | A stale index table. The only fixable rule. |

`fix: true` regenerates the index under the ADR lock and never changes ADR files. It refuses while structure or format errors remain. Stage references are checked by the roadmap plugin.

## Edit protection

### AFT interoperability

AFT builds implementing interoperability binding v1 advertise actually registered tools, absolute source paths, capabilities and a `project(toolName, input, cwd)` function through synchronous `aft:binding-request` / `aft:binding` events. Only matching version, session and request replies are accepted. Each use rechecks the live extension source against the advertised path exactly, without path regexes. Shutdown clears the cache; missed responses retry.

For a bound tool, AFT uses its own argument normalizers and read-only engine preflight to return `{kind, paths, broad}`. Targets include both ends of moves, multi-file hashline changes and AST scopes, resolved against the current call's `cwd`. Mutation targets pass through the existing symlink, hardlink and ancestor-directory safeguards; observations proceed. A `bash` execution projection does not replace native command inspection, and uses AFT's `workdir`. While managed documents exist, unenumerable scopes, uninspectable execution, malformed projections and AFT-only mutation tools lacking a verified binding are refused. Native tools and sessions without AFT retain their behavior. This remains best-effort extension protection, not a sandbox.

### Native mutation protection

Once `docs/adr/` is managed, a tool-call hook blocks native mutations of `docs/adr/**` in main and subagent sessions, with guidance to use `adr_manage`. It finds the target's git work tree, checks lexical and resolved paths (including dangling symlink destinations) and compares device and inode against multiply linked managed files, so a hardlink alias cannot change a managed file.

| Surface | Coverage |
| --- | --- |
| `write` | Its `path`, including `[path#TAG]` headers copied from read output. |
| `edit`, `apply_patch` | Every native edit grammar (`hashline`, `replace`, `patch`, `apply_patch`, `sloppy`); any managed source or destination is blocked, unknown grammars are refused. |
| `ast_edit` | `paths` after the native scope normalization; directories and globs containing `docs/adr` are blocked. |
| `lsp` | File-named `rename`, applied `code_actions` and `rename_file` (both names). |
| `bash` | Best-effort static detection of redirections, `tee`, `mv`, `cp`, `rm`, in-place `sed` and `truncate`. |

Repositories without a marker are unaffected. A malformed marker, or a path-resolution or file-identity error, refuses the call. The hook does not intercept `eval`, editors launched from bash or other programs that write files; shell variables and indirect writes can evade it.

## Recovery and worktrees

Writes take one lock, `<git common dir>/adr/lock`, and replace each file atomically (temporary file plus rename), ADR files first and the index last. A multi-file write is not a transaction. Cancellation stops before the next temporary write or rename; files already written stay and are listed in the refusal.

1. Run `/adr check` or `adr_check`.
2. Run `/adr check --fix` or `adr_check` with `fix: true` for a stale index.
3. Restore other damage with git and check again.

IDs come from `<git common dir>/adr/counters.json`, `{"v":1,"adr":N}`, shared by every worktree of a clone. A new ID is one above the largest of that counter, the `adr` counter the roadmap plugin kept in `<git common dir>/roadmap/counters.json` (read, never written) and every ID on disk. An unreadable counter file pauses allocation rather than risking a reused ID. The checked-out Markdown is the source of truth on each branch.

## Without a UI

`/adr init` returns the rendered preview and a `/adr confirm <token>` command without writing. The token covers exactly the shown files and lasts until the session is rebuilt (start, switch, branch, tree) or a newer `/adr init` preview replaces it; confirming rechecks that initialization still produces the same files. Bare `/adr` prints the list and usage. Notices and errors become displayed session messages.

## State snapshot

The main session publishes `adr.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)). `state` is the `adr/status` payload, version 1, derived from files on disk, or `null` when the repository has no managed `docs/adr/`. It is rewritten at session start, switch, branch and tree, after every `adr_*` tool call, `/adr` command and service write, and at the start of each agent turn.

| Field | Content |
| --- | --- |
| `kind`, `version` | `"adr/status"`, `1` |
| `repoRoot` | Git work tree root. |
| `format` | Marker format (`1`), or `null` while `docs/adr/README.md` is still a legacy roadmap index. |
| `legacyFiles` | Number of files, index included, still in the legacy roadmap format. |
| `counts` | `{ proposed, accepted, rejected, deprecated, superseded }`. |
| `records` | ID-ordered `{ id, title, status, date, stage?, superseded_by? }`; absent links are omitted. |

## Service contract

Other plugins in the same session reach this plugin through `pi.events`. The roadmap plugin uses it to read ADRs, link them to stages and initialize `docs/adr/`.

The requester subscribes to `adr:binding`, emits `adr:binding-request` with `{ v: 1, sessionId, requestId }`, and unsubscribes. The plugin answers synchronously inside the request handler, only when `sessionId` is its own session, with `{ v: 1, sessionId, requestId, toolSourcePath, api }`. No answer means the plugin is not loaded; `v !== 1` or a missing `api` means an incompatible version.

```ts
type AdrActor = "main" | "sub";
type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
type AdrDirState = "absent" | "empty" | "managed" | "unmanaged";
interface AdrSections { context: string; drivers?: string; options: string[]; outcome: string; consequences?: string; confirmation?: string; pros_cons?: string; more_info?: string }
interface AdrCreateInput { title: string; sections: AdrSections; status?: Exclude<AdrStatus, "superseded">; stage?: string; decision_makers?: string[]; consulted?: string[]; informed?: string[] }
interface AdrRecord {
  id: string; title: string; status: AdrStatus; date: string;
  stage?: string; supersedes: string[]; superseded_by?: string;
  decision_makers: string[]; consulted: string[]; informed: string[];
  path: string;     // repository-relative, e.g. docs/adr/0001-use-madr.md
  body: string;     // MADR body after the "# title" line
  legacy: boolean;  // stored in the legacy roadmap format
}
interface AdrSnapshot { repoRoot: string; records: AdrRecord[]; parseErrors: { path: string; message: string }[] }
interface AdrWriteOptions { signal?: AbortSignal; dryRun?: boolean }
interface AdrWriteResult { files: { path: string; content: string }[]; ids: string[]; warnings: string[] }
type StageResolver = (repoRoot: string, stageId: string) => Promise<string | undefined>; // undefined = valid; string = refusal reason

interface AdrApiV1 {
  version: 1;
  dirState(repoRoot: string): Promise<AdrDirState>;
  load(repoRoot: string): Promise<AdrSnapshot | null>;
  initialize(repoRoot: string, actor: AdrActor, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  create(repoRoot: string, actor: AdrActor, input: AdrCreateInput, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  createMany(repoRoot: string, actor: AdrActor, inputs: AdrCreateInput[], options?: AdrWriteOptions & { initialize?: boolean }): Promise<AdrWriteResult>;
  link(repoRoot: string, actor: AdrActor, id: string, stage: string | undefined, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  relinkStage(repoRoot: string, actor: AdrActor, from: string, to: string, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  registerStageResolver(resolver: StageResolver): () => void;
}
```

| Method | Behavior |
| --- | --- |
| `dirState` | `managed` covers this plugin's marker and a legacy roadmap index. Throws for a marker that claims management but does not parse. |
| `load` | The snapshot, records in ID order, or `null` unless managed. Files that fail to parse are listed in `parseErrors` and left out of `records`. |
| `initialize` | Main only. Writes the marker into an absent or empty `docs/adr/`; refuses an unmanaged one; returns an empty result with a warning when already managed. |
| `create` | `createMany` with one input. |
| `createMany` | Creates ADRs in one locked batch with sequential IDs, in input order. Refuses an uninitialized directory unless `initialize: true` (main only), which also writes the marker into an absent or empty directory in the same batch. |
| `link` | Main session only, at any ADR status. Sets or changes one ADR's stage link after resolver validation; `stage: undefined` clears it without a resolver. Leaves the body, status and supersession links unchanged. |
| `relinkStage` | Rewrites every `stage: from` to `to`, for a stage renumbering. It needs a registered resolver but does not ask it about `to`, since the caller owns the rename. |
| `registerStageResolver` | One resolver per session; the latest registration wins, and the returned function unregisters only its own resolver. |

All writes take the ADR lock, honor `signal`, apply the same validation and actor rules as the tools, and rewrite touched files in this plugin's format. The resolver is called before the lock is taken, so it may read the caller's own files freely. With `dryRun`, a write returns the files it would write and provisional IDs (above the counters and the disk, as for a real write) without writing files or consuming counters; consecutive dry runs therefore return the same IDs. `files` lists repository-relative paths, ADR files first and the index last; `ids` lists created ADRs in input order, then other changed ADRs. Refusals are thrown as `Error` with a user-facing message.

The resolver receives the repository root the call was made with, resolved to its git work tree root, and a stage ID such as `S04`.
