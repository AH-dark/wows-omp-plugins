import { expect, test } from "bun:test";

import { AftContract, type AftProjection, type AftTool } from "../plugins/omo-prometheus/src/aft-contract.ts";
import {
  aftProjectionBlockReason,
  executionBlockReason,
  executionToolSourceBlockReason,
  type TrustedToolSources,
} from "../plugins/omo-prometheus/src/workflow.ts";

const AFT_ENTRY = "/repo/.omp/extensions/aft/dist/index.js";
const OTHER_PATH = "/repo/.omp/extensions/rogue/dist/index.js";

/** A synchronous pi.events stand-in: listeners run inside emit, like the host bus's handlers before their first await. */
class ContractEvents {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(channel: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(payload);
  }
}

function toolEntry(name: string, sourcePath: string, capabilities: string[]): Record<string, unknown> {
  return { name, sourcePath, capabilities };
}

function respond(bus: ContractEvents, tools: unknown, project: unknown = async () => ({ kind: "observation", paths: [], broad: false })) {
  return bus.on("aft:binding-request", (raw) => {
    const request = raw as { sessionId: string; requestId: string };
    bus.emit("aft:binding", { ...request, v: 1, tools, project });
  });
}

test("AFT handshake accepts only a well-formed v1 answer and remembers it for the session", () => {
  const bus = new ContractEvents();
  const contract = new AftContract(bus);
  const tools = [toolEntry("aft_outline", AFT_ENTRY, ["observation"]), toolEntry("read", AFT_ENTRY, ["observation", "mutation"])];
  const unsubscribe = respond(bus, tools);

  const binding = contract.requestBinding("s1");
  expect(binding?.v).toBe(1);
  expect(binding?.tools.size).toBe(2);
  const outline = binding?.tools.get("aft_outline");
  expect(outline?.sourcePath).toBe(AFT_ENTRY);
  expect(outline?.capabilities.has("observation")).toBe(true);
  expect(typeof binding?.project).toBe("function");

  // Cached: a second lookup does not need another responder.
  unsubscribe();
  expect(contract.binding("s1")?.tools.size).toBe(2);

  contract.forget("s1");
  expect(contract.binding("s1")).toBeUndefined();
});

test("AFT handshake ignores mismatched version/session/request and non-correlated or duplicate replies", () => {
  const bus = new ContractEvents();
  const contract = new AftContract(bus);
  let requestId = "";
  bus.on("aft:binding-request", (raw) => {
    const request = raw as { sessionId: string; requestId: string };
    requestId = request.requestId;
    const tools = [toolEntry("aft_search", AFT_ENTRY, ["observation"])];
    const project = async () => ({ kind: "observation" as const, paths: [], broad: false });
    bus.emit("aft:binding", { ...request, v: 2, tools, project });
    bus.emit("aft:binding", { ...request, v: 1, sessionId: "other", tools, project });
    bus.emit("aft:binding", { ...request, v: 1, requestId: "other", tools, project });
    bus.emit("aft:binding", { v: 1, sessionId: request.sessionId, requestId: request.requestId, tools, project });
  });
  const binding = contract.requestBinding("s1");
  expect(binding?.requestId).toBe(requestId);
  expect(binding?.tools.get("aft_search")?.sourcePath).toBe(AFT_ENTRY);
});

