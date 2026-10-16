import { type EscalationReason, TASK_DIFFICULTIES, type TaskDifficulty } from "#src/routing.ts";

/** The first output line a child writes to ask its parent for a stronger re-dispatch. */
export const ESCALATE_LINE = "ESCALATE: deep-high";

/** How the next dispatch under a remembered name is raised. */
export interface Escalation {
  reason: EscalationReason;
  difficulty: TaskDifficulty;
}

const MEMO_LIMIT = 256;

function remember<V>(entries: Map<string, V>, key: string, value: V): void {
  entries.delete(key);
  entries.set(key, value);
  for (const oldest of entries.keys()) {
    if (entries.size <= MEMO_LIMIT) break;
    entries.delete(oldest);
  }
}

export function firstOutputLine(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The child output inside the host's `<task-result>` envelope, which is the
 * delivery text of a background task job: everything after its `<output>` or
 * `<preview …>` line. Empty when the envelope has neither.
 */
export function taskResultOutput(envelope: string): string {
  const lines = envelope.split("\n");
  const start = lines.findIndex((line) => line.trim() === "<output>" || line.trim().startsWith("<preview "));
  return start < 0 ? "" : lines.slice(start + 1).join("\n");
}

/**
 * Per-session memory of routed children whose next dispatch must be raised. A
 * record is keyed by the exact name its task item was dispatched under, never
 * with a suffix removed, so `Lane-1` and `Lane-2` stay apart. A child that
 * answers `ESCALATE: deep-high` raises its name to `demanding`; a child that
 * fails after judge-dispatch lowered its own spawn raises its name one
 * difficulty above the one applied. Each record serves one later dispatch;
 * both maps are bounded.
 */
export class EscalationMemo {
  /** Lowered difficulties by host child id, so same-named siblings never share one. */
  #lowered = new Map<string, TaskDifficulty>();
  #raised = new Map<string, Escalation>();

  /** Note that judge-dispatch lowered the spawn of the child with this host id. */
  lowered(childId: string, difficulty: TaskDifficulty): void {
    remember(this.#lowered, childId.trim(), difficulty);
  }

  /** Record the final outcome of the child `childId`, dispatched under the task name `name`. */
  settle(name: string, childId: string, failed: boolean, output: string): void {
    const lowered = this.#lowered.get(childId.trim());
    this.#lowered.delete(childId.trim());
    if (firstOutputLine(output) === ESCALATE_LINE) {
      remember(this.#raised, name, { reason: "escalate", difficulty: "demanding" });
    } else if (failed && lowered !== undefined) {
      const raised = TASK_DIFFICULTIES[Math.min(TASK_DIFFICULTIES.indexOf(lowered) + 1, TASK_DIFFICULTIES.length - 1)] ?? "demanding";
      remember(this.#raised, name, { reason: "failure", difficulty: raised });
    }
  }

  /** The escalation remembered for a task name, left in place until a routed dispatch uses it. */
  peek(name: string): Escalation | undefined {
    return this.#raised.get(name);
  }

  /** Drop the record once a dispatch under its name has been routed with it. */
  consume(name: string): void {
    this.#raised.delete(name);
  }
}
