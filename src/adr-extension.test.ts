import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scheduler } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";

import { dirState, loadInitialized, today } from "../plugins/adr/src/documents.ts";
import { createMany, initialize, type WriteResult } from "../plugins/adr/src/operations.ts";
import { pluginStatePath } from "../plugins/adr/src/plugin-state.ts";
import type { AdrApiV1 } from "../plugins/adr/src/service.ts";
import type { UiFactory } from "../plugins/adr/src/ses.ts";
import { readUiMenu } from "../plugins/adr/src/settings.ts";
import type { AdrStatusState } from "../plugins/adr/src/state.ts";
import type { Receipt } from "../plugins/adr/src/tools.ts";
import {
  type AdrMessenger,
  type AdrUi,
  HeadlessUi,
  type MenuChoice,
  type MenuEntry,
  type MenuOptions,
  type PreviewFile,
} from "../plugins/adr/src/ui.ts";
import { decision, git, LEGACY_ADR_1, LEGACY_INDEX } from "./adr-fixtures.ts";

const CHILD_ENV = "ADR_EXTENSION_CASE";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/adr/src/index.ts", import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL("../plugins/adr", import.meta.url));

class ScriptedUi implements AdrUi {
  readonly interactive = true;
  console = false;
  menuChoice: MenuChoice | undefined;
  /** Answers queued for successive menu calls (a console re-opening); `menuChoice` answers once it is empty. */
  menuChoices: Array<MenuChoice | undefined> = [];
  menuCalls: MenuEntry[][] = [];
  menuOptions: Array<MenuOptions | undefined> = [];
  texts: Array<string | undefined> = [];
  confirmed: boolean | undefined = true;
  previewCalls: Array<{ title: string; files: PreviewFile[] }> = [];
  notifications: Array<{ message: string; level: string }> = [];

  async menu(entries: MenuEntry[], options?: MenuOptions) {
    this.menuCalls.push(entries);
    this.menuOptions.push(options);
    return this.menuChoices.length ? this.menuChoices.shift() : this.menuChoice;
  }

  async text() {
    return this.texts.shift();
  }

  async previewConfirm(p: { title: string; files: PreviewFile[] }) {
    this.previewCalls.push(p);
    return this.confirmed;
  }

  notify(message: string, level: "info" | "warning" | "error") {
    this.notifications.push({ message, level });
  }
}

interface Harness {
  session: AgentSession;
  runner: ExtensionRunner;
  events: { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };
  ui: ScriptedUi;
  kickoffs: string[];
  messages: string[];
  setUi: (factory?: UiFactory) => void;
  getAllTools: () => Array<{ name: string; sourceInfo?: { source: string; path: string } }>;
}

async function createHarness(root: string, options: { sub?: boolean; entry?: string } = {}): Promise<Harness> {
  // These imports intentionally exercise the loader boundary after the child's isolated HOME is set.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const entry = options.entry ?? ENTRY;
  const ui = new ScriptedUi();
  const { session, extensionsResult, eventBus } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false, "edit.mode": "hashline" }),
    toolNames: ["read", "write", "edit", "bash"],
    additionalExtensionPaths: [entry],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    ...(options.sub ? { taskDepth: 1, agentId: "adr-sdk-child", agentName: "task", parentTaskPrefix: "adr-child" } : {}),
  });
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw new Error(error.error);
    },
  });
  assert.deepEqual(extensionsResult.errors, []);
  const factory = extensionsResult.preparedExtensions?.find((extension) => extension.resolvedPath === entry)?.factory;
  assert(factory && "__setUiFactory" in factory && typeof factory.__setUiFactory === "function");
  const setter = factory.__setUiFactory;
  const setUi = (value?: UiFactory): void => {
    setter(value);
  };
  setUi(async () => ui);
  const runner = session.extensionRunner;
  assert(runner);
  const kickoffs: string[] = [];
  const messages: string[] = [];
  // Preserve command dispatch while recording its kickoff instead of making a provider request.
  extensionsResult.runtime.sendUserMessage = (content) => {
    assert.equal(typeof content, "string");
    if (typeof content === "string") kickoffs.push(content);
  };
  extensionsResult.runtime.sendMessage = (message) => {
    const content = typeof message === "string" ? message : message.content;
    assert.equal(typeof content, "string");
    if (typeof content === "string") messages.push(content);
  };
  for (const name of ["write", "edit", "bash", "adr_status", "adr_manage", "adr_check"]) {
    assert(session.getToolByName(name), `Real loader must register ${name}`);
  }
  assert.equal(runner.createContext().agent.kind, options.sub ? "sub" : "main");
  await runner.emit({ type: "session_start" });
  return {
    session,
    runner,
    events: eventBus,
    ui,
    kickoffs,
    messages,
    setUi,
    getAllTools: () => extensionsResult.runtime.getAllTools(),
  };
}