test("AFT handshake rejects a malformed tools array or a missing project function", () => {
  const bus = new ContractEvents();
  const contract = new AftContract(bus);
  const project = async () => ({ kind: "observation" as const, paths: [], broad: false });

  // Duplicate name.
  let unsubscribe = respond(bus, [toolEntry("read", AFT_ENTRY, ["observation"]), toolEntry("read", AFT_ENTRY, ["observation"])], project);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();

  // Relative source path.
  unsubscribe = respond(bus, [toolEntry("read", "relative/index.js", ["observation"])], project);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();

  // Empty capabilities.
  unsubscribe = respond(bus, [toolEntry("read", AFT_ENTRY, [])], project);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();

  // Unknown capability.
  unsubscribe = respond(bus, [toolEntry("read", AFT_ENTRY, ["rewrite"])], project);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();

  // Missing project function.
  unsubscribe = respond(bus, [toolEntry("read", AFT_ENTRY, ["observation"])], null);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();

  // Empty or non-string name.
  unsubscribe = respond(bus, [{ name: "", sourcePath: AFT_ENTRY, capabilities: ["observation"] }], project);
  expect(contract.requestBinding("s1")).toBeUndefined();
  unsubscribe();
});

test("a miss retries on the next call instead of caching a negative result", () => {
  const bus = new ContractEvents();
  const contract = new AftContract(bus);
  expect(contract.binding("s1")).toBeUndefined();
  respond(bus, [toolEntry("aft_outline", AFT_ENTRY, ["observation"])]);
  expect(contract.binding("s1")?.tools.get("aft_outline")).toBeDefined();
});

function trustedWith(
  tools: AftTool[],
  project: (toolName: string, input: Record<string, unknown>, cwd: string) => Promise<AftProjection> = async () => ({
    kind: "observation",
    paths: [],
    broad: false,
  }),
): TrustedToolSources {
  const map = new Map(tools.map((tool): [string, AftTool] => [tool.name, tool]));
  return { aft: { v: 1, sessionId: "s1", requestId: "r1", tools: map, project } };
}

function aftTool(name: string, sourcePath: string, capabilities: Array<"observation" | "mutation" | "execution" | "native-url">): AftTool {
  return { name, sourcePath, capabilities: new Set(capabilities) };
}

test("Atlas admits an AFT observation tool only when the session binding names it with observation capability", () => {
  const trusted = trustedWith([aftTool("aft_outline", AFT_ENTRY, ["observation"])]);
  expect(executionBlockReason("aft_outline", { target: "src" }, trusted)).toBeUndefined();
  // Unbound: no AFT handshake answered this session.
  expect(executionBlockReason("aft_outline", { target: "src" })).toBeTruthy();
  // Bound to a different tool name.
  expect(executionBlockReason("aft_zoom", { target: "src" }, trusted)).toBeTruthy();
  // Enumerated but not bound in this session's handshake.
  expect(executionBlockReason("aft_safety", { op: "list" }, trusted)).toBeTruthy();
});

test("aft_safety admits only list/history, never checkpoint/restore/undo/purge, independent of binding", () => {
  const trusted = trustedWith([aftTool("aft_safety", AFT_ENTRY, ["observation", "mutation"])]);
  expect(executionBlockReason("aft_safety", { op: "list" }, trusted)).toBeUndefined();
  expect(executionBlockReason("aft_safety", { op: "history", path: "src/index.ts" }, trusted)).toBeUndefined();
  for (const op of ["checkpoint", "restore", "undo", "purge"]) {
    expect(executionBlockReason("aft_safety", { op }, trusted)).toBeTruthy();
  }
  expect(executionBlockReason("aft_safety", {}, trusted)).toBeTruthy();
  // The op-gate alone is not admission: an allowed op is still refused when nothing bound this tool.
  expect(executionBlockReason("aft_safety", { op: "list" })).toBeTruthy();
});

test("ast_grep_replace admits only dryRun:true, never a real rewrite, independent of binding", () => {
  const trusted = trustedWith([aftTool("ast_grep_replace", AFT_ENTRY, ["observation", "mutation"])]);
  expect(
    executionBlockReason("ast_grep_replace", { pattern: "$A", rewrite: "$A", lang: "typescript", dryRun: true }, trusted),
  ).toBeUndefined();
  expect(executionBlockReason("ast_grep_replace", { pattern: "$A", rewrite: "$A", lang: "typescript" }, trusted)).toBeTruthy();
  expect(
    executionBlockReason("ast_grep_replace", { pattern: "$A", rewrite: "$A", lang: "typescript", dryRun: false }, trusted),
  ).toBeTruthy();
  expect(executionBlockReason("ast_grep_replace", { pattern: "$A", rewrite: "$A", lang: "typescript", dryRun: true })).toBeTruthy();
});

