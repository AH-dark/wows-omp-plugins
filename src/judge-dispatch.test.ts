import { describe, expect, test } from "bun:test";

import {
  acceptRoutingDecision,
  ExplicitSpawnClaims,
  type ModelOption,
  PendingSpawnRoutes,
  parseLegalAgentNames,
  parseTaskInput,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  type ScoredModelOption,
  selectSpawnModel,
  serializeCandidate,
} from "../plugins/judge-dispatch/src/routing.ts";

describe("task input routing", () => {
  test("rewrites only the flat agent field", () => {
    const input = {
      agent: "task",
      task: "Review the authentication boundary",
      effort: "hi",
      isolated: true,
      outputSchema: { type: "object" },
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid flat task input");

    expect(routes).toEqual([
      {
        index: null,
        assignment: "Review the authentication boundary",
        requestedAgent: "task",
        modelPinned: false,
      },
    ]);
    expect(rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer" }])).toEqual({
      ...input,
      agent: "security-reviewer",
    });
    expect(rewriteTaskRoutes(input, routes, [undefined])).toBe(input);
    expect(rewriteTaskRoutes(input, routes, [{ agent: "task", effort: "hi" }])).toBe(input);
    expect(input.agent).toBe("task");
  });

  test("a judged effort replaces or fills the requested effort", () => {
    const input = { agent: "task", task: "Trace the deadlock", effort: "lo" };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid flat task input");

    expect(rewriteTaskRoutes(input, routes, [{ effort: "hi" }])).toEqual({ ...input, effort: "hi" });
    const { effort: _, ...withoutEffort } = input;
    expect(rewriteTaskRoutes(withoutEffort, routes, [{ effort: "med" }])).toEqual({ ...withoutEffort, effort: "med" });
    expect(input.effort).toBe("lo");
  });

  test("a budget spawn name fills a missing name but never replaces the caller's", () => {
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
        { name: "Plan", agent: "task", task: "Sketch the migration" },
      ],
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid batch task input");
    const rewritten = rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer" }, undefined, { effort: "med" }]);

    expect(rewritten).toEqual({
      ...input,
      tasks: [{ ...input.tasks[0], agent: "security-reviewer" }, input.tasks[1], { ...input.tasks[2], effort: "med" }],
    });
    expect(input.tasks[0]?.agent).toBe("task");
    expect(input.tasks[2]).not.toHaveProperty("effort");
  });

  test("records only own model keys as pins and preserves them through agent and effort routing", () => {
    for (const model of ["@default", ["@slow", "openai/gpt-5"], undefined]) {
      const item = { agent: "task", task: "Inspect the boundary", model };
      for (const input of [item, { context: "shared", tasks: [item] }]) {
        const routes = parseTaskInput(input);
        if (!routes) throw new Error("expected valid pinned task input");
        expect(routes[0]?.modelPinned).toBe(true);
        const rewritten = rewriteTaskRoutes(input, routes, [{ agent: "scout", effort: "hi" }]);
        expect(rewritten).toEqual(
          "tasks" in input ? { ...input, tasks: [{ ...item, agent: "scout", effort: "hi" }] } : { ...item, agent: "scout", effort: "hi" },
        );
      }
    }
    const inherited = Object.assign(Object.create({ model: "@slow" }), { task: "Inspect the boundary" });
    expect(parseTaskInput(inherited)?.[0]?.modelPinned).toBe(false);
    expect(parseTaskInput({ context: "shared", tasks: [inherited] })?.[0]?.modelPinned).toBe(false);
  });

  test("leaves batch-level model keys untouched for the host to reject", () => {
    for (const model of ["@default", ["@slow"], undefined]) {
      expect(parseTaskInput({ context: "shared", tasks: [{ task: "Inspect the boundary" }], model })).toBeUndefined();
    }
  });

  test("leaves malformed task shapes unparsed", () => {
    expect(parseTaskInput({ context: "shared", tasks: [{ agent: "task" }] })).toBeUndefined();
    expect(parseTaskInput({ task: "valid", agent: 42 })).toBeUndefined();
  });
});

