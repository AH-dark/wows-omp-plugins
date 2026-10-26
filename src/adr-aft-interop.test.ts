import { afterEach, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { AftContract, isExtensionSourced, normalizeProjection, type ToolProvenance } from "../plugins/adr/src/aft-contract.ts";
import { type AftIntegration, interceptionReason } from "../plugins/adr/src/interception.ts";
import { initialize } from "../plugins/adr/src/operations.ts";
import { cleanupFixtures, repoFixture } from "./adr-fixtures.ts";
import { contractEvents } from "./roadmap-fixtures.ts";

afterEach(cleanupFixtures);

async function managedRepo(): Promise<string> {
  const root = await repoFixture();
  await initialize(root, "main");
  return root;
}

/** A fake bound-tool integration: `project` answers whatever this call programs it to, `isExtensionSourced` is fixed. */
function fakeAft(project: AftIntegration["project"], extensionSourced = true): AftIntegration {
  return { project, isExtensionSourced: () => extensionSourced };
}

test("with no AFT integration, native mutation protection is unchanged", async () => {
  const root = await managedRepo();
  await expect(interceptionReason("write", { path: "docs/adr/x.md", content: "x" }, root)).resolves.toMatch(/adr_manage/);
  await expect(interceptionReason("write", { path: "notes.md", content: "x" }, root)).resolves.toBeUndefined();
});

test("a bound AFT mutation projection blocks managed targets and allows ordinary ones, by its own paths, not toolName", async () => {
  const root = await managedRepo();
  const into = (paths: string[]) => fakeAft(async () => ({ kind: "mutation", paths, broad: false }));
  // "aft_rewrite" is not a recognized native tool name at all; only the projection decides.
  await expect(interceptionReason("aft_rewrite", {}, root, into([join(root, "docs/adr/injected.md")]))).resolves.toMatch(/adr_manage/);
  await expect(interceptionReason("aft_rewrite", {}, root, into([join(root, "notes.md")]))).resolves.toBeUndefined();
});

test("move/rename destinations are protected even when the source is an ordinary file", async () => {
  const root = await managedRepo();
  const aft = fakeAft(async () => ({
    kind: "mutation",
    paths: [join(root, "sample.ts"), join(root, "docs/adr/injected.md")],
    broad: false,
  }));
  await expect(interceptionReason("aft_move", { path: "sample.ts", destination: "docs/adr/injected.md" }, root, aft)).resolves.toMatch(
    /adr_manage/,
  );
});

test("observation kind is always allowed, even when its paths point inside the managed directory", async () => {
  const root = await managedRepo();
  const aft = fakeAft(async () => ({ kind: "observation", paths: [join(root, "docs/adr/README.md")], broad: true }));
  await expect(interceptionReason("aft_outline", {}, root, aft)).resolves.toBeUndefined();
});

test("unknown kind fails closed only while the repository is managed", async () => {
  const unknown = fakeAft(async () => ({ kind: "unknown", paths: [], broad: true }));
  const managed = await managedRepo();
  await expect(interceptionReason("aft_safety", { op: "restore", name: "x" }, managed, unknown)).resolves.toMatch(
    /could not be determined/,
  );
  const bare = await repoFixture();
  await expect(interceptionReason("aft_safety", { op: "restore", name: "x" }, bare, unknown)).resolves.toBeUndefined();
});

test("a malformed projection throws instead of silently allowing the call", async () => {
  expect(() => normalizeProjection({ kind: "bogus", paths: [], broad: false })).toThrow();
  expect(() => normalizeProjection({ kind: "mutation", paths: [1], broad: false })).toThrow();
  expect(() => normalizeProjection({ kind: "mutation", paths: [], broad: "yes" })).toThrow();
  const root = await managedRepo();
  const broken = fakeAft(async () => normalizeProjection({ kind: "mutation", paths: "not-an-array" as unknown as string[], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, root, broken)).rejects.toThrow();
});

test("an unverified AFT-only mutation name refuses when extension-sourced and the repository is managed", async () => {
  const unbound = fakeAft(async () => undefined, true);
  const managed = await managedRepo();
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, managed, unbound)).resolves.toMatch(
    /binding to this session is missing or does not match/,
  );
  // Not extension-sourced: nothing registered under that name, so there is nothing to refuse.
  const notExtension = fakeAft(async () => undefined, false);
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, managed, notExtension)).resolves.toBeUndefined();
  // Extension-sourced but the repository is not managed: nothing to protect yet.
  const bare = await repoFixture();
  await expect(interceptionReason("aft_move", { path: "x", destination: "y" }, bare, unbound)).resolves.toBeUndefined();
  // An arbitrary unbound extension tool name outside the known AFT mutation set is unaffected.
  const other = fakeAft(async () => undefined, true);
  await expect(interceptionReason("some_other_extension_tool", {}, managed, other)).resolves.toBeUndefined();
});

test("execution kind never trusts empty projected paths as safe: bash still gets native command parsing", async () => {
  const root = await managedRepo();
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  await expect(interceptionReason("bash", { command: "rm -rf docs/adr" }, root, execution)).resolves.toMatch(/adr_manage/);
  // A benign command AFT cannot flag and native parsing also finds nothing destructive in stays allowed.
  await expect(interceptionReason("bash", { command: "ls docs/adr" }, root, execution)).resolves.toBeUndefined();
});

test("execution kind fails closed for a tool with no native parser when it reports no paths and the repo is managed", async () => {
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  const managed = await managedRepo();
  await expect(interceptionReason("powershell", { command: "Remove-Item docs/adr -Recurse" }, managed, execution)).resolves.toMatch(
    /execution scope could not be determined/,
  );
  const bare = await repoFixture();
  await expect(interceptionReason("powershell", { command: "Remove-Item docs/adr -Recurse" }, bare, execution)).resolves.toBeUndefined();
});

test("execution kind with explicit projected paths still protects managed targets", async () => {
  const root = await managedRepo();
  const execution = fakeAft(async () => ({ kind: "execution", paths: [join(root, "docs/adr/README.md")], broad: false }));
  await expect(interceptionReason("powershell", {}, root, execution)).resolves.toMatch(/adr_manage/);
});

test("AFT-projected relative paths resolve against the call's cwd, not process cwd", async () => {
  const root = await managedRepo();
  const aft = fakeAft(async () => ({ kind: "mutation", paths: ["docs/adr/x.md"], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, root, aft)).resolves.toMatch(/adr_manage/);
});

test("symlink/hardlink safeguards also apply to AFT-projected candidates", async () => {
  const root = await managedRepo();
  await symlink(join(root, "docs/adr"), join(root, "adr-alias"));
  const aft = fakeAft(async () => ({ kind: "mutation", paths: [join(root, "adr-alias/injected.md")], broad: false }));
  await expect(interceptionReason("aft_rewrite", {}, root, aft)).resolves.toMatch(/adr_manage/);
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
    { name: "aft_delete", sourceInfo: { source: "extension", path: spoofedPath } }, // claims realPath but registered elsewhere
    { name: "aft_import", sourceInfo: { source: "builtin", path: realPath } }, // not an extension at all
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
    if (requests === 1) return; // simulate AFT not loaded yet: no reply at all
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
  // A confirmed binding is cached; a further call does not re-request.
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
  const root = await managedRepo();
  const execution = fakeAft(async () => ({ kind: "execution", paths: [], broad: true }));
  await expect(interceptionReason("bash", { command: "rm README.md", workdir: "docs/adr" }, root, execution)).resolves.toMatch(
    /adr_manage/,
  );
});
