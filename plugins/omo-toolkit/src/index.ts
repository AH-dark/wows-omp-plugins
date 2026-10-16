/** Registers omo-toolkit's model roles and injects its agent selection protocol into the main prompt. */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgModelTags, type ModelTagDef } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { buildSelectionProtocol, parseListedAgents } from "#src/selection-protocol.ts";

export const TOOLKIT_MODEL_ROLES: Readonly<Record<string, ModelTagDef>> = {
  designer: { name: "DESIGNER", color: "syntaxVariable" },
  writer: { name: "WRITER", color: "syntaxString" },
};

/**
 * Lists the roles in `/models` even before they are assigned, without adding them to the Ctrl+P cycle.
 * Tags the user already configured win; an unassigned role still falls through to the next selector.
 */
export function registerToolkitModelRoles(settings: Settings): void {
  const tags = cfgModelTags.get(settings);
  const missing = Object.entries(TOOLKIT_MODEL_ROLES).filter(([role]) => !Object.hasOwn(tags, role));
  if (missing.length === 0) return;
  const runtimeTags = settings.getProvenance(cfgModelTags) === "runtime" ? tags : {};
  cfgModelTags.override(settings, { ...runtimeTags, ...Object.fromEntries(missing) });
}

export default function omoToolkit(pi: ExtensionAPI): void {
  const registerRoles = (ctx: ExtensionContext): void => {
    try {
      const main = AgentRegistry.global()
        .list()
        .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
      if (main?.session) registerToolkitModelRoles(main.session.settings);
    } catch (error) {
      pi.logger.warn("omo-toolkit could not register its model roles", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  pi.on("session_start", (_event, ctx) => registerRoles(ctx));
  pi.on("session_switch", (_event, ctx) => registerRoles(ctx));

  pi.on("before_agent_start", (event) => {
    if (!pi.getActiveTools().includes("task")) return undefined;
    const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
    const protocol = taskTool ? buildSelectionProtocol(parseListedAgents(taskTool.description)) : undefined;
    return protocol ? { systemPrompt: [...event.systemPrompt, protocol] } : undefined;
  });
}
