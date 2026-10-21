import { describe, expect, test } from "bun:test";

import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

import { EscalationMemo, taskResultOutput } from "../plugins/judge-dispatch/src/escalation.ts";
import {
  acceptRoutingDecision,
  ExplicitSpawnClaims,
  PendingSpawnRoutes,
  parseLegalAgentNames,
  parseModelTiers,
  parseTaskInput,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  serializeCandidate,
  type TaskDifficulty,
  thinkingStep,
  tierFor,
} from "../plugins/judge-dispatch/src/routing.ts";

describe("task input routing", () => {
  test("rewrites only the flat agent field and never the requested effort", () => {
    const input = {
      agent: "task",
      task: "Review the authentication boundary",
      effort: "hi",
      solutionSpace: "cause open, no repro",
      isolated: true,
      outputSchema: { type: "object" },
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid flat task input");

    expect(routes).toEqual([
      {
        index: null,
        assignment: "Review the authentication boundary",
        solutionSpace: "cause open, no repro",
        explicitEffort: true,
        requestedAgent: "task",
      },
    ]);
    expect(rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer", difficulty: "demanding" }])).toEqual({
      ...input,
      agent: "security-reviewer",
    });
    expect(rewriteTaskRoutes(input, routes, [undefined])).toBe(input);
    expect(rewriteTaskRoutes(input, routes, [{ agent: "task", difficulty: "routine" }])).toBe(input);
    expect(input.agent).toBe("task");
  });

  test("a routing spawn name fills a missing name but never replaces the caller's", () => {
    const unnamed = { agent: "task", task: "Rename a helper" };
    const unnamedRoutes = parseTaskInput(unnamed);
    if (!unnamedRoutes) throw new Error("expected valid flat task input");
    expect(rewriteTaskRoutes(unnamed, unnamedRoutes, [{ name: "task-1a2b3c4d" }])).toEqual({ ...unnamed, name: "task-1a2b3c4d" });

    const named = { ...unnamed, name: "Rename" };
    const namedRoutes = parseTaskInput(named);
    if (!namedRoutes) throw new Error("expected valid flat task input");
    expect(namedRoutes[0]?.name).toBe("Rename");
    expect(rewriteTaskRoutes(named, namedRoutes, [{ name: "task-1a2b3c4d" }])).toBe(named);
  });

  test("rewrites batch items independently without changing shared context or sibling fields", () => {
    const input = {
      context: "Shared release constraints",
      async: true,
      tasks: [
        { name: "Audit", agent: "task", task: "Inspect the boundary", effort: "hi", isolated: true },
        { name: "Docs", agent: "sonic", task: "Correct one heading", effort: "lo", tools: ["lookup"] },
        { agent: "task", task: "Sketch the migration", solutionSpace: "several designs open" },
      ],
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid batch task input");
    expect(routes.map(({ solutionSpace, explicitEffort }) => ({ solutionSpace, explicitEffort }))).toEqual([
      { solutionSpace: undefined, explicitEffort: true },
      { solutionSpace: undefined, explicitEffort: true },
      { solutionSpace: "several designs open", explicitEffort: undefined },
    ]);
    const rewritten = rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer" }, undefined, { name: "task-1a2b3c4d" }]);

    expect(rewritten).toEqual({
      ...input,
      tasks: [{ ...input.tasks[0], agent: "security-reviewer" }, input.tasks[1], { ...input.tasks[2], name: "task-1a2b3c4d" }],
    });
    expect(input.tasks[0]?.agent).toBe("task");
    expect(input.tasks[2]).not.toHaveProperty("name");
  });

  test("leaves malformed task shapes unparsed", () => {
    expect(parseTaskInput({ context: "shared", tasks: [{ agent: "task" }] })).toBeUndefined();
    expect(parseTaskInput({ task: "valid", agent: 42 })).toBeUndefined();
  });
});

test("candidate serialization exposes only compact agent metadata, never models", () => {
  const serialized = serializeCandidate({
    name: "scout",
    description: "Read-only   repository\nresearch",
    source: "bundled",
    readOnly: true,
    patterns: ["openai/gpt-fast:low"],
    thinkingLevel: "medium" as ConfiguredThinkingLevel,
  });

  expect(serialized).toEqual({
    name: "scout",
    description: "Read-only repository research",
    source: "bundled",
    access: "read-only",
  });
});

test("keeps routing below the scoped tool-call timeout", () => {
  expect(routingDeadlineMs(30_000)).toBe(8_000);
  expect(routingDeadlineMs(5_000)).toBe(4_000);
  expect(routingDeadlineMs(1_200)).toBeUndefined();
  expect(routingDeadlineMs(Number.NaN)).toBeUndefined();
});

describe("legal agent extraction", () => {
  const description = [
    "Delegate work to background subagents.",
    "",
    "# Available Agents",
    "Pick the most specific agent.",
    "### scout (READ-ONLY)",
    "Fast read-only research.",
    "### security-reviewer",
    "Evidence-backed security analysis.",
  ].join("\n");

  test("reads the host's rendered spawnable agent list", () => {
    expect(parseLegalAgentNames(description)).toEqual(["scout", "security-reviewer"]);
  });

  test("reads backticked bullet names only inside the available agents section", () => {
    const bulletDescription = [
      "# Available Agents",
      "`m<N>` is a user-tagged model.",
      "- `scout` (READ-ONLY; investigation only, no edits): Research",
      "- `task`: Implement",
      "- `scout`: Duplicate entry",
      "# Other Section",
      "- `audit-fixer`: Not a task agent",
    ].join("\n");
    expect(parseLegalAgentNames(bulletDescription)).toEqual(["scout", "task"]);
    expect(parseLegalAgentNames("# Available Agents\n### task\n# Other Section\n### intruder")).toEqual(["task"]);
  });

  test("does not treat an unrecognized or empty section as disabled", () => {
    expect(parseLegalAgentNames("# Available Agents\nUnrecognized listing format\n")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\n# Other Section\nAgent spawning is currently disabled.")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\n")).toBeUndefined();
  });

  test("reports spawning-disabled sessions as an empty legal set", () => {
    expect(parseLegalAgentNames("# Available Agents\nAgent spawning is currently disabled.\n")).toEqual([]);
  });

  test("returns undefined when the section is absent so callers can fail open", () => {
    expect(parseLegalAgentNames("Delegate work to ONE background subagent per call.")).toBeUndefined();
  });
});

describe("routing authority boundaries", () => {
  const candidates = [
    { name: "task", readOnly: false },
    { name: "audit-auditor", readOnly: true },
    { name: "scout", readOnly: true },
    { name: "audit-fixer", readOnly: false },
    { name: "metis", readOnly: true },
    { name: "momus", readOnly: true },
    { name: "oracle", readOnly: true },
    { name: "seance", readOnly: true },
    { name: "reviewer", readOnly: true },
  ];

  test("never offers workflow-owned agents as destinations", () => {
    expect(routableCandidates("task", candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
    expect(routableCandidates(undefined, candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
  });

  test("keeps workflow-owned and unknown explicit sources untouched, including effort", () => {
    for (const name of ["audit-fixer", "audit-auditor", "metis", "momus", "oracle", "seance", "unknown-agent"]) {
      expect(routableCandidates(name, candidates)).toBeUndefined();
    }
  });

  test("restricts a read-only source to read-only destinations", () => {
    expect(routableCandidates("scout", candidates)?.map((candidate) => candidate.name)).toEqual(["scout", "reviewer"]);
  });
});

describe("routing decision acceptance", () => {
  const candidates = ["task", "scout"];

  test("accepts a legal native choice at the threshold", () => {
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: 0.7 }, candidates, 0.7)).toBe("scout");
  });

  test("rejects low-confidence, non-native, and illegal choices", () => {
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: 0.69 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: Number.NaN }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "online", choice: "scout", confidence: 1 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "local", choice: "scout", confidence: 1 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "native", choice: "missing", confidence: 1 }, candidates, 0.7)).toBeUndefined();
  });
});