async function command(h: Harness, args = ""): Promise<void> {
  const registered = h.runner.getCommand("adr");
  assert(registered);
  await registered.handler(args, h.runner.createCommandContext());
}

async function call(h: Harness, name: string, input: object): Promise<Receipt> {
  const tool = h.session.getToolByName(name);
  assert(tool);
  const result = await tool.execute(`sdk-${name}-${crypto.randomUUID()}`, input);
  // The SDK erases the in-process extension detail type; validate its discriminator at this boundary.
  assert(result.details && typeof result.details === "object" && "ok" in result.details && typeof result.details.ok === "boolean");
  const details = result.details as Receipt;
  assert.equal(Boolean(result.isError), !details.ok);
  return details;
}

async function injection(h: Harness): Promise<string> {
  const result = await h.runner.emitBeforeAgentStart("Continue", undefined, ["Original host policy"]);
  if (!result?.systemPrompt) return "";
  assert.equal(result.systemPrompt[0], "Original host policy");
  return result.systemPrompt.slice(1).join("\n");
}

function request(h: Harness, payload: Record<string, unknown>): { toolSourcePath: string; api: AdrApiV1 } | undefined {
  let reply: { toolSourcePath: string; api: AdrApiV1 } | undefined;
  const unsubscribe = h.events.on("adr:binding", (data) => {
    const value = data as { v?: unknown; requestId?: unknown; toolSourcePath: string; api: AdrApiV1 };
    if (value.v === 1 && value.requestId === payload.requestId) reply = value;
  });
  try {
    h.events.emit("adr:binding-request", payload);
  } finally {
    unsubscribe();
  }
  return reply;
}

const CASES: Record<string, string> = {
  handshake: "the service answers only its own session through a symlinked install and exposes a working v1 api",
  interception: "an initialized repository blocks native docs/adr mutations and allows other files",
  "interception-legacy": "a legacy roadmap ADR index protects docs/adr and the tools read it",
  uninitialized: "an uninitialized repository injects nothing, allows docs/adr writes and refuses tools and unmanaged init",
  tools: "tools list, detail, manage and check ADRs, inject a bounded summary and publish the sidecar",
  link: "adr_manage sets, changes and clears stage links with resolver validation and required ids",
  init: "/adr init writes only after a confirmed preview and is idempotent",
  headless: "without a UI, /adr init holds a token for /adr confirm and subcommands decide, note and hand off",
  menu: "the /adr menu accepts, notes, supersedes and starts new decisions",
  console: "the fullscreen console re-opens after local actions with a result line and closes on hand-off or Esc",
  settings: "uiMenu is read from the project settings, defaults to fullscreen and falls back on invalid values",
  subagent: "subagents get the summary, create only proposed ADRs and cannot decide or run /adr",
};

