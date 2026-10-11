import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const CHILD_SCENARIO_ENV = "JUDGE_DISPATCH_HOST_JUDGE_SCENARIO";
const CHILD_OUTPUT_MARKER = "JUDGE_DISPATCH_HOST_JUDGE_RESULT:";
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_URL = pathToFileURL(join(dirname(THIS_FILE), "../plugins/judge-dispatch/src/index.ts")).href;
const HOST_KEY = ["host", "typesafe", "key"].join("-");

/** One hook-level action, replayed in order after a session's other fields; each pushes one entry to `steps`. */
type HookStep =
  | { bind: { name: string; role?: string; model?: string; op?: "clear" } }
  | { assistant: { name: string; arguments: Record<string, unknown> }[] }
  | { call: Record<string, unknown>; id: string; tool?: string }
  | { end: string; result: Record<string, unknown>; isError?: boolean }
  /**
   * The spawn key comes from `spawn.spawnKey`, or is allocated through a real session-scoped AgentOutputManager
   * as background task jobs do: for the literal `allocate` name, or for item `item` of call `from` as dispatched.
   */
  | { spawn: Record<string, unknown>; allocate?: string; from?: string; item?: number }
  | { sessionId: string }
  /** Appends entries to the active branch, or with `replace` moves to another branch holding only them. */
  | { branch: unknown[]; replace?: boolean };

interface SessionSpec {
  project: string;
  calls: number;
  bindings?: { name: string; role?: string; model?: string }[];
  clearBindings?: string[];
  description?: string;
  inputs?: Record<string, unknown>[];
  branch?: unknown[];
  spawns?: Record<string, unknown>[];
  steps?: HookStep[];
}

interface ChildScenario {
  sessions: SessionSpec[];
  response: "success" | "unauthorized" | "network-error";
  agentChoice?: string;
  hostKey?: string;
  explicitRole?: boolean;
  emptyRoleChain?: boolean;
  defaultChain?: string[];
  disabledProviders?: string[];
  modelPool?: string[];
}

interface RecordedRequest {
  authorization: string | null;
  body: string;
}

/** Results cross a JSON boundary, so a fail-open `undefined` arrives as `null`. */
interface SessionReport {
  results: unknown[];
  warnings: unknown[];
  notifications: { message: unknown; level?: unknown }[];
  usage: unknown[];
  /** Working-message calls in order; a restore (`undefined`) arrives as `null`. */
  working: unknown[];
  /** Custom message types that remain after the plugin's `context` hook, given a legacy route record plus one ordinary message. */
  modelView: unknown[];
  bindingResults: unknown[];
  spawnResults: unknown[];
  steps: unknown[];
}

interface ChildReport {
  requests: RecordedRequest[];
  sessions: SessionReport[];
}

type TestHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

/** Bundled OMP agents, so candidate discovery finds real definitions for both names. */
const TASK_DESCRIPTION = "# Available Agents\n### scout\nRead-only investigator\n### task\nGeneral-purpose agent";