test("a bound AFT tool without the observation capability stays refused even though it is named", () => {
  const trusted = trustedWith([aftTool("aft_outline", AFT_ENTRY, ["execution"])]);
  expect(executionBlockReason("aft_outline", {}, trusted)).toBeTruthy();
});

test("nested xd:// dispatch admits a bound AFT observation tool without allowing writes", () => {
  const trusted = trustedWith([
    aftTool("aft_search", AFT_ENTRY, ["observation"]),
    aftTool("aft_safety", AFT_ENTRY, ["observation", "mutation"]),
  ]);
  const device = (tool: string, args: object) => ({ path: `xd://${tool}`, content: JSON.stringify(args) });
  expect(executionBlockReason("write", device("aft_search", { query: "handler" }), trusted)).toBeUndefined();
  expect(executionBlockReason("write", device("aft_search", { query: "handler" }))).toBeTruthy();
  // Never a nested device at all: not in the enumerated set regardless of binding content.
  expect(executionBlockReason("write", device("aft_import", { op: "add" }), trusted)).toBeTruthy();
  // Enumerated and bound, but op-gated: list is admitted, restore is refused by its own prefilter.
  expect(executionBlockReason("write", device("aft_safety", { op: "list" }), trusted)).toBeUndefined();
  expect(executionBlockReason("write", device("aft_safety", { op: "restore" }), trusted)).toBeTruthy();
});

test("live provenance must match the bound AFT source path exactly; a same-name shadow from elsewhere is refused", () => {
  const trusted = trustedWith([aftTool("aft_outline", AFT_ENTRY, ["observation"])]);
  expect(executionToolSourceBlockReason("aft_outline", "extension", false, trusted, AFT_ENTRY)).toBeUndefined();
  expect(executionToolSourceBlockReason("aft_outline", "extension", false, trusted, OTHER_PATH)).toBeTruthy();
  expect(executionToolSourceBlockReason("aft_outline", "mcp", false, trusted, AFT_ENTRY)).toBeTruthy();
  expect(executionToolSourceBlockReason("aft_outline", "builtin", false, trusted)).toBeTruthy();
});

test("read and grep keep their native builtin path untouched and gain only the verified AFT extension instance", () => {
  const trusted = trustedWith([aftTool("read", AFT_ENTRY, ["observation", "mutation"]), aftTool("grep", AFT_ENTRY, ["observation"])]);
  // Native builtin: unaffected by AFT binding, with or without one.
  expect(executionToolSourceBlockReason("read", "builtin")).toBeUndefined();
  expect(executionToolSourceBlockReason("read", "builtin", false, trusted)).toBeUndefined();
  expect(executionToolSourceBlockReason("grep", "builtin", false, trusted)).toBeUndefined();
  // Extension source: only the exact bound AFT instance is admitted.
  expect(executionToolSourceBlockReason("read", "extension", false, trusted, AFT_ENTRY)).toBeUndefined();
  expect(executionToolSourceBlockReason("grep", "extension", false, trusted, AFT_ENTRY)).toBeUndefined();
  expect(executionToolSourceBlockReason("read", "extension", false, trusted, OTHER_PATH)).toBeTruthy();
  expect(executionToolSourceBlockReason("read", "extension")).toBeTruthy();
  // No binding at all: unchanged pre-existing refusal of an unverified extension shadow.
  expect(executionToolSourceBlockReason("read", "extension", false, {}, AFT_ENTRY)).toBeTruthy();
});

