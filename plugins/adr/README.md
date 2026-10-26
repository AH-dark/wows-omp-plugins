<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-dark.png">
  <img alt="adr" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-light.png">
</picture>

# adr

English | [简体中文](README.zh.md)

> Architecture decisions that stay in your repository, written and changed by the agent only through dedicated tools.

Keeps architecture decision records (ADRs) in `docs/adr/` as Markdown in the [MADR 4.0](https://github.com/adr/madr) format. The agent drafts decisions from an interview with you, records them as proposed, and changes them only through status transitions, supersession and dated notes. You accept, reject or deprecate decisions from a menu. A short summary of open decisions reaches the agent in every turn.

## Install

```bash
omp plugin install adr@wows-omp-plugins
```

Requires OMP 18.10.4 or newer and a local Git repository. Any `git init` work tree works and no remote is needed; outside a Git repository the commands and tools refuse. Start a new session after installing. The plugin ships the `adr` skill and a pinned MADR 4.0 template.

## Quick start

1. Run `/adr init` in the main session. `docs/adr/` must be absent or empty. Review the preview and pick `Write 1 file` (Shift+W in the fullscreen preview).
2. Run `/adr new` (optionally with a topic, such as `/adr new database choice`). The agent interviews you about the context, options and outcome, shows you the draft and records it as a proposed ADR.
3. Run `/adr`, select the ADR, press Enter and choose `Accept`, `Reject` or `Deprecate`.

Repositories whose ADRs were written by the roadmap plugin 0.4.0 or earlier need no initialization; see [Existing roadmap ADRs](#existing-roadmap-adrs).

## Usage

### Records

| Field | Meaning |
| --- | --- |
| ID (`ADR-0001`) | Monotonic, never reused. The file is `docs/adr/0001-slug.md`. |
| Status | `proposed`, `accepted`, `rejected`, `deprecated` or `superseded`. |
| Supersedes / superseded by | Reciprocal links between a decision and its replacement. |
| Stage | Optional link to a roadmap stage; needs the roadmap plugin. |
| Decision-makers, consulted, informed | Optional participant lists. |

`docs/adr/README.md` is the initialization marker and holds a generated table of every decision. A hook blocks ordinary agent edits to `docs/adr/`; you can still edit body text in your own editor.

### Lifecycle

- New decisions start as `proposed`; the agent creates an accepted one only when you explicitly agree.
- A proposed ADR can be revised as a whole. An accepted one is never rewritten: it is deprecated, superseded by a new accepted ADR, or extended with a dated note under More Information.
- Only the main session (you, or the main agent acting for you) accepts, rejects, deprecates or supersedes. Subagents can create proposed ADRs, revise them and add notes.
- Only the main session can set, change or clear an existing ADR's stage link, at any status (including superseded). This changes metadata, not the decision body or status.

### Commands

All commands run in the main session and complete subcommands and ADR IDs.

| Command | Behavior |
| --- | --- |
| `/adr` | Opens the ADR console. Filter by status, search, read an ADR, accept, reject or deprecate it, append a note, supersede it, start a new decision or run the check. See [The /adr console](#the-adr-console). |
| `/adr list [status]` | List ADRs, optionally with one status. |
| `/adr show <id>` | Show one ADR with its supersession chain. |
| `/adr accept\|reject\|deprecate <id>` | Record your decision. |
| `/adr note <id> <text>` | Append a dated note under More Information. |
| `/adr new [topic]` | Ask the agent to interview you for a new decision. |
| `/adr supersede <id> [topic]` | Ask the agent to interview you for a replacement of an accepted or deprecated decision. |
| `/adr check [--fix]` | Check consistency; `--fix` regenerates the index table. |
| `/adr init` | Initialize `docs/adr/` after a confirmed preview. |
| `/adr confirm <token>` | Confirm a held `/adr init` preview when no dialog was available. |

### The /adr console

With the default `uiMenu: fullscreen`, `/adr` fills the terminal. ADRs are listed on the left with a status mark, and the selected one is shown in full on the right, with its supersession chain.

| Key | Action |
| --- | --- |
| Up, Down, Home, End | Select an ADR. |
| PgUp, PgDn, mouse wheel | Scroll the decision text. The wheel over the list moves the selection. |
| Tab, Shift+Tab | Switch between All and each status present, with counts. |
| Lowercase letters, digits | Search IDs, titles and statuses. Backspace edits the search. |
| Enter | Choose a decision for the selected ADR in a small dialog. |
| Shift+A, R, D | Accept, reject or deprecate the selected ADR, when its status allows it. |
| Shift+N, S | Append a note, or supersede an accepted or deprecated ADR. |
| Shift+O | Start a new decision. |
| Shift+C | Run the check. |
| Shift+F | Run the check and regenerate the index. |
| Esc | Clear the search, then close. |

Accepting, rejecting, deprecating, adding a note and running the check reopen the console on the same ADR, with the result in one line above the key hints. The full result also goes to the conversation. Starting a new decision or a supersession closes the console, because the agent interviews you next. Cancelling their topic dialog brings you back to the console.

The `/adr init` preview uses the same layout: the files on the left, the selected file on the right. Shift+W writes every file, Esc declines.

### Agent tools

| Tool | Purpose |
| --- | --- |
| `adr_status` | List ADRs (optional `status` filter), or read one by `id` with its full text and supersession chain. |
| `adr_manage` | `create`, `revise`, `set_status`, `supersede`, `note`, `link`. `link` requires `id`; supply `stage` to set or change the link, or omit it to clear. |
| `adr_check` | Consistency check; `fix: true` regenerates the index table. |

In a repository without `docs/adr/` management, every tool refuses and tells the agent to ask you to run `/adr init`.

### Existing roadmap ADRs

ADRs written by the roadmap plugin 0.4.0 or earlier are read as they are, including their `docs/adr/README.md` index, so the repository counts as initialized. Each write rewrites only the files it touches in this plugin's format, and the first write converts the index, keeping the text you wrote in it. Untouched files keep their bytes. ADR numbering continues above the roadmap plugin's ADR counter, which is read but never changed.

The conversion is one-way: the roadmap plugin 0.4.0 and earlier cannot read converted files. Clones that still run one of those versions must upgrade the roadmap plugin and install this plugin, so upgrade them before the first write.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-adr`.

```bash
omp plugin config set wows-omp-plugin-adr uiMenu inline
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `uiMenu` | `fullscreen` \| `inline` | `fullscreen` | `fullscreen` opens the [console](#the-adr-console) and the fullscreen write preview. `inline` keeps the small select dialogs: a status filter, a list, then the actions for one ADR. An invalid value counts as `fullscreen`, with a warning in the log. |

The setting applies only in the terminal UI and is read each time an `/adr` command runs, so a change needs no restart.

## Working with other plugins

- **roadmap**: the roadmap plugin requires this plugin. It reads ADRs and links them to stages through this plugin's service contract, and its `/init-project` initializes `docs/adr/` when the directory is absent or empty. Setting or changing a stage link requires the loaded roadmap plugin and an existing stage; clearing a link does not.
- **omo-prometheus**: Atlas admits the `adr_*` tools during plan execution, alongside the roadmap tools.
- **[AFT](https://github.com/cortexkit/aft)**: with interoperability binding v1, document protection uses AFT's own mutation targets, including batch/hashline edits and move destinations. Ordinary edits outside managed ADRs still work. Unverified AFT-only mutation tools or uninspectable effects are refused while ADRs are managed; update AFT or use the ADR tools. See [edit protection](REFERENCE.md#edit-protection).

## Without the terminal UI

| Host | Behavior |
| --- | --- |
| RPC (`--mode rpc`, `rpc-ui`) and ACP | The inline menu and dialogs whatever `uiMenu` says, sent as `select`, `input` and `editor` requests. ACP clients may show notices only in their log. |
| No UI (`--no-ui`, print, JSON, SDK) | No dialogs. Bare `/adr` prints the list and usage; use the subcommands. `/adr init` returns the preview and a token without writing; confirm with `/adr confirm <token>`. Notices become session messages. |

Client programs can read the ADR status from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- `/adr init` does not adopt a non-empty `docs/adr/` that this plugin does not manage.
- The edit protection is best effort, especially for `bash`, and is not a sandbox.
- `check` verifies the documents, not whether the code follows the decisions.
- A multi-file write is not all-or-nothing; an interrupted one can leave a stale index for `/adr check --fix`.
- Separate clones do not share numbering, so their IDs can collide; worktrees of one clone do share it.
- Without a UI, a held `/adr init` preview lives only in memory and is lost when the process exits.

## Reference

[REFERENCE.md](REFERENCE.md) covers the tool inputs, the file formats including legacy roadmap files, the allowed Markdown, edit protection, recovery and worktrees, the state snapshot and the service contract for other plugins.

## License

MIT. The vendored MADR template keeps its own licenses in `assets/madr/`.
