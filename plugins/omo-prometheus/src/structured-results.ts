import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/**
 * The task tool offers `outputSchema`/`schemaMode` only while `task.structured` is on (default off), and its schema
 * silently drops them otherwise. Gates and HEAVY verifiers need both, so while Atlas executes a runtime override turns
 * the setting on. The value records whether a runtime override existed before and what it was, so restoring puts back
 * exactly that layer.
 */
const forcedSessions = new WeakMap<AgentSession, { value: unknown } | undefined>();

function structuredSetting() {
  const setting = lookup("task.structured");
  if (!setting) throw new Error("host setting task.structured is not registered");
  return setting;
}

/** Turns `task.structured` on for this session; returns whether it changed now. */
export function forceStructuredResults(session: AgentSession): boolean {
  const setting = structuredSetting();
  const { settings } = session;
  if (forcedSessions.has(session) || setting.get(settings) === true) return false;
  forcedSessions.set(session, settings.getProvenance(setting) === "runtime" ? { value: setting.get(settings) } : undefined);
  setting.override(settings, true);
  return true;
}

export function restoreStructuredResults(session: AgentSession): void {
  if (!forcedSessions.has(session)) return;
  const previous = forcedSessions.get(session);
  forcedSessions.delete(session);
  const setting = structuredSetting();
  if (previous) setting.override(session.settings, previous.value);
  else setting.clearOverride(session.settings);
}