test("candidate serialization exposes only compact routing metadata", () => {
  const serialized = serializeCandidate({
    name: "scout",
    description: "Read-only   repository\nresearch",
    source: "bundled",
    readOnly: true,
    declaredModelPatterns: ["@smol"],
    model: {
      role: "smol",
      pool: [
        { pattern: "openai/gpt-fast:low", key: "openai/gpt-fast", provider: "openai", intelligence: 40, blendedPrice: 1 },
        { pattern: "anthropic/claude-haiku", key: "anthropic/claude-haiku", provider: "anthropic" },
      ],
    },
  });

  expect(serialized).toEqual({
    name: "scout",
    description: "Read-only repository research",
    source: "bundled",
    access: "read-only",
    model: { declared: ["@smol"], role: "smol", models: ["openai/gpt-fast", "anthropic/claude-haiku"] },
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
    { name: "reviewer", readOnly: true },
  ];

  test("never offers workflow-owned agents as destinations", () => {
    expect(routableCandidates("task", candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
    expect(routableCandidates(undefined, candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
  });

  test("keeps workflow-owned and unknown explicit sources untouched, including effort", () => {
    for (const name of ["audit-fixer", "audit-auditor", "metis", "momus", "oracle", "unknown-agent"]) {
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

describe("spawn model selection", () => {
  const option = (key: string, intelligence: number, blendedPrice: number): ScoredModelOption => ({
    pattern: `${key}:high`,
    key,
    provider: key.slice(0, key.indexOf("/")),
    intelligence,
    blendedPrice,
  });
  // A strongest-first chain: the primary is the best model, fallbacks get weaker.
  const primary = option("openai/primary", 50, 4);
  const sibling = option("openai/sibling", 47, 4);
  const stronger = option("anthropic/stronger", 58, 8);
  const weak = option("cheap/weak", 26, 1.5);
  const pool = [primary, sibling, stronger, weak];
  const fitFor = (key: string) => Object.fromEntries(pool.map((entry) => [entry.key, entry.key === key ? 0.7 : 0.1]));
  const base = { pool, providerWeights: new Map<string, number>() };
  const sample = (budget: "minimum" | "balanced" | "max", difficulty: "routine" | "standard" | "demanding", random: number) =>
    selectSpawnModel({ ...base, budget, difficulty, pick: "weighted", random: () => random })?.chosen?.key;

  test("best takes the judge's fit among models the budget admits relative to the primary", () => {
    const pick = (budget: "minimum" | "balanced" | "max", key: string) =>
      selectSpawnModel({ ...base, budget, difficulty: "routine", pick: "best", fit: fitFor(key) })?.chosen?.key;
    expect(pick("balanced", "openai/sibling")).toBe("openai/sibling");
    expect(pick("balanced", "anthropic/stronger")).toBe("anthropic/stronger");
    expect(pick("balanced", "cheap/weak")).toBe("openai/primary");
    expect(pick("max", "openai/sibling")).toBe("openai/primary");
    expect(pick("minimum", "cheap/weak")).toBe("cheap/weak");
  });

  test("best keeps the primary without a model judgment", () => {
    expect(selectSpawnModel({ ...base, budget: "minimum", difficulty: "routine", pick: "best" })).toEqual({
      primary: "openai/primary",
      keptReason: "no model judgment",
    });
  });

  test("provider weights multiply the judged fit", () => {
    const fit = { "openai/primary": 0.3, "anthropic/stronger": 0.45, "openai/sibling": 0.25 };
    const pick = (weights: [string, number][]) =>
      selectSpawnModel({ ...base, providerWeights: new Map(weights), budget: "balanced", difficulty: "routine", pick: "best", fit })?.chosen
        ?.key;
    expect(pick([])).toBe("anthropic/stronger");
    expect(pick([["openai", 2]])).toBe("openai/primary");
  });

  test("weighted sampling reaches every admitted model and favors cheap ones on lower budgets", () => {
    // Cost order: weak 1.5, sibling 4 (weaker of the 4s), primary 4, stronger 8.
    expect(sample("minimum", "routine", 0)).toBe("openai/primary");
    expect(sample("minimum", "routine", 0.99)).toBe("cheap/weak");
    expect(sample("balanced", "demanding", 0.99)).toBe("anthropic/stronger");
    expect(sample("max", "routine", 0.99)).toBe("anthropic/stronger");
    // routine/minimum weights in pool order: primary 1/9, sibling 1/4, stronger 1/16, weak 1, so weak takes about 70% of draws.
    const draws = Array.from({ length: 100 }, (_, index) => sample("minimum", "routine", index / 100));
    expect(draws.filter((key) => key === "cheap/weak").length).toBeGreaterThanOrEqual(65);
    expect(new Set(draws).size).toBe(4);
  });

  test("an unscored primary or a single admitted model keeps the configured primary", () => {
    const unscored: ModelOption = { pattern: "x/unknown", key: "x/unknown", provider: "x" };
    expect(selectSpawnModel({ ...base, pool: [unscored, primary], budget: "minimum", difficulty: "routine", pick: "weighted" })).toEqual({
      primary: "x/unknown",
      keptReason: "primary model has no catalog score",
    });
    expect(selectSpawnModel({ ...base, pool: [stronger, primary], budget: "max", difficulty: "routine", pick: "weighted" })).toEqual({
      primary: "anthropic/stronger",
      keptReason: "no eligible alternatives",
    });
  });
});

describe("pending spawn routes", () => {
  const decision = { agent: "task", primary: "openai/primary", patterns: ["openai/sibling"], note: "note" };

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

describe("pinned task models", () => {
  test("splits a pin into its base agent and raw target in flat and batch items", () => {
    const flat = { task: "Inspect the boundary", agent: " scout @ openai/gpt-5-mini:high ", name: "Review" };
    expect(parseTaskInput(flat)).toEqual([
      {
        index: null,
        assignment: "Inspect the boundary",
        requestedAgent: "scout",
        explicitModel: "openai/gpt-5-mini:high",
        modelPinned: false,
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
    expect(parseTaskInput({ task: "Inspect the boundary", agent: "scout@abliterated", model: "openai/gpt-5" })?.[0]).toEqual(
      expect.objectContaining({ requestedAgent: "scout", explicitModel: "abliterated", modelPinned: true }),
    );
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
