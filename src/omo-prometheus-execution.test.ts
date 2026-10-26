import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { prompt as hostPrompt } from "@oh-my-pi/pi-utils";

import { type ExecutionLedger, type LedgerItem, ledgerRows } from "../plugins/omo-prometheus/src/ledger.ts";

const CHILD_ENV = "PROMETHEUS_EXECUTION_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
// Padded table cells and trailing spaces are rewritten by the host prompt formatter in the approval handoff.
const plan = `# Execution integrity  

| Area     | Owner |
|----------|-------|
| runtime  | T1    |


## Tasks
- [ ] T1. Implement the prerequisite
  - Agent: task
  - Depends on: none
  - Acceptance: prerequisite behavior is observed
- [ ] T2. Exercise the dependent behavior
  - Agent: task
  - Depends on: T1
  - Acceptance: dependent behavior is observed
- [ ] T3. Update independent behavior
  - Agent: task
  - Depends on: none
  - Acceptance: independent behavior is observed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;
// The host bundles this template without exporting it; render it exactly as the approval handoff does.
const planModeApprovedPrompt = await readFile(
  join(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))), "prompts/system/plan-mode-approved.md"),
  "utf8",
);
const approvedHandoff = (planFilePath: string | undefined, planContent: string) =>
  hostPrompt.render(planModeApprovedPrompt, { planFilePath, planContent, contextPreserved: false });

interface Result {
  isError?: boolean;
  content: { type: string; text?: string }[];
  details?: { outputSchema?: Record<string, unknown>; ledger?: ExecutionLedger };
}
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface RegisteredTool {
  name: string;
  execute(id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result>;
}

interface PreparedAssignment {
  item: LedgerItem;
  current: ExecutionLedger;
  toolCallId: string;
  input: Record<string, unknown>;
  /** Text of the start result, including plugin-collected F1 Git evidence. */
  startText?: string;
}

/** Real extension entry and native registry/event bus; model execution is a controlled terminal-result boundary. */
async function scenario(name: string, root: string): Promise<void> {
  // Host modules intentionally load only in the child process, after HOME and host state are isolated.
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { TASK_SUBAGENT_LIFECYCLE_CHANNEL } = await import("@oh-my-pi/pi-coding-agent/task/types");
  const { z } = await import("zod");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { cfgCycleOrder } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  const { getKnownRoleIds } = await import("@oh-my-pi/pi-coding-agent/config/model-roles");
  const settings = Settings.isolated();
  const appliedRoles: Array<{ role: string; model: string }> = [];
  const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
  const { loadOverallPlanReference } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff");
  const tuiModule = await import("@oh-my-pi/pi-tui");
  await tuiModule.initTheme();
  // `theme` is a live binding assigned by initTheme; read it afterwards, not at destructuring time.
  const hostTheme = tuiModule.theme;
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  let artifacts = join(root, "artifacts");
  await mkdir(join(artifacts, "local", "prometheus"), { recursive: true });
  await mkdir(join(root, "sessions"));
  const sourcePlanFile = join(artifacts, "local", "integrity-plan.md");
  let planFile = sourcePlanFile;
  let ledgerFile = "";
  const entries: unknown[] = [{ type: "mode_change", id: "plan-mode", mode: "plan" }];
  let hooks = new Map<string, Hook>();
  let tools = new Map<string, RegisteredTool>();
  let bus = new EventBus();
  let mode = true;
  let reference: string | undefined;
  let sequence = 0;
  let confirmations = 0;
  let confirmAnswer = true as boolean;
  const confirmTitles: string[] = [];
  let sessionId = "integrity-session";
  const notices: string[] = [];
  const menuRenders: string[] = [];
  let menuKey = "\x1b";
  const selections: Array<{ title: string; options: string[] }> = [];
  let pickOption = (options: string[]): string | undefined => options[0];
  const inputAnswers: Array<string | undefined> = [];
  let interactive = true;
  let agentKind: "main" | "sub" = "main";
  const sent: Array<{ message: { customType?: string; content?: unknown }; options: unknown }> = [];
  const sessionFiles = new Map<string, { id: string; entries: unknown[] }>();
  const completions = new Map<string, (prefix: string) => Array<{ value: string; description?: string }> | null>();
  const commands = new Map<string, (args: string, context: ExtensionContext) => Promise<void>>();
  type NativeJob = {
    id: string;
    agentId: string;
    type: "task";
    status: string;
    startTime: number;
    label: string;
    ownerId: string;
    promise: Promise<void>;
  };
  const nativeJobs: NativeJob[] = [];
  let settleNativeJob: (() => void) | undefined;
  /** Like the host job manager, a run that completes or fails settles the job promise; a cancel request alone does not. */
  const nativeJob = (agentId: string, initial: string): NativeJob => {
    const run = Promise.withResolvers<void>();
    let status = initial;
    if (initial === "completed" || initial === "failed") run.resolve();
    settleNativeJob = run.resolve;
    return {
      id: `job-${agentId}`,
      agentId,
      type: "task",
      startTime: Date.now(),
      label: agentId,
      ownerId: "Main",
      promise: run.promise,
      get status() {
        return status;
      },
      set status(next: string) {
        status = next;
        if (next === "completed" || next === "failed") run.resolve();
      },
    };
  };
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => join(root, "sessions"),
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  const localProtocolOptions = { getSessionId: () => sessionId, getArtifactsDir: () => artifacts };
  const cycledOrders: string[][] = [];
  // Ctrl+P reaches AgentSession.cycleRoleModels, a prototype method the plugin may shadow.
  const sessionPrototype = {
    cycleRoleModels: async (roleOrder: readonly string[]) => {
      cycledOrders.push([...roleOrder]);
      return undefined;
    },
  };
  let todoPhases: TodoPhase[] = [];
  const live = Object.assign(Object.create(sessionPrototype), {
    settings,
    resolveRoleModelWithThinking: (role: string) => {
      const selector = settings.getModelRole(role);
      const [provider, id] = selector?.split("/") ?? [];
      return { model: provider && id ? { provider, id } : undefined, explicitThinkingLevel: false, warning: undefined };
    },
    applyRoleModel: async (entry: { role: string; model: { provider: string; id: string } }) => {
      appliedRoles.push({ role: entry.role, model: `${entry.model.provider}/${entry.model.id}` });
    },
    sessionManager,
    getTodoPhases: () => todoPhases,
    setTodoPhases: (next: typeof todoPhases) => {
      todoPhases = next;
    },
    getPlanModeState: () => ({ enabled: mode }),
    getPlanReferencePath: () => reference,
    setPlanReferencePath: (path: string) => {
      reference = path;
    },
    asyncJobManager: { getAllJobs: ({ ownerId }: { ownerId: string }) => nativeJobs.filter((job) => job.ownerId === ownerId) },
    effectiveExtensionRoots: undefined,
    getSessionAgents: () => [],
  }) as AgentSession;
  const switchTo = async (id: string, next: unknown[], reason: "new" | "resume") => {
    sessionId = id;
    entries.splice(0, entries.length, ...next);
    await hook("session_switch", { reason });
    return { cancelled: false };
  };
  const ctx = {
    cwd: root,
    get hasUI() {
      return interactive;
    },
    mode: "tui",
    agent: {
      get kind() {
        return agentKind;
      },
      id: "Main",
    },
    sessionManager,
    newSession: async () => await switchTo(`fresh-${sequence++}`, [], "new"),
    switchSession: async (file: string) => {
      const target = sessionFiles.get(file);
      assert(target, `Unknown session file ${file}`);
      return await switchTo(target.id, structuredClone(target.entries), "resume");
    },
    getSystemPrompt: () => [],
    ui: {
      setWidget: () => {},
      notify(message: string) {
        notices.push(message);
      },
      confirm: async (title: string) => {
        confirmations += 1;
        confirmTitles.push(title);
        return confirmAnswer;
      },
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        return pickOption(options);
      },
      input: async () => inputAnswers.shift(),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (result: unknown) => void,
        ) => { render(width: number): readonly string[]; handleInput(key: string): void },
      ) =>
        await new Promise<unknown>((resolve) => {
          const component = factory({ requestRender() {} }, hostTheme, {}, resolve);
          menuRenders.push(Bun.stripANSI(component.render(120).join("\n")));
          component.handleInput(menuKey);
        }),
    },
  } as unknown as ExtensionContext;
  let activeTools = ["task", "read", "write", "atlas_ledger", "atlas_release"];
  const install = (registerExtension: typeof register = register) => {
    hooks = new Map();
    tools = new Map();
    bus = new EventBus();
    const api = {
      zod: z,
      events: bus,
      logger: { warn() {} },
      registerCommand: (
        name: string,
        spec: {
          handler: (args: string, context: ExtensionContext) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => Array<{ value: string; description?: string }> | null;
        },
      ) => {
        commands.set(name, spec.handler);
        if (spec.getArgumentCompletions) completions.set(name, spec.getArgumentCompletions);
      },
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      on: (event: string, handler: Hook) => {
        hooks.set(event, handler);
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
      getActiveTools: () => activeTools,
      setActiveTools: async () => {},
      getAllTools: () => [
        {
          name: "task",
          description:
            "# Available Agents\n- `task`: worker\n- `reviewer`: review\n- `scout` (READ-ONLY; investigation only, no edits): research",
          sourceInfo: { source: "builtin" },
        },
        { name: "write", sourceInfo: { source: "builtin" } },
        { name: "wait", sourceInfo: { source: "builtin" } },
        { name: "ask", sourceInfo: { source: "builtin" } },
        ...[...tools.values()].map((tool) => ({
          name: tool.name,
          sourceInfo: { source: "extension", path: fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url)) },
        })),
      ],
      sendMessage(message: { customType?: string; content?: unknown }, options: unknown) {
        sent.push({ message, options });
      },
      sendUserMessage() {},
    } as unknown as ExtensionAPI;
    registerExtension(api);
  };
  const main = () => AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  AgentRegistry.resetGlobalForTests();
  main();
  install();
  const hook = async (event: string, data: Record<string, unknown> = {}) => {
    const handler = hooks.get(event);
    assert(handler, `Missing ${event} hook`);
    return handler({ type: event, ...data }, ctx);
  };
  const call = async (params: Record<string, unknown>, toolName = "atlas_ledger") => {
    const tool = tools.get(toolName);
    assert(tool, `Missing ${toolName}`);
    return tool.execute(`ledger-${sequence++}`, params, undefined, undefined, ctx);
  };
  const ok = (result: Result) => {
    assert.notEqual(result.isError, true, JSON.stringify(result));
  };
  const refused = (result: Result) => {
    assert.equal(result.isError, true, JSON.stringify(result));
  };
  const ledger = async (): Promise<ExecutionLedger> => JSON.parse(await readFile(ledgerFile, "utf8"));
  const row = async (id: string): Promise<LedgerItem> => {
    const current = await ledger();
    const item = ledgerRows(current).find((item) => item.id === id);
    assert(item);
    return item;
  };
  if (name === "plan-mode-disabled") {
    // With plan.enabled off the host refuses /plan, so Prometheus must refuse instead of claiming it started.
    const { cfgPlanEnabled } = await import("@oh-my-pi/pi-coding-agent/plan-mode/settings");
    cfgPlanEnabled.override(settings, false);
    mode = false;
    const stateEntries = () =>
      entries.filter(
        (entry) =>
          typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === "wows-omp-omo-prometheus.state",
      );
    assert.deepEqual(await hook("input", { text: "/prometheus draft the rollout", source: "user" }), { handled: true });
    assert.match(notices.at(-1) ?? "", /plan mode.*turned off/);
    await commands.get("prometheus")?.("draft the rollout", ctx);
    assert.match(notices.at(-1) ?? "", /plan mode.*turned off/);
    assert.deepEqual(stateEntries(), []);
    cfgPlanEnabled.override(settings, true);
    assert.deepEqual(await hook("input", { text: "/prometheus draft the rollout", source: "user" }), { text: "/plan draft the rollout" });
    return;
  }
  if (name === "plain-plan-approval") {
    // Ordinary Plan Mode proposals never expose the atlas tier.
    reference = "local://integrity-plan.md";
    await hook("tool_result", {
      toolName: "write",
      toolCallId: "plain-proposal",
      isError: false,
      details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
      content: [{ type: "text", text: "Plan proposal submitted" }],
    });
    assert.deepEqual(cfgCycleOrder.get(settings), ["smol", "default", "slow"]);
    assert.equal(settings.getProvenance(cfgCycleOrder), "default");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    return;
  }
  const heavyPlan = plan.replace(
    "  - Acceptance: prerequisite behavior is observed",
    "  - Tier: HEAVY\n  - Acceptance: prerequisite behavior is observed",
  );
  await writeFile(
    sourcePlanFile,
    name === "cycle" ? plan.replace("Depends on: none", "Depends on: T2") : name.startsWith("heavy-") ? heavyPlan : plan,
  );
  await commands.get("prometheus")?.("", ctx);
  if (name === "review-round-limit") {
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "plugin-overrides.json"),
      JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { reviewRoundLimit: 2 } } }),
    );
    await hook("session_start");
    const review = async (agent = "momus", kind = "review_kind: routine") =>
      (await hook("tool_call", {
        toolName: "task",
        toolCallId: `review-${sequence++}`,
        input: { agent, task: `${kind}\nabsolute_plan_path: ${sourcePlanFile}\nreview_round: r${sequence}` },
      })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(await review(), undefined);
    // An Oracle consultation is not a plan-review round.
    assert.equal(await review("oracle", "Which migration order is safer?"), undefined);
    assert.equal(await review("oracle", "review_kind: high_accuracy"), undefined);
    assert.equal(selections.length, 0);
    // At the limit the user adds rounds for this plan; an invalid count is rejected and asked again.
    inputAnswers.push("zero", "1");
    assert.equal(await review(), undefined);
    assert.deepEqual(
      selections.map((selection) => selection.title),
      [2, 2].map((limit) => `Plan review has used all ${limit} rounds allowed for this plan. Raise the limit, or stop here?`),
    );
    assert.match(notices.at(-1) ?? "", /"zero" is not a positive whole number/);
    // The count and the added round survive a restart; stopping refuses the dispatch and asks for a proposal.
    await hook("session_shutdown");
    install();
    await hook("session_start");
    pickOption = (options) => options[1];
    const stopped = await review();
    assert.equal(stopped?.block, true);
    assert.match(stopped?.reason ?? "", /user stopped plan review at its limit of 3 rounds.*Propose it now as it stands/);
    pickOption = () => undefined;
    assert.match((await review())?.reason ?? "", /dismissed the review-round limit prompt/);
    interactive = false;
    assert.match((await review())?.reason ?? "", /limit of 3 rounds and no user is available/);
    interactive = true;
    // A new planning episode starts a fresh count.
    await commands.get("prometheus")?.("", ctx);
    await commands.get("prometheus")?.("", ctx);
    pickOption = (options) => options[0];
    const before = selections.length;
    assert.equal(await review(), undefined);
    assert.equal(selections.length, before);
    return;
  }
  if (name === "propose-grammar") {
    const propose = async (content: string) =>
      (await hook("tool_call", { toolName: "write", toolCallId: `propose-${sequence++}`, input: { path: "xd://propose", content } })) as
        | { block?: boolean; reason?: string }
        | undefined;
    await writeFile(join(artifacts, "local", "slices-plan.md"), "# Plan\n\n## Approach\n\n### Slice A\n");
    const refusal = await propose("slices");
    assert.equal(refusal?.block, true);
    assert.match(refusal?.reason ?? "", /Missing ## Tasks or T rows/);
    assert.equal(await propose(JSON.stringify({ title: "integrity" })), undefined);
    // An unresolvable slug is left to the host, which reports the missing plan itself.
    assert.equal(await propose("absent"), undefined);
    return;
  }
  if (name === "plan-mode-restored" || name === "plan-mode-reentered") {
    await hook("before_agent_start", { prompt: "draft the plan", systemPrompt: [] });
    // A resumed session restores plan mode by appending another `plan` entry; only an exit between them starts a new episode.
    if (name === "plan-mode-reentered") entries.push({ type: "mode_change", id: "plan-exit", mode: "none" });
    entries.push({ type: "mode_change", id: "plan-mode-again", mode: "plan" });
    await hook("session_shutdown");
    install();
    await hook("session_start");
    await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] });
    await hook("tool_result", {
      toolName: "write",
      toolCallId: "proposal",
      isError: false,
      details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "local://integrity-plan.md", planExists: true } } },
      content: [{ type: "text", text: "Plan proposal submitted" }],
    });
    // The atlas approval tier appears only for a Prometheus proposal.
    assert.equal(cfgCycleOrder.get(settings)[0] === "atlas", name === "plan-mode-restored");
    return;
  }
  mode = false;
  reference = "local://integrity-plan.md";
  await hook("tool_result", {
    toolName: "write",
    toolCallId: "proposal",
    isError: false,
    details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
    content: [
      {
        type: "text",
        text:
          name === "fresh-handoff" || name.startsWith("compact-")
            ? "Plan proposal submitted"
            : "Plan approved at local://integrity-plan.md",
      },
    ],
  });
  if (name !== "cycle" && name !== "fresh-handoff" && !name.startsWith("compact-"))
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
  if (reference?.startsWith("atlas://")) {
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
  }
  const approvalFile = () => join(dirname(planFile), "approval.json");
  const reload = async () => {
    await hook("session_shutdown");
    install();
    await hook("session_start");
  };
  if (name === "url-boundaries") {
    const approvedUrl = reference as string;
    assert.equal(InternalUrlRouter.instance().getHandler("atlas")?.spec.write, undefined);
    assert.deepEqual(InternalUrlRouter.instance().writeTier(approvedUrl, "replacement", undefined), {
      tier: "write",
      policy: "deny",
      reason: "atlas:// URLs are read-only",
    });
    await assert.rejects(
      InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        localProtocolOptions,
        sessionId: "foreign-session",
      }),
      /unavailable/,
    );
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, localProtocolOptions), { path: approvedUrl, content: plan });
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const approved = await new AtlasStore(sessionManager.getSessionDir()).find("integrity");
    const { AtlasPlanReferences } = await import("../plugins/omo-prometheus/src/atlas-plan-url.ts");
    const handler = InternalUrlRouter.instance().getHandler("atlas") as InstanceType<typeof AtlasPlanReferences>;
    const pending = handler.bind("pending-session", approved);
    handler.unbind(sessionId, approved.id);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), handler);
    await pending;
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, { getSessionId: () => "pending-session" }), {
      path: approvedUrl,
      content: plan,
    });
    await handler.bind(sessionId, approved);
    handler.unbind("pending-session", approved.id);
    assert.equal(
      await InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        sessionId: "native-child-session",
        localProtocolOptions,
        session: { localProtocolOptions } as ToolSession,
      }),
      planFile,
    );
    await assert.rejects(
      InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        sessionId: "native-child-session",
        localProtocolOptions,
      }),
      /unavailable/,
    );
    await assert.rejects(loadOverallPlanReference(approvedUrl, { getSessionId: () => "foreign-session" }), /unavailable/);
    await assert.rejects(InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from"), /unavailable/);
    for (const invalid of [approvedUrl.replace("/plan.md", "/ledger.json"), `${approvedUrl}?x=1`, `${approvedUrl}/../plan.md`]) {
      await assert.rejects(loadOverallPlanReference(invalid, localProtocolOptions));
    }
    const bundleDir = dirname(planFile);
    const movedBundle = `${bundleDir}-moved`;
    await rename(bundleDir, movedBundle);
    await symlink(movedBundle, bundleDir, "dir");
    try {
      await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions), /backing changed/);
    } finally {
      await rm(bundleDir);
      await rename(movedBundle, bundleDir);
    }
    await writeFile(planFile, `${plan}\nChanged`);
    await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions), /content changed/);
    await writeFile(planFile, plan);
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(reference, "local://integrity-plan.md");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions));
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, localProtocolOptions), { path: approvedUrl, content: plan });
    reference = "local://explicit-user-plan.md";
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(reference, "local://explicit-user-plan.md");
    const foreignHandler = {
      scheme: "atlas",
      spec: { backing: "virtual" as const, selectors: "none" as const, immutable: true },
      resolve: async () => ({ url: approvedUrl, content: "", contentType: "text/plain" as const }),
    };
    InternalUrlRouter.instance().register(foreignHandler);
    await commands.get("atlas")?.("integrity", ctx);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), foreignHandler);
    assert.equal(reference, "local://explicit-user-plan.md");
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), foreignHandler);
    InternalUrlRouter.instance().unregister("atlas");
    return;
  }
  if (name === "exit-during-url-binding") {
    await commands.get("atlas")?.("exit", ctx);
    const { AtlasPlanReferences } = await import("../plugins/omo-prometheus/src/atlas-plan-url.ts");
    const original = AtlasPlanReferences.prototype.bind;
    let entered!: () => void;
    let continueBind!: () => void;
    const atBind = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumeBind = new Promise<void>((resolve) => {
      continueBind = resolve;
    });
    AtlasPlanReferences.prototype.bind = async function (session, approved) {
      entered();
      await resumeBind;
      return original.call(this, session, approved);
    };
    try {
      const entering = commands.get("atlas")?.("integrity", ctx);
      await atBind;
      await commands.get("atlas")?.("exit", ctx);
      continueBind();
      await entering;
      assert.equal(reference, "local://integrity-plan.md");
      assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
      refused(await call({ action: "status" }));
    } finally {
      continueBind();
      AtlasPlanReferences.prototype.bind = original;
    }
    return;
  }
  if (name === "parallel-url-bindings") {
    const firstUrl = reference as string;
    const firstSession = sessionId;
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const second = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "parallel",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://parallel-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "parallel-proposal",
      availableAgents: ["task", "reviewer"],
    });
    sessionId = "parallel-session";
    entries.length = 0;
    reference = "local://PLAN.md";
    const { loadLegacyPiModule } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat");
    const loaded = (await loadLegacyPiModule(fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url)))) as {
      default: typeof register;
    };
    assert.notEqual(loaded.default, register, "the host reload must use a distinct extension module identity");
    install(loaded.default); // Native loads use distinct module identities, but share the host's router.
    await hook("session_start");
    await commands.get("atlas")?.("parallel", ctx);
    const secondUrl = reference as string;
    assert.equal(secondUrl, `atlas://${second.id}/plan.md`);
    assert.deepEqual(await loadOverallPlanReference(secondUrl, localProtocolOptions), { path: secondUrl, content: plan });
    await assert.rejects(loadOverallPlanReference(firstUrl, localProtocolOptions), /unavailable/);
    await commands.get("atlas")?.("exit", ctx);
    assert(InternalUrlRouter.instance().getHandler("atlas"), "the first Atlas session still owns its URL");
    assert.deepEqual(await loadOverallPlanReference(firstUrl, { getSessionId: () => firstSession }), {
      path: firstUrl,
      content: plan,
    });
    await assert.rejects(loadOverallPlanReference(secondUrl, localProtocolOptions), /unavailable/);
    return;
  }
  if (name === "resume-absolute-reference") {
    reference = planFile;
    await reload();
    assert(reference?.startsWith("atlas://"));
    assert.deepEqual(await loadOverallPlanReference(reference, localProtocolOptions), { path: reference, content: plan });
    ok(await call({ action: "status" }));
    return;
  }

  const prepare = async (id: string): Promise<PreparedAssignment> => {
    const result = await call({ action: "start", id });
    ok(result);
    const item = await row(id);
    const current = await ledger();
    const toolCallId = `dispatch-${sequence++}`;
    const input = {
      agent: item.dispatchAgent,
      task: `review_kind: compliance\natlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [id]: item.attempt } })}\nPerform ${item.title}; acceptance: ${item.acceptance}`,
      solutionSpace: "Known scoped assignment",
      ...(result.details?.outputSchema ? { outputSchema: result.details.outputSchema, schemaMode: "strict" } : {}),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    const startText = result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
    return { item, current, toolCallId, input, startText };
  };
  const publish = async (
    prepared: PreparedAssignment,
    childAgentId: string,
    options: {
      parentId?: string;
      status?: "running" | "idle";
      content?: string;
      observe?: boolean;
      createdAt?: number;
      nativeStatus?: string;
      finalResult?: boolean;
      finalError?: string;
      asyncStatus?: string;
      index?: number;
    } = {},
  ) => {
    const content =
      options.content ??
      (prepared.item.id.startsWith("F")
        ? JSON.stringify({
            gateId: prepared.item.id,
            planSha256: prepared.current.planSha256,
            attempt: prepared.item.attempt,
            verdict: "PASS",
            summary: "The named criteria were exercised",
            evidence: ["actual command and observed result"],
          })
        : "Implemented assigned behavior; command observed the expected result.");
    await writeFile(join(artifacts, `${childAgentId}.md`), content);
    const sessionFile = join(artifacts, `${childAgentId}.jsonl`);
    AgentRegistry.global().register({
      id: childAgentId,
      kind: "sub",
      displayName: childAgentId,
      parentId: options.parentId ?? "Main",
      session: null,
      sessionFile,
      status: options.status ?? "idle",
      createdAt: options.createdAt ?? prepared.item.startedAt ?? 0,
      history: { outputPath: join(artifacts, `${childAgentId}.md`) },
    });
    if (options.observe !== false)
      bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
        id: childAgentId,
        agent: prepared.item.dispatchAgent,
        index: options.index ?? 0,
        status: options.nativeStatus ?? "completed",
        sessionFile,
        parentToolCallId: prepared.toolCallId,
      });
    if (options.asyncStatus !== undefined) {
      nativeJobs.push(nativeJob(childAgentId, options.asyncStatus));
      await hook("tool_result", {
        toolName: "task",
        toolCallId: prepared.toolCallId,
        input: prepared.input,
        isError: false,
        details: {
          results: [],
          async: { state: "running", jobId: `job-${childAgentId}`, type: "task" },
          progress: [{ id: childAgentId, index: 0 }],
        },
        content: [{ type: "text", text: "Native task scheduled" }],
      });
    } else if (options.finalResult !== false) {
      await hook("tool_result", {
        toolName: "task",
        toolCallId: prepared.toolCallId,
        input: prepared.input,
        isError: false,
        details: { results: [{ id: childAgentId, index: 0, exitCode: 0, aborted: false, error: options.finalError }] },
        content: [{ type: "text", text: options.finalError ?? "Native task finished" }],
      });
    }
  };
  const done = (id: string, childAgentId: string) =>
    call({ action: "done", id, childAgentId, evidence: "Inspected behavior and child output" });
  const finish = async (id: string) => {
    const prepared = await prepare(id);
    const child = `Child${sequence++}`;
    await publish(prepared, child);
    ok(await done(id, child));
    return child;
  };
  const tasksDone = async () => {
    await finish("T1");
    await finish("T2");
    await finish("T3");
  };
  const gatesDone = async () => {
    await finish("F1");
    await finish("F2");
    await finish("F3");
    await finish("F4");
  };

  if (name === "atlas-autocomplete") {
    await tasksDone();
    await gatesDone();
    // A fully verified plan exits immediately, without the early-exit prompt.
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(confirmations, 0);
    refused(await call({ action: "status" }));
    // Host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const store = new AtlasStore(sessionManager.getSessionDir());
    const current = await store.create({
      name: "Current work",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://current-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "current-proposal",
      availableAgents: ["task", "reviewer"],
    });
    const foreign = join(root, "other-workspace");
    await mkdir(foreign);
    await store.create({
      name: "Foreign work",
      content: plan,
      cwd: foreign,
      sourcePlanPath: "local://foreign-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "foreign-proposal",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("", ctx);
    const complete = completions.get("atlas");
    assert(complete);
    assert.deepEqual(complete("Current"), [{ value: "Current work", label: "Current work", description: current.id }]);
    assert.deepEqual(complete(current.id.slice(0, 14)), [{ value: "Current work", label: "Current work", description: current.id }]);
    assert.equal(complete("integrity"), null);
    assert.equal(complete("Foreign"), null);
    assert.match(menuRenders.at(-1) ?? "", /Current work/);
    assert.doesNotMatch(menuRenders.at(-1) ?? "", /Foreign work/);
    menuKey = "\r";
    await commands.get("atlas")?.("", ctx);
    assert.equal(reference, `atlas://${current.id}/plan.md`);
    return;
  }

  if (name === "atlas-dispatch") {
    await commands.get("atlas")?.("exit", ctx);
    refused(await call({ action: "status" }));
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const store = new AtlasStore(sessionManager.getSessionDir());
    const work = await store.create({
      name: "Dispatch work",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://dispatch-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "dispatch-proposal",
      availableAgents: ["task", "reviewer"],
    });
    const kickoffs = () => sent.filter(({ message }) => message.customType === "wows-omp-omo-prometheus.atlas-start");
    // Enter in a session that already has a conversation asks where to run, then starts on its own.
    entries.push({ type: "message", message: { role: "user", content: "earlier question" } });
    menuKey = "\r";
    await commands.get("atlas")?.("", ctx);
    assert.deepEqual(selections.at(-1)?.options, ["Start in a new session", "Start in this session", "Cancel"]);
    assert.match(sessionId, /^fresh-/);
    assert.equal(reference, `atlas://${work.id}/plan.md`);
    ok(await call({ action: "status" }));
    assert.equal(kickoffs().length, 1);
    assert.deepEqual(sent.at(-1)?.options, { triggerTurn: true, deliverAs: "followUp" });
    const executedEntries = structuredClone(entries);
    await commands.get("atlas")?.("exit", ctx);
    refused(await call({ action: "status" }));

    // Resume lists sessions that executed the plan, newest first, and returns there without a kickoff.
    const sessionsDir = sessionManager.getSessionDir();
    const writeSession = async (id: string, modified: number) => {
      const file = join(sessionsDir, `${id}.jsonl`);
      const lines = [{ type: "title", v: 1, title: `${id} title` }, { type: "session", version: 3, id, cwd: root }, ...executedEntries];
      await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      await utimes(file, modified, modified);
      sessionFiles.set(file, { id, entries: executedEntries });
    };
    await writeSession("older-worker", 1_000_000);
    await writeSession("newer-worker", 2_000_000);
    menuKey = "R";
    await commands.get("atlas")?.("", ctx);
    const choices = selections.at(-1)?.options ?? [];
    assert.equal(choices.length, 2);
    assert.match(choices[0] ?? "", /newer-worker title/);
    assert.match(choices[1] ?? "", /older-worker title/);
    assert.equal(sessionId, "newer-worker");
    assert.equal(reference, `atlas://${work.id}/plan.md`);
    ok(await call({ action: "status" }));
    assert.equal(kickoffs().length, 1);
    assert.match(notices.at(-1) ?? "", /Atlas resumed Dispatch work/);
    return;
  }

  if (name === "cycle") {
    refused(await call({ action: "status" }));
    assert.notEqual(await hook("tool_call", { toolName: "task", toolCallId: "bad", input: { task: "implement" } }), undefined);
    assert.equal(await hook("session_stop"), undefined);
    return;
  }
  if (name === "fresh-handoff") {
    entries.length = 0;
    install();
    await hook("before_agent_start", {
      prompt: approvedHandoff(reference, plan),
      systemPrompt: [],
    });
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
    ok(await call({ action: "status" }));
    await finish("T1");
    return;
  }
  if (name === "compact-after-save-and-quit") {
    // Native "Save and quit" exits plan mode without approval and opens a new session; the proposal stays in the old one.
    const savedEntries = structuredClone(entries);
    const savedSessionId = sessionId;
    await switchTo("fresh-after-save", [], "new");
    await switchTo(savedSessionId, savedEntries, "resume");
    // Pre-prompt auto-compaction in the resumed session is not a plan approval.
    await hook("session_before_compact");
    await hook("session_compact");
    assert.equal(reference, "local://integrity-plan.md");
    refused(await call({ action: "status" }));
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    assert.equal((await new AtlasStore(sessionManager.getSessionDir()).list()).length, 0);
    return;
  }
  if (name.startsWith("compact-")) {
    const sourceReference = reference;
    await hook("session_before_compact");
    await hook("session_compact");
    const boundUrl = reference;
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
    const originalLedgerId = (await ledger()).ledgerId;
    // The host restores its source local:// reference after the session_compact callback.
    reference = name.endsWith("reference-mismatch") ? "local://unrelated-plan.md" : sourceReference;
    const inline = name.endsWith("inline-mismatch") ? `${plan}\nAltered acceptance` : plan;
    const prompt = approvedHandoff(reference, inline);
    const queued = name.startsWith("compact-queued");
    const message = {
      role: name.endsWith("user-role") ? "user" : "developer",
      content: [{ type: "text", text: prompt }],
      attribution: name.endsWith("user-attribution") ? "user" : "agent",
      synthetic: true,
      timestamp: Date.now(),
    };
    if (queued) await hook("context", { messages: [message] });
    else await hook("before_agent_start", { prompt, systemPrompt: [] });
    if (name === "compact-handoff" || name === "compact-queued-handoff") {
      ok(await call({ action: "status" }));
      ok(await call({ action: "start", id: "T1" }));
      assert.equal(reference, boundUrl);
      if (queued) {
        reference = sourceReference;
        await hook("context", { messages: [message] });
        refused(await call({ action: "status" }));
        assert.equal(reference, sourceReference, "consumed native compact handoff must not authorize a later reference overwrite");
      }
    } else {
      refused(await call({ action: "status" }));
      assert.notEqual(reference, boundUrl);
    }
    assert.equal((await ledger()).ledgerId, originalLedgerId);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    assert.equal((await new AtlasStore(sessionManager.getSessionDir()).list()).length, 1);
    return;
  }
  if (name === "resume-missing-ledger") {
    await rm(ledgerFile);
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] });
    refused(await call({ action: "status" }));
    await assert.rejects(readFile(ledgerFile), { code: "ENOENT" });
    assert.equal(await hook("session_stop"), undefined);
    return;
  }
  if (name === "resume-reference-mismatch") {
    reference = "local://other-plan.md";
    await reload();
    assert.equal(reference, "local://other-plan.md");
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "resume-invalid-approval") {
    const marker = JSON.parse(await readFile(approvalFile(), "utf8")) as Record<string, unknown>;
    marker.planSha256 = "0".repeat(64);
    await writeFile(approvalFile(), JSON.stringify(marker));
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "resume-missing-provenance") {
    const marker = JSON.parse(await readFile(approvalFile(), "utf8")) as Record<string, unknown>;
    delete marker.proposedByToolCallId;
    await writeFile(approvalFile(), JSON.stringify(marker));
    const checkpoint = entries.findLast(
      (entry) =>
        entry !== null && typeof entry === "object" && "customType" in entry && entry.customType === "wows-omp-omo-prometheus.state",
    );
    assert(checkpoint && typeof checkpoint === "object" && "data" in checkpoint && checkpoint.data && typeof checkpoint.data === "object");
    const data: Record<string, unknown> = { ...checkpoint.data };
    delete data.proposedByToolCallId;
    entries.push({ type: "custom", customType: "wows-omp-omo-prometheus.state", data });
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "concurrent") {
    const [first, independent] = await Promise.all([prepare("T1"), prepare("T3")]);
    await Promise.all([publish(first, "First"), publish(independent, "Independent")]);
    const results = await Promise.all([done("T1", "First"), done("T3", "Independent")]);
    results.forEach(ok);
    assert.equal((await row("T1")).status, "done");
    assert.equal((await row("T3")).status, "done");
    assert.equal((await row("T2")).status, "open");
    return;
  }
  if (name === "multi-row") {
    ok(await call({ action: "start", id: "T1" }));
    ok(await call({ action: "start", id: "T3" }));
    const current = await ledger();
    const first = await row("T1");
    const third = await row("T3");
    const toolCallId = "multi-row-dispatch";
    const input = {
      agent: "task",
      task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { T1: first.attempt, T3: third.attempt } })}\nImplement both independent criteria.`,
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "Combined", {
      createdAt: Math.max(first.startedAt ?? 0, third.startedAt ?? 0),
    });
    ok(await done("T1", "Combined"));
    ok(await done("T3", "Combined"));
    const second = await prepare("T2");
    refused(await done("T2", "Combined"));
    await publish(second, "Second");
    ok(await done("T2", "Second"));
    return;
  }
  if (name === "invalid-ledger") {
    for (const mutation of ["changed-plan", "corrupt", "missing"]) {
      const original = await readFile(ledgerFile, "utf8");
      if (mutation === "changed-plan") await writeFile(planFile, `${plan}\nChanged acceptance`);
      if (mutation === "corrupt") await writeFile(ledgerFile, "{broken");
      if (mutation === "missing") await rm(ledgerFile);
      refused(await call({ action: "status" }));
      refused(await call({ reason: "claim complete" }, "atlas_release"));
      assert.notEqual(await hook("tool_call", { toolName: "task", toolCallId: "blocked", input: { task: "implement" } }), undefined);
      assert.equal(await hook("session_stop"), undefined);
      assert.equal(confirmations, 0);
      await writeFile(planFile, plan);
      await writeFile(ledgerFile, original);
    }
    await hook("input", { text: "/atlas exit", source: "user" });
    assert.equal(
      await hook("tool_call", { toolName: "task", toolCallId: "outside", input: { agent: "task", task: "ordinary work" } }),
      undefined,
    );
    return;
  }
  if (name === "ordering") {
    refused(await call({ action: "start", id: "T2" }));
    refused(await call({ action: "done", id: "T1", childAgentId: "Bogus", evidence: "agent://Bogus PASS" }));
    refused(await call({ action: "start", id: "F1" }));
    await tasksDone();
    const fidelity = await prepare("F4");
    await publish(fidelity, "StaleAttempt", {
      content: JSON.stringify({
        gateId: "F4",
        planSha256: fidelity.current.planSha256,
        attempt: "stale-attempt",
        verdict: "PASS",
        summary: "claims success",
        evidence: ["report"],
      }),
    });
    refused(await done("F4", "StaleAttempt"));
    await publish(fidelity, "Fidelity");
    ok(await done("F4", "Fidelity"));
    await finish("F1");
    return;
  }
  if (name === "progress-guard") {
    activeTools = [...activeTools, "todo"];
    const refreshTodo = (op: string) =>
      hook("tool_result", {
        toolName: "todo",
        toolCallId: `todo-${sequence++}`,
        isError: false,
        content: [],
        details: { op, phases: todoPhases, storage: "session" },
      });
    const guarded = async (toolName: string, input: Record<string, unknown> = {}, toolCallId = `guarded-${sequence++}`) => {
      const result = (await hook("tool_call", { toolName, toolCallId, input })) as { reason?: string } | undefined;
      return result?.reason;
    };
    const started = await call({ action: "start", id: "T1" });
    ok(await call({ action: "start", id: "T3" }));
    const startText = started.content.map((part: { text?: string }) => part.text ?? "").join("\n");
    assert(startText.startsWith("Refresh the todo HUD now"), startText);
    assert(!startText.includes("| Acceptance |"), "a changed-row result renders the compact ledger");
    const current = await ledger();
    const bind = (item: LedgerItem) => ({
      agent: item.dispatchAgent,
      task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [item.id]: item.attempt } })}\nPerform ${item.title}`,
    });
    const [first, third] = [await row("T1"), await row("T3")];
    assert.match((await guarded("task", bind(first))) ?? "", /todo HUD/);
    assert.match((await guarded("wait")) ?? "", /todo HUD/);
    await refreshTodo("view");
    assert.match((await guarded("wait")) ?? "", /todo HUD/);
    await refreshTodo("start");
    const dispatched = [];
    for (const [item, child] of [
      [first, "FinishedFirst"],
      [third, "FinishedThird"],
    ] as const) {
      const toolCallId = `dispatch-${sequence++}`;
      const input = bind(item);
      assert.equal(await guarded("task", input, toolCallId), undefined);
      dispatched.push({ prepared: { item, current, toolCallId, input, startText }, child });
    }
    for (const { prepared, child } of dispatched) await publish(prepared, child);
    assert.match((await guarded("wait")) ?? "", /T1, T3 has a final result/);
    assert.match((await guarded("task", { agent: "scout", task: "Read the module layout" })) ?? "", /T1, T3/);
    ok(await done("T1", "FinishedFirst"));
    await refreshTodo("done");
    assert.match((await guarded("wait")) ?? "", /child of T3 has a final result/);
    assert.equal(await guarded("task", bind(third)), undefined, "a replacement child for the finished row may dispatch");
    assert.equal(await guarded("wait"), undefined);
    return;
  }
  if (name === "progress-reports") {
    const text = (result: { content: { text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n");
    assert.doesNotMatch(text(await call({ action: "start", id: "T1" })), /Progress report/, "reports are off by default");
    await mkdir(join(root, ".omp"), { recursive: true });
    await writeFile(
      join(root, ".omp", "plugin-overrides.json"),
      JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { progressReports: true } } }),
    );
    await hook("session_start");
    assert.match(text(await call({ action: "start", id: "T3" })), /write the dispatch block/);
    assert.match(text(await call({ action: "block", id: "T3", evidence: "Needs the vendor SDK" })), /write the outcome block for this row/);
    const context = (await hook("context", { messages: [] })) as { messages: { content?: unknown }[] };
    assert.match(JSON.stringify(context.messages), /<progress-reports>/);
    return;
  }
  if (name === "ask-guard") {
    const asked = async () => {
      const result = (await hook("tool_call", { toolName: "ask", toolCallId: `ask-${sequence++}`, input: { questions: [] } })) as
        | { reason?: string }
        | undefined;
      return result?.reason;
    };
    const continuation = async () => {
      const result = (await hook("session_stop")) as { additionalContext?: string } | undefined;
      return result?.additionalContext ?? "";
    };
    assert.match((await asked()) ?? "", /Atlas ask guard: .*T1 \(dispatchable\), T3 \(dispatchable\)/);
    ok(await call({ action: "start", id: "T3" }));
    ok(await call({ action: "block", id: "T1", evidence: "Which storage backend should T1 use?" }));
    assert.match((await asked()) ?? "", /T3 \(in progress\)/, "a running row keeps the session free of ask");
    assert.match(await continuation(), /Dispatch the next unblocked items/);
    ok(await call({ action: "block", id: "T3", evidence: "The user must integrate the vendor SDK" }));
    assert.equal(await asked(), undefined, "once only blocked rows and their dependents remain, ask is allowed");
    const stalled = await continuation();
    assert.match(stalled, /Nothing can move without the user/);
    assert.match(stalled, /T1: Which storage backend should T1 use\?; T3: The user must integrate the vendor SDK/);
    assert.match(stalled, /Call ask now/);
    ok(await call({ action: "reopen", id: "T3", evidence: "Integrated by the user in commit abc123" }));
    assert.match((await asked()) ?? "", /T3 \(dispatchable\)/);
    return;
  }
  if (name === "gate-fix") {
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas tasks")?.tasks[0]?.status, "pending");
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas final gates")?.tasks[0]?.status, "pending");
    await tasksDone();
    await finish("F1");
    const review = await prepare("F2");
    await publish(review, "Rejecting", {
      content: JSON.stringify({
        gateId: "F2",
        planSha256: review.current.planSha256,
        attempt: review.item.attempt,
        verdict: "FAIL",
        summary: "snapshot retention test is nondeterministic",
        evidence: ["expected 8 keys, got 10"],
      }),
    });
    refused(await done("F2", "Rejecting"));
    refused(await call({ action: "fix", id: "F2", evidence: "nondeterministic test", title: "Stabilize retention test" }));
    refused(await call({ action: "fix", id: "T2", evidence: "x", title: "x", acceptance: "x" }));
    ok(
      await call({
        action: "fix",
        id: "F2",
        evidence: "snapshot retention test is nondeterministic",
        title: "Stabilize retention test",
        acceptance: "the retention test passes on repeated runs",
      }),
    );
    assert.deepEqual(todoPhases.find((phase) => phase.name === "Atlas fixes")?.tasks, [
      { content: "X1. Stabilize retention test", status: "pending" },
    ]);
    // This host import must follow isolated HOME setup, like the other host modules above.
    const { applyOpsToPhases } = await import("@oh-my-pi/pi-coding-agent/tools/todo");
    const normalized = applyOpsToPhases(todoPhases, [{ op: "unblock", task: "X1. Stabilize retention test" }]);
    assert.deepEqual(normalized.errors, []);
    // The host keeps one running item, which rewrites some parallel Atlas row the ledger still holds elsewhere.
    assert.notDeepEqual(normalized.phases, todoPhases);
    live.setTodoPhases(normalized.phases);
    const priorWrites = entries.length;
    const correctedResult = await hook("tool_result", {
      toolName: "todo",
      toolCallId: "todo-refresh",
      isError: false,
      content: [],
      details: { op: "unblock", phases: normalized.phases, storage: "session" },
    });
    assert(correctedResult && typeof correctedResult === "object" && "details" in correctedResult);
    const correctedDetails = correctedResult.details;
    assert(correctedDetails && typeof correctedDetails === "object" && "phases" in correctedDetails);
    assert.deepEqual(correctedDetails.phases, todoPhases);
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas fixes")?.tasks[0]?.status, "pending");
    assert(entries.length > priorWrites);
    const persisted = entries.at(-1);
    assert(persisted && typeof persisted === "object" && "customType" in persisted && "data" in persisted);
    assert.equal(persisted.customType, "user_todo_edit");
    assert.deepEqual(persisted.data, { phases: todoPhases });
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas final gates")?.tasks[0]?.status, "completed");
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas final gates")?.tasks[1]?.status, "pending");
    refused(await call({ action: "start", id: "F2" }));
    await finish("X1");
    assert.equal(todoPhases.find((phase) => phase.name === "Atlas fixes")?.tasks[0]?.status, "completed");
    await finish("F2");
    await finish("F3");
    await finish("F4");
    const current = await ledger();
    assert.deepEqual(
      [...current.items, ...current.fixes, ...current.gates].map((item) => [item.id, item.status]),
      [
        ["T1", "done"],
        ["T2", "done"],
        ["T3", "done"],
        ["X1", "done"],
        ["F1", "done"],
        ["F2", "done"],
        ["F3", "done"],
        ["F4", "done"],
      ],
    );
    ok(await call({ reason: "verified completion" }, "atlas_release"));
    return;
  }
  if (name === "final-native-outcome") {
    let prepared = await prepare("T1");
    await publish(prepared, "EarlyCompletion", { finalResult: false });
    refused(await done("T1", "EarlyCompletion"));
    await publish(prepared, "CaptureFailed", { finalError: "Isolated patch capture failed after subprocess completion" });
    refused(await done("T1", "CaptureFailed"));
    ok(await call({ action: "reopen", id: "T1" }));
    prepared = await prepare("T1");
    await publish(prepared, "PendingCapture", { asyncStatus: "running" });
    refused(await done("T1", "PendingCapture"));
    const pending = nativeJobs.find((job) => job.agentId === "PendingCapture");
    assert(pending);
    pending.status = "failed";
    refused(await done("T1", "PendingCapture"));
    ok(await call({ action: "reopen", id: "T1" }));
    prepared = await prepare("T1");
    await publish(prepared, "SuccessfulCapture", { asyncStatus: "completed" });
    await hook("context", { messages: [] });
    nativeJobs.length = 0;
    ok(await done("T1", "SuccessfulCapture"));
    assert.equal((await row("T1")).status, "done");
    assert.equal((await row("T2")).status, "open");
    return;
  }
  if (name === "wake-ownership" || name === "wake-native-success" || name === "wake-native-failure" || name === "wake-missing-lifecycle") {
    const prepared = await prepare("T1");
    await publish(prepared, "WokenChild", {
      asyncStatus: "completed",
      nativeStatus: name === "wake-missing-lifecycle" ? "started" : "completed",
    });
    if (name === "wake-ownership") ok(await done("T1", "WokenChild"));
    assert.equal(
      await hook("tool_call", {
        toolName: "write",
        toolCallId: "wake-message",
        input: { path: "agent://WokenChild", content: "Inspect this follow-up" },
      }),
      undefined,
    );
    await publish(prepared, "WokenChild", { status: "running", nativeStatus: "started", finalResult: false });
    // Native wake jobs are registered on yield, later than the original task's returnedAt.
    // Until a wake job exists, the new lifecycle generation itself retains writer ownership.
    if (name === "wake-ownership") await commands.get("atlas")?.("exit", ctx);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    if (name === "wake-ownership") await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    let settleWake!: () => void;
    const wakeJob = {
      id: "job-WokenChild-2",
      agentId: "WokenChild",
      type: "task" as const,
      ownerId: "Main",
      startTime: Date.now(),
      label: "IRC follow-up",
      status: "running",
      promise: new Promise<void>((resolve) => {
        settleWake = resolve;
      }),
    };
    nativeJobs.push(wakeJob);
    await publish(prepared, "WokenChild", { nativeStatus: "completed", finalResult: false, content: "New output from the wake turn" });
    // An old synchronous final result and an old completed native job cannot authorize overwritten output.
    await hook("tool_result", {
      toolName: "task",
      toolCallId: prepared.toolCallId,
      isError: false,
      details: { results: [{ id: "WokenChild", index: 0, exitCode: 0, aborted: false }] },
      content: [],
    });
    if (name !== "wake-ownership") refused(await done("T1", "WokenChild"));
    else await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    wakeJob.status = name === "wake-native-success" || name === "wake-missing-lifecycle" ? "completed" : "failed";
    await hook("context", { messages: [] });
    // Even a terminal-looking wake job row does not settle its retained native promise.
    if (name !== "wake-ownership") refused(await done("T1", "WokenChild"));
    else await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    settleWake();
    await hook("tool_result", { toolName: "task", toolCallId: "unrelated", isError: false, details: {}, content: [] });
    if (name === "wake-native-success" || name === "wake-missing-lifecycle") {
      ok(await done("T1", "WokenChild"));
      const receipt = (await row("T1")).receipt;
      assert(receipt);
      assert.equal(await readFile(join(dirname(planFile), "evidence", `${receipt.receiptId}.md`), "utf8"), "New output from the wake turn");
    } else if (name === "wake-native-failure") refused(await done("T1", "WokenChild"));
    if (name !== "wake-ownership") await commands.get("atlas")?.("exit", ctx);
    await rival.acquire(shared.id, "rival");
    await rival.release(shared.id, "rival");
    return;
  }
  if (name === "wake-wrapper-cancel" || name === "wake-wrapper-direct-abort") {
    const prepared = await prepare("T1");
    await publish(prepared, "AbortableWake", { asyncStatus: "completed" });
    await publish(prepared, "AbortableWake", { status: "running", nativeStatus: "started", finalResult: false });
    // These real host modules load only inside the isolated child process.
    const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
    const { untilAborted } = await import("@oh-my-pi/pi-utils");
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const manager = new AsyncJobManager({ onJobComplete() {} });
    Object.defineProperty(live, "asyncJobManager", { value: manager, configurable: true });
    let resolveOutcome!: (text: string) => void;
    let underlyingFinished = false;
    const outcome = new Promise<string>((resolve) => {
      resolveOutcome = resolve;
    }).then((text) => {
      underlyingFinished = true;
      return text;
    });
    const id = manager.register("task", "AbortableWake", ({ signal }) => untilAborted(signal, outcome), {
      id: "AbortableWake-revived",
      agentId: "AbortableWake",
      ownerId: "Main",
    });
    const job = manager.getJob(id);
    assert(job);
    try {
      await hook("context", { messages: [] });
      if (name === "wake-wrapper-cancel") assert(manager.cancel(id, { ownerId: "Main" }));
      else job.abortController.abort();
      await job.promise;
      assert.equal(job.status, name === "wake-wrapper-cancel" ? "cancelled" : "failed");
      assert.equal(underlyingFinished, false, "native abort wrapper must settle while underlying wake is still pending");
      await publish(prepared, "AbortableWake", { nativeStatus: "completed", finalResult: false, content: "Unsettled wake output" });
      refused(await done("T1", "AbortableWake"));
      await commands.get("atlas")?.("exit", ctx);
      const rival = new AtlasStore(sessionManager.getSessionDir());
      const shared = await rival.find("integrity");
      await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
      resolveOutcome("The unwrapped wake finally completed");
      await outcome;
      assert.equal(underlyingFinished, true);
      await hook("tool_result", { toolName: "task", toolCallId: "unrelated", isError: false, details: {}, content: [] });
      // The plugin has only the cancelled wrapper; lifecycle and caller knowledge of the
      // unwrapped promise are not a native final handle and cannot release its lock.
      await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    } finally {
      resolveOutcome("Cleanup");
      await outcome;
      await manager.dispose({ timeoutMs: 100 });
    }
    return;
  }
  if (name === "wake-without-job") {
    const git = (...args: string[]) => assert.equal(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode, 0);
    git("init", "-q");
    git("config", "user.email", "atlas@example.test");
    git("config", "user.name", "Atlas");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "chore: baseline");
    await writeFile(join(root, "adr-0001.md"), "# ADR\n");
    const commit = () => call({ action: "commit", paths: ["adr-0001.md"], message: "docs: record the relay" }, "atlas_git");
    const prepared = await prepare("T1");
    await publish(prepared, "PeerWoken", { asyncStatus: "completed" });
    // A peer's message wakes the finished child; the host registers no wake job for a turn answered without yield.
    await publish(prepared, "PeerWoken", { status: "running", nativeStatus: "started", finalResult: false });
    refused(await commit());
    await publish(prepared, "PeerWoken", { nativeStatus: "completed", finalResult: false });
    ok(await commit());
    // The finished turn no longer holds the plan, but without a native outcome it never supplies a receipt.
    refused(await done("T1", "PeerWoken"));
    await commands.get("atlas")?.("exit", ctx);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    await rival.acquire(shared.id, "rival");
    await rival.release(shared.id, "rival");
    return;
  }
  if (name === "mixed-schedule-failure" || name === "mixed-inline-failure") {
    ok(await call({ action: "start", id: "T1" }));
    ok(await call({ action: "start", id: "T3" }));
    const current = await ledger();
    const first = await row("T1");
    const third = await row("T3");
    const toolCallId = "mixed-dispatch";
    const input = {
      context: "Independent native task members",
      tasks: [first, third].map((item) => ({
        agent: item.dispatchAgent,
        task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [item.id]: item.attempt } })}\nExecute ${item.id}`,
      })),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "RunningSibling", { asyncStatus: "running" });
    if (name === "mixed-inline-failure")
      bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
        id: "FailedMember",
        index: 1,
        status: "failed",
        sessionFile: join(artifacts, "FailedMember.jsonl"),
        parentToolCallId: toolCallId,
      });
    const details = {
      results: [],
      async: { state: "running", type: "task", jobId: "job-RunningSibling" },
      progress: [
        { id: "RunningSibling", index: 0, status: "running" },
        { id: "FailedMember", index: 1, status: name === "mixed-inline-failure" ? "aborted" : "failed" },
      ],
    };
    await hook("tool_result", { toolName: "task", toolCallId, input, isError: false, details, content: [] });
    refused(await done("T3", "FailedMember"));
    await commands.get("atlas")?.("exit", ctx);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    const sibling = nativeJobs.find((job) => job.agentId === "RunningSibling");
    assert(sibling);
    sibling.status = "completed";
    await hook("tool_result", { toolName: "task", toolCallId, input, isError: false, details, content: [] });
    await rival.acquire(shared.id, "rival");
    await rival.release(shared.id, "rival");
    await commands.get("atlas")?.("integrity", ctx);
    ok(await call({ action: "status" }));
    assert.equal((await row("T3")).status, "open");
    return;
  }
  if (name === "batch-error-sibling") {
    ok(await call({ action: "start", id: "T1" }));
    ok(await call({ action: "start", id: "T3" }));
    const current = await ledger();
    const first = await row("T1");
    const third = await row("T3");
    const toolCallId = "salvaged-batch";
    const input = {
      context: "Independent native task members",
      tasks: [first, third].map((item) => ({
        agent: item.dispatchAgent,
        task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [item.id]: item.attempt } })}\nExecute ${item.id}`,
      })),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "LandedSibling", { finalResult: false });
    await publish({ item: third, current, toolCallId, input }, "SalvagedMember", { finalResult: false, index: 1 });
    // The host ORs every member's payload into one batch isError; only the salvaged member carries its own error.
    await hook("tool_result", {
      toolName: "task",
      toolCallId,
      input,
      isError: true,
      details: {
        results: [
          { id: "LandedSibling", index: 0, exitCode: 0, aborted: false },
          { id: "SalvagedMember", index: 1, exitCode: 0, aborted: false, error: "Isolated branch merge failed" },
        ],
      },
      content: [{ type: "text", text: "Task execution failed: Isolated branch merge failed" }],
    });
    ok(await done("T1", "LandedSibling"));
    assert.equal((await row("T1")).status, "done");
    refused(await done("T3", "SalvagedMember"));
    return;
  }
  if (name === "atlas-model-role") {
    const cycle = () => cfgCycleOrder.get(settings);
    assert(getKnownRoleIds(settings).includes("atlas"), "atlas is listed as a model role");
    // The approved proposal exposed the atlas tier to the native approval slider.
    assert.deepEqual(cycle(), ["atlas", "smol", "default", "slow"]);
    // Ctrl+P keeps cycling only the user's roles while the approval tier is exposed.
    await live.cycleRoleModels(cycle(), "forward");
    assert.deepEqual(cycledOrders, [["smol", "default", "slow"]]);
    await commands.get("atlas")?.("exit", ctx);
    assert.deepEqual(cycle(), ["smol", "default", "slow"]);
    assert(!Object.hasOwn(live, "cycleRoleModels"), "Ctrl+P returns to the host implementation");
    assert.equal(settings.getProvenance(cfgCycleOrder), "default");
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(appliedRoles, []);
    assert.doesNotMatch(notices.at(-1) ?? "", /atlas model role/);
    await commands.get("atlas")?.("exit", ctx);
    settings.overrideModelRoles({ atlas: "test/atlas-model" });
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(appliedRoles, [{ role: "atlas", model: "test/atlas-model" }]);
    assert.match(notices.at(-1) ?? "", /Switched to the atlas model role \(test\/atlas-model\)/);
    assert.deepEqual(cycle(), ["smol", "default", "slow"]);
    return;
  }
  if (name === "cross-session") {
    const approvedUrl = reference;
    await finish("T1");
    const origin = (await row("T1")).receipt;
    assert(origin);
    ok(await call({ action: "start", id: "T3" }));
    const originalArtifacts = artifacts;
    await hook("input", { text: "/atlas exit", source: "user" });
    await hook("session_shutdown");
    sessionId = "successor-session";
    artifacts = join(root, "successor-artifacts");
    await mkdir(artifacts, { recursive: true });
    await rm(originalArtifacts, { recursive: true, force: true });
    entries.length = 0;
    reference = "local://PLAN.md";
    AgentRegistry.resetGlobalForTests();
    main();
    install();
    await hook("session_start");
    await commands.get("atlas")?.("missing-plan", ctx);
    assert.match(notices.at(-1) ?? "", /No approved Atlas plan named missing-plan; available: integrity/);
    await commands.get("atlas")?.("exit", ctx);
    // The proposal file name, including its `-plan` suffix, selects the same bundle.
    await commands.get("atlas")?.("integrity-plan", ctx);
    const status = await call({ action: "status" });
    ok(status);
    assert.equal(reference, approvedUrl);
    assert.deepEqual(await loadOverallPlanReference(reference as string, localProtocolOptions), { path: reference, content: plan });
    assert.deepEqual((await row("T1")).receipt, origin);
    assert.equal((await row("T3")).status, "open");
    assert(status.content.some((part) => part.text?.includes(join(dirname(planFile), "evidence", `${origin.receiptId}.md`))));
    await finish("T2");
    await finish("T3");
    const gate = await prepare("F1");
    // Native child ids can repeat across sessions; origin session is part of freshness.
    await publish(gate, origin.childAgentId);
    ok(await done("F1", origin.childAgentId));
    await finish("F2");
    await finish("F3");
    await finish("F4");
    ok(await call({ reason: "shared verification complete" }, "atlas_release"));
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    return;
  }
  if (name === "switch-reference") {
    await finish("T1");
    const firstEntries = entries.slice();
    const firstReference = reference;
    sessionId = "second-session";
    entries.length = 0;
    await hook("session_switch", { reason: "new" });
    // The host can retain the previous reference on the same AgentSession object.
    assert.equal(reference, "local://PLAN.md");
    await assert.rejects(loadOverallPlanReference(firstReference as string, localProtocolOptions));
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const second = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "second",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://second-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "second-native",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("second", ctx);
    assert.equal(reference, `atlas://${second.id}/plan.md`);
    const secondEntries = entries.slice();
    sessionId = "integrity-session";
    entries.splice(0, entries.length, ...firstEntries);
    await hook("session_switch", { reason: "resume" });
    ok(await call({ action: "status" }));
    assert.equal(reference, firstReference);
    assert.equal((await row("T1")).status, "done");
    sessionId = "second-session";
    entries.splice(0, entries.length, ...secondEntries);
    reference = "local://explicit-unrelated-plan.md";
    await hook("session_switch", { reason: "resume" });
    refused(await call({ action: "status" }));
    assert.equal(reference, "local://explicit-unrelated-plan.md");
    return;
  }
  if (name === "exact-commands") {
    assert(!tools.has("prometheus_ledger") && !tools.has("prometheus_release"));
    const approvedReference = reference;
    for (const selector of ["integrity", "missing-plan"]) {
      await commands.get("atlas")?.(selector, ctx);
      assert.match(notices.at(-1) ?? "", /Switching plans is not allowed/);
      await hook("input", { text: `/atlas ${selector}`, source: "user" });
      assert.match(notices.at(-1) ?? "", /Switching plans is not allowed/);
      assert.equal(reference, approvedReference);
    }
    await commands.get("prometheus")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /cannot release/);
    await hook("input", { text: "/prometheus", source: "user" });
    assert.match(notices.at(-1) ?? "", /Atlas is active/);
    ok(await call({ action: "status" }));
    assert.notEqual(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    // While active, bare /atlas opens only the running plan's read-only view; Esc closes it and Atlas stays.
    confirmAnswer = false;
    const rendersBefore = menuRenders.length;
    menuKey = "\x1b";
    await commands.get("atlas")?.("", ctx);
    assert.equal(menuRenders.length, rendersBefore + 1);
    const activeView = menuRenders.at(-1) ?? "";
    assert.match(activeView, /Active in this session/);
    assert.match(activeView, /exit Atlas/);
    assert.doesNotMatch(activeView, /\bstart\b|resume|rename|delete/);
    ok(await call({ action: "status" }));
    await commands.get("atlas")?.("exit", ctx);
    assert.deepEqual(confirmTitles, ["Exit Atlas early?"]);
    ok(await call({ action: "status" }));
    confirmAnswer = true;
    // Shift+X in the view exits the same way /atlas exit does.
    menuKey = "X";
    await commands.get("atlas")?.("", ctx);
    assert.deepEqual(confirmTitles, ["Exit Atlas early?", "Exit Atlas early?"]);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("exit", ctx);
    assert.match(notices.at(-1) ?? "", /not active/);
    menuKey = "\x1b";
    await commands.get("atlas")?.("", ctx);
    assert.match(menuRenders.at(-1) ?? "", /integrity/);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("missing-plan", ctx);
    assert.match(notices.at(-1) ?? "", /Atlas execution paused/);
    assert.notEqual(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const other = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "second",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://second-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "native-second",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("second", ctx);
    ok(await call({ action: "status" }));
    assert.equal(reference, `atlas://${other.id}/plan.md`);
    await commands.get("atlas")?.("exit", ctx);
    await hook("input", { text: "/atlas integrity", source: "user" });
    assert.equal(reference, approvedReference);
    ok(await call({ action: "status" }));
    await commands.get("atlas")?.("exit", ctx);
    mode = true;
    await commands.get("prometheus")?.("", ctx);
    await commands.get("atlas")?.("integrity", ctx);
    assert.match(notices.at(-1) ?? "", /cannot enter during planning/);
    await hook("input", { text: "/atlas integrity", source: "user" });
    assert.match(notices.at(-1) ?? "", /cannot enter during planning/);
    await commands.get("atlas")?.("", ctx);
    assert.match(menuRenders.at(-1) ?? "", /All|Unfinished/);
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "exit-live-child" || name === "shutdown-live-child" || name === "cancelled-live-child") {
    const prepared = await prepare("T1");
    await publish(prepared, "PendingChild", { asyncStatus: "running" });
    const originalAttempt = prepared.item.attempt;
    await hook("session_tree");
    assert.equal((await row("T1")).attempt, originalAttempt);
    assert.equal((await row("T1")).status, "in_progress");
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    if (name === "shutdown-live-child") await hook("session_shutdown");
    else await commands.get("atlas")?.("exit", ctx);
    assert.deepEqual(await loadOverallPlanReference(`atlas://${shared.id}/plan.md`, localProtocolOptions), {
      path: `atlas://${shared.id}/plan.md`,
      content: plan,
    });
    if (name === "exit-live-child")
      assert.equal(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    await assert.rejects(rival.acquire(shared.id, "session-b"), /live execution owner/);
    if (name === "exit-live-child") {
      await commands.get("atlas")?.("integrity", ctx);
      refused(await call({ action: "status" }));
      assert.equal((await row("T1")).attempt, originalAttempt);
      await commands.get("atlas")?.("exit", ctx);
      const other = await rival.create({
        name: "unrelated",
        content: plan,
        cwd: root,
        sourcePlanPath: "local://unrelated-plan.md",
        sourceSessionId: "origin",
        proposedByToolCallId: "other-proposal",
        availableAgents: ["task", "reviewer"],
      });
      await commands.get("atlas")?.("unrelated", ctx);
      assert.equal(reference, `atlas://${other.id}/plan.md`);
      ok(await call({ action: "status" }));
      await commands.get("atlas")?.("exit", ctx);
    }
    const job = nativeJobs.find((job) => job.agentId === "PendingChild");
    assert(job);
    if (name === "cancelled-live-child") {
      job.status = "cancelled";
      await hook("context", { messages: [] });
      await assert.rejects(rival.acquire(shared.id, "session-b"), /live execution owner/);
      nativeJobs.length = 0; // The exact observed promise must survive native history eviction.
      assert(settleNativeJob);
      settleNativeJob();
    } else job.status = "failed";
    await hook("tool_result", {
      toolName: "task",
      toolCallId: prepared.toolCallId,
      isError: false,
      details: { async: { state: "failed", type: "task", jobId: job.id }, results: [] },
      content: [],
    });
    await rival.acquire(shared.id, "session-b");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    await rival.release(shared.id, "session-b");
    if (name === "shutdown-live-child") await commands.get("atlas")?.("exit", ctx);
    await commands.get("atlas")?.("integrity", ctx);
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "open");
    return;
  }
  if (name === "exit-during-capture") {
    const prepared = await prepare("T1");
    await publish(prepared, "FinishingChild");
    // This test intercepts the module instance loaded by the isolated extension above.
    const { ChildEvidence } = await import("../plugins/omo-prometheus/src/evidence.ts");
    const original = ChildEvidence.prototype.capture;
    let entered!: () => void;
    let continueCapture!: () => void;
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      continueCapture = resolve;
    });
    ChildEvidence.prototype.capture = async function (options) {
      const receipt = await original.call(this, options);
      entered();
      await resume;
      return receipt;
    };
    try {
      const pending = done("T1", "FinishingChild");
      await captured;
      await commands.get("atlas")?.("exit", ctx);
      continueCapture();
      refused(await pending);
      assert.equal((await row("T1")).status, "in_progress");
      await commands.get("atlas")?.("integrity", ctx);
      ok(await call({ action: "status" }));
      assert.equal((await row("T1")).status, "open");
    } finally {
      continueCapture();
      ChildEvidence.prototype.capture = original;
    }
    return;
  }
  if (name === "legacy-pauses") {
    const oldLedger = join(artifacts, "local", "prometheus", "integrity-ledger.json");
    const oldMarker = join(artifacts, "local", "prometheus", "integrity.proposal.json");
    const progress = await readFile(ledgerFile, "utf8");
    const proposal = await readFile(oldMarker, "utf8");
    await writeFile(oldLedger, progress);
    await hook("session_shutdown");
    entries.length = 0;
    entries.push({
      type: "custom",
      customType: "wows-omp-omo-prometheus.state",
      data: {
        version: 2,
        phase: "executing",
        planFilePath: "local://integrity-plan.md",
        ledgerPath: "local://prometheus/integrity-ledger.json",
        planSha256: (await ledger()).planSha256,
        proposedByToolCallId: "old-proposal",
      },
    });
    reference = "local://integrity-plan.md";
    install();
    await hook("session_start");
    refused(await call({ action: "status" }));
    assert.match(notices.join("\n"), /fresh native reapproval/);
    await commands.get("atlas")?.("exit", ctx);
    assert.equal(await readFile(oldLedger, "utf8"), progress);
    assert.equal(await readFile(oldMarker, "utf8"), proposal);
    assert.equal(await readFile(sourcePlanFile, "utf8"), plan);
    return;
  }
  if (name === "workspace-mismatch") {
    await commands.get("atlas")?.("exit", ctx);
    const otherCwd = join(root, "different-worktree");
    await mkdir(otherCwd);
    const foreignContext = { ...ctx, cwd: otherCwd } as ExtensionContext;
    await commands.get("atlas")?.("integrity", foreignContext);
    assert.match(notices.at(-1) ?? "", /different workspace/);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("", foreignContext);
    return;
  }

  if (name === "heavy-verify" || name === "heavy-verify-fail") {
    const prepared = await prepare("T1");
    assert.match(prepared.startText ?? "", /T1 is HEAVY/);
    await publish(prepared, "Implementer");
    ok(await done("T1", "Implementer"));
    let current = await row("T1");
    assert.equal(current.status, "in_progress");
    assert.equal(current.receipt?.childAgentId, "Implementer");
    // A recorded implementation alone never completes the row, so nothing waiting on it may start.
    refused(await done("T1", "Implementer"));
    refused(await call({ action: "start", id: "T2" }));
    refused(await call({ action: "verify", id: "T3" }));
    const again = (await hook("tool_call", { toolName: "task", toolCallId: `dispatch-${sequence++}`, input: prepared.input })) as
      | { block?: boolean; reason?: string }
      | undefined;
    assert.match(again?.reason ?? "", /already recorded/);
    const started = await call({ action: "verify", id: "T1" });
    ok(started);
    current = await row("T1");
    const attempt = current.verification?.attempt;
    const verifyStartedAt = current.verification?.startedAt;
    assert(attempt && verifyStartedAt !== undefined);
    const planSha256 = (await ledger()).planSha256;
    const marker = `atlas_assignment: ${JSON.stringify({ planSha256, verify: { T1: attempt } })}`;
    assert(started.content.some((part) => part.text?.includes(marker)));
    const input = {
      agent: current.verification?.dispatchAgent,
      task: `${marker}\nVerify T1 adversarially and report; never fix.`,
      solutionSpace: "Verification only",
      outputSchema: started.details?.outputSchema,
      schemaMode: "strict",
    };
    const loose = (await hook("tool_call", {
      toolName: "task",
      toolCallId: `dispatch-${sequence++}`,
      input: { ...input, schemaMode: "permissive" },
    })) as { block?: boolean } | undefined;
    assert.equal(loose?.block, true);
    const notObject = (await hook("tool_call", {
      toolName: "task",
      toolCallId: `dispatch-${sequence++}`,
      input: { ...input, outputSchema: "[]" },
    })) as { block?: boolean } | undefined;
    assert.equal(notObject?.block, true);
    // Strict tool-schema providers (OpenAI Responses) can only send the schema as JSON text, which the host parses.
    const textInput = { ...input, outputSchema: JSON.stringify(input.outputSchema) };
    const verifier: PreparedAssignment = { item: current, current: await ledger(), toolCallId: `dispatch-${sequence++}`, input: textInput };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId: verifier.toolCallId, input: textInput }), undefined);
    // The implementer's own completion never counts as the independent verification.
    refused(await done("T1", "Implementer"));
    const verdict = name === "heavy-verify" ? "PASS" : "FAIL";
    await publish(verifier, "Verifier", {
      createdAt: verifyStartedAt,
      content: JSON.stringify({ rowId: "T1", planSha256, attempt, verdict, summary: `Verifier ${verdict}`, evidence: ["reproduced"] }),
    });
    ok(await done("T1", "Verifier"));
    current = await row("T1");
    if (name === "heavy-verify-fail") {
      assert.equal(current.status, "open");
      assert.equal(current.receipt, undefined);
      assert.equal(current.verification?.verdict, "fail");
      assert.equal(current.evidence, "Verification failed: Verifier FAIL");
      const restarted = await call({ action: "start", id: "T1" });
      ok(restarted);
      assert(restarted.content.some((part) => part.text?.includes("give this to the implementation child: Verifier FAIL")));
      return;
    }
    assert.equal(current.status, "done");
    assert.equal(current.verification?.verdict, "pass");
    assert.equal(current.verification?.receipt?.childAgentId, "Verifier");
    ok(await call({ action: "start", id: "T2" }));
    await reload();
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "done");
    return;
  }
  if (name === "research-children") {
    const research = async (agent: string, extra: Record<string, unknown> = {}) =>
      (await hook("tool_call", {
        toolName: "task",
        toolCallId: `research-${sequence++}`,
        input: { agent, task: "Diagnose why T1 fails; report findings only.", solutionSpace: "Read-only diagnosis", ...extra },
      })) as { block?: boolean; reason?: string } | undefined;
    // Read-only capability comes from the live agent definition: scout's tools only read.
    assert.equal(await research("scout"), undefined);
    for (const agent of ["task", "reviewer"]) assert.match((await research(agent))?.reason ?? "", /read-only research, and \S+ can write/);
    assert.match((await research("scout", { tools: ["probe"] }))?.reason ?? "", /cannot carry extra tools/);
    assert.match((await research("momus", { task: "review_kind: compliance\nDiagnose" }))?.reason ?? "", /momus stays plan-gated/);
    // A research child's output is never row evidence, and research never rides in a bound batch.
    const prepared = await prepare("T1");
    const scoutCall = `research-${sequence++}`;
    const scoutInput = { agent: "scout", task: "Inspect the T1 failure.", solutionSpace: "Read-only diagnosis" };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId: scoutCall, input: scoutInput }), undefined);
    await publish({ ...prepared, toolCallId: scoutCall, input: scoutInput }, "Scout");
    refused(await done("T1", "Scout"));
    const mixed = (await hook("tool_call", {
      toolName: "task",
      toolCallId: `dispatch-${sequence++}`,
      input: { context: "Shared context", tasks: [prepared.input, scoutInput] },
    })) as { block?: boolean; reason?: string } | undefined;
    assert.match(mixed?.reason ?? "", /their own task call/);
    return;
  }
  if (name === "atlas-git") {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      return result.stdout.toString();
    };
    git("init", "-q");
    git("config", "user.email", "atlas@example.test");
    git("config", "user.name", "Atlas");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "chore: baseline");
    const gitTool = (params: Record<string, unknown>) => call(params, "atlas_git");
    await writeFile(join(root, "adr-0001.md"), "# ADR\n");
    await writeFile(join(root, "stray.md"), "unrelated\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "note.md"), "note\n");
    // A commit names its files: directories, pathspec magic and a missing message never widen or guess one.
    refused(await gitTool({ action: "commit", paths: ["docs"], message: "docs: add a note" }));
    refused(await gitTool({ action: "commit", paths: ["*.md"], message: "docs: add everything" }));
    refused(await gitTool({ action: "commit", paths: ["adr-0001.md"] }));
    ok(await gitTool({ action: "commit", paths: ["adr-0001.md"], message: "docs: record the first ADR" }));
    assert.equal(git("log", "-1", "--format=%s").trim(), "docs: record the first ADR");
    assert.equal(git("show", "--name-only", "--format=", "HEAD").trim(), "adr-0001.md");
    assert.match(git("status", "--short", "--", "stray.md"), /\?\? stray\.md/);
    // Revisions cannot smuggle options such as --output, which would write files.
    refused(await gitTool({ action: "show", revision: "--output=leak.txt" }));
    ok(await gitTool({ action: "diff", revision: "HEAD~1..HEAD", stat: true }));
    // While a bound child runs, inspection works and commits wait.
    await prepare("T1");
    ok(await gitTool({ action: "status" }));
    refused(await gitTool({ action: "commit", paths: ["stray.md"], message: "docs: add stray notes" }));
    // Only the Atlas main session may use it.
    agentKind = "sub";
    refused(await gitTool({ action: "status" }));
    return;
  }
  if (name === "structured-results") {
    // Host modules load only inside the isolated child process, after HOME is private.
    const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
    const structured = lookup("task.structured");
    assert.ok(structured);
    // Gates and verifiers need outputSchema and schemaMode, which the host offers only while task.structured is on.
    assert.equal(structured.get(settings), true);
    await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] });
    assert.equal(notices.filter((notice) => notice.includes("task.structured")).length, 1);
    // Leaving execution puts the user's setting back without leaving a runtime layer behind.
    await hook("session_shutdown");
    assert.equal(structured.get(settings), false);
    assert.equal(settings.getProvenance(structured), "default");
    return;
  }
  if (name === "isolation-required" || name === "non-git-workspace") {
    // Host modules load only inside the isolated child process, after HOME is private.
    const { cfgTaskIsolationEnabled, cfgTaskIsolationMerge } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    cfgTaskIsolationEnabled.override(settings, true);
    if (name === "isolation-required") assert.equal(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode, 0);
    const dispatch = async (id: string, extra: Record<string, unknown> = {}) => {
      ok(await call({ action: "start", id }));
      const item = await row(id);
      const task = `atlas_assignment: ${JSON.stringify({ planSha256: (await ledger()).planSha256, rows: { [id]: item.attempt } })}\nImplement ${id}`;
      return (await hook("tool_call", {
        toolName: "task",
        toolCallId: `dispatch-${sequence++}`,
        input: { agent: item.dispatchAgent, task, solutionSpace: "Scoped", ...extra },
      })) as { block?: boolean; reason?: string } | undefined;
    };
    if (name === "non-git-workspace") {
      // Host isolation needs Git, so outside a work tree nothing demands it and Git settings stay untouched.
      assert.equal(await dispatch("T1"), undefined);
      assert.equal(cfgTaskIsolationMerge.get(settings), "patch");
      const prompt = (await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] })) as { systemPrompt?: string[] };
      assert.match(prompt.systemPrompt?.join("\n") ?? "", /<workspace git="none">.*never run `git init`/);
      const git = await call({ action: "status" }, "atlas_git");
      assert.equal(git.isError, true);
      assert.match(git.content[0]?.text ?? "", /not a Git repository, and Atlas never uses or creates one/);
      await assert.rejects(readFile(join(root, ".git", "HEAD")), { code: "ENOENT" });
      return;
    }
    assert.match((await dispatch("T1"))?.reason ?? "", /T1 is implementation work and must dispatch with isolated: true/);
    assert.equal(cfgTaskIsolationMerge.get(settings), "patch");
    ok(await call({ action: "reopen", id: "T1" }));
    assert.equal(await dispatch("T1", { isolated: true }), undefined);
    assert.equal(await dispatch("T3", { isolated: true }), undefined);
    // Patch merges would drop each child's commits, so Atlas runs isolated children with branch merges and says so once.
    assert.equal(cfgTaskIsolationMerge.get(settings), "branch");
    assert.equal(notices.filter((notice) => notice.includes("task.isolation.merge")).length, 1);
    // Leaving execution puts the user's setting back without leaving a runtime layer behind.
    await hook("session_shutdown");
    assert.equal(cfgTaskIsolationMerge.get(settings), "patch");
    assert.equal(settings.getProvenance(cfgTaskIsolationMerge), "default");
    return;
  }
  if (name === "discover") {
    const discover = (params: Record<string, unknown>) => call({ action: "discover", ...params });
    const defect = { id: "T1", title: "Repair the shared parser", acceptance: "the parser test passes", evidence: "T1 exposed it" };
    refused(await discover(defect));
    ok(await discover({ ...defect, scope: "in" }));
    const d1 = await row("D1");
    assert.equal(d1.origin, "T1");
    assert.equal(d1.tier, "light");
    assert.deepEqual((await row("F1")).dependsOn, ["T1", "T2", "T3", "D1"]);
    assert.deepEqual(
      todoPhases.map((phase) => phase.name),
      ["Atlas tasks", "Atlas discovered", "Atlas final gates"],
    );
    ok(await discover({ scope: "out", title: "Legacy importer leaks handles", evidence: "Outside this change" }));
    assert.equal((await ledger()).deferred.length, 1);
    await tasksDone();
    await finish("D1");
    await prepare("F1");
    refused(await discover({ ...defect, id: "T2", scope: "in" }));
    ok(await discover({ scope: "out", id: "F1", title: "Unrelated flaky test", evidence: "Outside this change" }));
    return;
  }
  await tasksDone();
  if (name === "untrusted-children") {
    const review = await prepare("F1");
    // The workspace is a plain temporary directory: F1 still starts, with a plain statement instead of a diff.
    assert.match(review.startText ?? "", /Git evidence unavailable: the plan workspace is not a Git work tree/);
    assert.doesNotMatch(review.startText ?? "", /\$ git diff --stat/);
    // Atlas binds the compliance reviewer to the approved bundle file instead of an inline plan copy.
    assert.ok(review.startText?.includes(`absolute_plan_path: ${planFile}`), review.startText ?? "missing start text");
    await writeFile(join(artifacts, "Bogus.md"), "PASS");
    refused(await done("F1", "Bogus"));
    for (const [child, options] of [
      ["Foreign", { parentId: "Other" }],
      ["Running", { status: "running" as const }],
      ["NoNativeResult", { observe: false }],
      ["Failed", { nativeStatus: "failed" }],
      ["Old", { createdAt: 0 }],
      ["Prose", { content: "The failure mentions PASS but I reject this gate." }],
    ] as const) {
      await publish(review, child, options);
      refused(await done("F1", child));
    }
    await publish(review, "Rejected", {
      content: JSON.stringify({
        gateId: "F1",
        planSha256: review.current.planSha256,
        attempt: review.item.attempt,
        verdict: "FAIL",
        summary: "Not fixed",
        evidence: ["failing scenario"],
        reviewedGates: {},
      }),
    });
    refused(await done("F1", "Rejected"));
    await publish(review, "Approved");
    ok(await done("F1", "Approved"));
    const next = await prepare("F2");
    await publish(next, "Approved");
    refused(await done("F2", "Approved"));
    return;
  }
  if (name === "reopen-running") {
    await finish("F1");
    await finish("F2");
    const running = await prepare("F4");
    ok(await call({ action: "reopen", id: "F4" }));
    await publish(running, "StaleFidelity");
    refused(await done("F4", "StaleFidelity"));
    await finish("F3");
    await finish("F4");
    ok(await call({ action: "reopen", id: "T1" }));
    const current = await ledger();
    assert.equal(current.items[0]?.status, "open");
    assert.equal(current.items[1]?.status, "done");
    assert(current.gates.every((item) => item.status === "done" && item.receipt));
    refused(await call({ reason: "stale success" }, "atlas_release"));
    return;
  }
  if (name === "branch-keeps-progress") {
    const snapshot = entries.slice();
    await finish("F1");
    const receipt = (await row("F1")).receipt;
    entries.splice(0, entries.length, ...snapshot);
    await hook("session_tree");
    ok(await call({ action: "status" }));
    assert.deepEqual((await row("F1")).receipt, receipt);
    assert.equal((await row("F1")).status, "done");
    await writeFile(join(artifacts, `${receipt?.childAgentId}.md`), "Changed old local output");
    ok(await call({ action: "status" }));
    assert.equal((await row("F1")).status, "done");
    return;
  }
  await gatesDone();
  if (name === "rollback") {
    const completed = await readFile(ledgerFile, "utf8");
    ok(await call({ action: "reopen", id: "T1" }));
    await writeFile(ledgerFile, completed);
    await reload();
    const current = await ledger();
    assert.equal(current.items[0]?.status, "open");
    assert.equal(current.items[1]?.status, "done");
    assert(current.gates.every((item) => item.status === "done"));
    return;
  }
  if (name === "changed-output") {
    const original = await row("T1");
    assert(original.receipt);
    await writeFile(join(dirname(planFile), "evidence", `${original.receipt.receiptId}.md`), "Different unverified output");
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "open");
    assert.equal((await row("T2")).status, "done");
    assert((await ledger()).gates.every((item) => item.status === "done"));
    return;
  }
  if (name === "resume") {
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
    const status = await call({ action: "status" });
    ok(status);
    assert(status.details?.ledger?.gates.every((item) => item.status === "done"));
    ok(await call({ reason: "verified completion" }, "atlas_release"));
    assert.equal(confirmations, 1);
    return;
  }
  if (name === "resume-default-reference") {
    reference = "local://PLAN.md";
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
    assert.equal(reference, `atlas://${basename(dirname(planFile))}/plan.md`);
    const status = await call({ action: "status" });
    ok(status);
    assert(status.details?.ledger?.gates.every((item) => item.status === "done"));
    ok(await call({ reason: "verified completion" }, "atlas_release"));
    assert.equal(confirmations, 1);
    return;
  }
  if (name === "missing-proof") {
    const current = await ledger();
    if (current.items[0]) delete current.items[0].receipt;
    await writeFile(ledgerFile, JSON.stringify(current));
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
    const reopened = await ledger();
    assert.equal(reopened.items[0]?.status, "open");
    assert.equal(reopened.items[1]?.status, "done");
    assert.equal(reopened.items[2]?.status, "done");
    assert(reopened.gates.every((item) => item.status === "done"));
    const next = await prepare("T1");
    await publish(next, "HistoricalFile", { observe: false });
    refused(await done("T1", "HistoricalFile"));
    return;
  }
  throw new Error(`Unknown scenario ${name}`);
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.PROMETHEUS_EXECUTION_ROOT as string);
  console.log("PROMETHEUS_EXECUTION_OK");
} else {
  // The scenario is also an executable child script, where importing bun:test would be invalid.
  const { describe, expect, test } = await import("bun:test");
  describe("Prometheus registered execution tools and hooks", () => {
    for (const name of [
      "cycle",
      "fresh-handoff",
      "url-boundaries",
      "parallel-url-bindings",
      "exit-during-url-binding",
      "resume-absolute-reference",
      "resume-missing-ledger",
      "rollback",
      "changed-output",
      "concurrent",
      "multi-row",
      "resume-reference-mismatch",
      "resume-invalid-approval",
      "resume-missing-provenance",
      "invalid-ledger",
      "ordering",
      "gate-fix",
      "progress-guard",
      "progress-reports",
      "ask-guard",
      "untrusted-children",
      "final-native-outcome",
      "reopen-running",
      "resume",
      "resume-default-reference",
      "missing-proof",
      "cross-session",
      "exact-commands",
      "atlas-autocomplete",
      "atlas-dispatch",
      "atlas-model-role",
      "plain-plan-approval",
      "plan-mode-disabled",
      "exit-live-child",
      "shutdown-live-child",
      "cancelled-live-child",
      "exit-during-capture",
      "legacy-pauses",
      "workspace-mismatch",
      "branch-keeps-progress",
      "switch-reference",
      "wake-ownership",
      "wake-native-success",
      "wake-native-failure",
      "wake-missing-lifecycle",
      "wake-wrapper-cancel",
      "wake-wrapper-direct-abort",
      "wake-without-job",
      "mixed-schedule-failure",
      "mixed-inline-failure",
      "batch-error-sibling",
      "compact-handoff",
      "compact-inline-mismatch",
      "compact-reference-mismatch",
      "compact-queued-handoff",
      "compact-queued-inline-mismatch",
      "compact-queued-reference-mismatch",
      "compact-queued-user-role",
      "compact-queued-user-attribution",
      "compact-after-save-and-quit",
      "plan-mode-restored",
      "plan-mode-reentered",
      "propose-grammar",
      "review-round-limit",
      "heavy-verify",
      "heavy-verify-fail",
      "research-children",
      "structured-results",
      "isolation-required",
      "non-git-workspace",
      "atlas-git",
      "discover",
    ]) {
      // Each scenario runs in its own process with a private HOME, so scenarios share no state.
      test.concurrent(name, async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "prometheus-execution-")));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: {
              ...process.env,
              [CHILD_ENV]: name,
              PROMETHEUS_EXECUTION_ROOT: root,
              HOME: root,
              PI_CODING_AGENT_DIR: join(root, "agent"),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exitCode, stderr).toBe(0);
          expect(stdout).toContain("PROMETHEUS_EXECUTION_OK");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}
