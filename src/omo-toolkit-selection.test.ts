import { describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import omoToolkit from "../plugins/omo-toolkit/src/index.ts";

type BeforeAgentStart = (event: { systemPrompt: string[] }) => { systemPrompt: string[] } | undefined;

const BULLET_ROSTER = [
  "Spawn subagents.",
  "",
  "# Available Agents",
  "- `task`: General worker.",
  "- `deep-low`: Goal-oriented worker.",
  "- `librarian`: Research.",
  "",
  "# Delegation",
  "- `deep-high`: mentioned outside the roster",
].join("\n");

const HEADING_ROSTER = [
  "# Available Agents",
  "### deep-low",
  "Goal-oriented worker.",
  "### deep-high",
  "Escalated worker.",
  "### visual-engineering",
  "UI work.",
].join("\n");

function protocolFor(taskDescription: string | undefined, activeTools = ["read", "task"]): string | undefined {
  let handler: BeforeAgentStart | undefined;
  const pi = {
    logger: { warn() {} },
    on(event: string, registered: BeforeAgentStart) {
      if (event === "before_agent_start") handler = registered;
    },
    getActiveTools: () => activeTools,
    getAllTools: () =>
      taskDescription === undefined ? [] : [{ name: "task", description: taskDescription, parameters: {}, source: "builtin" }],
  } as unknown as ExtensionAPI;
  omoToolkit(pi);
  if (!handler) throw new Error("before_agent_start was not registered");
  const result = handler({ systemPrompt: ["base"] });
  if (!result) return undefined;
  expect(result.systemPrompt[0]).toBe("base");
  expect(result.systemPrompt).toHaveLength(2);
  return result.systemPrompt[1];
}

describe("omo-toolkit agent selection protocol", () => {
  test("is not injected when task is inactive", () => {
    expect(protocolFor(HEADING_ROSTER, ["read"])).toBeUndefined();
  });

  test("is not injected when the task roster lists no omo-toolkit agent", () => {
    expect(protocolFor("# Available Agents\n- `task`: General worker.\n- `scout`: Explorer.")).toBeUndefined();
    expect(protocolFor("# Available Agents\nAgent spawning is currently disabled.")).toBeUndefined();
    expect(protocolFor(undefined)).toBeUndefined();
  });

  test("bullet roster: names only listed agents and drops deep-high escalation when deep-high is unlisted", () => {
    const protocol = protocolFor(BULLET_ROSTER);

    expect(protocol).toContain("`deep-low`:");
    expect(protocol).toContain("`librarian`:");
    expect(protocol).toContain("When unsure, choose `deep-low`.");
    expect(protocol).not.toContain("`visual-engineering`");
    expect(protocol).not.toContain("to `deep-high`");
    expect(protocol).not.toContain("- `deep-high`:");
    expect(protocol).not.toContain("ESCALATE: parent");
    expect(protocol).toContain("ESCALATE: deep-high");
  });

  test("heading roster: deep-high listed enables escalation to deep-high and to the user", () => {
    const protocol = protocolFor(HEADING_ROSTER);

    expect(protocol).toContain("`visual-engineering`:");
    expect(protocol).toContain("- `deep-high`:");
    expect(protocol).toContain("to `deep-high`");
    expect(protocol).toContain("ESCALATE: parent");
    expect(protocol).not.toContain("`librarian`");
  });
});
