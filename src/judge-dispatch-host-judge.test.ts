import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const CHILD_SCENARIO_ENV = "JUDGE_DISPATCH_HOST_JUDGE_SCENARIO";
const CHILD_OUTPUT_MARKER = "JUDGE_DISPATCH_HOST_JUDGE_RESULT:";
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_URL = pathToFileURL(join(dirname(THIS_FILE), "../plugins/judge-dispatch/src/index.ts")).href;
const HOST_KEY = ["host", "typesafe", "key"].join("-");

/** One hook-level action, replayed in order after a session's other fields; each pushes one entry to `steps`. */
type HookStep =
  | { call: Record<string, unknown>; id: string }
  | { end: string; result: Record<string, unknown> }
  /**
   * The spawn key comes from `spawn.spawnKey`, or is allocated through a real session-scoped AgentOutputManager
   * as background task jobs do: for the literal `allocate` name, or for item `item` of call `from` as dispatched.
   */
  | { spawn: Record<string, unknown>; allocate?: string; from?: string; item?: number }
  /** Registers a real host job that stays running until a later `finish` step. */
  | { job: string; owner?: string }
  | { finish: string; output: string; failed?: boolean }
  /** Appends entries to the active branch. */
  | { branch: unknown[] };

interface SessionSpec {
  project: string;
  calls: number;
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
  /** The difficulty the stub judge answers; the hardest offered by default. */
  difficultyChoice?: string;
  difficultyConfidence?: number;
  hostKey?: string;
  explicitRole?: boolean;
  emptyRoleChain?: boolean;
  defaultChain?: string[];
  disabledProviders?: string[];
  /** `task.agentModelOverrides` entries. */
  agentModels?: Record<string, string[]>;
  maxEffort?: string;
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
            (id === "agent"
              ? choices.find((name) => name === (scenario.agentChoice ?? "scout"))
              : (choices.find((name) => name === scenario.difficultyChoice) ?? choices.at(-1))) ??
            choices[0] ??
            "";
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(choices.map((name) => [name, name === choice ? 1 : 0])),
              confidence: id === "difficulty" ? (scenario.difficultyConfidence ?? 0.99) : 0.99,
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
    if (scenario.agentModels || scenario.explicitRole) process.env.OPENAI_API_KEY = "fixture-openai-key";

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
    const { cfgTaskAgentModelOverrides, cfgTaskMaxEffort } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async/job-manager");
    const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
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
      if (scenario.agentModels) cfgTaskAgentModelOverrides.override(settings, scenario.agentModels);
      if (scenario.maxEffort) cfgTaskMaxEffort.override(settings, scenario.maxEffort as never);
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"), { settings });
      const handlers = new Map<string, TestHandler[]>();
      const report: SessionReport = {
        results: [],
        warnings: [],
        notifications: [],
        usage: [],
        working: [],
        modelView: [],
        spawnResults: [],
        steps: [],
      };
      let branch: unknown[] = [...(session.branch ?? [])];