test("write's extension source is admitted at the sync layer only under the native-url capability, exact-matched; native builtin write is unaffected", () => {
  const trusted = trustedWith([aftTool("write", AFT_ENTRY, ["native-url"])]);
  // Native builtin: unaffected by AFT binding, with or without one.
  expect(executionToolSourceBlockReason("write", "builtin")).toBeUndefined();
  expect(executionToolSourceBlockReason("write", "builtin", false, trusted)).toBeUndefined();
  // Exact-matched extension source under the right capability.
  expect(executionToolSourceBlockReason("write", "extension", false, trusted, AFT_ENTRY)).toBeUndefined();
  // Wrong source path, no binding at all, or wrong capability: all refused.
  expect(executionToolSourceBlockReason("write", "extension", false, trusted, OTHER_PATH)).toBeTruthy();
  expect(executionToolSourceBlockReason("write", "extension")).toBeTruthy();
  const observationOnly = trustedWith([aftTool("write", AFT_ENTRY, ["observation"])]);
  expect(executionToolSourceBlockReason("write", "extension", false, observationOnly, AFT_ENTRY)).toBeTruthy();
});

test("aftProjectionBlockReason requires AFT's own live classification to agree with the admitted kind, even once source and capability already passed", async () => {
  const projectingTo = (kind: "observation" | "mutation" | "execution" | "native" | "unknown") =>
    trustedWith([aftTool("write", AFT_ENTRY, ["native-url"])], async () => ({ kind, paths: [], broad: false }));

  // write genuinely delegating an internal URL: admitted.
  await expect(
    aftProjectionBlockReason(projectingTo("native"), "write", { path: "agent://0-Child", content: "status?" }, "/repo"),
  ).resolves.toBeUndefined();
  // Same static capability, same exact source, but this exact call projects as a real mutation: refused.
  await expect(
    aftProjectionBlockReason(projectingTo("mutation"), "write", { path: "src/index.ts", content: "x" }, "/repo"),
  ).resolves.toBeTruthy();
  await expect(
    aftProjectionBlockReason(projectingTo("unknown"), "write", { path: "xd://aft_safety", content: "?" }, "/repo"),
  ).resolves.toBeTruthy();

  // No binding at all: refused, not silently admitted.
  await expect(aftProjectionBlockReason({}, "write", { path: "agent://0-Child" }, "/repo")).resolves.toBeTruthy();

  // A throwing projector refuses rather than defaulting to admission.
  const throwing = trustedWith([aftTool("write", AFT_ENTRY, ["native-url"])], async () => {
    throw new Error("boom");
  });
  await expect(aftProjectionBlockReason(throwing, "write", { path: "agent://0-Child" }, "/repo")).resolves.toContain("boom");

  // Tools with no entry in the projected-kind table are not gated here at all.
  await expect(aftProjectionBlockReason(projectingTo("native"), "aft_outline", {}, "/repo")).resolves.toBeUndefined();
});

test("aftProjectionBlockReason refuses an operation-gated call whose live projection disagrees with its own op prefilter", async () => {
  const trusted = trustedWith([aftTool("aft_safety", AFT_ENTRY, ["observation", "mutation"])], async () => ({
    kind: "mutation" as const,
    paths: ["/repo/.aft/checkpoints/latest"],
    broad: false,
  }));
  // The op said "list" (passes the synchronous prefilter), but AFT itself projects this exact call as a mutation.
  await expect(aftProjectionBlockReason(trusted, "aft_safety", { op: "list" }, "/repo")).resolves.toBeTruthy();
});

test("malformed live projections refuse instead of throwing or granting transport access", async () => {
  for (const malformed of [null, { kind: "native", paths: [1], broad: false }, { kind: "native", paths: [] }]) {
    const trusted = trustedWith([aftTool("write", AFT_ENTRY, ["native-url"])], async () => malformed as unknown as AftProjection);
    await expect(aftProjectionBlockReason(trusted, "write", { path: "agent://peer" }, "/repo")).resolves.toContain("malformed projection");
  }
});