function startTypeSafeServer(scenario: ChildScenario, requests: RecordedRequest[]): { origin: string; stop(): void } {
  if (scenario.response === "network-error") return { origin: "http://127.0.0.1:1", stop() {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") return new Response(null, { status: 404 });
      const body = await request.text();
      requests.push({ authorization: request.headers.get("authorization"), body });
      if (scenario.response === "unauthorized") return new Response("invalid api key", { status: 401 });

      // Controlled native answer; only offer the named choice when it is legal.
      const payload = JSON.parse(body) as { questions?: Record<string, { criteria?: Record<string, unknown> }> };
      const answers = Object.fromEntries(
        Object.entries(payload.questions ?? {}).map(([id, question]) => {
          const choices = Object.keys(question.criteria ?? {});
          const choice =
            (id === "agent" ? choices.find((name) => name === (scenario.agentChoice ?? "scout")) : choices.at(-1)) ?? choices[0] ?? "";
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(choices.map((name) => [name, name === choice ? 1 : 0])),
              confidence: 0.99,
            },
          ];
        }),
      );
      return Response.json({
        model: "system-one",
        answers,
        usage: { input_tokens: 17, output_tokens: 3 },
      });
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

async function executeChildScenario(scenario: ChildScenario): Promise<ChildReport> {
  const requests: RecordedRequest[] = [];
  const server = startTypeSafeServer(scenario, requests);
  try {
    if (scenario.hostKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = scenario.hostKey;
    if (scenario.modelPool || scenario.explicitRole) process.env.OPENAI_API_KEY = "fixture-openai-key";

    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "models.yml"), `providers:\n  typesafe:\n    baseUrl: ${server.origin}\n`);

    // The child runs outside the test runner with its own HOME, so host modules load only after isolation is in place.
    const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
    const { Settings, withActiveSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent/sdk");
    const { cfgDisabledProviders, cfgModelRoles } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
    const { cfgRetryFallbackChains } = await import("@oh-my-pi/pi-coding-agent/session/settings");
    const { AgentOutputManager } = await import("@oh-my-pi/pi-coding-agent/task/output-manager");
    const { Type } = await import("@oh-my-pi/omptype/typebox");
    const { cfgTaskAgentModelOverrides } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    // This runtime-selected absolute URL keeps the child fixture on the same plugin source as the parent checkout.
    const { default: registerJudgeDispatch } = await import(PLUGIN_URL);

    const sessionReports: SessionReport[] = [];
    for (const [sessionIndex, session] of scenario.sessions.entries()) {
      const settings = await Settings.loadIsolated({ cwd: session.project, agentDir });
      if (scenario.explicitRole) {
        cfgModelRoles.override(settings, { abliterated: "openai/gpt-5-mini", task: "openai/gpt-5" });
        cfgRetryFallbackChains.override(settings, {
          abliterated: scenario.emptyRoleChain ? [] : ["openai/gpt-5"],
          task: ["openai/gpt-5-mini"],
          ...(scenario.defaultChain ? { default: scenario.defaultChain } : {}),
        });
      }
      if (scenario.disabledProviders) cfgDisabledProviders.override(settings, scenario.disabledProviders);
      if (scenario.modelPool) cfgTaskAgentModelOverrides.override(settings, { task: scenario.modelPool, scout: scenario.modelPool });
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"), { settings });
      const handlers = new Map<string, TestHandler[]>();
      let bindingTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
      const report: SessionReport = {
        bindingResults: [],
        results: [],
        warnings: [],
        notifications: [],
        usage: [],
        working: [],
        modelView: [],
        spawnResults: [],
        steps: [],
      };
      // The host reuses one session manager across /new and /resume; a step may change its session id or branch in place.
      let sessionId = `host-judge-session-${sessionIndex}`;
      let branch: unknown[] = [...(session.branch ?? [])];

      const api = {
        typebox: { Type },
        registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) {
          bindingTool = tool;
        },
        logger: {
          warn(message: unknown, details?: unknown) {
            report.warnings.push(details === undefined ? message : [message, details]);
          },
        },
        on(event: string, handler: TestHandler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        getAllTools: () => [{ name: "task", description: session.description ?? TASK_DESCRIPTION, parameters: {}, source: "builtin" }],
        registerMessageRenderer() {},
      } as unknown as ExtensionAPI;

      const context = {
        cwd: session.project,
        ui: {
          notify(message: unknown, level?: unknown) {
            report.notifications.push({ message, level });
          },
          setWorkingMessage(message?: unknown) {
            report.working.push(message ?? null);
          },
        },
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => branch,
          getLeafId: () => `host-judge-leaf-${sessionIndex}`,
          appendModelUsage(entry: unknown) {
            report.usage.push(entry);
          },
        },
        modelRegistry: registry,
      } as unknown as ExtensionContext;

      const onlyHandler = (event: string): TestHandler => {
        const registered = handlers.get(event) ?? [];
        if (registered.length !== 1) throw new Error(`expected one ${event} handler, received ${registered.length}`);
        return (payload, ctx) => withActiveSettings(settings, () => (registered[0] as TestHandler)(payload, ctx));
      };

      registerJudgeDispatch(api);
      let bindCalls = 0;
      // The host persists every tool result on the active branch before the next tool round runs its hooks.
      const executeBind = async (params: Record<string, unknown>) => {
        if (!bindingTool) throw new Error("judge-dispatch binding tool was not registered");
        const tool = bindingTool;
        const callId = `host-judge-bind-${bindCalls++}`;
        const result = await withActiveSettings(settings, () =>
          tool.execute(callId, params, new AbortController().signal, () => {}, context),
        );
        branch.push({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "judge_dispatch_model" } });
        return result;
      };
      for (const binding of session.bindings ?? []) report.bindingResults.push(await executeBind(binding));
      for (const name of session.clearBindings ?? []) report.bindingResults.push(await executeBind({ name, op: "clear" }));

      for (let call = 0; call < session.calls; call += 1) {
        const input = session.inputs?.[call] ?? { task: "Implement the requested repository change", agent: "task" };
        report.results.push(
          await onlyHandler("tool_call")(
            {
              type: "tool_call",
              toolCallId: `host-judge-tool-${sessionIndex}-${call}`,
              toolName: "task",
              input,
            },
            context,
          ),
        );
      }
      for (const spawn of session.spawns ?? []) {
        report.spawnResults.push(
          await onlyHandler("before_subagent_spawn")({ type: "before_subagent_spawn", invocationKind: "task", ...spawn }, context),
        );
      }
      const outputManager = new AgentOutputManager(() => null);
      // Item names each call step dispatched after the plugin's rewrite, for spawn steps that follow it.
      const dispatchedNames = new Map<string, unknown[]>();
      // Each session id keeps its own branch, as the host restores a session's tree when switching back to it.
      const branches = new Map<string, unknown[]>();
      for (const step of session.steps ?? []) {
        if ("bind" in step) {
          report.steps.push(await executeBind(step.bind));
        } else if ("assistant" in step) {
          const content = step.assistant.map((call, index) => ({ type: "toolCall", id: `assistant-${index}`, ...call }));
          report.steps.push(
            await onlyHandler("assistant_message")({ type: "assistant_message", message: { role: "assistant", content } }, context),
          );
        } else if ("call" in step) {
          const result = await onlyHandler("tool_call")(
            { type: "tool_call", toolCallId: step.id, toolName: step.tool ?? "task", input: step.call },
            context,
          );
          const sent =
            result && typeof result === "object" && "input" in result && result.input && typeof result.input === "object"
              ? result.input
              : step.call;
          const items: unknown[] = "tasks" in sent && Array.isArray(sent.tasks) ? sent.tasks : [sent];
          dispatchedNames.set(
            step.id,
            items.map((item) => (item && typeof item === "object" && "name" in item ? item.name : undefined)),
          );
          report.steps.push(result);
        } else if ("end" in step) {
          const end = {
            type: "tool_execution_end",
            toolCallId: step.end,
            toolName: "task",
            result: step.result,
            isError: step.isError ?? false,
          };
          report.steps.push(await onlyHandler("tool_execution_end")(end, context));
        } else if ("spawn" in step) {
          const dispatched = step.from === undefined ? undefined : dispatchedNames.get(step.from)?.[step.item ?? 0];
          if (step.from !== undefined && typeof dispatched !== "string") throw new Error(`call ${step.from} dispatched no item name`);
          const allocated = step.allocate ?? (typeof dispatched === "string" ? dispatched.trim() : undefined);
          const spawnKey = allocated === undefined ? step.spawn.spawnKey : await outputManager.allocate(allocated);
          const result = await onlyHandler("before_subagent_spawn")(
            { type: "before_subagent_spawn", invocationKind: "task", ...step.spawn, spawnKey },
            context,
          );
          report.steps.push({ spawnKey, result: result ?? null });
        } else if ("sessionId" in step) {
          branches.set(sessionId, branch);
          sessionId = step.sessionId;
          branch = branches.get(sessionId) ?? [];
          report.steps.push(null);
        } else {
          branch = step.replace ? [...step.branch] : [...branch, ...step.branch];
          report.steps.push(null);
        }
      }
      const filtered = (await onlyHandler("context")(
        {
          type: "context",
          messages: [
            { role: "custom", customType: "other-plugin.note", content: "kept" },
            { role: "custom", customType: "wows-omp-judge-dispatch.route", content: "judge-dispatch  task → scout (0.99)" },
          ],
        },
        context,
      )) as { messages: { customType?: string }[] };
      report.modelView = filtered.messages.map((message) => message.customType);
      sessionReports.push(report);
    }

    return { requests, sessions: sessionReports };
  } finally {
    server.stop();
  }
}