describe("model tiers", () => {
  test("an agent's own tier beats the tier for every agent, and standard work always keeps the agent's model", () => {
    const tiers = parseModelTiers(" routine=@smol, demanding=openai/gpt-5:high ,ultrabrain.demanding=@slow ");
    expect(tierFor(tiers, "ultrabrain", "demanding")).toBe("@slow");
    expect(tierFor(tiers, "ultrabrain", "routine")).toBe("@smol");
    expect(tierFor(tiers, "scout", "demanding")).toBe("openai/gpt-5:high");
    expect(tierFor(tiers, "ultrabrain", "standard")).toBeUndefined();
    expect(tierFor(parseModelTiers(""), "scout", "routine")).toBeUndefined();
  });

  test("refuses the whole setting on any malformed or repeated entry", () => {
    const malformed = [
      "standard=@smol",
      "routine",
      "routine=",
      "routine=smol",
      "routine=@smol:high",
      "routine=pi/smol",
      "routine=@smol,routine=@slow",
      "scout.routine=openai/a,openai/b",
      "scout.fast=@smol",
      "routine=@smol,",
      ",demanding=@slow",
    ];
    for (const raw of malformed) expect(() => parseModelTiers(raw), raw).toThrow("invalid modelTiers entry");
  });
});

describe("thinking steps", () => {
  const model = (efforts: string[]) =>
    ({ provider: "openai", id: "fixture", reasoning: true, thinking: { mode: "effort", efforts } }) as unknown as Model;
  // Host thinking levels are a const enum; the fixtures use their string values.
  const step = (target: Model | undefined, baseline: string | undefined, difficulty: TaskDifficulty, ceiling?: string) =>
    thinkingStep(target, baseline as ConfiguredThinkingLevel | undefined, difficulty, ceiling as Effort | undefined) as
      | { from: string; to: string }
      | undefined;
  const ladder = model(["minimal", "low", "medium", "high"]);
  const sparse = model(["low", "high", "xhigh"]);

  test("moves one supported level from the baseline in the judged direction", () => {
    expect(step(ladder, "medium", "demanding")).toEqual({ from: "medium", to: "high" });
    expect(step(ladder, "medium", "routine")).toEqual({ from: "medium", to: "low" });
    expect(step(ladder, "medium", "standard")).toBeUndefined();
    // The baseline counts as the level the model would really run: medium runs as low on this ladder.
    expect(step(sparse, "medium", "demanding")).toEqual({ from: "low", to: "high" });
  });

  test("never steps below the lowest supported level, so never to off, nor above the highest", () => {
    expect(step(ladder, "minimal", "routine")).toBeUndefined();
    expect(step(sparse, "low", "routine")).toBeUndefined();
    expect(step(ladder, "high", "demanding")).toBeUndefined();
  });

  test("respects task.maxEffort, dropping a step up that the ceiling would cancel", () => {
    expect(step(sparse, "high", "demanding", "max")).toEqual({ from: "high", to: "xhigh" });
    expect(step(sparse, "high", "demanding", "high")).toBeUndefined();
    expect(step(ladder, "medium", "demanding", "medium")).toBeUndefined();
    expect(step(model(["low", "medium", "high", "xhigh"]), "xhigh", "routine", "medium")).toEqual({ from: "xhigh", to: "medium" });
    expect(step(model(["high", "xhigh"]), "high", "demanding", "low")).toBeUndefined();
    expect(step(model(["high", "xhigh"]), "xhigh", "routine", "low")).toBeUndefined();
  });

  test("leaves auto, inherit, off, a missing baseline and models without thinking levels alone", () => {
    for (const baseline of ["auto", "inherit", "off", undefined]) expect(step(ladder, baseline, "demanding")).toBeUndefined();
    expect(step(model([]), "medium", "demanding")).toBeUndefined();
    expect(step(undefined, "medium", "demanding")).toBeUndefined();
  });
});

