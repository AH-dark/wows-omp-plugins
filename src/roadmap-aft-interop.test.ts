import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AftContract, isExtensionSourced, normalizeProjection, type ToolProvenance } from "../plugins/roadmap/src/aft-contract.ts";
import { type AftIntegration, interceptionReason } from "../plugins/roadmap/src/interception.ts";
import { git } from "./adr-fixtures.ts";
import { cleanupFixtures, contractEvents, diskFixture } from "./roadmap-fixtures.ts";

const bareRoots: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const root of bareRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function bareRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-bare-"));
  bareRoots.push(root);
  await git(root, ["init", "-q"]);
  return root;
}

/** A fake bound-tool integration: `project` answers whatever this call programs it to, `isExtensionSourced` is fixed. */
function fakeAft(project: AftIntegration["project"], extensionSourced = true): AftIntegration {
  return { project, isExtensionSourced: () => extensionSourced };
}

test("with no AFT integration, native mutation protection is unchanged", async () => {
  const { repo } = await diskFixture();
  await expect(interceptionReason("write", { path: "docs/roadmap/x.md", content: "x" }, repo.repoRoot)).resolves.toMatch(
    /roadmap_stage|roadmap_todo/,
  );
  await expect(interceptionReason("write", { path: "notes.md", content: "x" }, repo.repoRoot)).resolves.toBeUndefined();
});

test("a bound AFT mutation projection blocks managed targets and allows ordinary ones, by its own paths, not toolName", async () => {
  const { repo } = await diskFixture();
  const into = (paths: string[]) => fakeAft(async () => ({ kind: "mutation", paths, broad: false }));
  await expect(
    interceptionReason("aft_rewrite", {}, repo.repoRoot, into([join(repo.repoRoot, "docs/roadmap/injected.md")])),
  ).resolves.toMatch(/roadmap_stage|roadmap_todo/);
  await expect(interceptionReason("aft_rewrite", {}, repo.repoRoot, into([join(repo.repoRoot, "notes.md")]))).resolves.toBeUndefined();
});

test("move/rename destinations are protected even when the source is an ordinary file", async () => {
  const { repo } = await diskFixture();
  const aft = fakeAft(async () => ({
    kind: "mutation",
    paths: [join(repo.repoRoot, "sample.ts"), join(repo.repoRoot, "docs/roadmap/injected.md")],
    broad: false,
  }));
  await expect(
    interceptionReason("aft_move", { path: "sample.ts", destination: "docs/roadmap/injected.md" }, repo.repoRoot, aft),
  ).resolves.toMatch(/roadmap_stage|roadmap_todo/);
});

test("observation kind is always allowed, even when its paths point inside the managed directory", async () => {
  const { repo } = await diskFixture();
  const aft = fakeAft(async () => ({ kind: "observation", paths: [join(repo.repoRoot, "docs/roadmap/README.md")], broad: true }));
  await expect(interceptionReason("aft_outline", {}, repo.repoRoot, aft)).resolves.toBeUndefined();
});

test("unknown kind fails closed only while a roadmap is initialized", async () => {
  const unknown = fakeAft(async () => ({ kind: "unknown", paths: [], broad: true }));
  const { repo } = await diskFixture();
  await expect(interceptionReason("aft_safety", { op: "restore", name: "x" }, repo.repoRoot, unknown)).resolves.toMatch(
    /could not be determined/,
  );
  const bare = await bareRepo();
  await expect(interceptionReason("aft_safety", { op: "restore", name: "x" }, bare, unknown)).resolves.toBeUndefined();
});

test("a malformed projection throws instead of silently allowing the call", async () => {
  expect(() => normalizeProjection({ kind: "bogus", paths: [], broad: false })).toThrow();
  expect(() => normalizeProjection({ kind: "mutation", paths: [1], broad: false })).toThrow();
  expect(() => normalizeProjection({ kind: "mutation", paths: [], broad: "yes" })).toThrow();
  const { repo } = await diskFixture();
  const broken = fakeAft(async () => normalizeProjection({ kind: "mutation", paths: "not-an-array" as unknown as string[], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, repo.repoRoot, broken)).rejects.toThrow();
});

test("an unverified AFT-only mutation name refuses when extension-sourced and a roadmap is initialized", async () => {
  const unbound = fakeAft(async () => undefined, true);
  const { repo } = await diskFixture();
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, repo.repoRoot, unbound)).resolves.toMatch(
    /binding to this session is missing or does not match/,
  );
  const notExtension = fakeAft(async () => undefined, false);
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, repo.repoRoot, notExtension)).resolves.toBeUndefined();
  const bare = await bareRepo();
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, bare, unbound)).resolves.toBeUndefined();
  const other = fakeAft(async () => undefined, true);
  await expect(interceptionReason("some_other_extension_tool", {}, repo.repoRoot, other)).resolves.toBeUndefined();
});