async function createProject(settings: Record<string, unknown>): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "judge-dispatch-host-judge-"));
  const configDirectory = join(project, ".omp");
  await mkdir(configDirectory, { recursive: true });
  await Bun.write(join(configDirectory, "plugin-overrides.json"), JSON.stringify({ settings: { [PACKAGE_NAME]: settings } }));
  return project;
}

async function withProjects<T>(settings: Record<string, unknown>[], run: (projects: string[]) => Promise<T>): Promise<T> {
  const projects: string[] = [];
  try {
    for (const projectSettings of settings) projects.push(await createProject(projectSettings));
    return await run(projects);
  } finally {
    await Promise.all(projects.map((project) => rm(project, { recursive: true, force: true })));
  }
}

async function runIsolatedScenario(scenario: ChildScenario): Promise<ChildReport> {
  const isolationRoot = scenario.sessions[0]?.project;
  if (!isolationRoot) throw new Error("host judge scenario requires at least one session");

  const child = Bun.spawn({
    cmd: [process.execPath, THIS_FILE],
    cwd: isolationRoot,
    env: {
      HOME: isolationRoot,
      XDG_CACHE_HOME: join(isolationRoot, ".xdg-cache"),
      XDG_CONFIG_HOME: join(isolationRoot, ".xdg-config"),
      XDG_DATA_HOME: join(isolationRoot, ".xdg-data"),
      XDG_STATE_HOME: join(isolationRoot, ".xdg-state"),
      PI_CODING_AGENT_DIR: join(isolationRoot, ".agent"),
      NO_COLOR: "1",
      [CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`isolated host judge fixture exited ${exitCode}\n${stderr}\n${stdout}`);

  const resultLine = stdout.split("\n").find((line) => line.startsWith(CHILD_OUTPUT_MARKER));
  if (!resultLine) throw new Error(`isolated host judge fixture returned no result\n${stderr}\n${stdout}`);
  return JSON.parse(resultLine.slice(CHILD_OUTPUT_MARKER.length)) as ChildReport;
}

function diagnostics(report: ChildReport): string {
  return JSON.stringify({ sessions: report.sessions, bodies: report.requests.map(({ body }) => body) });
}

async function registerTests(): Promise<void> {
  // The child fixture executes this file outside Bun's test runner, so only the parent branch may load bun:test.
  const { describe, expect, setDefaultTimeout, test } = await import("bun:test");
  // Every test boots a real host in a child process; the 5s default is too tight when the suite runs in parallel.
  setDefaultTimeout(30_000);
  const namedTask = (name: string) => ({ task: `Review ${name}`, agent: "task", name });
  const taskSpawn = { agent: "task", modelRole: "task", patterns: ["openai/gpt-5"] };
  const roleSpawn = { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch explicit role @abliterated" };
  const bound = expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining("Bound task") }] });
  const refused = (text: string) =>
    expect.objectContaining({ isError: true, content: [{ type: "text", text: expect.stringContaining(text) }] });
  const blocked = (reason: string) => expect.objectContaining({ block: true, reason: expect.stringContaining(reason) });
  const prometheus = (phase: string) => [{ type: "custom", customType: "wows-omp-omo-prometheus.state", data: { phase } }];
  const blockedResult = { content: [{ type: "text", text: "Blocked by another extension" }], details: { isError: true } };
  // A bound item runs under its own name plus a unique token, which its spawn key must carry.
  const spawned = (name: string) => expect.stringMatching(new RegExp(`^${name}_jd[0-9a-f]{12}$`));
  const renamed = (name: string) => ({ input: { ...namedTask(name), name: spawned(name) } });

  describe.serial("judge-dispatch through the host judge role", () => {
    test("a native judge that is not Jev routes task calls and journals usage", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          hostKey: HOST_KEY,
        });

        expect(report.requests.map((request) => request.authorization)).toEqual([`Bearer ${HOST_KEY}`]);
        expect(report.sessions[0]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "scout" } }]);
        expect(report.sessions[0]?.usage).toEqual([expect.objectContaining({ purpose: "judge-dispatch" })]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task → scout (0.99)", level: "info" }]);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("shows a status line for every routed call and keeps legacy route records from the model", async () => {
      await withProjects([{ judgeEffort: true }, { judgeEffort: true, indicator: false }], async ([shown, hidden]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: shown as string, calls: 1 },
            { project: hidden as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        const rewritten = { input: { task: "Implement the requested repository change", agent: "scout", effort: "hi" } };
        const [visible, silent] = report.sessions;

        expect(visible?.results).toEqual([rewritten]);
        expect(visible?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(visible?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · effort default → hi (0.99)", level: "info" },
        ]);
        expect(visible?.modelView).toEqual(["other-plugin.note"]);

        expect(silent?.results).toEqual([rewritten]);
        expect(silent?.working).toEqual([]);
        expect(silent?.notifications).toEqual([]);
      });

      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
        });
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (0.99)", level: "info" }]);
      });
    });

    test("judgeEffort adds the effort question and writes the judged effort", async () => {
      await withProjects([{}, { judgeEffort: true }], async ([plain, effort]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: plain as string, calls: 1 },
            { project: effort as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });

        const askedQuestions = report.requests.map((request) => Object.keys(JSON.parse(request.body).questions ?? {}));
        expect(askedQuestions).toEqual([["agent"], ["agent", "difficulty"]]);
        expect(report.sessions[1]?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "scout", effort: "hi" } },
        ]);
      });
    });

    test("pinned models keep their selectors and names while agent and effort routing still apply", async () => {
      const modelPool = ["openai/gpt-5", "openai/gpt-5-mini"];
      const flat = { task: "Inspect the boundary", agent: "task", model: modelPool[0] };
      const batch = {
        context: "shared",
        tasks: [{ ...flat, name: "Pinned", model: modelPool }, flat],
      };
      const invalidBatch = { ...batch, model: modelPool[0] };
      const spawn = { spawnKey: "parent.Pinned", agent: "scout", patterns: [modelPool[0]] };
      await withProjects([{ selectModel: true, modelBudget: "minimum", judgeEffort: true }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: project as string, calls: 3, inputs: [flat, batch, invalidBatch], spawns: [spawn] },
            { project: project as string, calls: 1, inputs: [{ task: flat.task, agent: "task", name: "Pinned" }], spawns: [spawn] },
          ],
          response: "success",
          hostKey: HOST_KEY,
          modelPool,
        });
        expect(report.sessions[0]?.results).toEqual([
          { input: { ...flat, agent: "scout", effort: "hi" } },
          { input: { ...batch, tasks: batch.tasks.map((item) => ({ ...item, agent: "scout", effort: "hi" })) } },
          null,
        ]);
        expect(report.sessions[0]?.spawnResults).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · effort default → hi (0.99) · model pinned by call", level: "info" },
          {
            message:
              "judge-dispatch  #1 task → scout (0.99) · effort default → hi (0.99) · model pinned by call ; #2 task → scout (0.99) · effort default → hi (0.99) · model pinned by call",
            level: "info",
          },
        ]);
        expect(report.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([
          ["agent", "difficulty"],
          ["agent", "difficulty"],
          ["agent", "difficulty"],
          ["agent", "difficulty", "model"],
        ]);
        expect(report.sessions[1]?.spawnResults, diagnostics(report)).toEqual([
          expect.objectContaining({ model: [modelPool[1], modelPool[0]] }),
        ]);
      });
    });

    test("a pinned item cannot consume another pending model switch with the same name", async () => {
      const modelPool = ["openai/gpt-5", "openai/gpt-5-mini"];
      const task = { task: "Inspect the boundary", agent: "task", name: "Shared" };
      await withProjects([{ selectModel: true, modelBudget: "minimum" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 1,
              inputs: [{ context: "shared", tasks: [task, { ...task, model: modelPool[0] }] }],
              spawns: [{ spawnKey: "parent.Shared", agent: "scout", patterns: [modelPool[0]] }],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          modelPool,
        });
        expect(report.sessions[0]?.spawnResults).toEqual([null]);
      });
    });

    test("a named task uses an unrelated model role without judge model selection", async () => {
      const task = namedTask("ReviewLogic");
      const scoutSpawn = { ...taskSpawn, agent: "scout" };
      await withProjects([{ selectModel: true, modelBudget: "minimum", judgeEffort: true }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "ReviewLogic", role: "abliterated" } },
                { call: task, id: "bound" },
                { spawn: scoutSpawn, from: "bound" },
                { spawn: { ...scoutSpawn, spawnKey: "parent.ReviewLogic" } },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          modelPool: ["openai/gpt-5", "openai/gpt-5-mini"],
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          { input: { ...task, agent: "scout", effort: "hi", name: spawned("ReviewLogic") } },
          { spawnKey: spawned("ReviewLogic"), result: roleSpawn },
          { spawnKey: "parent.ReviewLogic", result: null },
        ]);
        expect(report.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent", "difficulty"]]);
        expect(report.sessions[0]?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · effort default → hi (0.99) · model bound to @abliterated", level: "info" },
        ]);
      });
    });

    test("an explicit model works without the judge and invalid or duplicate bindings do not reroute", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "One", role: "missing-role" } },
                { bind: { name: "One", role: "abliterated" } },
                { bind: { name: "One", model: "openai/gpt-5-mini" } },
                { bind: { name: "Direct", model: "openai/gpt-5-mini" } },
                { call: namedTask("One"), id: "one" },
                { call: namedTask("Direct"), id: "direct" },
                { spawn: taskSpawn, from: "one" },
                { spawn: taskSpawn, from: "direct" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          refused("missing-role"),
          bound,
          refused("already has a pending model binding"),
          bound,
          renamed("One"),
          renamed("Direct"),
          { spawnKey: spawned("One"), result: roleSpawn },
          {
            spawnKey: spawned("Direct"),
            result: { model: ["openai/gpt-5-mini"], note: "judge-dispatch explicit model openai/gpt-5-mini" },
          },
        ]);
        expect(report.requests).toEqual([]);
      });
    });

    test("duplicate and workflow-owned items cannot consume a binding, and a same-named retry waits for the bound spawn", async () => {
      await withProjects([{}], async ([project]) => {
        const item = namedTask("ReviewLogic");
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "ReviewLogic", role: "abliterated" } },
                { call: { context: "shared", tasks: [item, item] }, id: "duplicate" },
                { call: { ...item, agent: "metis" }, id: "workflow" },
                { call: item, id: "bound" },
                { call: item, id: "retry" },
                { spawn: taskSpawn, from: "bound" },
                { call: item, id: "unbound" },
                { spawn: taskSpawn, from: "unbound" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          blocked("unique"),
          blocked("workflow-owned"),
          renamed("ReviewLogic"),
          blocked("has not started"),
          { spawnKey: spawned("ReviewLogic"), result: roleSpawn },
          null,
          { spawnKey: "ReviewLogic", result: null },
        ]);
      });
    });

    test("an empty target role chain never silently inherits the old role chain", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "ReviewLogic", role: "abliterated" } },
                { call: namedTask("ReviewLogic"), id: "bound" },
                { spawn: taskSpawn, from: "bound" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          emptyRoleChain: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          renamed("ReviewLogic"),
          { spawnKey: spawned("ReviewLogic"), result: blocked("empty fallback chain") },
        ]);
      });
    });

    test("a cancelled binding can be cleared without affecting a later task of the same name", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 1,
              bindings: [{ name: "ReviewLogic", role: "abliterated" }],
              clearBindings: ["ReviewLogic"],
              inputs: [{ task: "Review the boundary", agent: "task", name: "ReviewLogic" }],
              spawns: [{ spawnKey: "parent.ReviewLogic", agent: "task", modelRole: "task", patterns: ["openai/gpt-5"] }],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.bindingResults).toEqual([
          expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining("Bound task") }] }),
          { content: [{ type: "text", text: "Cleared model binding for ReviewLogic" }] },
        ]);
        expect(report.sessions[0]?.spawnResults).toEqual([null]);
      });
    });

    test("repeated and concurrently pending bound names each reach only their own spawn", async () => {
      const modelSpawn = { model: ["openai/gpt-5-mini"], note: "judge-dispatch explicit model openai/gpt-5-mini" };
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "Scout", role: "abliterated" } },
                { call: namedTask("Scout"), id: "first" },
                { bind: { name: "Scout", model: "openai/gpt-5-mini" } },
                { call: { ...namedTask("Scout"), name: " Scout " }, id: "second" },
                { call: namedTask("Scout"), id: "early" },
                { spawn: taskSpawn, from: "second" },
                { spawn: taskSpawn, from: "first" },
                { call: namedTask("Scout"), id: "unbound" },
                { spawn: taskSpawn, from: "unbound" },
                { spawn: { ...taskSpawn, spawnKey: "parent.Scout-2" } },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          renamed("Scout"),
          bound,
          renamed("Scout"),
          blocked("has not started"),
          { spawnKey: spawned("Scout"), result: modelSpawn },
          { spawnKey: spawned("Scout"), result: roleSpawn },
          null,
          { spawnKey: "Scout", result: null },
          { spawnKey: "parent.Scout-2", result: null },
        ]);
      });
    });

    test("a binding and its task in one tool round are refused in either order without poisoning later rounds", async () => {
      const writeBind = { path: "xd://judge_dispatch_model", content: JSON.stringify({ name: "R2", model: "openai/gpt-5-mini" }) };
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                {
                  assistant: [
                    { name: "task", arguments: namedTask("R1") },
                    { name: "judge_dispatch_model", arguments: { name: "R1", role: "abliterated" } },
                  ],
                },
                { call: namedTask("R1"), id: "same-round" },
                { call: { name: "R1", role: "abliterated" }, id: "bind", tool: "judge_dispatch_model" },
                { bind: { name: "R1", role: "abliterated" } },
                { end: "same-round", result: blockedResult, isError: true },
                { assistant: [{ name: "task", arguments: namedTask("R1") }] },
                { call: namedTask("R1"), id: "next-round" },
                { spawn: taskSpawn, from: "next-round" },
              ],
            },
            {
              project: project as string,
              calls: 0,
              steps: [
                {
                  assistant: [
                    { name: "write", arguments: writeBind },
                    { name: "task", arguments: namedTask("R2") },
                  ],
                },
                { call: writeBind, id: "device", tool: "write" },
                { call: namedTask("R2"), id: "same-round" },
              ],
            },
            {
              // A recovered message reaches dispatch without the assistant message hook.
              project: project as string,
              calls: 0,
              steps: [
                { call: { name: "R3", role: "abliterated" }, id: "bind", tool: "judge_dispatch_model" },
                { call: namedTask("R3"), id: "after-bind" },
                { call: namedTask("R4"), id: "before-bind" },
                { bind: { name: "R4", role: "abliterated" } },
                { spawn: taskSpawn, allocate: "R4" },
                { assistant: [] },
                { call: namedTask("R3"), id: "next-round" },
                { bind: { name: "R4", role: "abliterated" } },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        const [ordered, device, recovered] = report.sessions;
        expect(ordered?.steps, diagnostics(report)).toEqual([
          null,
          blocked("later tool round"),
          null,
          bound,
          null,
          null,
          renamed("R1"),
          { spawnKey: spawned("R1"), result: roleSpawn },
        ]);
        expect(device?.steps).toEqual([null, null, blocked("later tool round")]);
        expect(recovered?.steps).toEqual([
          null,
          blocked("later tool round"),
          null,
          refused("already dispatched in this tool round"),
          { spawnKey: "R4", result: null },
          null,
          null,
          bound,
        ]);
      });
    });

    test("session switches keep each session's bindings, background claims survive them, and other branches cannot use a binding", async () => {
      const preflightFailure = {
        content: [{ type: "text", text: "Task execution failed: Unknown agent" }],
        details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
      };
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "R1", role: "abliterated" } },
                { bind: { name: "R2", role: "abliterated" } },
                { bind: { name: "R3", role: "abliterated" } },
                { call: namedTask("R2"), id: "background" },
                { call: namedTask("R3"), id: "settled" },
                { sessionId: "host-judge-session-next" },
                { call: namedTask("R1"), id: "other-session" },
                { spawn: taskSpawn, from: "background" },
                { end: "settled", result: preflightFailure },
                { assistant: [] },
                { bind: { name: "R3", role: "abliterated" } },
                { call: namedTask("R3"), id: "next-session" },
                { spawn: taskSpawn, from: "next-session" },
                { sessionId: "host-judge-session-0" },
                { assistant: [] },
                { call: namedTask("R1"), id: "returned" },
                { bind: { name: "R3", role: "abliterated" } },
                { spawn: taskSpawn, from: "settled" },
                { spawn: taskSpawn, from: "returned" },
              ],
            },
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "X", role: "abliterated" } },
                { branch: [], replace: true },
                { call: namedTask("X"), id: "other-branch" },
                { bind: { name: "X", role: "abliterated" } },
                { call: namedTask("X"), id: "this-branch" },
                { spawn: taskSpawn, from: "this-branch" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        const [switched, branched] = report.sessions;
        expect(switched?.steps, diagnostics(report)).toEqual([
          bound,
          bound,
          bound,
          renamed("R2"),
          renamed("R3"),
          null,
          null,
          { spawnKey: spawned("R2"), result: roleSpawn },
          null,
          null,
          bound,
          renamed("R3"),
          { spawnKey: spawned("R3"), result: roleSpawn },
          null,
          null,
          renamed("R1"),
          refused("already has a pending model binding"),
          { spawnKey: spawned("R3"), result: null },
          { spawnKey: spawned("R1"), result: roleSpawn },
        ]);
        expect(branched?.steps).toEqual([
          bound,
          null,
          blocked("another branch"),
          bound,
          renamed("X"),
          { spawnKey: spawned("X"), result: roleSpawn },
        ]);
      });
    });

    test("an unspawned claim returns when its call settles, stays with a background job, and blocks an unbound retry", async () => {
      const preflightFailure = {
        content: [{ type: "text", text: "Task execution failed: Unknown agent" }],
        details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
      };
      const backgroundJob = {
        content: [{ type: "text", text: "Spawned agent R1" }],
        details: { projectAgentsDir: null, results: [], totalDurationMs: 0, async: { state: "running", jobId: "R1", type: "task" } },
      };
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "R1", role: "abliterated" } },
                { call: namedTask("R1"), id: "preflight" },
                { end: "preflight", result: preflightFailure },
                { bind: { name: "R1", role: "abliterated" } },
                { call: namedTask("R1"), id: "background" },
                { end: "background", result: backgroundJob },
                { bind: { name: "R1", op: "clear" } },
                { call: namedTask("R1"), id: "retry" },
                { bind: { name: "R1", role: "abliterated" } },
                { call: namedTask("R1"), id: "rebound" },
                { spawn: taskSpawn, from: "preflight" },
                { spawn: taskSpawn, from: "background" },
                { spawn: taskSpawn, from: "rebound" },
                { call: namedTask("R1"), id: "unbound" },
                { spawn: taskSpawn, from: "unbound" },
                { bind: { name: "R2", role: "abliterated" } },
                { call: namedTask("R2"), id: "blocked" },
                { end: "blocked", result: blockedResult, isError: true },
                { spawn: taskSpawn, from: "blocked" },
                { call: namedTask("R2"), id: "after-block" },
                { spawn: taskSpawn, from: "after-block" },
                { bind: { name: "R2", op: "clear" } },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          renamed("R1"),
          null,
          refused("already has a pending model binding"),
          renamed("R1"),
          null,
          {
            content: [
              {
                type: "text",
                text: "No model binding pending for R1; the task already dispatched with it has not started and keeps its explicit model when it starts. If that task failed or was cancelled, bind R1 again",
              },
            ],
          },
          blocked("has not started"),
          bound,
          renamed("R1"),
          { spawnKey: spawned("R1"), result: null },
          { spawnKey: spawned("R1"), result: roleSpawn },
          { spawnKey: spawned("R1"), result: roleSpawn },
          null,
          { spawnKey: "R1", result: null },
          bound,
          renamed("R2"),
          null,
          { spawnKey: spawned("R2"), result: null },
          renamed("R2"),
          { spawnKey: spawned("R2"), result: roleSpawn },
          { content: [{ type: "text", text: "No model binding pending for R2" }] },
        ]);
      });
    });

    test("unreadable task shapes cannot take a binding, and look-alike names never reach a claim", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "X", role: "abliterated" } },
                { call: namedTask("X-2"), id: "literal" },
                { call: { context: "", tasks: [namedTask("X")] }, id: "empty-context" },
                { call: { context: "shared", model: "openai/gpt-5", tasks: [{ ...namedTask("X"), name: " X " }] }, id: "top-level-model" },
                { call: { context: "shared", tasks: [namedTask("X"), namedTask("X")] }, id: "duplicate" },
                { call: namedTask("X"), id: "bound" },
                { spawn: taskSpawn, from: "literal" },
                { spawn: taskSpawn, allocate: "X" },
                { spawn: taskSpawn, from: "bound" },
                { assistant: [] },
                { bind: { name: "X-2", role: "abliterated" } },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          null,
          blocked("cannot read"),
          blocked("cannot read"),
          blocked("unique"),
          renamed("X"),
          { spawnKey: "X-2", result: null },
          { spawnKey: "X", result: null },
          { spawnKey: spawned("X"), result: roleSpawn },
          null,
          bound,
        ]);
      });
    });

    test("role aliases, unresolvable concrete models, and disabled providers are refused at bind time", async () => {
      await withProjects([{}], async ([project]) => {
        const concrete = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "A", model: "pi/abliterated" } },
                { bind: { name: "A", model: "@abliterated" } },
                { bind: { name: "A", model: "openai/gpt-9-missing" } },
                { bind: { name: "A", model: "openai/gpt-5-mini" } },
                { call: namedTask("A"), id: "concrete" },
                { spawn: taskSpawn, from: "concrete" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          defaultChain: ["openai/gpt-5"],
        });
        expect(concrete.sessions[0]?.steps, diagnostics(concrete)).toEqual([
          refused("not a role alias"),
          refused("not a role alias"),
          refused("openai/gpt-9-missing"),
          bound,
          renamed("A"),
          {
            spawnKey: spawned("A"),
            result: { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch explicit model openai/gpt-5-mini" },
          },
        ]);

        const disabled = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [{ bind: { name: "B", model: "openai/gpt-5-mini" } }, { bind: { name: "B", role: "abliterated" } }],
            },
          ],
          response: "success",
          explicitRole: true,
          disabledProviders: ["openai"],
        });
        expect(disabled.sessions[0]?.steps, diagnostics(disabled)).toEqual([
          refused("No enabled model resolves"),
          refused("No enabled model resolves"),
        ]);
      });
    });

    test("Atlas execution neither consumes nor is blocked by pending bindings, and refuses earlier claims at spawn", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { bind: { name: "T1", role: "abliterated" } },
                { branch: prometheus("executing") },
                { call: namedTask("T1"), id: "atlas" },
                { spawn: taskSpawn, allocate: "T1" },
                { bind: { name: "T9", role: "abliterated" } },
                { branch: prometheus("idle") },
                { call: namedTask("T1"), id: "after" },
                { spawn: taskSpawn, from: "after" },
                { bind: { name: "T2", role: "abliterated" } },
                { call: namedTask("T2"), id: "before" },
                { branch: prometheus("executing") },
                { spawn: taskSpawn, from: "before" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          bound,
          null,
          null,
          { spawnKey: "T1", result: null },
          refused("Prometheus"),
          null,
          renamed("T1"),
          { spawnKey: spawned("T1"), result: roleSpawn },
          bound,
          renamed("T2"),
          null,
          { spawnKey: spawned("T2"), result: blocked("before the approved Prometheus plan") },
        ]);
      });
    });

    test("routes a bullet roster but excludes write-capable metadata from read-only requests", async () => {
      await withProjects([{}, { judgeEffort: true }], async ([ordinary, readOnly]) => {
        const description = [
          "# Available Agents",
          "- `task`: General-purpose agent",
          "- `scout` (READ-ONLY; investigation only, no edits): Research",
          "- `security-reviewer` (READ-ONLY; investigation only, no edits): Security research",
          "# Other Section",
          "- `oracle`: Not available in this task roster",
        ].join("\n");
        const report = await runIsolatedScenario({
          sessions: [
            { project: ordinary as string, calls: 1, description },
            {
              project: readOnly as string,
              calls: 1,
              description,
              inputs: [{ task: "Investigate a security issue", agent: "scout" }],
            },
          ],
          response: "success",
          agentChoice: "security-reviewer",
          hostKey: HOST_KEY,
        });

        expect(report.sessions[0]?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "security-reviewer" } },
        ]);
        expect(report.sessions[1]?.results).toEqual([{ input: { task: "Investigate a security issue", agent: "scout", effort: "hi" } }]);
        const requests = report.requests.map(
          (request) =>
            JSON.parse(request.body) as {
              state: { candidates: { name: string }[] };
              questions: Record<string, unknown>;
            },
        );
        expect(requests.map((request) => request.state.candidates.map((candidate) => candidate.name))).toEqual([
          ["task", "scout", "security-reviewer"],
          ["scout"],
        ]);
        expect(requests.map((request) => Object.keys(request.questions))).toEqual([["agent"], ["difficulty"]]);
      });
    });

    test("unknown or disabled rosters, unresolved access, and reserved sources do not change agent or effort", async () => {
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        const inputs = ["metis", "momus", "oracle", "audit-auditor", "unknown-agent"].map((agent) => ({
          agent,
          task: "Review this plan",
          effort: "lo",
        }));
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: inputs.length, inputs }],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toEqual([]);
        expect(report.sessions[0]?.results).toEqual(inputs.map(() => null));
      });
      await withProjects([{ judgeEffort: true }, { judgeEffort: true }], async ([unknown, disabled]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: unknown as string, calls: 1, description: "# Available Agents\nUnrecognized listing format" },
            { project: disabled as string, calls: 1, description: "# Available Agents\nAgent spawning is currently disabled." },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toEqual([]);
        expect(report.sessions.map((session) => session.results)).toEqual([[null], [null]]);
      });
    });

    test("active Atlas execution owns agent and effort; an idle state restores ordinary routing", async () => {
      await withProjects([{ judgeEffort: true }, { judgeEffort: true }], async ([executing, idle]) => {
        const state = (phase: string) => ({ type: "custom", customType: "wows-omp-omo-prometheus.state", data: { phase } });
        const input = {
          agent: "task",
          task: 'Implement T1\natlas_assignment: {"planSha256":"approved","rows":{"T1":"attempt"}}',
          effort: "lo",
        };
        const report = await runIsolatedScenario({
          sessions: [
            { project: executing as string, calls: 1, inputs: [input], branch: [state("planning"), state("executing")] },
            { project: idle as string, calls: 1, inputs: [input], branch: [state("executing"), state("idle")] },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[1]?.results).toEqual([{ input: { ...input, agent: "scout", effort: "hi" } }]);
      });
    });

    test("without a host credential task calls keep the requested agent and warn once per session", async () => {
      await withProjects([{}, {}], async ([first, second]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: first as string, calls: 2 },
            { project: second as string, calls: 2 },
          ],
          response: "success",
        });

        expect(report.requests).toHaveLength(0);
        for (const session of report.sessions) {
          expect(session.results).toEqual([null, null]);
          expect(session.usage).toHaveLength(0);
          expect(session.notifications.filter((notice) => notice.level === "warning")).toHaveLength(1);
          expect(session.notifications.filter((notice) => notice.level === "info")).toEqual([
            { message: "judge-dispatch  task kept (judge unavailable)", level: "info" },
            { message: "judge-dispatch  task kept (judge unavailable)", level: "info" },
          ]);
        }
      });
    });

    test("a rejected host credential fails open without the availability warning or leaking the key", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "unauthorized",
          hostKey: HOST_KEY,
        });

        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (judge failed)", level: "info" }]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(report.requests[0]?.body).not.toContain(HOST_KEY);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("a transport failure fails open without the availability warning", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "network-error",
          hostKey: HOST_KEY,
        });

        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (judge failed)", level: "info" }]);
        expect(report.sessions[0]?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });
  });
}

const childScenario = process.env[CHILD_SCENARIO_ENV];
if (childScenario !== undefined) {
  try {
    const report = await executeChildScenario(JSON.parse(childScenario) as ChildScenario);
    console.log(`${CHILD_OUTPUT_MARKER}${JSON.stringify(report)}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  await registerTests();
}