describe("pending spawn routes", () => {
  const decision = {
    kind: "tier" as const,
    agent: "task",
    primary: "openai/primary",
    difficulty: "routine" as const,
    patterns: ["openai/sibling"],
    note: "note",
  };

  test("matches the host's prefixed and collision-suffixed spawn keys once", () => {
    const pending = new PendingSpawnRoutes();
    pending.add("Audit", decision);
    expect(pending.take("parent.Audit-2", "task")).toEqual(decision);
    expect(pending.take("Audit", "task")).toBeUndefined();
  });

  test("an agent mismatch or a name claimed twice changes nothing", () => {
    const pending = new PendingSpawnRoutes();
    pending.add("Audit", decision);
    expect(pending.take("Audit", "scout")).toBeUndefined();
    pending.add("Plan", decision);
    pending.add("Plan", decision);
    expect(pending.take("Plan", "task")).toBeUndefined();
    expect(pending.take("Plan-2", "task")).toBeUndefined();
  });
});

describe("escalation memo", () => {
  test("an ESCALATE answer raises the next dispatch under that name to demanding until a routed dispatch consumes it", () => {
    const memo = new EscalationMemo();
    memo.settle("Fix", "parent.Fix-2", false, "\n  ESCALATE: deep-high  \nThe cause is still open.");
    expect(memo.peek("Other")).toBeUndefined();
    expect(memo.peek("Fix")).toEqual({ reason: "escalate", difficulty: "demanding" });
    expect(memo.peek("Fix")).toEqual({ reason: "escalate", difficulty: "demanding" });
    memo.consume("Fix");
    expect(memo.peek("Fix")).toBeUndefined();
  });

  test("keeps the caller's names exact, including their own numeric suffixes", () => {
    const memo = new EscalationMemo();
    // A retried `Lane-1` runs as host child `Lane-1-2`; its record belongs to `Lane-1` alone.
    memo.settle("Lane-1", "parent.Lane-1-2", false, "ESCALATE: deep-high");
    expect(memo.peek("Lane-1")).toEqual({ reason: "escalate", difficulty: "demanding" });
    expect(memo.peek("Lane")).toBeUndefined();
    expect(memo.peek("Lane-2")).toBeUndefined();
  });

  test("a failure raises the next dispatch one difficulty only after judge-dispatch lowered that child", () => {
    const memo = new EscalationMemo();
    memo.settle("Plain", "Plain", true, "Task failed");
    expect(memo.peek("Plain")).toBeUndefined();

    memo.lowered("parent.Cheap", "routine");
    memo.settle("Cheap", "parent.Cheap", true, "Task failed");
    expect(memo.peek("Cheap")).toEqual({ reason: "failure", difficulty: "standard" });

    memo.lowered("Fine", "routine");
    memo.settle("Fine", "Fine", false, "Done.");
    memo.settle("Fine", "Fine", true, "A later run that was not lowered failed.");
    expect(memo.peek("Fine")).toBeUndefined();
  });

  test("a same-named concurrent child does not inherit another child's lowered route", () => {
    const memo = new EscalationMemo();
    memo.lowered("parent.Fix", "routine");
    memo.settle("Fix", "parent.Fix-2", true, "This child was not lowered.");
    expect(memo.peek("Fix")).toBeUndefined();
    memo.settle("Fix", "parent.Fix", true, "The lowered child failed too.");
    expect(memo.peek("Fix")).toEqual({ reason: "failure", difficulty: "standard" });
  });

  test("ignores an escalation line that is not the first", () => {
    const memo = new EscalationMemo();
    memo.settle("Late", "Late", false, "Summary first.\nESCALATE: deep-high");
    expect(memo.peek("Late")).toBeUndefined();
  });

  test("reads a background child's answer from the host's rendered task-result envelope", () => {
    const envelope = (output: string, outputPath?: string) =>
      formatTaskResultSummary(
        {
          index: 0,
          id: "Fix",
          agent: "deep-low",
          agentSource: "bundled",
          task: "Fix the deadlock",
          exitCode: 0,
          output,
          stderr: "",
          truncated: false,
          durationMs: 1,
          tokens: 0,
          requests: 1,
          ...(outputPath ? { outputPath } : {}),
        },
        { totalDurationMs: 1 },
      );
    const outcome = (output: string) => {
      const memo = new EscalationMemo();
      memo.settle("Fix", "Fix", false, taskResultOutput(output));
      return memo.peek("Fix");
    };
    expect(outcome(envelope("ESCALATE: deep-high\nThe design is open."))).toEqual({ reason: "escalate", difficulty: "demanding" });
    // Long output arrives as a preview pointing at the full output.
    expect(outcome(envelope(`ESCALATE: deep-high\n${"detail\n".repeat(1_000)}`, "/tmp/Fix.md"))).toEqual({
      reason: "escalate",
      difficulty: "demanding",
    });
    expect(outcome(envelope("Fixed the deadlock.\nESCALATE: deep-high"))).toBeUndefined();
  });
});