      const api = {
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
          getSessionId: () => `host-judge-session-${sessionIndex}`,
          getBranch: () => branch,
          getLeafId: () => `host-judge-leaf-${sessionIndex}`,
          appendModelUsage(entry: unknown) {
            report.usage.push(entry);
          },
        },
        modelRegistry: registry,
      } as unknown as ExtensionContext;

      const jobs = new AsyncJobManager({ onJobComplete() {} });
      const jobOutcomes = new Map<string, PromiseWithResolvers<string>>();
      const ownerId = `fixture-parent-${sessionIndex}`;
      jobs.registerDeliverySink(ownerId, () => {});
      if (session.steps?.some((step) => "job" in step)) {
        AgentRegistry.global().register({
          id: ownerId,
          displayName: ownerId,
          kind: "main",
          session: { sessionManager: context.sessionManager, asyncJobManager: jobs, getSessionAgents: () => [] } as unknown as AgentSession,
        });
      }

      const onlyHandler = (event: string): TestHandler => {
        const registered = handlers.get(event) ?? [];
        if (registered.length !== 1) throw new Error(`expected one ${event} handler, received ${registered.length}`);
        return (payload, ctx) => withActiveSettings(settings, () => (registered[0] as TestHandler)(payload, ctx));
      };

      registerJudgeDispatch(api);

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
      for (const step of session.steps ?? []) {
        if ("call" in step) {
          const result = await onlyHandler("tool_call")(
            { type: "tool_call", toolCallId: step.id, toolName: "task", input: step.call },
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
          const end = { type: "tool_execution_end", toolCallId: step.end, toolName: "task", result: step.result, isError: false };
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
        } else if ("job" in step) {
          const outcome = Promise.withResolvers<string>();
          const jobId = jobs.register("task", step.job, () => outcome.promise, {
            id: step.job,
            agentId: step.job,
            ownerId: step.owner ?? ownerId,
          });
          jobOutcomes.set(jobId, outcome);
          report.steps.push(null);
        } else if ("finish" in step) {
          const outcome = jobOutcomes.get(step.finish);
          if (!outcome) throw new Error(`no background job ${step.finish}`);
          if (step.failed) outcome.reject(new Error(step.output));
          else outcome.resolve(step.output);
          await jobs.getJob(step.finish)?.promise;
          report.steps.push(null);
        } else {
          branch = [...branch, ...step.branch];
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
      AgentRegistry.global().unregister(ownerId);
      await jobs.dispose();
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
  const pinnedTask = (name: string, agent: string) => ({ task: `Review ${name}`, agent, name });
  const taskSpawn = { agent: "task", modelRole: "task", patterns: ["openai/gpt-5"] };
  const roleSpawn = { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch pinned role @abliterated" };
  const modelSpawn = { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch pinned model openai/gpt-5-mini" };
  const blocked = (reason: string) => ({ block: true, reason: expect.stringContaining(reason) });
  const lost = blocked("its pin is no longer known to judge-dispatch");
  const prometheus = (phase: string) => [{ type: "custom", customType: "wows-omp-omo-prometheus.state", data: { phase } }];
  // A pinned item runs under its own name (or agent) plus a unique token, which its spawn key must carry.
  const spawned = (name: string) => expect.stringMatching(new RegExp(`^${name}_jd[0-9a-f]{12}$`));
  // Pinned results also tell the parent model how its pinned items were renamed.
  const pinNotice = expect.stringContaining("judge-dispatch rewrote the pinned items of this task call");
  const dispatchedPin = (name: string) => ({
    input: { ...pinnedTask(name, "task"), name: spawned(name) },
    additionalContext: pinNotice,
  });

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
        const rewritten = { input: { task: "Implement the requested repository change", agent: "scout" } };
        const [visible, silent] = report.sessions;

        expect(visible?.results).toEqual([rewritten]);
        expect(visible?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(visible?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · difficulty demanding (0.99)", level: "info" },
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

    test("judgeEffort adds the difficulty question but never writes task effort", async () => {
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
        expect(report.sessions[1]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "scout" } }]);
      });
    });

    test("the caller's solutionSpace reaches the judgment for flat calls and batch items", async () => {
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        const inputs = [
          { task: "Fix the flaky test", agent: "task", solutionSpace: "cause open, no repro" },
          {
            context: "Shared release constraints",
            tasks: [
              { task: "Rename the helper", agent: "task", solutionSpace: "one fix: rename, names given" },
              { task: "Sketch the migration", agent: "task" },
            ],
          },
        ];
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: inputs.length, inputs }],
          response: "success",
          hostKey: HOST_KEY,
        });
        const bodies = report.requests.map(
          (request) =>
            JSON.parse(request.body) as { state: { solutionSpace?: string }; questions: { difficulty?: { instructions?: string } } },
        );
        expect(bodies.map((body) => body.state.solutionSpace)).toEqual(["cause open, no repro", "one fix: rename, names given", undefined]);
        expect(bodies[0]?.questions.difficulty?.instructions).toContain("solutionSpace");
      });
    });

    test("judgeEffort steps the spawn's thinking level from the level its agent would use", async () => {
      const named = (name: string, extra: Record<string, unknown> = {}) => ({
        task: `Implement ${name}`,
        agent: "task",
        name,
        ...extra,
      });
      const scoutSpawn = { agent: "scout", patterns: ["openai/gpt-5"] };
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        // scout runs at its frontmatter level (medium); the task agent's selector carries its own level.
        const routed = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: named("Deep"), id: "deep" },
                { spawn: scoutSpawn, from: "deep" },
                { call: named("Moved"), id: "moved" },
                { spawn: { ...scoutSpawn, patterns: ["openai/gpt-5-mini"] }, from: "moved" },
                { call: named("Chosen", { effort: "lo" }), id: "chosen" },
                { spawn: scoutSpawn, from: "chosen" },
                { call: { task: "Implement Unnamed", agent: "task" }, id: "unnamed" },
                { spawn: scoutSpawn, from: "unnamed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5:low"] },
        });
        const step = { model: ["openai/gpt-5:high"], note: "judge-dispatch demanding task: thinking medium → high" };
        expect(routed.sessions[0]?.steps, diagnostics(routed)).toEqual([
          { input: { ...named("Deep"), agent: "scout" } },
          { spawnKey: "Deep", result: step },
          { input: { ...named("Moved"), agent: "scout" } },
          { spawnKey: "Moved", result: null },
          { input: { ...named("Chosen", { effort: "lo" }), agent: "scout" } },
          { spawnKey: "Chosen", result: null },
          { input: { task: "Implement Unnamed", agent: "scout", name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) } },
          { spawnKey: expect.stringMatching(/^scout-[0-9a-f]{8}$/), result: step },
        ]);
        expect(routed.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
          // An explicit effort leaves nothing for a difficulty to change, so none is asked.
          "judge-dispatch  task → scout (0.99)",
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
        ]);

        const kept = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 1,
              inputs: [named("Own")],
              spawns: [{ agent: "task", spawnKey: "Own", patterns: ["gpt-5:low", "openai/gpt-5-mini"] }],
            },
          ],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5:low"] },
        });
        expect(kept.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task kept (0.99) · thinking low → medium (0.99)",
        ]);
        expect(kept.sessions[0]?.spawnResults).toEqual([
          { model: ["gpt-5:medium", "openai/gpt-5-mini"], note: "judge-dispatch demanding task: thinking low → medium" },
        ]);

        // The task agent's own level is auto, and task.maxEffort caps read-only scout at the level it already has.
        const untouched = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 2, inputs: [named("Auto"), named("Capped", { agent: "scout" })] }],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5"] },
          maxEffort: "medium",
        });
        expect(untouched.sessions[0]?.results).toEqual([null, null]);
        expect(untouched.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task kept (0.99) · difficulty demanding (0.99)",
          "judge-dispatch  scout · difficulty demanding (0.99)",
        ]);
      });
    });

    test("model tiers swap the spawn model by difficulty, an agent's own tier first, and fail open", async () => {
      const tierSpawn = { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch demanding tier @abliterated" };
      const projects = [
        { judgeEffort: true, modelTiers: "demanding=@task,scout.demanding=@abliterated" },
        { modelTiers: "demanding=@missing-role" },
        { modelTiers: "scout.demanding=@abliterated", minimumConfidence: 0.995 },
      ];
      await withProjects(projects, async ([agentTier, missing, unsure]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: agentTier as string,
              calls: 0,
              steps: [
                { call: pinnedTask("Tiered", "task"), id: "tiered" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "tiered" },
              ],
            },
            { project: missing as string, calls: 1, inputs: [pinnedTask("Missing", "task")] },
            { project: unsure as string, calls: 1, inputs: [pinnedTask("Unsure", "task")] },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5"] },
        });
        const [tiered, failOpen, lowConfidence] = report.sessions;
        expect(tiered?.steps, diagnostics(report)).toEqual([
          { input: { ...pinnedTask("Tiered", "task"), agent: "scout" } },
          { spawnKey: "Tiered", result: tierSpawn },
        ]);
        expect(tiered?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
        expect(failOpen?.results).toEqual([{ input: { ...pinnedTask("Missing", "task"), agent: "scout" } }]);
        expect(failOpen?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 kept (tier @missing-role: unknown model role missing-role) · difficulty demanding (0.99)",
        ]);
        expect(lowConfidence?.results).toEqual([null]);
        expect(lowConfidence?.notifications.map((notice) => notice.message)).toEqual(["judge-dispatch  task kept (no confident choice)"]);
      });
    });

    test("an agent-specific tier asks difficulty only after the final agent can use it", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        const scenario: ChildScenario = {
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        };
        const kept = await runIsolatedScenario({ ...scenario, agentChoice: "task" });
        expect(kept.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent"]]);
        expect(kept.sessions[0]?.results).toEqual([null]);

        const tiered = await runIsolatedScenario(scenario);
        expect(tiered.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent"], ["difficulty"]]);
        expect(tiered.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });
    });

    test("standard work, a low-confidence difficulty, and a tier equal to the primary leave the spawn unchanged", async () => {
      await withProjects([{ modelTiers: "demanding=@abliterated" }, { modelTiers: "demanding=@task" }], async ([tier, same]) => {
        const input = pinnedTask("Keep", "scout");
        const scenario = (project: string): ChildScenario => ({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "keep" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "keep" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });
        const standard = await runIsolatedScenario({ ...scenario(tier as string), difficultyChoice: "standard" });
        const unsure = await runIsolatedScenario({ ...scenario(tier as string), difficultyConfidence: 0.5 });
        const noOp = await runIsolatedScenario(scenario(same as string));
        for (const report of [standard, unsure, noOp]) {
          expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([null, { spawnKey: "Keep", result: null }]);
        }
        expect(standard.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  scout · difficulty standard (0.99)",
        ]);
        expect(unsure.sessions[0]?.notifications.map((notice) => notice.message)).toEqual(["judge-dispatch  scout"]);
        expect(noOp.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  scout · difficulty demanding (0.99)",
        ]);
      });
    });

    test("a pinned role keeps judged agent routing but skips tiers and thinking steps", async () => {
      const task = pinnedTask("ReviewLogic", "task@abliterated");
      const scoutSpawn = { ...taskSpawn, agent: "scout" };
      await withProjects([{ judgeEffort: true, modelTiers: "demanding=@task" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: task, id: "pinned" },
                { spawn: scoutSpawn, from: "pinned" },
                { spawn: { ...scoutSpawn, spawnKey: "parent.ReviewLogic" } },
                { spawn: { ...scoutSpawn, spawnKey: "parent.ReviewLogic-2" } },
                { spawn: { ...scoutSpawn, spawnKey: "parent.Something_jd0123456789ab" } },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          {
            input: { ...task, agent: "scout", name: expect.stringMatching(/^ReviewLogic_jd[0-9a-f]{12}$/) },
            additionalContext: expect.stringMatching(
              /ReviewLogic with agent task@abliterated now runs as ReviewLogic_jd[0-9a-f]{12} on @abliterated/,
            ),
          },
          { spawnKey: spawned("ReviewLogic"), result: roleSpawn },
          { spawnKey: "parent.ReviewLogic", result: null },
          { spawnKey: "parent.ReviewLogic-2", result: null },
          { spawnKey: "parent.Something_jd0123456789ab", result: lost },
        ]);
        expect(report.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent"]]);
        expect(report.sessions[0]?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · model pinned to @abliterated", level: "info" },
        ]);
      });
    });

    test("a concrete model pin works without a judge credential and survives only an unsettled or background call", async () => {
      const unnamed = { task: "Review the boundary", agent: "task@openai/gpt-5-mini" };
      const preflightFailure = {
        content: [{ type: "text", text: "Task execution failed: Unknown agent" }],
        details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
      };
      const backgroundJob = {
        content: [{ type: "text", text: "Spawned agent task" }],
        details: { projectAgentsDir: null, results: [], totalDurationMs: 0, async: { state: "running", jobId: "task", type: "task" } },
      };
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: unnamed, id: "concrete" },
                { spawn: taskSpawn, from: "concrete" },
                { call: unnamed, id: "settled" },
                { end: "settled", result: preflightFailure },
                { spawn: taskSpawn, from: "settled" },
                { call: unnamed, id: "background" },
                { end: "background", result: backgroundJob },
                { spawn: taskSpawn, from: "background" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          defaultChain: ["openai/gpt-5"],
        });
        const dispatched = { input: { ...unnamed, agent: "task", name: spawned("task") }, additionalContext: pinNotice };
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          dispatched,
          { spawnKey: spawned("task"), result: modelSpawn },
          dispatched,
          null,
          { spawnKey: spawned("task"), result: lost },
          dispatched,
          null,
          { spawnKey: spawned("task"), result: modelSpawn },
        ]);
        expect(report.requests).toEqual([]);
      });
    });

    test("invalid pins refuse the whole call without rewriting it", async () => {
      const item = (agent: string) => ({ task: "Review the boundary", agent });
      await withProjects([{}], async ([project]) => {
        const refusals: [Record<string, unknown>, string][] = [
          [item("scout@missing-role"), "unknown model role missing-role"],
          [item("scout@openai/gpt-5,openai/gpt-5-mini"), "single provider/model selector"],
          [item("scout@pi/abliterated"), "single provider/model selector"],
          [item("scout@openai/gpt-9-missing"), "no enabled model resolves for openai/gpt-9-missing"],
          [item("metis@abliterated"), "workflow-owned agent metis"],
          [item("@abliterated"), '"@abliterated"'],
          [item("scout@"), '"scout@"'],
          [
            { context: "shared", tasks: [pinnedTask("Good", "task@abliterated"), pinnedTask("Bad", "task@missing-role")] },
            "task@missing-role: unknown model role missing-role",
          ],
          [
            pinnedTask("Review_jd0123456789ab", "task"),
            "Task name Review_jd0123456789ab ends like a model-pin spawn name, which judge-dispatch reserves; use another name",
          ],
        ];
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                ...refusals.map(([call], index) => ({ call, id: `refused-${index}` })),
                { spawn: taskSpawn, allocate: "Good" },
                { spawn: { ...taskSpawn, spawnKey: "parent.Good" } },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          ...refusals.map(([, reason]) => blocked(reason)),
          { spawnKey: "Good", result: null },
          { spawnKey: "parent.Good", result: null },
        ]);

        const disabled = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: item("scout@openai/gpt-5-mini"), id: "model" },
                { call: item("scout@abliterated"), id: "role" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          disabledProviders: ["openai"],
        });
        expect(disabled.sessions[0]?.steps, diagnostics(disabled)).toEqual([
          blocked("no enabled model resolves for openai/gpt-5-mini"),
          blocked("no enabled model resolves for @abliterated"),
        ]);
      });
    });

    test("same-named pinned items get distinct spawn names that reach only their own spawn", async () => {
      const role = pinnedTask("Twin", "task@abliterated");
      const model = pinnedTask("Twin", "task@openai/gpt-5-mini");
      const plain = pinnedTask("Twin", "task");
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: { context: "shared", tasks: [role, model, plain] }, id: "twins" },
                { spawn: taskSpawn, from: "twins", item: 1 },
                { spawn: taskSpawn, from: "twins", item: 2 },
                { spawn: taskSpawn, from: "twins", item: 0 },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          defaultChain: ["openai/gpt-5"],
        });
        const steps = report.sessions[0]?.steps ?? [];
        expect(steps, diagnostics(report)).toEqual([
          {
            input: {
              context: "shared",
              tasks: [{ ...role, agent: "task", name: spawned("Twin") }, { ...model, agent: "task", name: spawned("Twin") }, plain],
            },
            additionalContext: pinNotice,
          },
          { spawnKey: spawned("Twin"), result: modelSpawn },
          { spawnKey: "Twin", result: null },
          { spawnKey: spawned("Twin"), result: roleSpawn },
        ]);
        const keys = steps.slice(1).map((step) => (step && typeof step === "object" && "spawnKey" in step ? step.spawnKey : undefined));
        expect(new Set(keys).size).toBe(3);
      });
    });

    test("a pinned role without a fallback chain never inherits the agent's own role chain", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: pinnedTask("Empty", "task@abliterated"), id: "empty" },
                { call: pinnedTask("Chained", "task@task"), id: "chained" },
                { spawn: taskSpawn, from: "empty" },
                { spawn: taskSpawn, from: "chained" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
          emptyRoleChain: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          dispatchedPin("Empty"),
          dispatchedPin("Chained"),
          { spawnKey: spawned("Empty"), result: blocked("has no fallback chain") },
          {
            spawnKey: spawned("Chained"),
            result: { model: ["openai/gpt-5", "openai/gpt-5-mini"], note: "judge-dispatch pinned role @task" },
          },
        ]);
      });
    });

    test("Prometheus execution refuses pins at dispatch and at spawn but leaves unpinned calls alone", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { branch: prometheus("executing") },
                { call: pinnedTask("T1", "task@abliterated"), id: "pinned" },
                { call: pinnedTask("T1", "task"), id: "unpinned" },
                { branch: prometheus("idle") },
                { call: pinnedTask("T2", "task@abliterated"), id: "before" },
                { branch: prometheus("executing") },
                { spawn: taskSpawn, from: "before" },
              ],
            },
          ],
          response: "success",
          explicitRole: true,
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          null,
          blocked("cannot be pinned while an approved Prometheus plan executes"),
          null,
          null,
          dispatchedPin("T2"),
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
        expect(report.sessions[1]?.results).toEqual([null]);
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
        expect(report.sessions[1]?.results).toEqual([{ input: { ...input, agent: "scout" } }]);
      });
    });

    test("an escalated or failed lowered child raises its next same-named dispatch once, keeping the requested agent", async () => {
      const fix = { task: "Fix the deadlock", agent: "task", name: "Fix" };
      const scoutSpawn = { agent: "scout", patterns: ["openai/gpt-5"] };
      const childResult = (id: string, agent: string, output: string, failed = false) => ({
        content: [{ type: "text", text: "<task-result>" }],
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index: 0, id, agent, agentSource: "bundled", task: "", output, stderr: "", truncated: false },
              ...{ durationMs: 1, tokens: 0, requests: 1, exitCode: failed ? 1 : 0 },
              ...(failed ? { error: "child failed" } : {}),
            },
          ],
        },
      });
      const tierSpawn = (difficulty: string) => ({
        model: ["openai/gpt-5-mini", "openai/gpt-5"],
        note: `judge-dispatch ${difficulty} tier @abliterated`,
      });
      const scenario: Omit<ChildScenario, "sessions"> = {
        response: "success",
        hostKey: HOST_KEY,
        explicitRole: true,
        agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
      };

      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          ...scenario,
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: fix, id: "first" },
                { spawn: scoutSpawn, from: "first" },
                { end: "first", result: childResult("Fix", "scout", "\nESCALATE: deep-high\nThe cause is still open.") },
                { call: fix, id: "escalated" },
                { spawn: { agent: "task", patterns: ["openai/gpt-5"] }, from: "escalated" },
                { call: fix, id: "again" },
              ],
            },
          ],
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { ...fix, agent: "scout" } },
          { spawnKey: "Fix", result: tierSpawn("demanding") },
          null,
          null,
          { spawnKey: "Fix-2", result: tierSpawn("demanding") },
          { input: { ...fix, agent: "scout" } },
        ]);
        expect(report.requests).toHaveLength(2);
        expect(report.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });

      const cheap = { ...fix, name: "Cheap" };
      const plain = { ...fix, name: "Plain" };
      await withProjects([{ modelTiers: "routine=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          ...scenario,
          difficultyChoice: "routine",
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: cheap, id: "cheap" },
                { spawn: scoutSpawn, from: "cheap" },
                { end: "cheap", result: childResult("Cheap", "scout", "Could not finish.", true) },
                { call: cheap, id: "raised" },
                // A failure without a lowered spawn is not remembered.
                { call: plain, id: "plain" },
                { end: "plain", result: childResult("Plain", "scout", "Could not finish.", true) },
                { call: plain, id: "plain-again" },
              ],
            },
          ],
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { ...cheap, agent: "scout" } },
          { spawnKey: "Cheap", result: tierSpawn("routine") },
          null,
          null,
          { input: { ...plain, agent: "scout" } },
          null,
          { input: { ...plain, agent: "scout" } },
        ]);
        expect(report.requests).toHaveLength(3);
        expect(report.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · raised to standard after a failed lowered run",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });
    });

    test("escalation records keep the caller's exact names, even names ending in a number", async () => {
      const lane = (name: string) => ({ task: `Fix ${name}`, agent: "task", name });
      // OMP allocated `Lane-1-2` for the retried `Lane-1`, because an earlier `Lane-1` child still holds `Lane-1`.
      const escalated = {
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index: 0, id: "Lane-1-2", agent: "scout", agentSource: "bundled", task: "", stderr: "", truncated: false },
              ...{ output: "ESCALATE: deep-high", durationMs: 1, tokens: 0, requests: 1, exitCode: 0 },
            },
          ],
        },
      };
      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: lane("Lane-1"), id: "first" },
                { end: "first", result: escalated },
                { call: lane("Lane-2"), id: "sibling" },
                { call: lane("Lane"), id: "prefix" },
                { call: lane("Lane-1"), id: "retry" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        // Lane-1, then Lane-2 and Lane are judged normally; only the retried Lane-1 is raised.
        expect(
          report.sessions[0]?.notifications.map((notice) => notice.message),
          diagnostics(report),
        ).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
        ]);
        // Only the retry under the escalated name skips the judge.
        expect(report.requests).toHaveLength(3);
      });
    });

    test("a kept route leaves the escalation record for the next routed dispatch under that name", async () => {
      const fix = (agent: string) => ({ task: "Fix the deadlock", agent, name: "Fix" });
      const escalated = {
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index: 0, id: "Fix", agent: "scout", agentSource: "bundled", task: "", stderr: "", truncated: false },
              ...{ output: "ESCALATE: deep-high", durationMs: 1, tokens: 0, requests: 1, exitCode: 0 },
            },
          ],
        },
      };
      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: fix("task"), id: "first" },
                { end: "first", result: escalated },
                // Workflow-owned and unlisted agents keep their route, so neither may use up the record.
                { call: fix("metis"), id: "owned" },
                { call: fix("unknown-agent"), id: "unlisted" },
                { call: fix("task"), id: "retry" },
                { call: fix("task"), id: "again" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        expect(
          report.sessions[0]?.notifications.map((notice) => notice.message),
          diagnostics(report),
        ).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  metis kept (workflow-owned or unknown agent)",
          "judge-dispatch  unknown-agent kept (workflow-owned or unknown agent)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });
    });

    test("a tier naming the agent's own model at another thinking level applies that level instead of a step", async () => {
      const own = pinnedTask("Own", "scout");
      await withProjects(
        [{ modelTiers: "scout.demanding=openai/gpt-5:high" }, { judgeEffort: true, modelTiers: "scout.demanding=openai/gpt-5:high" }],
        async ([tierOnly, withSteps]) => {
          const report = await runIsolatedScenario({
            sessions: [tierOnly, withSteps].map((project) => ({
              project: project as string,
              calls: 0,
              steps: [
                { call: own, id: "own" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "own" },
              ],
            })),
            response: "success",
            hostKey: HOST_KEY,
            explicitRole: true,
            agentModels: { scout: ["openai/gpt-5"] },
          });
          const tierSpawn = { model: ["openai/gpt-5:high"], note: "judge-dispatch demanding tier openai/gpt-5:high" };
          for (const session of report.sessions) {
            // scout's own level is its frontmatter `medium`; the tier's explicit `high` must win, not be skipped or stepped.
            expect(session.steps, diagnostics(report)).toEqual([null, { spawnKey: "Own", result: tierSpawn }]);
            expect(session.notifications.map((notice) => notice.message)).toEqual([
              "judge-dispatch  scout · model openai/gpt-5 → openai/gpt-5:high (0.99)",
            ]);
          }
        },
      );
    });

    test("background jobs are remembered only at terminal settlement and only for their owning session", async () => {
      await withProjects(
        Array.from({ length: 3 }, () => ({ modelTiers: "routine=@abliterated,demanding=@abliterated" })),
        async (projects) => {
          const input = pinnedTask("Fix", "task");
          const pending = {
            details: {
              results: [],
              progress: [{ index: 0, id: "Fix", agent: "scout", status: "running" }],
              async: { state: "running", jobId: "Fix", type: "task" },
            },
          };
          const sessions = projects.map(
            (project, index): SessionSpec => ({
              project,
              calls: 0,
              steps: [
                { call: input, id: "first" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "first" },
                { job: "Fix", ...(index === 2 ? { owner: "another-session" } : {}) },
                { end: "first", result: pending },
                {
                  finish: "Fix",
                  failed: index === 1,
                  output: `<task-result id="Fix">\n<output>\n${index === 1 ? "Unable to finish." : "ESCALATE: deep-high"}\n</output>\n</task-result>`,
                },
                { call: input, id: "retry" },
              ],
            }),
          );
          const report = await runIsolatedScenario({
            sessions,
            response: "success",
            hostKey: HOST_KEY,
            explicitRole: true,
            difficultyChoice: "routine",
            agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
          });
          expect(report.requests).toHaveLength(4);
          expect(report.sessions[0]?.steps.at(-1), diagnostics(report)).toBeNull();
          expect(report.sessions[0]?.notifications.at(-1)?.message).toBe(
            "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          );
          expect(report.sessions[1]?.steps.at(-1), diagnostics(report)).toBeNull();
          expect(report.sessions[1]?.notifications.at(-1)?.message).toBe(
            "judge-dispatch  task · raised to standard after a failed lowered run",
          );
          expect(report.sessions[2]?.steps.at(-1), diagnostics(report)).toEqual({ input: { ...input, agent: "scout" } });
        },
      );
    });

    test("unknown stored settings warn once per session and a malformed modelTiers keeps every call as requested", async () => {
      await withProjects([{ legacyKnob: true }, { modelTiers: "routine=nonsense" }], async ([unknown, malformed]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: unknown as string, calls: 2 },
            { project: malformed as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        const [ignored, invalid] = report.sessions;
        expect(ignored?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "scout" } },
          { input: { task: "Implement the requested repository change", agent: "scout" } },
        ]);
        expect(ignored?.notifications.filter((notice) => notice.level === "warning")).toEqual([
          { message: expect.stringMatching(/legacyKnob.*modelTiers/), level: "warning" },
        ]);
        expect(invalid?.results).toEqual([null]);
        expect(JSON.stringify(invalid?.warnings)).toContain("invalid modelTiers entry");
        expect(report.requests).toHaveLength(2);
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