test("execution kind never trusts empty projected paths as safe: bash still gets native command parsing", async () => {
  const { repo } = await diskFixture();
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  await expect(interceptionReason("bash", { command: "rm -rf docs/roadmap" }, repo.repoRoot, execution)).resolves.toMatch(
    /roadmap_stage|roadmap_todo/,
  );
  await expect(interceptionReason("bash", { command: "ls docs/roadmap" }, repo.repoRoot, execution)).resolves.toBeUndefined();
});

test("execution kind fails closed for a tool with no native parser when it reports no paths and a roadmap is initialized", async () => {
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  const { repo } = await diskFixture();
  await expect(
    interceptionReason("powershell", { command: "Remove-Item docs/roadmap -Recurse" }, repo.repoRoot, execution),
  ).resolves.toMatch(/execution scope could not be determined/);
  const bare = await bareRepo();
  await expect(
    interceptionReason("powershell", { command: "Remove-Item docs/roadmap -Recurse" }, bare, execution),
  ).resolves.toBeUndefined();
});

test("execution kind with explicit projected paths still protects managed targets", async () => {
  const { repo } = await diskFixture();
  const execution = fakeAft(async () => ({ kind: "execution", paths: [join(repo.repoRoot, "docs/roadmap/README.md")], broad: false }));
  await expect(interceptionReason("powershell", {}, repo.repoRoot, execution)).resolves.toMatch(/roadmap_stage|roadmap_todo/);
});