describe("pinned task models", () => {
  test("splits a pin into its base agent and raw target in flat and batch items", () => {
    const flat = { task: "Inspect the boundary", agent: " scout @ openai/gpt-5-mini:high ", name: "Review" };
    expect(parseTaskInput(flat)).toEqual([
      {
        index: null,
        assignment: "Inspect the boundary",
        requestedAgent: "scout",
        explicitModel: "openai/gpt-5-mini:high",
        name: "Review",
      },
    ]);
    const routes = parseTaskInput({
      context: "shared",
      tasks: [
        { task: "Pinned role", agent: "task@abliterated" },
        { task: "Plain", agent: "task" },
      ],
    });
    expect(routes?.map(({ requestedAgent, explicitModel }) => ({ requestedAgent, explicitModel }))).toEqual([
      { requestedAgent: "task", explicitModel: "abliterated" },
      { requestedAgent: "task", explicitModel: undefined },
    ]);
  });

  test("keeps malformed pins visible so the caller can refuse them", () => {
    const parsed = (agent: string) => parseTaskInput({ task: "Inspect the boundary", agent })?.[0];
    expect(parsed("@abliterated")).toEqual(expect.objectContaining({ explicitModel: "abliterated" }));
    expect(parsed("@abliterated")?.requestedAgent).toBeUndefined();
    expect(parsed("scout@")).toEqual(expect.objectContaining({ requestedAgent: "scout", explicitModel: "" }));
  });

  test("each claim gets a unique spawn name that only its own spawn key consumes once; a pinned name without a claim is lost", () => {
    const model = { target: "@abliterated", patterns: ["openai/gpt-5-mini"], note: "note" };
    const claims = new ExplicitSpawnClaims();
    const first = claims.claim("call", "Scout", model);
    const second = claims.claim("call", "Scout", model);
    expect(first).toMatch(/^Scout_jd[0-9a-f]{12}$/);
    expect(second).toMatch(/^Scout_jd[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    expect(claims.claim("call", "parent.child", model)).toMatch(/^parent-child_jd[0-9a-f]{12}$/);
    for (const key of ["Scout", "Scout-2", `${first}x`, `${first}-2`]) expect(claims.take(key)).toBeUndefined();
    expect(claims.take(`parent.${second}`)).toBe(model);
    expect(claims.take(` ${first} `)).toBe(model);
    expect(claims.take(first)).toBe("lost");
    expect(claims.take("Other_jd0123456789ab")).toBe("lost");
  });
});
