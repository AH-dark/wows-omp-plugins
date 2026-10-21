import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import type { ExecutionLedger, LedgerItem } from "./ledger.ts";

const TASKS = "Atlas tasks";
const DISCOVERED = "Atlas discovered";
const FIXES = "Atlas fixes";
const GATES = "Atlas final gates";
const DELIVERY = "Atlas delivery";
const ATLAS_PHASES: Record<string, true> = { [TASKS]: true, [DISCOVERED]: true, [FIXES]: true, [GATES]: true, [DELIVERY]: true };

function todoItem(row: LedgerItem): TodoItem {
  const content = `${row.id}. ${row.title}`;
  if (row.status === "blocked") {
    const blocker = row.evidence?.replace(/\s+/g, " ").trim().slice(0, 240);
    return { content, status: "blocked", ...(blocker ? { blocker } : {}) };
  }
  return {
    content,
    status: row.status === "open" ? "pending" : row.status === "done" ? "completed" : "in_progress",
  };
}

/** The ledger alone determines Atlas phase membership, order and state. */
export function atlasTodoPhases(ledger: ExecutionLedger): TodoPhase[] {
  return [
    { name: TASKS, tasks: ledger.items.map(todoItem) },
    ...(ledger.discoveries.length ? [{ name: DISCOVERED, tasks: ledger.discoveries.map(todoItem) }] : []),
    ...(ledger.fixes.length ? [{ name: FIXES, tasks: ledger.fixes.map(todoItem) }] : []),
    { name: GATES, tasks: ledger.gates.map(todoItem) },
    ...(ledger.deliveries.length ? [{ name: DELIVERY, tasks: ledger.deliveries.map(todoItem) }] : []),
  ];
}

/**
 * Retain unrelated phases at their existing positions, replacing only reserved Atlas phases. A newly appearing
 * Atlas phase goes before the first later Atlas phase already listed, so discovered work and fixes precede the gates.
 */
export function mergeAtlasTodos(current: readonly TodoPhase[], ledger: ExecutionLedger): TodoPhase[] | undefined {
  const atlas = atlasTodoPhases(ledger);
  const seen = new Set<string>();
  const next: TodoPhase[] = [];
  for (const phase of current) {
    if (!Object.hasOwn(ATLAS_PHASES, phase.name)) {
      next.push(phase);
      continue;
    }
    const replacement = atlas.find((entry) => entry.name === phase.name);
    if (replacement && !seen.has(phase.name)) {
      next.push(replacement);
      seen.add(phase.name);
    }
  }
  for (const [index, phase] of atlas.entries()) {
    if (seen.has(phase.name)) continue;
    const later = atlas.slice(index + 1).map((entry) => entry.name);
    const position = next.findIndex((entry) => later.includes(entry.name));
    next.splice(position === -1 ? next.length : position, 0, phase);
    seen.add(phase.name);
  }
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
}

/** Follow the host's /todo commit order; only validated, active ledgers may reach this call. */
export function syncAtlasTodos(
  session: { getTodoPhases(): TodoPhase[]; setTodoPhases(phases: TodoPhase[]): void },
  sessionManager: { appendCustomEntry(type: string, data: { phases: TodoPhase[] }): unknown },
  ledger: ExecutionLedger,
): boolean {
  const next = mergeAtlasTodos(session.getTodoPhases(), ledger);
  if (!next) return false;
  session.setTodoPhases(next);
  sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: next });
  return true;
}

/** Non-view host todo operations succeed when repeated against the already-synced target; the row's state picks the op. */
export function atlasTodoRefreshCall(row: LedgerItem): string {
  const op = row.status === "in_progress" ? "start" : row.status === "done" ? "done" : row.status === "blocked" ? "block" : "unblock";
  const call = {
    op,
    task: `${row.id}. ${row.title}`,
    ...(op === "block" && row.evidence ? { reason: row.evidence.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
  };
  return `Refresh the todo HUD now with the already-synced item: todo(${JSON.stringify(call)}). Until a todo call has succeeded, task dispatch, wait and atlas_release are refused, even in the same response as the todo call, because the guard checks before either runs: pair the todo call only with independent read-only calls, and send task, wait or atlas_release in the next response. One call covers every ledger change before it. Do not edit Atlas phases manually.`;
}
