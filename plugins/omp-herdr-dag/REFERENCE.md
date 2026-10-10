# omp-herdr-dag reference

English | [简体中文](REFERENCE.zh.md)

## Activation

Pane management, the viewer, transport subscriptions and snapshot publishing require `mode: "tui"`, `hasUI: true` and all three Herdr environment variables. RPC/rpc-ui and ACP stay inactive even with `hasUI` true or inherited Herdr variables; SDK and headless sessions with `hasUI: false` never start or split panes. Noninteractive child sessions do not start a viewer. Outside Herdr, `/dag-pane` reports that the pane is unavailable; the `todo` wrapper stays registered. On Windows the plugin shows a one-time notice.

Bun discovery tries `bun` first, then the host executable only if its `--version` output looks like a Bun semantic version; the plugin does not assume a compiled OMP executable can run the viewer. Missing Bun produces a warning and skips pane management.

`/dag-pane open` is idempotent, `close` is safe without a pane, and manual opening ignores `displayTiming`. The plugin manages only its recorded pane ID, never panes found by title. A dismissal is saved; a newly observed run ID or `/dag-pane open` clears it. A todo list hidden as Atlas mirror phases counts as observed, so releasing Atlas does not clear a dismissal when it reveals that list. A viewer closed with `q` stays dismissed across session rebinding.

## Plan-execution detection

A purple run requires the recorded proposal, the host's matching plan reference and its exact approval envelope. A user message saying `Plan approved.` or a bare new-session event is not enough. The plan epoch ends once its list is completed or abandoned and the agent turn ends without continuation; a later list is an ordinary blue run.

Queued synthetic developer approval messages go through the same checks as a new turn's approval prompt. Canonical todo writes must be newer than both the live polling baseline and the recorded approval to claim the first plan list, so lists replayed on startup, switching or rewinding cannot. The final agent-turn boundary reconciles canonical todo writes before checking whether the plan list is terminal. Trusted queued handoffs are identified by host timestamp and approval text, accepted only after the current proposal, and consumed once. A context that retains an old approval cannot approve a later proposal for the same path.

While Atlas is bound, an all-mirror todo list cannot claim or consume an armed native plan approval. The Atlas run claims it instead, and releasing Atlas ends that plan execution. The Atlas mirror phases then reappear as plain blue todos, as they do when integration is disabled. An approval that arrives while Atlas integration is disabled is still claimed by the first new native list.

## Graph layout

- The critical path uses only explicit dependency edges, weighting each node by its observed elapsed time or by 1 when unstarted, and is drawn with heavy lines. At crossings only its own arms stay heavy; where it shares a stroke with the selection, the critical path wins. Runs without explicit edges have no critical path.
- The default transitive reduction hides a direct forward edge when a longer forward path orders the same two nodes, so final gates that depend on every task hang off the last task as one fan-out. Fix and backward edges are always drawn, and the critical path still uses every dependency.
- Long edges share one vertical trunk per source through skipped layers, branching at each target. Edges converging on one node share an arrowhead; several edges from or into one node share a connector.
- Node boxes are 30 columns wide and shrink to no less than 20 when that lets the widest layer fit. A layer stays on one row if it fits twice the pane width, or 120 columns in narrower panes; four boxes need 86 columns, so a 50-column pane keeps four final gates on one row and scrolls sideways to the selection. Wider layers wrap within their band, left to right then top to bottom; trunks to later rows pass through earlier rows.
- Each node sits under the median of its parents. With `layoutAlign: centered`, overlapping siblings spread on both sides of their parent and the graph centers on the canvas axis; with `left`, siblings move only rightwards and the graph sits against the left edge.
- In node mode, Up/Down pick the box closest by centre in the row above or below, Left/Right the next box in the row, and paging follows the drawn order. A folded layer occupies one summary row. Panning or scrolling stops the view from following the selection until a node-mode arrow key, paging or a click selects a node again. Switching runs or views starts at the top. Mode, scroll position and the edge toggle are not persisted.
- Running task cards, linked or not, use warning borders and a `stalled` label until new progress arrives.
- Repeated activations of a subagent keep its completed usage and add the current activation, without double-counting cumulative progress frames. Run usage counts each linked subagent once.
- A subagent reported as finished turns failed or aborted when the final `task` tool result reports it so (for example, an isolation merge or patch apply that failed after the child settled). Detached background tasks are not corrected this way. On a collab guest, mirrored host tool results update the view but never append plan-execution entries.
- The viewer enables terminal mouse reporting while running and disables it on every exit path, including signals. Transcript text has terminal control sequences stripped; labels wrap by display width. The transcript reader opens no writable host session.

## Placement

Orientation is portrait when `cols < 2 * rows`, landscape otherwise. The measured OMP rectangle adds the owned pane's share back, so opening the viewer does not itself flip orientation. Hysteresis switches landscape to portrait below `2 * rows - 4` and back above `2 * rows + 4`. Resize checks are debounced by 750 ms and also run on heartbeats.

Herdr 0.9.3 cannot move a pane within a tab, so an orientation flip closes the recorded pane and opens a replacement with a new pane ID, resuming the saved view state and socket connection. Position and size changes alone do not recreate an open pane. Right and bottom use a direct split; left and top split and then swap. Herdr focuses the swap source; with `focusPane: false` the plugin restores OMP focus, but cannot restore an unrelated pane that was focused before the swap.

