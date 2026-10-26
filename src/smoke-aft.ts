import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AtlasStore } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { initProject } from "../plugins/roadmap/src/operations.ts";
import { adrApi } from "./roadmap-fixtures.ts";

const CHILD = "AFT_INTEROP_SMOKE_CHILD";
const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN = `# AFT interoperability

## Tasks
- [ ] T1. Exercise the registered tools
  - Agent: task
  - Depends on: none
  - Acceptance: Native delegation and document protection preserve their boundaries

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

async function sdk(root: string, aftEntry: string, reverse: boolean): Promise<void> {
  // Host modules must initialize after the child receives its isolated HOME and session directories.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  const { MAIN_AGENT_ID } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  await initTheme();
  const hashline = process.env.AFT_INTEROP_EDIT_MODE === "hashline";
  const configDir = join(process.env.XDG_CONFIG_HOME ?? join(root, "config"), "cortexkit");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "aft.jsonc"),
    JSON.stringify({ disabled_tools: [], edit_mode: hashline ? "hashline" : undefined, indexes: { semantic: false } }),
  );
  const git = discoverRepo(root);
  assert(git);
  const initialized = await initProject(
    { ...git, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr"), adr: adrApi() },
    { sessionId: "interop-fixture", kind: "main" },
    {
      project: { name: "AFT interoperability", description: "Real extension SDK smoke" },
      round: { title: "Integration", goal: "Preserve tool boundaries", constraints: [], non_goals: [], principles: [] },
      stages: [
        {
          title: "Integration",
          objective: "Verify tools",
          scope_in: [],
          scope_out: [],
          done_criteria: [{ id: "DC1", statement: "Tool boundaries hold", verify: "Run the real extension smoke" }],
        },
      ],
      adrs: [],
    },
  );
  assert(initialized.ok, JSON.stringify(initialized));
  await mkdir(join(root, ".omp"), { recursive: true });
  await writeFile(
    join(root, ".omp/plugin-overrides.json"),
    JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { herdrDag: false, atlasWidget: false } } }),
  );
  await writeFile(join(root, "sample.ts"), 'export const message = "before";\n');
  const pluginEntries = ["adr", "roadmap", "omo-prometheus"].map((name) => join(HERE, "../plugins", name, "src/index.ts"));
  const common = {
    cwd: root,
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: true,
    skipPythonPreflight: true,
    cacheWarming: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  };
  const { session, extensionsResult } = await createAgentSession({
    ...common,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    toolNames: ["read", "write", "edit", "grep", "task", "todo", "bash"],
    additionalExtensionPaths: reverse ? [...pluginEntries, aftEntry] : [aftEntry, ...pluginEntries],
  });
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw new Error(error.error);
      },
    });
    assert.deepEqual(extensionsResult.errors, []);
    const runner = session.extensionRunner;
    assert(runner);
    extensionsResult.runtime.sendMessage = () => {};
    await runner.emit({ type: "session_start" });
    const provenance = extensionsResult.runtime.getAllTools().find((tool) => tool.name === "write")?.sourceInfo;
    assert.equal(provenance?.source, "extension", "The smoke must exercise the AFT replacement, not native write");
    let sequence = 0;
    const invoke = async (name: string, input: Record<string, unknown>) => {
      const tool = session.getToolByName(name);
      assert(tool, `Missing registered tool: ${name}`);
      const result = await tool.execute(`interop-${sequence++}`, input);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result;
    };
    const blocked = async (name: string, input: Record<string, unknown>, reason: RegExp) => {
      const result = await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: `denied-${sequence++}`, input });
      assert.equal(result?.block, true, `${name} should be blocked: ${JSON.stringify(input)}`);
      assert.match(result.reason ?? "", reason);
    };
    const allowed = async (name: string, input: Record<string, unknown>) => {
      const result = await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: `admitted-${sequence++}`, input });
      assert.notEqual(result?.block, true, `${JSON.stringify(input)}: ${JSON.stringify(result)}`);
    };

    session.setPlanModeState({ enabled: true, planFilePath: "local://interop-plan.md" });
    session.setPlanProposalHandler((title) => session.preparePlanForReview(title));
    await invoke("write", { path: "local://interop-plan.md", content: PLAN });
    const proposal = await invoke("write", { path: "xd://propose", content: "interop" });
    assert.match(JSON.stringify(proposal.details), /interop-plan\.md/);
    console.log("PASS native local plan write and proposal dispatch");
    session.setPlanProposalHandler(null);
    session.setPlanModeState(undefined);

    const protectedBefore = await readFile(join(root, "docs/roadmap/README.md"), "utf8");
    for (const directory of ["docs/adr", "docs/roadmap"]) {
      await blocked("write", { path: `${directory}/README.md`, content: "corrupted" }, /[Mm]anaged|mutation/);
      if (hashline) {
        await blocked("edit", { patch: `[${directory}/README.md#AAAA]\nREM` }, /^Managed .*must change through/);
        await blocked("edit", { patch: `[sample.ts#AAAA]\nMV ${directory}/injected.ts` }, /^Managed .*must change through/);
        await blocked(
          "edit",
          { patch: `[sample.ts#AAAA]\nPUT 1:\n+changed\n[${directory}/README.md#BBBB]\nREM` },
          /^Managed .*must change through/,
        );
      } else {
        await blocked("edit", { path: `${directory}/README.md`, edits: [{ oldString: "#", newString: "changed" }] }, /[Mm]anaged|mutation/);
      }
      await blocked("aft_move", { path: "sample.ts", destination: `${directory}/injected.ts` }, /[Mm]anaged|mutation/);
      await blocked("aft_import", { op: "organize", path: `${directory}/README.md` }, /[Mm]anaged|mutation/);
      await blocked("ast_grep_replace", { paths: [directory], lang: "typescript", pattern: "$A", rewrite: "$A" }, /[Mm]anaged|mutation/);
    }
    let sampleEdit: Record<string, unknown> = { path: "sample.ts", edits: [{ oldString: "before", newString: "after" }] };
    if (hashline) {
      const before = await invoke("read", { path: "sample.ts" });
      const tag = JSON.stringify(before.content).match(/#([0-9a-f]{4})\]/i)?.[1];
      assert(tag, JSON.stringify(before));
      sampleEdit = { patch: `[sample.ts#${tag}]\nPUT 1:\n+export const message = "after";` };
    }
    await allowed("edit", sampleEdit);
    await invoke("edit", sampleEdit);
    assert.match(await readFile(join(root, "sample.ts"), "utf8"), /after/);
    assert.equal(await readFile(join(root, "docs/roadmap/README.md"), "utf8"), protectedBefore);
    console.log("PASS managed mutation rejection and ordinary AFT edit");

    const store = new AtlasStore(session.sessionManager.getSessionDir());
    const plan = await store.create({
      name: "AFT interoperability",
      content: PLAN,
      cwd: root,
      sourcePlanPath: "local://interop-plan.md",
      sourceSessionId: session.sessionManager.getSessionId(),
      proposedByToolCallId: "interop-proposal",
    });
    const atlas = runner.getCommand("atlas");
    assert(atlas);
    await atlas.handler(plan.id, runner.createCommandContext());
    const read = await invoke("read", { path: "sample.ts" });
    assert.match(JSON.stringify(read.content), /after/);
    await invoke("grep", { path: root, pattern: "after", include: "*.ts" });
    await invoke("aft_outline", { target: join(root, "sample.ts") });
    await allowed("aft_search", { query: "message", pattern: "message" });
    await invoke("write", { path: "xd://roadmap_status", content: "{}" });
    await invoke("write", { path: "xd://adr_status", content: "{}" });
    console.log("PASS bound AFT observation and nested managed devices");

    const peer = await createAgentSession({
      ...common,
      agentId: "interop-peer",
      agentDir: join(root, "peer-agent"),
      sessionManager: SessionManager.create(root, join(root, "peer-sessions")),
      toolNames: ["read", "write"],
      additionalExtensionPaths: [],
    });
    try {
      // A planning recipient folds IRC into its context without starting a provider turn.
      peer.session.setPlanModeState({ enabled: true, planFilePath: "local://peer-plan.md" });
      await invoke("write", { path: "agent://interop-peer", content: "interop coordination delivered" });
      assert.match(JSON.stringify(peer.session.agent.state.messages), /interop coordination delivered/);
    } finally {
      await peer.session.dispose();
    }
    const manager = session.asyncJobManager;
    assert(manager);
    let cancelled = false;
    const running = Promise.withResolvers<void>();
    const jobId = manager.register(
      "eval",
      "Interop cancellation",
      async ({ signal }) => {
        const stopped = Promise.withResolvers<void>();
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            stopped.resolve();
          },
          { once: true },
        );
        running.resolve();
        await stopped.promise;
        return "cancelled";
      },
      { id: "interop-job", ownerId: MAIN_AGENT_ID },
    );
    await running.promise;
    await invoke("write", { path: `proc://${jobId}/kill` });
    await manager.getJob(jobId)?.promise;
    assert.equal(cancelled, true);
    console.log("PASS peer delivery and cancellation without content");

    await blocked("write", { path: "sample.ts", content: "corrupted" }, /Atlas execution guard/);
    await blocked("write", { path: "proc://interop-job", content: "stdin" }, /Atlas execution guard/);
    await blocked("write", { path: "xd://bash", content: JSON.stringify({ command: "echo bypass" }) }, /Atlas execution guard/);
    await blocked("bash", { command: "echo bypass" }, /Atlas execution guard/);
    await blocked("aft_import", { op: "organize", path: "sample.ts" }, /Atlas execution guard/);
    await blocked("aft_safety", { op: "restore", name: "missing" }, /Atlas execution guard|mutation/);
    assert.match(await readFile(join(root, "sample.ts"), "utf8"), /after/);
    console.log("PASS Atlas mutation and execution boundaries");
    await atlas.handler("exit", runner.createCommandContext());
  } finally {
    await session.dispose();
    console.log("PASS extension shutdown");
  }
}

