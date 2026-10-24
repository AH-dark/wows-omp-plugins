<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-dark.png">
  <img alt="omp-herdr-dag" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-light.png">
</picture>

# omp-herdr-dag

English | [简体中文](README.zh.md)

Shows what OMP is working on as a live graph in a Herdr side pane: native todos, approved-plan execution, `omo-prometheus` Atlas plans with their dependencies, and every subagent with its tools, output, model and cost. The viewer only observes. It never schedules work, completes todos or changes the Atlas ledger.

## Install

```bash
omp plugin install omp-herdr-dag@wows-omp-plugins
```

Requires:

- OMP 18.10.4 or newer, running interactively inside Herdr (`HERDR_ENV`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` must be set);
- the `herdr` CLI on `PATH`;
- Bun, either `bun` on `PATH` or the path in `viewerRuntime`.

Linux is supported. macOS uses the same code but has not been verified. Windows is unsupported. Restart OMP after installing.

## Quick start

With the default settings the pane opens by itself when an approved plan starts executing. To open it any time:

```text
/dag-pane          # toggle
/dag-pane open
/dag-pane close
```

In the pane, use the arrow keys to move between nodes, Enter to expand one, `t` to switch to the Tasks view, `o` to read a subagent's transcript, and `?` for help.

## Usage

### When the pane opens

`displayTiming` controls automatic opening:

| Value | Opens for |
| --- | --- |
| `never` | Nothing; use `/dag-pane`. |
| `any-todo` | Native todos, approved-plan todos or an Atlas plan. |
| `plan-execution` (default) | Native plan execution after approval, or an Atlas plan. |
| `atlas-only` | An Atlas plan only. |

Subagent activity alone does not open the pane. After you close it with `q` or `/dag-pane close`, it stays closed for that run; a new run or `/dag-pane open` brings it back. `/new` and session switches reuse the same pane.

### Reading the graph

Each run is colored by its source:

| Source | Color | Meaning |
| --- | --- | --- |
| Native todo | Blue `#4f8cff` | Todo phases form bands. Dashed separators between phases mean order, not dependency. |
| Plan execution | Purple `#a371f7` | The first new todo list after you approve a native plan. |
| Atlas | Green `#3fb950` | `omo-prometheus` tasks, discovered work, fixes, final gates and delivery, with their real dependency edges. |

Node state follows your OMP theme:

| Icon | State |
| --- | --- |
| `○` | Pending |
| `◐` | Running |
| `✔` | Done |
| `✖` | Failed |
| `⊘` | Blocked |
| `⊖` | Abandoned |

Solid connectors are forward dependencies; the selected node's edges are drawn bold in the run's color. Dotted connectors are fix edges and backward dependencies (marked `↑ after <label>`). By default the graph hides an edge when a longer path already implies the same order; press `e` to draw every edge. The footer always lists the selected node's direct dependencies.

Press `p` to highlight the critical path, the longest chain of explicit dependencies by elapsed time. Press `c` to fold completed layers.

A running node whose subagent has made no progress for `stalledAfterSeconds` is marked `stalled` in warning color. A failed subagent does not mark its todo or ledger row failed.

### Tasks and transcripts

The Tasks view (`t`) lists every direct subagent from `task`, `eval` agents and `workpool`, with its current tool and arguments, recent output, model, retries, elapsed time, tokens and cost when OMP provides them. A subagent attaches to the todo that was in progress when it started. Missing metrics show as missing, never as zero.

Press `o` on a task, or on a node with an attached subagent, to read its transcript: assistant text, tool calls and short result previews, read from the existing session file.

### Viewer keys

| Key | Action |
| --- | --- |
| `q`, Ctrl+C | Quit and close the pane. |
| `t` | Toggle DAG and Tasks; from a transcript, switch to the other main view. |
| `h` | Show or hide the previous todo list (only one is kept). |
| `[` / `]` | Previous / next run. |
| Tab | Switch the arrow keys between selecting nodes (`NODES`) and panning the view (`PAN`). |
| Arrows, `j` / `k` | Select the nearest node, pan, move through tasks, or scroll a transcript. |
| PgUp / PgDn | Page through nodes, tasks or the transcript. |
| Enter | Expand or collapse the selected node or task. |
| `c` | Fold completed layers. |
| `p` | Highlight the critical path. |
| `e` | Draw every dependency edge. |
| `f` | Jump to the next running node. |
| `o` | Open the selected subagent's transcript. |
| Esc | Leave a transcript or close help. |
| `?` | Help. |

The mouse works too: the wheel scrolls, Shift+wheel scrolls sideways, a click selects a node and a double-click opens its transcript. While the viewer runs, a plain drag no longer selects text; most terminals still select with Shift held.

### Explicit todo dependencies

By default the graph knows only phase order. To draw real dependencies between todos, the agent can pass `edges` to `todo`, naming tasks by their exact text:

```json
{
  "op": "init",
  "list": [
    { "phase": "Implementation", "items": ["Build parser", "Connect viewer"] },
    { "phase": "Verification", "items": ["Check rendered output"] }
  ],
  "edges": [
    { "task": "Connect viewer", "after": ["Build parser"] },
    { "task": "Check rendered output", "after": ["Connect viewer"] }
  ]
}
```

The plugin strips `edges` before passing the call to the native `todo`, so todo behavior is unchanged. Unknown, self-referencing or cyclic edges are dropped with a `Herdr DAG edges:` warning, and the todo change still applies. Dependencies are never guessed from wording or phase order.

### Placement

The pane goes right of OMP in a landscape window and below it in a portrait one (portrait when columns are fewer than twice the rows). When the window flips orientation, the plugin recreates the pane in the new position. Positions and sizes are configurable per orientation.

When OMP exits, the pane closes too (`finishBehavior: close-with-omp`). With `keep-open`, it stays open, shows a disconnected banner and retries the connection every second.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omp-herdr-dag`.

```bash
omp plugin config wows-omp-plugin-omp-herdr-dag
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `displayTiming` | `never` \| `any-todo` \| `plan-execution` \| `atlas-only` | `plan-execution` | When the pane opens automatically. |
| `finishBehavior` | `close-with-omp` \| `keep-open` | `close-with-omp` | What happens to the pane when OMP exits. |
| `landscapePosition` | `left` \| `right` \| `top` \| `bottom` | `right` | Pane position in a landscape window. |
| `portraitPosition` | `left` \| `right` \| `top` \| `bottom` | `bottom` | Pane position in a portrait window. |
| `landscapeSize` | number from 0.15 to 0.6 | `0.35` | Pane share in landscape. |
| `portraitSize` | number from 0.15 to 0.6 | `0.4` | Pane share in portrait. |
| `followOrientation` | boolean | `true` | Move the pane when the window flips orientation. |
| `focusPane` | boolean | `false` | Focus the pane when it is created. |
| `stalledAfterSeconds` | number from 10 to 900 | `90` | Seconds without subagent progress before a task is marked stalled. |
| `todoDependencies` | boolean | `true` | Accept explicit `edges` on `todo`. Native todo operations work either way. |
| `atlasIntegration` | boolean | `true` | Show `omo-prometheus` Atlas plans. |
| `followTheme` | boolean | `true` | Follow OMP theme changes. |
| `colorTodo` | `#rrggbb` | `#4f8cff` | Todo run color. |
| `colorPlan` | `#rrggbb` | `#a371f7` | Plan run color. |
| `colorAtlas` | `#rrggbb` | `#3fb950` | Atlas run color. |
| `retentionDays` | number from 1 to 365 | `14` | Delete this plugin's files for sessions older than this, at session start. |
| `layoutAlign` | `centered` \| `left` | `centered` | Center the graph in the pane, or pack it against the left edge. |
| `viewerRuntime` | path or empty | `""` | Bun executable for the viewer; empty means find `bun` automatically. |

Settings are read for the session's working directory on startup, session switch and each command. An invalid field falls back to its default with a warning. Placement, size and color changes apply the next time the pane opens or the graph updates; they do not restart a running viewer.

## Working with other plugins

`omo-prometheus` Atlas plans appear as green runs when both this plugin's `atlasIntegration` and Prometheus's `herdrDag` setting are on (the default). Bands are ordered Tasks, Discovered, Fixes, Final gates, Delivery. Rows show their LIGHT/HEAVY tier badge and verification state when supplied. While an Atlas plan is shown, the todo phases Atlas mirrors (`Atlas tasks`, `Atlas discovered`, `Atlas fixes`, `Atlas final gates`, `Atlas delivery`) are hidden from the blue todo view to avoid showing the same work twice.

## Without the terminal UI

The pane only runs in an interactive TUI session inside Herdr. RPC, ACP, SDK and headless sessions never open a pane, even with Herdr variables set. The `todo` wrapper and its `edges` field work in every mode.

## Known limitations

- Herdr only; no other terminal multiplexer and no Windows.
- Subagents of subagents appear as status-only cards marked `activity unavailable`, without live tools, output or usage.
- Upgrading the plugin removes the installed copy the running OMP loaded, so a DAG pane cannot open again until you restart OMP. The plugin says so instead of opening a broken pane; a pane that is already open keeps working.
- Metrics and transcripts depend on what OMP reports.
- If OMP crashes between creating the pane and recording it, an orphan pane may remain. The plugin warns but never closes panes it does not own; close it by hand.
- The plugin's local files can contain task descriptions, tool arguments, output fragments, error messages and local paths. Treat them like session data.

## Reference

[REFERENCE.md](REFERENCE.md) covers plan-execution detection, layout and placement details, the Atlas event contract and local storage.

## License

MIT. An improved port of [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag), inspected at revision `a093cdf5da96e28dfe50348965d9f3bafb1c9531`. The upstream copyright and permission notice are kept in [NOTICE](NOTICE); see [LICENSE](LICENSE) for this plugin's license.