With `close-with-omp`, the viewer closes its own pane and exits after three missed 2-second heartbeats. With `keep-open`, a recovery snapshot is never taken as proof that OMP is alive. `q` always closes the viewer's own pane regardless of finish behavior.

Shutdown blocks further pane launches and resize timers immediately. Pane closure, socket cleanup and snapshot flushing share one 1.8-second budget; unfinished socket startup stays cancelled. On restart, an owned pane launched for a different socket, or an older record without one, is closed and recreated.

When settings change: `displayTiming` applies at the next evaluation without closing a pane; host shutdown uses the current `finishBehavior`, but the viewer's heartbeat-loss policy is fixed at launch; positions, sizes and `focusPane` apply at the next open or orientation recreation; `stalledAfterSeconds` needs an OMP restart for the task source; `todoDependencies` applies to later tool calls after settings reload; `atlasIntegration` reload toggles the consumer and mirror deduplication; colors and `layoutAlign` apply at the next snapshot; `followTheme: false` keeps the last sampled palette; `viewerRuntime` applies at the next launch. Settings are also read on each automatic-opening evaluation, including heartbeats, and invalid fields warn once per project scope.

## Atlas contract

The viewer consumes the `pi.events` contract published by `omo-prometheus`; the [omo-prometheus reference](../omo-prometheus/REFERENCE.md#herdr-dag-contract) defines the events. Without an enabled producer, the viewer reports Atlas integration as unavailable, and native todos and Tasks keep working.

`atlas:snapshot` stays at `v: 1`. Row kinds `task`, `discovered`, `fix`, `gate` and `delivery` are laid out as the bands Tasks, Discovered, Fixes, Final gates and Delivery. A discovered row draws a fix-style edge from its `origin`; a fix row keeps its edge toward the originating gate. These provenance edges imply no scheduling dependency. Optional `tier: "light" | "heavy"` shows as a LIGHT/HEAVY badge, and optional `verification: { status: "pending" | "running" | "passed" | "failed" }` as `verify: <status>` in the node and selection details; snapshots without either are still accepted. Timeline kinds also include `discovered`, `implemented`, `verify_started`, `verify_passed` and `verify_failed`. The viewer never reads timeline events as node state or scheduling authority, and unknown kinds have no effect. Verification children use the row's current `attempt` and are identified by its verification status.

## Todo edges

The wrapper preserves native mutations, details, hooks, approval, batch failure and rendering. A native operation error records no edges. Removing or changing tasks prunes their edges, and `init` starts a fresh generation.

## Local storage

Durable files live under `ctx.sessionManager.getSessionDir()/herdr-dag/<sessionId>/`; in-memory sessions (`--no-session`) use `os.tmpdir()/omp-herdr-dag/sessions/<sessionId>/`. They are versioned JSON, written through temporary-file replacement. `snapshot.json` and `pane.json` are version 2 and upgrade version 1 on load, keeping recovery data, ownership and dismissal. A v1 pane record without a socket path relaunches only its recorded pane and never adopts others. `view-state.json` stays at version 1; unknown or newer versions are ignored and replaced.

| File | Stored fields |
| --- | --- |
| `snapshot.json` | `version`, session ID/name, generation, connection flag, timestamp, runs, task cards, theme palette, three source colors, Atlas availability, and optional `layoutAlign` (absent in older snapshots, which render centered). |
| Run objects | ID, source, title, generation, nodes, edges, creation/update/finish timestamps, and done/total/elapsed/token/cost stats. |
| Node objects | ID, label, state, band/name, detail, start/finish timestamps, agent, linked task IDs, stalled flag, and optional tier and verification state. Edges contain `from`, `to` and `kind`. |
| Task cards | ID, parent task/node IDs, agent, status, optional stalled flag, description, current tool/arguments, recent output, completed/current activation totals (tokens, cost, duration), activation count, model, retry attempt/limit/error, optional `completionPercent` (the host's 0–100 completion estimate for a running child, shown next to its status; absent in older snapshots and when the host has no estimate), transcript path, start/finish timestamps, detached flag, depth and activity-availability flag. |
| Theme palette | Text, muted, dim, accent, success, error, warning, border, accented/muted border and optional background colors. |
| `pane.json` | `version`, splitting/open phase, pane/tab IDs when known, host pane ID, orientation, position, launch timestamp, optional launching socket path and dismissal flag. |
| `view-state.json` | `version`, folded run IDs, view (`dag`, `tasks`, `transcript`), selected run ID and critical-path toggle. |

The host session also stores custom entries: `omp-herdr-dag:plan-execution` (`v`, proposed/executing/idle state, optional plan path and run ID, timestamp) and `omp-herdr-dag:todo-edges` (`v`, generation, task/after records). No credentials are collected. Transcript contents are not copied; the viewer reads the existing files.

Live transport uses a Unix socket at `os.tmpdir()/omp-herdr-dag/<hash>.sock`, keyed by the Herdr host pane and process ID, in a private directory. Socket deltas are coalesced, with a full resync after a sequence mismatch or excessive backlog. Snapshots serve only restart recovery.

At session start, `retentionDays` prunes other plugin-owned session directories whose newest file is older than the cutoff. It never prunes the current session, host transcripts, Atlas bundles or custom entries in host sessions.

The plugin publishes no plugin-state snapshot of its own; clients can read native todo and subagent state from host RPC data and Atlas state from `omo-prometheus`'s snapshot.