test("AFT-projected relative paths resolve against the call's cwd, not process cwd", async () => {
  const { repo } = await diskFixture();
  const aft = fakeAft(async () => ({ kind: "mutation", paths: ["docs/roadmap/x.md"], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, repo.repoRoot, aft)).resolves.toMatch(/roadmap_stage|roadmap_todo/);
});

test("symlink/hardlink safeguards also apply to AFT-projected candidates", async () => {
  const { repo } = await diskFixture();
  await symlink(join(repo.repoRoot, "docs/roadmap"), join(repo.repoRoot, "roadmap-alias"));
  const aft = fakeAft(async () => ({ kind: "mutation", paths: [join(repo.repoRoot, "roadmap-alias/injected.md")], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, repo.repoRoot, aft)).resolves.toMatch(/roadmap_stage|roadmap_todo/);
});

function toolsReply(tools: Array<{ name: string; sourcePath: string; capabilities?: unknown }>): unknown {
  return tools.map(({ name, sourcePath, capabilities }) => ({ name, sourcePath, capabilities: capabilities ?? ["mutation"] }));
}

test("AftContract admits only tools whose live sourceInfo matches the advertised sourcePath exactly", async () => {
  const bus = contractEvents();
  const realPath = "/plugins/real-aft/index.ts";
  const spoofedPath = "/plugins/spoofed/index.ts";
  const live: ToolProvenance[] = [
    { name: "aft_move", sourceInfo: { source: "extension", path: realPath } },
    { name: "aft_delete", sourceInfo: { source: "extension", path: spoofedPath } },
    { name: "aft_import", sourceInfo: { source: "builtin", path: realPath } },
  ];
  bus.on("aft:binding-request", (payload) => {
    const { sessionId, requestId } = payload as { sessionId: string; requestId: string };
    bus.emit("aft:binding", {
      v: 1,
      sessionId,
      requestId,
      tools: toolsReply([
        { name: "aft_move", sourcePath: realPath },
        { name: "aft_delete", sourcePath: realPath },
        { name: "aft_import", sourcePath: realPath },
      ]),
      project: async () => ({ kind: "mutation", paths: [], broad: false }),
    });
  });
  const contract = new AftContract(bus, () => live);
  expect(await contract.project("s1", "aft_move", {}, "/repo")).toEqual({ kind: "mutation", paths: [], broad: false });
  expect(await contract.project("s1", "aft_delete", {}, "/repo")).toBeUndefined();
  expect(await contract.project("s1", "aft_import", {}, "/repo")).toBeUndefined();
  expect(isExtensionSourced(() => live, "aft_delete")).toBe(true);
  expect(isExtensionSourced(() => live, "aft_import")).toBe(false);
});

test("AftContract rejects a binding whose tools list has a duplicate name or an invalid capability", async () => {
  const bus = contractEvents();
  const live: ToolProvenance[] = [{ name: "aft_move", sourceInfo: { source: "extension", path: "/p/index.ts" } }];
  bus.on("aft:binding-request", (payload) => {
    const { sessionId, requestId } = payload as { sessionId: string; requestId: string };
    bus.emit("aft:binding", {
      v: 1,
      sessionId,
      requestId,
      tools: [
        { name: "aft_move", sourcePath: "/p/index.ts", capabilities: ["mutation"] },
        { name: "aft_move", sourcePath: "/p/index.ts", capabilities: ["mutation"] },
      ],
      project: async () => ({ kind: "mutation", paths: [], broad: false }),
    });
  });
  const contract = new AftContract(bus, () => live);
  expect(await contract.project("dup", "aft_move", {}, "/repo")).toBeUndefined();

  const bus2 = contractEvents();
  bus2.on("aft:binding-request", (payload) => {
    const { sessionId, requestId } = payload as { sessionId: string; requestId: string };
    bus2.emit("aft:binding", {
      v: 1,
      sessionId,
      requestId,
      tools: [{ name: "aft_move", sourcePath: "/p/index.ts", capabilities: ["teleportation"] }],
      project: async () => ({ kind: "mutation", paths: [], broad: false }),
    });
  });
  const contract2 = new AftContract(bus2, () => live);
  expect(await contract2.project("bad-cap", "aft_move", {}, "/repo")).toBeUndefined();
});

test("AftContract caches a successful binding for the session and retries after a miss", async () => {
  const bus = contractEvents();
  const live: ToolProvenance[] = [{ name: "aft_move", sourceInfo: { source: "extension", path: "/p/index.ts" } }];
  let requests = 0;
  bus.on("aft:binding-request", (payload) => {
    requests++;
    const { sessionId, requestId } = payload as { sessionId: string; requestId: string };
    if (requests === 1) return;
    bus.emit("aft:binding", {
      v: 1,
      sessionId,
      requestId,
      tools: [{ name: "aft_move", sourcePath: "/p/index.ts", capabilities: ["mutation"] }],
      project: async () => ({ kind: "mutation", paths: [], broad: false }),
    });
  });
  const contract = new AftContract(bus, () => live);
  expect(await contract.project("s2", "aft_move", {}, "/repo")).toBeUndefined();
  expect(requests).toBe(1);
  expect(await contract.project("s2", "aft_move", {}, "/repo")).toEqual({ kind: "mutation", paths: [], broad: false });
  expect(requests).toBe(2);
  expect(await contract.project("s2", "aft_move", {}, "/repo")).toEqual({ kind: "mutation", paths: [], broad: false });
  expect(requests).toBe(2);
  contract.forget("s2");
  expect(await contract.project("s2", "aft_move", {}, "/repo")).toEqual({ kind: "mutation", paths: [], broad: false });
  expect(requests).toBe(3);
});

test("a cached binding does not trust a replacement from another source", async () => {
  const bus = contractEvents();
  const live: ToolProvenance[] = [{ name: "aft_move", sourceInfo: { source: "extension", path: "/aft/index.ts" } }];
  bus.on("aft:binding-request", (payload) => {
    const { sessionId, requestId } = payload as { sessionId: string; requestId: string };
    bus.emit("aft:binding", {
      v: 1,
      sessionId,
      requestId,
      tools: [{ name: "aft_move", sourcePath: "/aft/index.ts", capabilities: ["mutation"] }],
      project: async () => ({ kind: "mutation", paths: ["/repo/plain.ts"], broad: false }),
    });
  });
  const contract = new AftContract(bus, () => live);
  expect(await contract.project("s1", "aft_move", {}, "/repo")).toEqual({ kind: "mutation", paths: ["/repo/plain.ts"], broad: false });
  live[0] = { name: "aft_move", sourceInfo: { source: "extension", path: "/other/index.ts" } };
  expect(await contract.project("s1", "aft_move", {}, "/repo")).toBeUndefined();
});

test("bound AFT shell targets follow workdir rather than the session directory", async () => {
  const { repo } = await diskFixture();
  const root = repo.repoRoot;
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  await expect(interceptionReason("bash", { command: "rm README.md", workdir: "docs/roadmap" }, root, execution)).resolves.toMatch(
    /roadmap_stage/,
  );
});
