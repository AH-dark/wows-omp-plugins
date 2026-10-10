import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { Snapshot, TodoPhase } from "../plugins/omp-herdr-dag/src/model.ts";
import { applyOps, encodeFrame, type Frame, FrameParser } from "../plugins/omp-herdr-dag/src/protocol.ts";
import type { PluginSettings } from "../plugins/omp-herdr-dag/src/settings.ts";
import { herdrSocketPath, type SnapshotTimer } from "../plugins/omp-herdr-dag/src/transport.ts";

const CHILD_ENV = "HERDR_DAG_EXTENSION_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>;
interface RegisteredTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{ isError?: boolean }>;
}

class Clock implements SnapshotTimer {
  now = 0;
  #id = 0;
  #jobs = new Map<number, { at: number; callback: () => void; repeat?: number }>();
  get pending(): number {
    return this.#jobs.size;
  }
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout {
    const id = ++this.#id;
    this.#jobs.set(id, { at: this.now + milliseconds, callback });
    return id as unknown as NodeJS.Timeout;
  }
  clearTimeout(handle: NodeJS.Timeout | undefined): void {
    this.#jobs.delete(handle as unknown as number);
  }
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout {
    const handle = this.setTimeout(callback, milliseconds);
    const job = this.#jobs.get(handle as unknown as number);
    assert(job);
    job.repeat = milliseconds;
    return handle;
  }
  clearInterval(handle: NodeJS.Timeout | undefined): void {
    this.#jobs.delete(handle as unknown as number);
  }
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.#jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, job] = next;
      this.now = job.at;
      if (job.repeat) job.at += job.repeat;
      else this.#jobs.delete(id);
      job.callback();
    }
    this.now = target;
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>, message = "condition did not settle"): Promise<void> {
  const deadline = Date.now() + 2_500;
  while (!(await predicate())) {
    assert(Date.now() < deadline, message);
    // Yield to actual Unix socket / filesystem completions; all duration-dependent timers use Clock.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class Peer {
  frames: Frame[] = [];
  socket: Socket;
  parser = new FrameParser();
  constructor(path: string) {
    this.socket = createConnection(path);
    this.socket.on("data", (chunk: Buffer) => this.frames.push(...this.parser.feed(chunk)));
    this.socket.on("error", () => {});
  }
  async ready(): Promise<void> {
    await eventually(() => this.frames.some((frame) => frame.type === "snapshot"));
    this.socket.write(encodeFrame({ v: 1, seq: 1, type: "ready", cols: 120, rows: 40 }));
  }
  async snapshot(): Promise<Snapshot> {
    this.socket.write(encodeFrame({ v: 1, seq: 2, type: "resync" }));
    const count = this.frames.filter((frame) => frame.type === "snapshot").length;
    await eventually(() => this.frames.filter((frame) => frame.type === "snapshot").length > count);
    const frame = this.frames.findLast((frame) => frame.type === "snapshot");
    assert(frame?.type === "snapshot");
    return frame.snapshot;
  }
}

async function scenario(name: string, root: string): Promise<void> {
  // Native SDK modules load only after the child has an isolated HOME and host-state root.
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Type } = await import("@oh-my-pi/omptype/typebox");
  const theme = await import("@oh-my-pi/pi-tui/theme");
  await theme.initTheme(false);
  const { default: register } = await import("../plugins/omp-herdr-dag/src/index.ts");
  const { readSnapshot, writePane } = await import("../plugins/omp-herdr-dag/src/persisted.ts");
  const { PLAN_EXECUTION_ENTRY } = await import("../plugins/omp-herdr-dag/src/sources/plan-execution.ts");
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, ".omp"), { recursive: true });
  let settings: Partial<PluginSettings> = { displayTiming: "never", followOrientation: false, viewerRuntime: process.execPath };
  const configure = async (patch: Partial<PluginSettings>) => {
    settings = { ...settings, ...patch };
    await writeFile(join(cwd, ".omp/plugin-overrides.json"), JSON.stringify({ settings: { "wows-omp-plugin-omp-herdr-dag": settings } }));
  };
  await configure({});
  let manager = SessionManager.create(cwd, join(root, "sessions"));
  let reference = "local://approved.md";
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const bus = new EventBus();
  const notices: string[] = [];
  const warnings: string[] = [];
  const calls: string[][] = [];
  const paneIds = new Set<string>(["host"]);
  let nextPane = 0;
  let hungClose = false;
  const clock = new Clock();
  const nativeNow = Date.now;
  const peers: Peer[] = [];
  let shutdown = false;
  // A collab guest's replica session never streams; a local tool call always ends while the agent streams.
  let idle = false;
  const ctx = {
    cwd,
    hasUI: name !== "non-ui",
    mode: name.startsWith("rpc") ? "rpc" : "tui",
    get sessionManager() {
      return manager;
    },
    ui: {
      notify: (message: string) => notices.push(message),
      get theme() {
        return theme.theme;
      },
    },
    invokeTool: async () => ({ content: [{ type: "text", text: "native" }], details: { op: "init", phases: list }, isError: false }),
    isIdle: () => idle,
  } as unknown as ExtensionContext;
  AgentRegistry.resetGlobalForTests();
  const live = {
    get sessionManager() {
      return manager;
    },
    getPlanReferencePath: () => reference,
  } as AgentSession;
  AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  let hellos = 0;
  bus.on("herdr-dag:hello", () => {
    hellos++;
  });
  const api = {
    typebox: { Type },
    events: bus,
    logger: { warn: (message: string) => warnings.push(message) },
    on: (event: string, hook: Hook) => hooks.set(event, hook),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(command, spec.handler),
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
  } as unknown as ExtensionAPI;
  const list: TodoPhase[] = [
    {
      name: "Build",
      tasks: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "pending" },
      ],
    },
  ];
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const handler = hooks.get(event);
    assert(handler, `Missing ${event}`);
    await handler({ type: event, ...payload }, ctx);
  };
  const todo = async (op = "init", phases = list) => {
    const details = { op, phases };
    await hook("tool_execution_end", { toolName: "todo", toolCallId: `todo-${Date.now()}`, result: { details }, isError: false });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: `todo-${Date.now()}`,
      toolName: "todo",
      details,
      content: [],
      isError: false,
      timestamp: Date.now(),
    });
  };
  const command = async (args = "") => {
    const handler = commands.get("dag-pane");
    assert(handler);
    await handler(args, ctx);
  };
  const connect = async () => {
    const peer = new Peer(herdrSocketPath("host", process.pid));
    peers.push(peer);
    await peer.ready();
    return peer;
  };
  const splits = () => calls.filter((args) => args[1] === "split").length;
  const dir = () => join(manager.getSessionDir(), "herdr-dag", manager.getSessionId());
  const proposal = () =>
    hook("tool_execution_end", {
      toolName: "write",
      toolCallId: "proposal",
      isError: false,
      result: { details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "local://approved.md", planExists: true } } } },
    });
  const handoff =
    'Plan approved.\n\n<plan path="local://approved.md">\n# Plan\n</plan>\nFull plan inlined below; durable copy at `local://approved.md`';
  register(api, {
    platform: name === "windows" ? "win32" : "linux",
    env:
      name === "outside-herdr"
        ? {}
        : name === "rpc-no-pane"
          ? { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fake/herdr.sock" }
          : { HERDR_ENV: "1", HERDR_PANE_ID: "host", HERDR_SOCKET_PATH: "/fake/herdr.sock" },
    timer: clock,
    exec: async (args, options) => {
      calls.push([...args]);
      const operation = args[1];
      let result: Record<string, unknown> = {};
      if (operation === "layout")
        result = {
          layout: {
            area: { x: 0, y: 0, width: 120, height: 40 },
            panes: [
              { pane_id: "host", rect: { x: 0, y: 0, width: 78, height: 40 } },
              ...[...paneIds].filter((id) => id !== "host").map((id) => ({ pane_id: id, rect: { x: 78, y: 0, width: 42, height: 40 } })),
            ],
            tab_id: "tab",
          },
        };
      if (operation === "split") {
        const id = `owned-${++nextPane}`;
        paneIds.add(id);
        result = { pane: { pane_id: id, tab_id: "tab" } };
      }
      if (operation === "get" || operation === "rename") {
        if (!paneIds.has(args[2] as string))
          return { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "gone" } }), exitCode: 1 };
        result = { pane: { pane_id: args[2], tab_id: "tab" } };
      }
      if (operation === "close") {
        if (hungClose)
          await new Promise<void>((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("aborted herdr close")), { once: true }),
          );
        paneIds.delete(args[2] as string);
      }
      if (operation === "run" && name === "resume-socket") {
        const socketPath = /'--socket' '([^']+)'/.exec(args[3] ?? "")?.[1];
        assert(socketPath, "viewer launch must specify its socket");
        const peer = new Peer(socketPath);
        peers.push(peer);
        await peer.ready();
      }
      return { stdout: operation === "run" ? "" : JSON.stringify({ result }), exitCode: 0 };
    },
  });
  try {
    if (name === "non-ui" || name === "windows" || name === "outside-herdr" || name.startsWith("rpc")) {
      await hook("session_start");
      await hook("session_switch", { reason: "new" });
      assert.deepEqual([...tools.keys()], ["todo"]);
      assert.equal(commands.size, name === "non-ui" || name.startsWith("rpc") ? 0 : 1);
      assert.equal(calls.length, 0);
      assert.equal(hellos, 0);
      if (name.startsWith("rpc")) {
        await todo();
        await hook("before_agent_start", { prompt: handoff });
        await hook("agent_end");
        assert.equal(calls.length, 0);
        assert.equal(hellos, 0);
        assert.equal(notices.length, 0);
        assert.equal(clock.pending, 0);
        assert.equal(await Bun.file(join(dir(), "snapshot.json")).exists(), false);
      }
      if (name === "windows") {
        await command("open");
        await command("open");
        assert.equal(notices.length, 1);
      }
      if (name === "outside-herdr") {
        await command();
        assert.equal(notices.length, 1);
      }
      const wrapper = tools.get("todo");
      assert(wrapper);
      await wrapper.execute("native", { op: "init", edges: [{ task: "B", after: ["A"] }] }, undefined, undefined, ctx);
      assert(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "omp-herdr-dag:todo-edges"));
      return;
    }
    if (name === "streaming") {
      const rootDir = join(manager.getSessionDir(), "herdr-dag");
      for (const id of ["stale", "fresh-file", manager.getSessionId()]) {
        await mkdir(join(rootDir, id), { recursive: true });
        await writeFile(join(rootDir, id, "snapshot.json"), "{}");
        if (id !== "fresh-file") await utimes(join(rootDir, id, "snapshot.json"), 1, 1);
        await utimes(join(rootDir, id), 1, 1);
      }
      await configure({ displayTiming: "any-todo" });
      await hook("session_start");
      assert.equal(hellos, 1);
      assert(!(await readdir(rootDir)).includes("stale"));
      assert((await readdir(rootDir)).includes("fresh-file"));
      assert((await readdir(rootDir)).includes(manager.getSessionId()));
      await todo();
      assert.equal(splits(), 1);
      assert.equal(hellos, 2);
      const peer = await connect();
      assert.equal(peer.frames[0]?.type, "hello");
      const hello = peer.frames[0];
      assert(hello?.type === "hello");
      assert.equal(hello.paths.snapshot, join(dir(), "snapshot.json"));
      assert.equal(hello.paths.state, join(dir(), "view-state.json"));
      assert.equal(peer.frames[1]?.type, "snapshot");
      const initial = peer.frames[1];
      assert(initial?.type === "snapshot");
      const completed: TodoPhase[] = [
        {
          name: "Build",
          tasks: [
            { content: "A", status: "completed" },
            { content: "B", status: "in_progress" },
          ],
        },
      ];
      await todo("done", completed);
      await todo("start", completed);
      clock.advance(99);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(peer.frames.filter((frame) => frame.type === "delta").length, 0);
      clock.advance(1);
      await eventually(() => peer.frames.some((frame) => frame.type === "delta"));
      const delta = peer.frames.find((frame) => frame.type === "delta");
      assert(delta?.type === "delta");
      assert.equal(peer.frames.filter((frame) => frame.type === "delta").length, 1);
      const applied = applyOps(initial.snapshot, delta, initial.seq);
      assert.equal(applied.baseMismatch, false);
      assert.equal(applied.snapshot.runs[0]?.nodes[0]?.state, "done");
      await peer.snapshot();
      clock.advance(1_899);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(!peer.frames.some((frame) => frame.type === "heartbeat"));
      clock.advance(1);
      await eventually(() => peer.frames.some((frame) => frame.type === "heartbeat"));
      manager.appendCustomEntry("user_todo_edit", {
        phases: [{ name: "Editor", tasks: [{ content: "From /todo", status: "in_progress" }] }],
      });
      const oldEpoch = theme.getThemeEpoch();
      assert((await theme.setTheme("light", false)).success);
      assert.notEqual(theme.getThemeEpoch(), oldEpoch);
      clock.advance(2_000);
      await Promise.resolve();
      await hook("agent_end", { willContinue: true });
      clock.advance(100);
      await eventually(() => peer.frames.some((frame) => frame.type === "delta" && frame.ops.some((op) => op.op === "theme")));
      const themed = await peer.snapshot();
      assert.equal(themed.theme.text, ctx.ui.theme.getColorHex("text"));
      assert(themed.runs.some((run) => run.nodes.some((node) => node.label.includes("From /todo"))));
      bus.emit("task:subagent:lifecycle", { id: "child", status: "started", agent: "task", description: "work", index: 0 });
      bus.emit("task:subagent:progress", {
        id: "child",
        progress: { id: "child", tokens: 123, cost: 0.02, durationMs: 12, currentTool: "read", recentOutput: ["hello"] },
      });
      await eventually(async () => (await peer.snapshot()).tasks.some((task) => task.id === "child"));
      const withTask = await peer.snapshot();
      assert.equal(withTask.tasks[0]?.nodeId, withTask.runs[0]?.nodes[0]?.id);
      assert.equal(withTask.runs[0]?.stats.tokens, 123);
      AgentRegistry.global().register({
        id: "grandchild",
        kind: "sub",
        displayName: "nested",
        parentId: "child",
        session: null,
        status: "running",
      });
      await eventually(async () =>
        (await peer.snapshot()).tasks.some((task) => task.id === "grandchild" && task.depth === 2 && !task.activityAvailable),
      );
      AgentRegistry.global().setStatus("grandchild", "idle");
      await eventually(async () => (await peer.snapshot()).tasks.some((task) => task.id === "grandchild" && task.status === "completed"));
      AgentRegistry.global().unregister("grandchild");
      await eventually(async () => !(await peer.snapshot()).tasks.some((task) => task.id === "grandchild"));
      await configure({ colorTodo: "#112233" });
      await todo("start");
      assert.equal((await peer.snapshot()).sources.todo, "#112233");
      clock.advance(250);
      // An older snapshot can exist while its replacement is in flight; shutdown waits for the writer queue.
      await hook("session_shutdown");
      shutdown = true;
      await eventually(async () => (await readSnapshot(join(dir(), "snapshot.json")))?.version === 2);
      assert.equal((await readSnapshot(join(dir(), "snapshot.json")))?.sessionId, manager.getSessionId());
      assert.equal((await readSnapshot(join(dir(), "snapshot.json")))?.sources.todo, "#112233");
      assert.equal((await stat(join(dir(), "snapshot.json"))).mode & 0o777, 0o600);
      assert(!(await readdir(dir())).some((file) => file.endsWith(".tmp")));
    } else if (name === "plan") {
      await configure({ displayTiming: "plan-execution" });
      await hook("session_start");
      await todo();
      assert.equal(splits(), 0);
      await proposal();
      reference = "local://different.md";
      await hook("before_agent_start", { prompt: handoff });
      assert.equal(splits(), 0);
      reference = "local://approved.md";
      await hook("session_compact");
      await hook("before_agent_start", { prompt: handoff });
      await todo();
      assert.equal(splits(), 1);
      const peer = await connect();
      assert.equal((await peer.snapshot()).runs.at(-1)?.source, "plan");
      const state = () => {
        const entry = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY);
        assert(entry?.type === "custom");
        const data = entry.data;
        assert(data && typeof data === "object" && "state" in data && typeof data.state === "string");
        return data.state;
      };
      assert.equal(state(), "executing");
      await todo("done", [{ name: "Build", tasks: [{ content: "A", status: "completed" }] }]);
      await hook("agent_end", { willContinue: true });
      assert.equal(state(), "executing");
      await hook("agent_end");
      assert.equal(state(), "idle");
    } else if (name === "collab-guest") {
      // Observe-only: a tool_result handler would turn off host speculative task launches.
      assert(!hooks.has("tool_result"));
      await hook("session_start");
      idle = true;
      await proposal();
      await todo();
      const peer = await connect();
      assert.equal((await peer.snapshot()).runs.at(-1)?.source, "todo");
      assert(!manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY));
    } else if (name === "queued-plan") {
      await configure({ displayTiming: "plan-execution" });
      await hook("session_start");
      await proposal();
      const state = () => {
        const entry = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY);
        assert(entry?.type === "custom");
        const data = entry.data;
        assert(data && typeof data === "object" && "state" in data && typeof data.state === "string");
        return data.state;
      };
      const message = {
        role: "developer",
        attribution: "agent",
        synthetic: true,
        content: [{ type: "text", text: handoff }],
        timestamp: Date.now(),
      };
      await hook("context", {
        messages: [
          { ...message, role: "user" },
          { ...message, synthetic: false },
        ],
      });
      assert.equal(state(), "proposed");
      reference = "local://different.md";
      await hook("context", { messages: [message] });
      assert.equal(state(), "proposed");
      reference = "local://approved.md";
      await hook("context", { messages: [message] });
      assert.equal(state(), "executing");
      manager.appendCustomEntry("user_todo_edit", { phases: list });
      clock.advance(2_000);
      await Promise.resolve();
      await hook("agent_end", { willContinue: true });
      assert.equal(splits(), 1);
      const peer = await connect();
      assert.equal((await peer.snapshot()).runs.at(-1)?.source, "plan");
      manager.appendCustomEntry("user_todo_edit", {
        phases: [{ name: "Build", tasks: [{ content: "A", status: "completed" }] }],
      });
      clock.advance(2_000);
      await Promise.resolve();
      await hook("agent_end");
      assert.equal(state(), "idle");
    } else if (name === "canonical-final-turn") {
      await hook("session_start");
      await proposal();
      await hook("before_agent_start", { prompt: handoff });
      await todo();
      manager.appendCustomEntry("user_todo_edit", {
        phases: [{ name: "Build", tasks: [{ content: "A", status: "completed" }] }],
      });
      await hook("agent_end");
      clock.advance(2_000);
      const peer = await connect();
      assert.equal((await peer.snapshot()).runs.at(-1)?.nodes[0]?.state, "done");
      const entry = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY);
      assert(entry?.type === "custom");
      const data = entry.data;
      assert(data && typeof data === "object" && "state" in data);
      assert.equal(data.state, "idle");
    } else if (name === "stale-approval") {
      await hook("session_start");
      await proposal();
      const oldApproval = { role: "developer", attribution: "agent", synthetic: true, content: handoff, timestamp: Date.now() };
      await hook("context", { messages: [oldApproval] });
      await todo();
      await todo("done", [{ name: "Build", tasks: [{ content: "A", status: "completed" }] }]);
      await hook("agent_end");
      await proposal();
      await hook("context", { messages: [oldApproval] });
      const state = () => {
        const entry = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY);
        assert(entry?.type === "custom");
        const data = entry.data;
        assert(data && typeof data === "object" && "state" in data);
        return data.state;
      };
      assert.equal(state(), "proposed");
      const newApproval = { ...oldApproval, timestamp: Date.now() + 1 };
      await hook("context", { messages: [oldApproval, newApproval] });
      assert.equal(state(), "executing");
    } else if (name === "atlas") {
      await configure({ displayTiming: "atlas-only" });
      await hook("session_start");
      await todo("init", [{ name: "Atlas tasks", tasks: [{ content: "Mirror", status: "in_progress" }] }]);
      assert.equal(splits(), 0);
      const atlas = {
        v: 1,
        sessionId: manager.getSessionId(),
        plan: { id: "approved", name: "Atlas", planFilePath: "plan.md", cwd },
        status: "running",
        done: 0,
        total: 1,
        rows: [
          { id: "T1", title: "Atlas real row", kind: "task", agent: "task", status: "in_progress", dependsOn: [], updatedAt: Date.now() },
        ],
        live: {},
        timeline: [],
        at: Date.now(),
      };
      bus.emit("atlas:snapshot", { ...atlas, sessionId: "foreign" });
      await hook("agent_end", { willContinue: true });
      assert.equal(splits(), 0);
      bus.emit("atlas:snapshot", atlas);
      await eventually(() => splits() === 1);
      const peer = await connect();
      const snapshot = await peer.snapshot();
      assert.deepEqual(
        snapshot.runs.map((run) => run.source),
        ["atlas"],
      );
      assert(snapshot.atlasAvailable);
      bus.emit("atlas:released", { v: 1, sessionId: manager.getSessionId(), planId: "approved", reason: "exit" });
      await eventually(async () => (await peer.snapshot()).runs.some((run) => run.source === "todo"));
      bus.emit("atlas:snapshot", atlas);
      await hook("agent_end", { willContinue: true });
      const before = hellos;
      await configure({ atlasIntegration: false });
      await command("open");
      assert((await peer.snapshot()).runs.some((run) => run.source === "todo"));
      await configure({ atlasIntegration: true });
      await command("open");
      assert(hellos >= before + 2);
      for (const timing of ["plan-execution", "any-todo"] as const) {
        await command("close");
        await configure({ displayTiming: timing });
        bus.emit("atlas:snapshot", { ...atlas, plan: { ...atlas.plan, id: timing } });
        const count = splits();
        await eventually(() => splits() > count);
      }
    } else if (name === "atlas-release-dismissal") {
      const atlas = (planId: string) => ({
        v: 1,
        sessionId: manager.getSessionId(),
        plan: { id: planId, name: "Atlas", planFilePath: "local://approved.md", cwd },
        status: "running",
        done: 0,
        total: 1,
        rows: [{ id: "T1", title: "Row", kind: "task", agent: "task", status: "in_progress", dependsOn: [], updatedAt: Date.now() }],
        live: {},
        timeline: [],
        at: Date.now(),
      });
      const mirror = (status: "in_progress" | "completed") => [{ name: "Atlas tasks", tasks: [{ content: "T1", status }] }];
      const planState = () => {
        const entry = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === PLAN_EXECUTION_ENTRY);
        assert(entry?.type === "custom");
        const data = entry.data;
        assert(data && typeof data === "object" && "state" in data);
        return data.state;
      };
      for (const timing of ["plan-execution", "any-todo"] as const) {
        await configure({ displayTiming: timing });
        await hook("session_start");
        await proposal();
        await hook("before_agent_start", { prompt: handoff });
        bus.emit("atlas:snapshot", atlas(timing));
        await todo("init", mirror("in_progress"));
        await hook("agent_end", { willContinue: true });
        const opened = splits();
        assert(paneIds.has(`owned-${opened}`), "Atlas opens the pane");
        await command("close");
        await todo("update", mirror("completed"));
        bus.emit("atlas:released", { v: 1, sessionId: manager.getSessionId(), planId: timing, reason: "exit" });
        await hook("agent_end");
        const peer = await connect();
        assert(
          (await peer.snapshot()).runs.some((run) => run.source === "todo"),
          "released mirror list becomes visible",
        );
        assert.equal(splits(), opened, `${timing}: released Atlas must not reopen a dismissed pane`);
        assert.equal(planState(), "idle", "releasing Atlas ends the approved plan execution");
        await todo();
        assert.equal(splits(), timing === "any-todo" ? opened + 1 : opened, "a genuinely new list keeps its timing");
        await command("close");
        manager = SessionManager.create(cwd, join(root, "sessions"));
      }
    } else if (name === "manual-dismissal") {
      await hook("session_start");
      bus.emit("task:subagent:lifecycle", { id: "solo", status: "started", agent: "task", index: 0 });
      await todo();
      assert.equal(splits(), 0); // never: only the command may open.
      await command("open");
      await command("open");
      assert.equal(splits(), 1);
      const peer = await connect();
      await configure({ displayTiming: "any-todo" });
      await command("close");
      await todo("start");
      assert.equal(splits(), 1);
      assert(JSON.parse(await readFile(join(dir(), "pane.json"), "utf8")).dismissed);
      await todo();
      assert.equal(splits(), 2);
      peer.socket.write(encodeFrame({ v: 1, seq: 3, type: "closed" }));
      await eventually(async () => JSON.parse(await readFile(join(dir(), "pane.json"), "utf8")).dismissed);
      paneIds.delete("owned-2"); // viewer q closes its own pane.
      await todo("start");
      assert.equal(splits(), 2);
      await todo();
      assert.equal(splits(), 3);
      await command(); // bare toggle closes.
      await command("toggle");
      assert.equal(splits(), 4);
      await command("nonsense");
      assert(notices.includes("Usage: /dag-pane [open|close|toggle]"));
      await command("close");
      const baseline = splits();
      // Restart/replay the same branch must not treat its existing run as a new id.
      await hook("session_start");
      await todo("start");
      assert.equal(splits(), baseline);
    } else if (name === "dismiss-switch") {
      await hook("session_start");
      await command("open");
      const peer = await connect();
      peer.socket.write(encodeFrame({ v: 1, seq: 3, type: "closed" }));
      await eventually(async () => JSON.parse(await readFile(join(dir(), "pane.json"), "utf8")).dismissed);
      paneIds.delete("owned-1");
      manager = SessionManager.create(cwd, join(root, "sessions"));
      await hook("session_switch", { reason: "new" });
      assert.equal((await peer.snapshot()).sessionId, manager.getSessionId());
      const record = JSON.parse(await readFile(join(dir(), "pane.json"), "utf8"));
      assert.equal(record.dismissed, true);
      assert.equal(record.paneId, undefined);
      assert.equal(splits(), 1);
      assert.deepEqual(warnings, []);
    } else if (name === "resume-socket") {
      await configure({ finishBehavior: "keep-open" });
      await writePane(join(dir(), "pane.json"), {
        version: 2,
        phase: "open",
        paneId: "old-owned",
        tabId: "tab",
        hostPaneId: "host",
        orientation: "landscape",
        position: "right",
        launchedAt: 1,
        dismissed: false,
        socketPath: herdrSocketPath("host", process.pid + 100),
      });
      paneIds.add("old-owned");
      await hook("session_start");
      await command("open");
      assert(!paneIds.has("old-owned"));
      assert.equal(splits(), 1);
      assert.equal(peers.length, 1);
      const peer = peers[0];
      assert(peer);
      assert.equal((await peer.snapshot()).sessionId, manager.getSessionId());
      assert.equal(JSON.parse(await readFile(join(dir(), "pane.json"), "utf8")).socketPath, herdrSocketPath("host", process.pid));
      await command("open");
      assert.equal(splits(), 1);
      assert.equal(peers.length, 1);
    } else if (name === "switch-replay") {
      await configure({ displayTiming: "any-todo" });
      await hook("session_start");
      await todo();
      const peer = await connect();
      const oldDir = dir();
      const oldSnapshot = await peer.snapshot();
      const before = peer.frames.length;
      manager = SessionManager.create(cwd, join(root, "sessions"));
      await hook("session_switch", { reason: "new" });
      await eventually(() => peer.frames.slice(before).some((frame) => frame.type === "hello"));
      const frames = peer.frames.slice(before);
      assert(frames[0]?.type === "bye" && frames[0].reason === "switch");
      assert(frames[1]?.type === "delta");
      assert(frames[2]?.type === "hello");
      assert(frames[3]?.type === "snapshot");
      const session = frames[1];
      assert(session?.type === "delta");
      const op = session.ops[0];
      assert(op?.op === "session");
      assert.equal(op.paths.snapshot, join(dir(), "snapshot.json"));
      assert.equal(op.paths.state, join(dir(), "view-state.json"));
      assert(op.generation > oldSnapshot.generation);
      assert.equal(splits(), 1);
      assert(!(await readdir(oldDir)).includes("pane.json"));
      assert.equal(JSON.parse(await readFile(join(dir(), "pane.json"), "utf8")).paneId, "owned-1");
      assert(calls.some((args) => args[1] === "rename" && args[3]?.includes(manager.getSessionId().slice(0, 8))));
      const wrapper = tools.get("todo");
      assert(wrapper);
      await wrapper.execute("edges", { op: "init", edges: [{ task: "B", after: ["A"] }] }, undefined, undefined, ctx);
      await todo();
      for (const event of ["session_branch", "session_tree"]) {
        await hook(event);
        const replayed = await peer.snapshot();
        assert.equal(replayed.runs.at(-1)?.edges.length, 1);
        assert.equal(replayed.runs.at(-1)?.nodes.length, 2);
      }
      await proposal();
      manager = SessionManager.create(cwd, join(root, "sessions"));
      await hook("session_switch", { reason: "new" });
      const beforeApproval = splits();
      await hook("before_agent_start", { prompt: "Ordinary user text" });
      assert.equal(splits(), beforeApproval);
      await hook("before_agent_start", { prompt: handoff });
      await todo();
      assert.equal((await peer.snapshot()).runs[0]?.source, "plan");
    } else if (name === "stalled-tasks") {
      Date.now = () => nativeNow() + clock.now;
      await configure({ stalledAfterSeconds: 10 });
      await hook("session_start");
      bus.emit("task:subagent:lifecycle", { id: "unlinked", status: "started", agent: "task", index: 0 });
      await todo();
      bus.emit("task:subagent:lifecycle", { id: "linked", status: "started", agent: "task", index: 0 });
      await command("open");
      const peer = await connect();
      const initial = await peer.snapshot();
      assert(initial.tasks.every((task) => task.stalled === false));
      const before = peer.frames.length;
      clock.advance(10_000);
      await Promise.resolve();
      await hook("agent_end", { willContinue: true });
      clock.advance(100);
      await eventually(() =>
        peer.frames.slice(before).some((frame) => frame.type === "delta" && frame.ops.some((op) => op.op === "task" && op.task.stalled)),
      );
      const stalled = await peer.snapshot();
      assert(stalled.tasks.every((task) => task.stalled));
      assert(stalled.runs[0]?.nodes[0]?.stalled);
      assert(stalled.tasks.find((task) => task.id === "unlinked")?.nodeId === undefined);
      bus.emit("task:subagent:progress", { progress: { id: "linked", currentTool: "read" } });
      bus.emit("task:subagent:lifecycle", { id: "unlinked", status: "completed" });
      await hook("agent_end", { willContinue: true });
      clock.advance(100);
      const active = await peer.snapshot();
      assert(active.tasks.every((task) => task.stalled === false));
      assert.equal(active.runs[0]?.nodes[0]?.stalled, false);
    } else if (name === "shutdown-paused-evaluation") {
      // Modules load in the executable child to preserve the isolated host module-loading boundary.
      const { PaneManager } = await import("../plugins/omp-herdr-dag/src/pane.ts");
      await configure({ displayTiming: "any-todo" });
      await hook("session_start");
      const reset = PaneManager.prototype.resetDismissal;
      let paused = false;
      const { promise: gate, resolve: resume } = Promise.withResolvers<void>();
      PaneManager.prototype.resetDismissal = async function () {
        paused = true;
        await gate;
        await reset.call(this);
      };
      const evaluation = todo();
      try {
        await eventually(() => paused);
        await hook("session_shutdown");
        shutdown = true;
        const before = calls.length;
        resume();
        await evaluation;
        assert.equal(calls.length, before, "paused auto-open must not issue Herdr commands after shutdown");
        assert.equal(clock.pending, 0, "shutdown must not leave heartbeat or snapshot timers");
      } finally {
        resume();
        PaneManager.prototype.resetDismissal = reset;
      }
    } else if (name === "shutdown-overall-deadline") {
      // Keep the executable child's isolated host module-loading boundary.
      const { Server } = await import("node:net");
      const { SnapshotWriter } = await import("../plugins/omp-herdr-dag/src/transport.ts");
      const listen = Server.prototype.listen;
      const flush = SnapshotWriter.prototype.flush;
      let releaseListen!: () => void;
      let pendingListen = false;
      let flushed = false;
      Server.prototype.listen = function (this: InstanceType<typeof Server>, ...args: Parameters<typeof listen>) {
        pendingListen = true;
        releaseListen = () => {
          listen.apply(this, args);
        };
        return this;
      } as typeof listen;
      SnapshotWriter.prototype.flush = async function () {
        // This integration regression measures the host's real shutdown cap, not a fake-clock delay.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 2_200);
        await promise;
        await flush.call(this);
        flushed = true;
      };
      const starting = hook("session_start");
      try {
        await eventually(() => pendingListen);
        // Release the platform listen even with the old unbounded stop, so the pre-fix failure settles.
        const releaseTimer = setTimeout(() => releaseListen(), 2_200);
        const at = Date.now();
        await hook("session_shutdown");
        shutdown = true;
        assert(Date.now() - at < 1_950, "the whole shutdown must fit within the host's two-second handler cap");
        assert.equal(clock.pending, 0);
        releaseListen();
        clearTimeout(releaseTimer);
        await starting;
        await eventually(() => flushed);
        assert.equal(clock.pending, 0, "late startup and persistence must not restart timers");
        const path = herdrSocketPath("host", process.pid);
        await eventually(async () => !(await Bun.file(path).exists()));
        const peer = new Peer(path);
        peers.push(peer);
        const { promise: refused, resolve: onRefused } = Promise.withResolvers<void>();
        peer.socket.once("error", onRefused);
        await refused;
        assert.equal(peer.frames.length, 0, "a stopped server must never accept a late viewer");
      } finally {
        Server.prototype.listen = listen;
        SnapshotWriter.prototype.flush = flush;
      }
    } else if (name === "stop-during-start") {
      // This scenario exercises the isolated child module-loading boundary.
      const { SnapshotServer } = await import("../plugins/omp-herdr-dag/src/transport.ts");
      const start = SnapshotServer.prototype.start;
      let stopping: Promise<void> | undefined;
      SnapshotServer.prototype.start = function () {
        const starting = start.call(this);
        stopping = hook("session_shutdown");
        return starting;
      };
      try {
        await hook("session_start");
        await stopping;
        shutdown = true;
      } finally {
        SnapshotServer.prototype.start = start;
      }
      assert.equal(clock.pending, 0);
      const socketPath = herdrSocketPath("host", process.pid);
      await assert.rejects(stat(socketPath), { code: "ENOENT" });
      const connectable = await new Promise<boolean>((resolve) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      });
      assert.equal(connectable, false);
    } else if (name.startsWith("shutdown-")) {
      await configure({ finishBehavior: name === "shutdown-keep" ? "keep-open" : "close-with-omp" });
      await hook("session_start");
      await command("open");
      const peer = await connect();
      hungClose = name === "shutdown-hung";
      const started = Date.now();
      await hook("session_shutdown");
      shutdown = true;
      assert(Date.now() - started < 2_000);
      await eventually(() => peer.frames.some((frame) => frame.type === "bye" && frame.reason === "shutdown"));
      assert.equal(calls.filter((args) => args[1] === "close").length, name === "shutdown-keep" ? 0 : 1);
      assert.equal(paneIds.has("owned-1"), name === "shutdown-keep" || name === "shutdown-hung");
      assert(!(await Bun.file(herdrSocketPath("host", process.pid)).exists()));
    } else if (name === "identity") {
      await hook("session_start");
      const peer = await connect();
      const snapshot = await peer.snapshot();
      console.log(
        `IDENTITY ${JSON.stringify({ pid: process.pid, socket: herdrSocketPath("host", process.pid), dir: dir(), sessionId: snapshot.sessionId })}`,
      );
    } else if (name === "v1-resume") {
      const path = join(dir(), "pane.json");
      await mkdir(dir(), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          phase: "open",
          paneId: "old-owned",
          tabId: "tab",
          hostPaneId: "host",
          orientation: "landscape",
          position: "right",
          launchedAt: 1,
          dismissed: true,
        }),
      );
      paneIds.add("old-owned");
      manager.appendCustomEntry("omp-herdr-dag:plan-execution", {
        v: 1,
        state: "executing",
        planFilePath: "local://approved.md",
        runId: `todo:${manager.getSessionId()}:1`,
        at: 1,
      });
      manager.appendCustomEntry("omp-herdr-dag:todo-edges", { v: 1, generation: 1, edges: [{ task: "B", after: ["A"] }] });
      manager.appendCustomEntry("user_todo_edit", { phases: list });
      await configure({ displayTiming: "plan-execution" });
      await hook("session_start");
      assert.equal(splits(), 0);
      const peer = await connect();
      const snapshot = await peer.snapshot();
      assert.equal(snapshot.runs[0]?.source, "plan");
      assert.equal(snapshot.runs[0]?.edges.length, 1);
      await command("open");
      assert.equal(splits(), 1); // Old v1 records have an unknown launching socket and are relaunched.
      assert(!paneIds.has("old-owned"));
      clock.advance(250);
      await eventually(async () => (await readSnapshot(join(dir(), "snapshot.json")))?.version === 2);
    } else if (name === "transport-edges") {
      const { SnapshotServer, SnapshotWriter } = await import("../plugins/omp-herdr-dag/src/transport.ts");
      await hook("session_start");
      const peer = await connect();
      const snapshot = await peer.snapshot();
      const path = join(root, "socket/stale.sock");
      await mkdir(join(root, "socket"));
      await writeFile(path, "stale socket");
      let closed = 0;
      const server = new SnapshotServer({
        socketPath: path,
        sessionId: snapshot.sessionId,
        paths: { snapshot: "s", state: "v" },
        snapshot,
        timer: clock,
        onClosed: () => {
          closed++;
        },
      });
      const stoppedClock = new Clock();
      const stoppedPath = join(root, "socket/stopped.sock");
      const stopped = new SnapshotServer({
        socketPath: stoppedPath,
        sessionId: snapshot.sessionId,
        paths: { snapshot: "s", state: "v" },
        snapshot,
        timer: stoppedClock,
      });
      const starting = stopped.start();
      await stopped.stop();
      await starting;
      assert.equal(stoppedClock.pending, 0);
      await assert.rejects(stat(stoppedPath), { code: "ENOENT" });
      const connectable = await new Promise<boolean>((resolve) => {
        const socket = createConnection(stoppedPath);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      });
      assert.equal(connectable, false);
      await server.start();
      const other = new Peer(path);
      peers.push(other);
      await other.ready();
      assert.equal((await stat(join(root, "socket"))).mode & 0o777, 0o700);
      const count = other.frames.length;
      other.socket.write('{"v":2,"seq":0,"type":"resync"}\nnot json\n{"v":1,"seq":3,"type":"res');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(other.frames.length, count);
      other.socket.write('ync"}\n');
      await eventually(() => other.frames.length > count);
      const bigTheme = { ...snapshot.theme, text: "x".repeat(140_000) };
      server.publish({ ...snapshot, theme: bigTheme }, [{ op: "theme", theme: bigTheme }]);
      server.publish({ ...snapshot, theme: bigTheme }, [{ op: "theme", theme: bigTheme }]);
      await eventually(() => other.frames.some((frame) => frame.type === "snapshot" && frame.snapshot.theme.text.length > 100_000));
      assert(!other.frames.slice(count).some((frame) => frame.type === "delta"));
      server.publish({ ...snapshot, generation: snapshot.generation + 1 });
      await eventually(() => other.frames.some((frame) => frame.type === "hello" && frame.generation > snapshot.generation));
      other.socket.write(encodeFrame({ v: 1, seq: 4, type: "closed" }));
      await eventually(() => closed === 1);
      const badPeer = new Peer(path);
      peers.push(badPeer);
      await badPeer.ready();
      badPeer.socket.write("x".repeat(1_048_577));
      await eventually(() => badPeer.socket.destroyed);
      await server.stop();
      assert(!(await Bun.file(path).exists()));
      const writer = new SnapshotWriter({ file: join(root, "recovery/snapshot.json"), timer: clock });
      writer.schedule(snapshot);
      clock.advance(249);
      assert(!(await Bun.file(join(root, "recovery/snapshot.json")).exists()));
      writer.schedule({ ...snapshot, generation: 42 });
      clock.advance(249);
      assert(!(await Bun.file(join(root, "recovery/snapshot.json")).exists()));
      clock.advance(1);
      await writer.flush();
      assert.equal((await readSnapshot(join(root, "recovery/snapshot.json")))?.generation, 42);
      let writeError: unknown;
      const brokenWriter = new SnapshotWriter({
        file: join(root, "recovery"),
        timer: clock,
        onError: (error) => {
          writeError = error;
        },
      });
      brokenWriter.schedule(snapshot); // Renaming over a directory must fail visibly.
      clock.advance(250);
      await eventually(() => writeError !== undefined);
      await assert.rejects(brokenWriter.flush());
    } else assert.fail(`Unknown scenario ${name}`);
    if (name !== "shutdown-hung") assert.deepEqual(warnings, []);
  } finally {
    Date.now = nativeNow;
    if (!shutdown) await hook("session_shutdown");
    for (const peer of peers) peer.socket.destroy();
    AgentRegistry.resetGlobalForTests();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.HERDR_DAG_EXTENSION_ROOT as string);
  console.log("HERDR_DAG_EXTENSION_OK");
} else {
  // bun:test cannot load in the executable child; this intentionally tests an isolated module-loading boundary.
  const { describe, expect, test } = await import("bun:test");
  const child = async (name: string, root: string, home = root) => {
    const processHandle = Bun.spawn([process.execPath, THIS_FILE], {
      env: { ...process.env, [CHILD_ENV]: name, HERDR_DAG_EXTENSION_ROOT: root, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("HERDR_DAG_EXTENSION_OK");
    return stdout;
  };
  describe("Herdr DAG registered extension, host sources and transport", () => {
    for (const name of [
      "non-ui",
      "rpc-no-pane",
      "rpc-herdr-env",
      "windows",
      "outside-herdr",
      "streaming",
      "plan",
      "collab-guest",
      "queued-plan",
      "canonical-final-turn",
      "stale-approval",
      "atlas",
      "atlas-release-dismissal",
      "manual-dismissal",
      "switch-replay",
      "dismiss-switch",
      "resume-socket",
      "stop-during-start",
      "shutdown-paused-evaluation",
      "shutdown-overall-deadline",
      "stalled-tasks",
      "shutdown-close",
      "shutdown-keep",
      "shutdown-hung",
      "v1-resume",
      "transport-edges",
    ]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "herdr-dag-extension-"));
        try {
          await child(name, root);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
    test("different processes in the same cwd have separate session dirs and sockets", async () => {
      const root = await mkdtemp(join(tmpdir(), "herdr-dag-isolation-"));
      try {
        const outputs = await Promise.all([child("identity", root, join(root, "home-a")), child("identity", root, join(root, "home-b"))]);
        const identities = outputs.map(
          (stdout) =>
            JSON.parse(
              stdout
                .split("\n")
                .find((line) => line.startsWith("IDENTITY "))
                ?.slice(9) ?? "null",
            ) as { pid: number; socket: string; dir: string },
        );
        assert(identities[0] && identities[1]);
        expect(identities[0].pid).not.toBe(identities[1].pid);
        expect(identities[0].socket).not.toBe(identities[1].socket);
        expect(identities[0].dir).not.toBe(identities[1].dir);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);
  });
}