if (process.env[CHILD]) {
  await sdk(process.env.AFT_INTEROP_ROOT as string, process.env.AFT_INTEROP_ENTRY as string, process.env[CHILD] === "reverse");
  // This isolated CLI ends after session shutdown; SDK process-scoped services are not another test session.
  process.exit(0);
} else {
  const entry = process.argv[2];
  if (!entry) throw new Error("Usage: bun run src/smoke-aft.ts <built-aft-extension-entry>");
  const aftEntry = await realpath(resolve(entry));
  const scenarios = ["forward:fuzzy", "reverse:fuzzy", "forward:hashline", "reverse:hashline"];
  const selected = process.argv[3];
  if (selected && !scenarios.includes(selected)) throw new Error(`Unknown smoke scenario: ${selected}`);
  for (const scenario of selected ? [selected] : scenarios) {
    const [order, editMode] = scenario.split(":");
    const home = await realpath(await mkdtemp(join(tmpdir(), "aft-interop-")));
    try {
      const root = join(home, "repo");
      await mkdir(root);
      const git = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
      assert.equal(git.exitCode, 0, git.stderr.toString());
      const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, "agent"),
          XDG_CONFIG_HOME: join(home, "config"),
          MAGIC_CONTEXT_PI_SUBAGENT: "1",
          [CHILD]: order,
          AFT_INTEROP_EDIT_MODE: editMode,
          AFT_INTEROP_ROOT: root,
          AFT_INTEROP_ENTRY: aftEntry,
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      assert.equal(exitCode, 0, `${scenario}:\n${stderr}`);
      console.log(`PASS ${scenario} extension load order and edit mode`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