async function acceptance(name: string, root: string): Promise<void> {
  let entry = ENTRY;
  if (name === "handshake") {
    // Marketplace installs load a plugin through a node_modules symlink into the plugin cache.
    const linked = join(dirname(root), "plugins/node_modules/wows-omp-plugin-adr");
    await mkdir(dirname(linked), { recursive: true });
    await symlink(PLUGIN_DIR, linked);
    entry = join(linked, "src/index.ts");
  }
  if (name === "subagent") {
    await initialize(root, "main");
    await createMany(root, "main", [{ ...decision, title: "Pending choice" }]);
  }
  const h = await createHarness(root, { sub: name === "subagent", entry });
  try {
    const sessionId = h.session.sessionManager.getSessionId();
    if (name === "handshake") {
      const reply = request(h, { v: 1, sessionId, requestId: "own" });
      assert(reply);
      assert.equal(reply.toolSourcePath, ENTRY);
      for (const tool of ["adr_status", "adr_manage", "adr_check"]) {
        const provenance = h.getAllTools().find((candidate) => candidate.name === tool)?.sourceInfo;
        assert.equal(provenance?.source, "extension");
        assert.equal(provenance?.path, reply.toolSourcePath);
      }
      assert.equal(request(h, { v: 1, sessionId: "another-session", requestId: "other" }), undefined);
      assert.equal(request(h, { v: 2, sessionId, requestId: "future" }), undefined);
      assert.equal(request(h, { v: 1, sessionId }), undefined);
      const { api } = reply;
      assert.equal(api.version, 1);
      assert.equal(await api.dirState(root), "absent");
      assert.equal(await api.load(root), null);
      await assert.rejects(api.create(root, "main", decision), /not initialized/);
      await assert.rejects(api.initialize(root, "sub"), /Only the main session/);
      const preview = await api.createMany(root, "main", [decision], { dryRun: true, initialize: true });
      assert.deepEqual(preview.ids, ["ADR-0001"]);
      assert.equal(await api.dirState(root), "absent");
      const created: WriteResult = await api.createMany(root, "main", [decision], { initialize: true });
      assert.deepEqual(created.files, preview.files);
      assert.equal(await api.dirState(root), "managed");
      await assert.rejects(api.create(root, "main", { ...decision, stage: "S01" }), /Stage links need the roadmap plugin/);
      const asked: string[] = [];
      const unregister = api.registerStageResolver(async (repoRoot, stage) => {
        asked.push(`${repoRoot}:${stage}`);
        return stage === "S01" ? undefined : "unknown stage";
      });
      await assert.rejects(api.create(root, "main", { ...decision, stage: "S02" }), /unknown stage/);
      const linked = await api.create(root, "sub", { ...decision, stage: "S01", status: "accepted" });
      assert.deepEqual(linked.ids, ["ADR-0002"]);
      assert.deepEqual(linked.warnings, ["Subagent ADRs are created as proposed."]);
      await api.link(root, "main", "ADR-0001", "S01");
      await api.relinkStage(root, "main", "S01", "S04");
      assert.deepEqual(asked, [`${root}:S02`, `${root}:S01`, `${root}:S01`]);
      const loaded = await api.load(root);
      assert(loaded);
      assert.deepEqual(
        loaded.records.map((record) => [record.id, record.status, record.stage, record.legacy, record.path]),
        [
          ["ADR-0001", "proposed", "S04", false, "docs/adr/0001-adopt-event-sourcing.md"],
          ["ADR-0002", "proposed", "S04", false, "docs/adr/0002-adopt-event-sourcing.md"],
        ],
      );
      assert.match(loaded.records[0]?.body ?? "", /^## Context and Problem Statement\n/);
      unregister();
      await assert.rejects(api.link(root, "main", "ADR-0001", "S01"), /Stage links need the roadmap plugin/);
      for (const stage of ["S01", undefined]) await assert.rejects(api.link(root, "sub", "ADR-0001", stage), /Only the main agent/);
      await api.link(root, "main", "ADR-0001", undefined);
      assert.equal((await api.load(root))?.records[0]?.stage, undefined);
      // The latest registration wins, and an older unregister cannot remove a newer resolver.
      const first = api.registerStageResolver(async () => "first");
      api.registerStageResolver(async () => undefined);
      first();
      await api.link(root, "main", "ADR-0001", "S05");
      await assert.rejects(api.load(join(dirname(root), "plugins")), /git work tree/);
    } else if (name === "link") {
      await initialize(root, "main");
      await createMany(root, "main", [{ ...decision, status: "accepted" }]);
      const reply = request(h, { v: 1, sessionId, requestId: "link" });
      assert(reply);
      const original = (await reply.api.load(root))?.records[0];
      assert(original);
      const missingId = await call(h, "adr_manage", { action: "link" });
      assert(!missingId.ok);
      assert.match(missingId.reason, /ADR id must be non-empty/);
      const noResolver = await call(h, "adr_manage", { action: "link", id: original.id, stage: "S01" });
      assert(!noResolver.ok);
      assert.match(noResolver.reason, /Stage links need the roadmap plugin/);
      const asked: string[] = [];
      const unregister = reply.api.registerStageResolver(async (repoRoot, stage) => {
        assert.equal(repoRoot, root);
        asked.push(stage);
        return stage === "S01" || stage === "S02" ? undefined : "unknown stage";
      });
      const unknown = await call(h, "adr_manage", { action: "link", id: original.id, stage: "S09" });
      assert(!unknown.ok);
      assert.match(unknown.reason, /Stage S09 cannot be linked: unknown stage/);
      assert.deepEqual((await reply.api.load(root))?.records[0], original);
      for (const stage of ["S01", "S02"]) {
        const receipt = await call(h, "adr_manage", { action: "link", id: original.id, stage });
        assert(receipt.ok, JSON.stringify(receipt));
        assert.deepEqual(receipt.changedFiles, [original.path]);
        assert.deepEqual((await reply.api.load(root))?.records[0], { ...original, stage });
      }
      assert.deepEqual(asked, ["S09", "S01", "S02"]);
      unregister();
      const cleared = await call(h, "adr_manage", { action: "link", id: original.id });
      assert(cleared.ok, JSON.stringify(cleared));
      assert.deepEqual((await reply.api.load(root))?.records[0], original);
      const unchanged = await call(h, "adr_manage", { action: "link", id: original.id });
      assert(unchanged.ok);
      assert.deepEqual(unchanged.changedFiles, []);
    } else if (name === "interception") {
      await initialize(root, "main");
      await createMany(root, "main", [decision]);
      const adrPath = join(root, "docs/adr/0001-adopt-event-sourcing.md");
      const before = await readFile(adrPath, "utf8");
      const indexBefore = await readFile(join(root, "docs/adr/README.md"), "utf8");
      for (const [toolName, input] of [
        ["write", { path: "docs/adr/0001-adopt-event-sourcing.md", content: "bad" }],
        ["write", { path: "docs/adr/0002-new.md", content: "bad" }],
        ["edit", { input: `[${adrPath}#ABCD]\nPUT <1:\n+bad` }],
        ["bash", { command: "echo x > docs/adr/README.md" }],
        ["bash", { command: "rm -rf docs/adr" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const tool = h.session.getToolByName(toolName);
        assert(tool);
        await assert.rejects(tool.execute(`block-${crypto.randomUUID()}`, input), /adr_manage/);
      }
      assert.equal(
        (await h.runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "broad", input: { command: "rm -rf docs" } }))
          ?.block,
        true,
      );
      assert.equal(await readFile(adrPath, "utf8"), before);
      assert.equal(await readFile(join(root, "docs/adr/README.md"), "utf8"), indexBefore);
      const write = h.session.getToolByName("write");
      assert(write);
      await write.execute("allow-other", { path: "docs/other.md", content: "allowed\n" });
      assert.equal(await readFile(join(root, "docs/other.md"), "utf8"), "allowed\n");
      await symlink(join(root, "docs/adr"), join(root, "adr-alias"));
      await assert.rejects(write.execute("symlink-target", { path: "adr-alias/x.md", content: "bad" }), /adr_manage/);
      // A corrupt marker must not downgrade to an unprotected repository.
      await writeFile(join(root, "docs/adr/README.md"), "---\nformat: 99\nadr: { format: 99 }\n---\n");
      await assert.rejects(write.execute("invalid-marker", { path: "docs/adr/x.md", content: "bad" }), /could not validate/);
    } else if (name === "interception-legacy") {
      await mkdir(join(root, "docs/adr"), { recursive: true });
      await writeFile(join(root, "docs/adr/README.md"), LEGACY_INDEX.replace(/\| ADR-0002 [^\n]*\n/, ""));
      await writeFile(join(root, "docs/adr/0001-use-postgres.md"), LEGACY_ADR_1);
      const write = h.session.getToolByName("write");
      assert(write);
      await assert.rejects(write.execute("legacy-block", { path: "docs/adr/0001-use-postgres.md", content: "bad" }), /adr_manage/);
      assert.equal(await readFile(join(root, "docs/adr/0001-use-postgres.md"), "utf8"), LEGACY_ADR_1);
      const status = await call(h, "adr_status", { id: "ADR-0001" });
      assert(status.ok, JSON.stringify(status));
      assert.match(status.summary, /legacy roadmap format/);
      assert.match(await injection(h), /^ADRs in docs\/adr: 1 accepted\./);
    } else if (name === "uninitialized") {
      assert.equal(await injection(h), "");
      for (const [toolName, input] of [
        ["write", { path: "docs/adr/x.md", content: "x" }],
        ["edit", { input: "[docs/adr/x.md#ABCD]\nPUT <1:\n+x" }],
        ["bash", { command: "echo x > docs/adr/x.md" }],
      ] as Array<[string, Record<string, unknown>]>) {
        assert.equal(await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }), undefined);
      }
      for (const [tool, input] of [
        ["adr_status", {}],
        ["adr_manage", { action: "create", ...decision }],
        ["adr_check", {}],
      ] as Array<[string, object]>) {
        const receipt = await call(h, tool, input);
        assert(!receipt.ok);
        assert.match(receipt.reason, /not initialized/);
        assert.match(receipt.hints.join("\n"), /\/adr init/);
      }
      const write = h.session.getToolByName("write");
      assert(write);
      await write.execute("uninitialized-write", { path: "docs/adr/notes.md", content: "allowed" });
      assert.equal(await readFile(join(root, "docs/adr/notes.md"), "utf8"), "allowed");
      assert.equal(await dirState(join(root, "docs/adr")), "unmanaged");
      await command(h, "init");
      assert.equal(h.ui.previewCalls.length, 0);
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /not managed by the adr plugin/);
      assert.equal(h.ui.notifications.at(-1)?.level, "error");
      assert.equal(await readFile(join(root, "docs/adr/notes.md"), "utf8"), "allowed");
      assert.equal(await dirState(join(root, "docs/adr")), "unmanaged");
      const status = await call(h, "adr_status", {});
      assert(!status.ok);
      assert.match(status.reason, /not managed by the adr plugin/);
    } else if (name === "tools") {
      await initialize(root, "main");
      for (let index = 1; index <= 6; index++) {
        const receipt = await call(h, "adr_manage", { action: "create", ...decision, title: `Choice ${index}` });
        assert(receipt.ok, JSON.stringify(receipt));
        assert.match(receipt.summary, new RegExp(`Created ADR-000${index}`));
      }
      const refused = await call(h, "adr_manage", { action: "create", ...decision, stage: "S01" });
      assert(!refused.ok);
      assert.match(refused.reason, /Stage links need the roadmap plugin/);
      assert(!(await call(h, "adr_manage", { action: "note", id: "ADR-0001", stage: "S01", text: "x" })).ok);
      assert((await call(h, "adr_manage", { action: "set_status", id: "ADR-0001", status: "accepted" })).ok);
      assert((await call(h, "adr_manage", { action: "supersede", id: "ADR-0001", ...decision, title: "Choice one revisited" })).ok);
      assert((await call(h, "adr_manage", { action: "note", id: "ADR-0002", text: "Measured twice." })).ok);
      const badBody = await call(h, "adr_manage", { action: "note", id: "ADR-0002", text: "<script>x</script>" });
      assert(!badBody.ok);
      assert.match(badBody.reason, /document structure/);
      const list = await call(h, "adr_status", { status: "proposed" });
      assert(list.ok);
      assert.match(list.summary, /^ADRs: 5 proposed, 1 accepted, 1 superseded\./);
      assert.match(list.summary, /- ADR-0002 \[proposed\] Choice 2/);
      assert(!list.summary.includes("ADR-0001 [superseded]"));
      const detail = await call(h, "adr_status", { id: "ADR-0001" });
      assert(detail.ok);
      assert.match(detail.summary, /Supersession chain: ADR-0001 \(superseded\) → ADR-0007 \(accepted\)/);
      assert.match(detail.summary, /# Choice 1\n\n## Context and Problem Statement/);
      assert(!(await call(h, "adr_status", { id: "ADR-0099" })).ok);
      const checked = await call(h, "adr_check", {});
      assert(checked.ok, JSON.stringify(checked));
      const block = await injection(h);
      assert.equal(
        block,
        [
          "ADRs in docs/adr: 5 proposed, 1 accepted, 1 superseded.",
          "Proposed: ADR-0002 Choice 2; ADR-0003 Choice 3; ADR-0004 Choice 4; ADR-0005 Choice 5; ADR-0006 Choice 6.",
          "Read decisions with adr_status (an id gives the full text); change them only through adr_manage.",
        ].join("\n"),
      );
      assert((await call(h, "adr_manage", { action: "create", ...decision, title: "Choice 8" })).ok);
      assert.match(await injection(h), /ADR-0006 Choice 6; and 1 more\./);
      // The sidecar follows tool calls; it is published after a short coalescing delay.
      const path = pluginStatePath(sessionId, "adr");
      let envelope: { plugin?: string; state?: AdrStatusState | null } = {};
      for (let attempt = 0; attempt < 50 && envelope.state?.records.length !== 8; attempt++) {
        await scheduler.wait(50);
        envelope = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      }
      assert.equal(envelope.plugin, "adr");
      assert.equal(envelope.state?.kind, "adr/status");
      assert.deepEqual(envelope.state?.counts, { proposed: 6, accepted: 1, rejected: 0, deprecated: 0, superseded: 1 });
      assert.equal(envelope.state?.format, 1);
      assert.equal(envelope.state?.legacyFiles, 0);
      assert.deepEqual(envelope.state?.records[0], {
        id: "ADR-0001",
        title: "Choice 1",
        status: "superseded",
        date: today(),
        superseded_by: "ADR-0007",
      });
    } else if (name === "init") {
      h.ui.confirmed = false;
      await command(h, "init");
      assert.equal(h.ui.previewCalls.length, 1);
      assert.deepEqual(
        h.ui.previewCalls[0]?.files.map((file) => file.path),
        ["docs/adr/README.md"],
      );
      assert.equal(await dirState(join(root, "docs/adr")), "absent");
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /declined/);
      h.ui.confirmed = true;
      await command(h, "init");
      assert.equal(await dirState(join(root, "docs/adr")), "managed");
      assert.match(h.messages.at(-1) ?? "", /Initialized ADR management/);
      assert.equal(await readFile(join(root, "docs/adr/README.md"), "utf8"), h.ui.previewCalls[1]?.files[0]?.content);
      await command(h, "init");
      assert.equal(h.ui.previewCalls.length, 2);
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /already initialized/);
      assert.match(await injection(h), /^ADRs in docs\/adr: no ADRs yet\./);
    } else if (name === "headless") {
      const messenger: AdrMessenger = {
        sendMessage: (message) => h.messages.push(typeof message === "string" ? message : String(message.content)),
      };
      h.setUi(async () => new HeadlessUi(messenger));
      await command(h, "init");
      const token = /\/adr confirm ([0-9a-f]{12})/.exec(h.messages.at(-1) ?? "")?.[1];
      assert(token, h.messages.join("\n"));
      assert.match(h.messages.at(-1) ?? "", /--- docs\/adr\/README\.md\n---\nformat: 1\nadr: \{ format: 1 \}/);
      assert.equal(await dirState(join(root, "docs/adr")), "absent");
      await command(h, "confirm 000000000000");
      assert.match(h.messages.at(-1) ?? "", /No pending ADR preview/);
      await command(h, `confirm ${token}`);
      assert.equal(await dirState(join(root, "docs/adr")), "managed");
      await command(h, `confirm ${token}`);
      assert.match(h.messages.at(-1) ?? "", /No pending ADR preview/);
      await createMany(root, "main", [decision, { ...decision, title: "Second" }]);
      await command(h);
      assert.match(h.messages.at(-1) ?? "", /ADRs: 2 proposed\.[\s\S]*Usage: \/adr/);
      await command(h, "accept ADR-0001");
      await command(h, "reject ADR-0002");
      await command(h, "note ADR-0001 Rolled out  to every service.");
      await command(h, "list accepted");
      assert.match(h.messages.at(-1) ?? "", /- ADR-0001 \[accepted\]/);
      const model = await loadInitialized(root);
      assert.deepEqual(
        model?.adrs.map((doc) => [doc.id, doc.status]),
        [
          ["ADR-0001", "accepted"],
          ["ADR-0002", "rejected"],
        ],
      );
      assert.match(model?.adrs[0]?.body ?? "", /\n\nRolled out {2}to every service\.\n\n$/);
      await command(h, "show ADR-0001");
      assert.match(h.messages.at(-1) ?? "", /Status: accepted/);
      await command(h, "new caching strategy");
      assert.match(h.kickoffs.at(-1) ?? "", /new architecture decision on: caching strategy[\s\S]*adr_manage/);
      await command(h, "supersede ADR-0002");
      assert.match(h.messages.at(-1) ?? "", /Only an accepted or deprecated ADR can be superseded/);
      await command(h, "supersede ADR-0001 use a queue");
      assert.match(h.kickoffs.at(-1) ?? "", /replaces ADR-0001 — Adopt event sourcing; new direction: use a queue[\s\S]*"supersede"/);
      await command(h, "check --fix");
      assert.match(h.messages.at(-1) ?? "", /ADR check passed/);
      await command(h, "bogus");
      assert.match(h.messages.at(-1) ?? "", /Usage: \/adr/);
    } else if (name === "menu") {
      await initialize(root, "main");
      await createMany(root, "main", [decision]);
      await command(h);
      assert.equal(h.ui.menuCalls[0]?.[0]?.record.id, "ADR-0001");
      assert.match(h.ui.menuCalls[0]?.[0]?.detail ?? "", /Status: proposed/);
      h.ui.menuChoice = { action: "accept", id: "ADR-0001" };
      await command(h);
      assert.equal((await loadInitialized(root))?.adrs[0]?.status, "accepted");
      h.ui.menuChoice = { action: "note", id: "ADR-0001" };
      h.ui.texts = ["  "];
      await command(h);
      h.ui.texts = ["Confirmed in production."];
      await command(h);
      assert.match((await loadInitialized(root))?.adrs[0]?.body ?? "", /Confirmed in production\.\n\n$/);
      assert.equal((await loadInitialized(root))?.adrs[0]?.body.match(/### \d{4}/g)?.length, 1);
      h.ui.menuChoice = { action: "new" };
      h.ui.texts = [undefined];
      await command(h);
      assert.equal(h.kickoffs.length, 0);
      h.ui.texts = [""];
      await command(h);
      assert.match(h.kickoffs.at(-1) ?? "", /^Use the adr skill to interview me about a new architecture decision\. /);
      h.ui.menuChoice = { action: "supersede", id: "ADR-0001" };
      h.ui.texts = ["switch storage"];
      await command(h);
      assert.match(h.kickoffs.at(-1) ?? "", /replaces ADR-0001[\s\S]*switch storage/);
      h.ui.menuChoice = { action: "check-fix" };
      await command(h);
      assert.match(h.messages.at(-1) ?? "", /ADR check passed/);
      for (const prefix of ["", "l", "list "]) {
        const labels =
          h.runner
            .getCommand("adr")
            ?.getArgumentCompletions?.(prefix)
            ?.map((option) => option.label) ?? [];
        assert.equal(new Set(labels).size, labels.length, `the menu shows every completion distinctly: ${labels.join(", ")}`);
      }
    } else if (name === "console") {
      await initialize(root, "main");
      await createMany(root, "main", [decision, { ...decision, title: "Second" }]);
      h.ui.console = true;
      h.ui.menuChoices = [
        { action: "accept", id: "ADR-0001" },
        { action: "check" },
        { action: "note", id: "ADR-0002" },
        { action: "supersede", id: "ADR-0002" },
        undefined,
      ];
      h.ui.texts = [undefined, "anything"];
      await command(h);
      assert.equal(h.ui.menuCalls.length, 5);
      assert.deepEqual(h.ui.menuOptions[0], {});
      assert.deepEqual(h.ui.menuOptions[1], { selectedId: "ADR-0001", message: { text: "ADR-0001 accepted.", level: "info" } });
      assert.equal(h.ui.menuCalls[1]?.[0]?.record.status, "accepted", "the re-opened console shows the new status");
      assert.equal(h.ui.menuOptions[2]?.selectedId, "ADR-0001");
      assert.match(h.ui.menuOptions[2]?.message?.text ?? "", /^ADR check passed/);
      assert.deepEqual(h.ui.menuOptions[3], { selectedId: "ADR-0002", message: { text: "No note appended.", level: "info" } });
      assert.equal(h.ui.menuOptions[4]?.message?.level, "error");
      assert.match(h.ui.menuOptions[4]?.message?.text ?? "", /Only an accepted or deprecated ADR can be superseded/);
      assert.equal(h.kickoffs.length, 0);
      assert.equal(h.ui.notifications.length, 0, "console errors stay in the console");
      assert.match(h.messages.join("\n"), /ADR-0001 accepted\.[\s\S]*ADR check passed/, "receipts still reach the conversation");
      // Hand-offs close the console: the agent interviews next.
      h.ui.menuCalls = [];
      h.ui.menuChoices = [{ action: "new" }];
      h.ui.texts = ["caching"];
      await command(h);
      assert.equal(h.ui.menuCalls.length, 1);
      assert.match(h.kickoffs.at(-1) ?? "", /new architecture decision on: caching/);
      h.ui.menuCalls = [];
      h.ui.menuChoices = [{ action: "supersede", id: "ADR-0001" }];
      h.ui.texts = [""];
      await command(h);
      assert.equal(h.ui.menuCalls.length, 1);
      assert.match(h.kickoffs.at(-1) ?? "", /replaces ADR-0001/);
      // A cancelled hand-off dialog returns to the console instead.
      h.ui.menuCalls = [];
      h.ui.menuChoices = [{ action: "new" }, undefined];
      h.ui.texts = [undefined];
      await command(h);
      assert.equal(h.ui.menuCalls.length, 2);
      assert.equal(h.ui.menuOptions.at(-1)?.message?.text, "No new decision started.");
      assert.equal((await loadInitialized(root))?.adrs[0]?.status, "accepted");
    } else if (name === "settings") {
      const warnings: unknown[] = [];
      const warn = (message: string, data: Record<string, unknown>): void => {
        warnings.push([message, data]);
      };
      assert.equal(await readUiMenu(root, warn), "fullscreen");
      const configure = (value: unknown) =>
        writeFile(join(root, ".omp/plugin-overrides.json"), JSON.stringify({ settings: { "wows-omp-plugin-adr": { uiMenu: value } } }));
      await mkdir(join(root, ".omp"), { recursive: true });
      await configure("inline");
      assert.equal(await readUiMenu(root, warn), "inline");
      await configure("fullscreen");
      assert.equal(await readUiMenu(root, warn), "fullscreen");
      assert.equal(warnings.length, 0);
      await configure("sideways");
      assert.equal(await readUiMenu(root, warn), "fullscreen");
      assert.match(JSON.stringify(warnings), /uiMenu setting is invalid.*sideways/);
    } else if (name === "subagent") {
      assert.match(await injection(h), /^ADRs in docs\/adr: 1 proposed\.\nProposed: ADR-0001 Pending choice\./);
      const created = await call(h, "adr_manage", { action: "create", ...decision, status: "accepted" });
      assert(created.ok);
      assert.match(created.warnings.join("\n"), /created as proposed/);
      const decided = await call(h, "adr_manage", { action: "set_status", id: "ADR-0001", status: "accepted" });
      assert(!decided.ok);
      assert.match(decided.reason, /Only the main agent/);
      assert(!(await call(h, "adr_manage", { action: "supersede", id: "ADR-0001", ...decision })).ok);
      for (const stage of ["S01", undefined]) {
        const linked = await call(h, "adr_manage", { action: "link", id: "ADR-0001", stage });
        assert(!linked.ok);
        assert.match(linked.reason, /Only the main agent/);
      }
      assert((await call(h, "adr_manage", { action: "note", id: "ADR-0001", text: "Subagent finding." })).ok);
      await command(h, "accept ADR-0001");
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /require the main session/);
      assert.deepEqual(
        (await loadInitialized(root))?.adrs.map((doc) => doc.status),
        ["proposed", "proposed"],
      );
    } else throw new Error(`Unknown acceptance case: ${name}`);
    console.log(`ADR_EXTENSION_OK ${name}`);
  } finally {
    h.setUi();
    await h.session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await acceptance(process.env[CHILD_ENV] as string, process.env.ADR_EXTENSION_ROOT as string);
} else {
  // A plain Bun child cannot import bun:test; this branch owns only the parent test runner.
  const { expect, test } = await import("bun:test");
  for (const [name, description] of Object.entries(CASES)) {
    // Each case runs in its own process with a private HOME and repository, so cases share no state.
    test.concurrent(`real SDK adr: ${description}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "adr-extension-"));
      try {
        const cwd = join(home, "repo");
        await mkdir(cwd);
        await git(cwd, ["init", "-q"]);
        const child = Bun.spawn([process.execPath, THIS_FILE], {
          cwd,
          env: { ...process.env, [CHILD_ENV]: name, ADR_EXTENSION_ROOT: cwd, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain(`ADR_EXTENSION_OK ${name}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
