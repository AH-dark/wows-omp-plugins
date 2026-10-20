import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { type AtlasStagePlan, requestPlans } from "../plugins/roadmap/src/atlas.ts";
import { check } from "../plugins/roadmap/src/check.ts";
import {
  loadAll,
  managedComment,
  parseRound,
  planningRevision,
  type Repo,
  roundFiles,
  roundSha256,
  type StageDoc,
} from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { renderCloseReminder, renderHandoff, renderInjection } from "../plugins/roadmap/src/handoff.ts";
import {
  type Actor,
  closeRound,
  initProject,
  openRound,
  type PreparationReceipt,
  type Receipt,
  type RoundCloseInput,
  type StageInput,
  stage,
  upgrade,
} from "../plugins/roadmap/src/operations.ts";
import { registerPrometheusContract } from "../plugins/roadmap/src/prometheus.ts";
import { type PendingClose, planModeActive, RoadmapSession } from "../plugins/roadmap/src/ses.ts";
import { roadmapStatus } from "../plugins/roadmap/src/state.ts";
import { adrApi, asFormatOne, contractEvents, modelFixture, planFixture, roundFixture, stageFixture } from "./roadmap-fixtures.ts";

const main: Actor = { sessionId: "main-session", kind: "main" };
const temporary: string[] = [];
const charter = {
  title: "Launch",
  goal: "Customers can check out",
  constraints: ["Keep the host floor"],
  non_goals: ["Refunds"],
  principles: [],
};
const checkout: StageInput = {
  title: "Checkout",
  objective: "Customers pay",
  scope_in: ["Payments"],
  scope_out: ["Refunds"],
  done_criteria: [
    { statement: "Checkout works", verify: "bun test checkout" },
    { statement: "Receipts arrive", verify: "Manual receipt check" },
  ],
};
const achieved: NonNullable<RoundCloseInput["outcome"]> = { assessment: "achieved", summary: "The round goal was met." };
const threeCriteria = "- DC1 — Pay\n  - Verify: a\n- DC2 — Receipt\n  - Verify: b\n- DC3 — Audit\n  - Verify: c";

afterAll(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function success(receipt: Receipt): Extract<Receipt, { ok: true }> {
  if (!receipt.ok) throw new Error(`${receipt.reason}\n${receipt.hints.join("\n")}`);
  return receipt;
}

function refused(receipt: Receipt | PreparationReceipt, message: string): void {
  if (receipt.ok) throw new Error("Expected a refused operation.");
  expect(`${receipt.reason}\n${receipt.hints.join("\n")}`).toContain(message);
}

async function initialized(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-multiplan-"));
  temporary.push(root);
  if ((await Bun.spawn(["git", "init", "-q", root]).exited) !== 0) throw new Error("git init failed");
  const git = discoverRepo(root);
  if (!git) throw new Error("No work tree");
  const repo: Repo = { ...git, roadmapDir: join(git.repoRoot, "docs/roadmap"), adrDir: join(git.repoRoot, "docs/adr"), adr: adrApi() };
  success(
    await initProject(repo, main, { project: { name: "Shop", description: "A shop." }, round: charter, adrs: [], stages: [checkout] }),
  );
  return repo;
}

async function reviewed(repo: Repo): Promise<{ id: string; sha256: string }> {
  const model = await loadAll(repo);
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) throw new Error("No active round");
  return { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
}

async function managedBytes(repo: Repo): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(repo.roadmapDir, { recursive: true })) {
    const path = join(repo.roadmapDir, name);
    files[name] = await readFile(path, "utf8").catch(() => "<directory>");
  }
  return files;
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

describe("round goal outcome", () => {
  test("format 1 closes without an outcome and refuses one; format 2 requires it and leaves closed history byte-identical", async () => {
    const repo = await initialized();
    await asFormatOne(repo);
    expect((await check(await loadAll(repo))).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    const before = await managedBytes(repo);
    refused(await closeRound(repo, main, { expected: await reviewed(repo), dispositions: [], outcome: achieved }), "/roadmap upgrade");
    expect(await managedBytes(repo)).toEqual(before);
    success(await closeRound(repo, main, { expected: await reviewed(repo), dispositions: [] }));
    let model = await loadAll(repo);
    const first = found(model.rounds.find((round) => round.id === "R1"));
    expect([first.format, first.status, first.outcome]).toEqual([1, "closed", undefined]);
    const frozen = roundFiles(model, first);

    success(await openRound(repo, main, { round: { ...charter, title: "Growth" }, import_todos: [] }));
    success(await upgrade(repo, main));
    success(await stage(repo, main, { action: "add", ...checkout, title: "Later" }));
    success(await stage(repo, main, { action: "drop", id: "S02", reason: "Deferred" }));
    const unchanged = await managedBytes(repo);
    refused(await closeRound(repo, main, { expected: await reviewed(repo), dispositions: [] }), "outcome");
    refused(
      await closeRound(repo, main, {
        expected: await reviewed(repo),
        dispositions: [],
        outcome: { assessment: "great" as never, summary: "Done" },
      }),
      "great",
    );
    refused(
      await closeRound(repo, main, { expected: await reviewed(repo), dispositions: [], outcome: { assessment: "partial", summary: "  " } }),
      "summary",
    );
    expect(await managedBytes(repo)).toEqual(unchanged);
    success(
      await closeRound(repo, main, {
        expected: await reviewed(repo),
        dispositions: [],
        outcome: { assessment: "partial", summary: "Growth shipped in part; referrals moved on." },
      }),
    );

    model = await loadAll(repo);
    const second = found(model.rounds.find((round) => round.id === "R2"));
    expect([second.format, second.status]).toEqual([2, "closed"]);
    expect(second.outcome).toContain("partial");
    expect(second.outcome).toContain("Growth shipped in part; referrals moved on.");
    expect(second.frozen_sha256).toBe(roundSha256(roundFiles(model, second)));
    const firstAfter = found(model.rounds.find((round) => round.id === "R1"));
    expect(roundFiles(model, firstAfter)).toEqual(frozen);
    expect(firstAfter.frozen_sha256).toBe(roundSha256(frozen));
    expect((await check(model)).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    // Only a format-2 round file can carry the outcome.
    const raw = await readFile(second.path, "utf8");
    const formatOne = raw
      .replace(managedComment(2), managedComment(1))
      .replace(/^format: 2$/m, "format: 1")
      .replace(/^target: null\n/m, "");
    expect(() => parseRound(formatOne, second.path)).toThrow("Fixed headings");
  });
});

describe("stage close with Atlas plans", () => {
  test("unfinished linked plans do not block the close; the receipt warns and Deviations names them", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const complete = planFixture({ planId: "plan-done", name: "Checkout", status: "complete", done: 3 });
    const open = planFixture({ planId: "plan-open", name: "Receipts [draft] | <b>`x`", criteria: ["DC2"] });
    const legacy = planFixture({ planId: "plan-legacy", name: "Legacy", criteria: undefined });
    const receipt = success(
      await stage(
        repo,
        main,
        {
          action: "close",
          id: "S01",
          delivered: "Checkout shipped.",
          deviations: "Receipt emails were deferred.",
          evidence: ["DC1", "DC2"].map((criterion) => ({ criterion, result: "pass" as const, method: "bun test", summary: "pass" })),
        },
        { plans: [complete, open, legacy] },
      ),
    );
    expect(receipt.warnings.join("\n")).toContain("plan-open");
    expect(receipt.warnings.join("\n")).toContain("plan-legacy");
    const model = await loadAll(repo);
    const closed = found(model.stages.find((candidate) => candidate.id === "S01"));
    expect(closed.status).toBe("closed");
    const deviations = found(/### Deviations\n\n([\s\S]*?)\n\n### Evidence/.exec(closed.outcome ?? "")?.[1]);
    expect(deviations).toContain("Receipt emails were deferred.");
    expect(deviations).toContain("plan-open");
    expect(deviations).toContain("DC2");
    expect(deviations).toContain("Receipts");
    expect(deviations).toContain("plan-legacy");
    expect(deviations).not.toContain("plan-done");
    expect((await check(model)).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  test("complete plans or no answer leave the given Deviations unchanged", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const close = {
      action: "close" as const,
      id: "S01",
      delivered: "Checkout shipped.",
      evidence: ["DC1", "DC2"].map((criterion) => ({ criterion, result: "pass" as const, method: "bun test", summary: "pass" })),
    };
    const receipt = success(await stage(repo, main, close, { plans: [planFixture({ status: "complete", done: 3 })] }));
    expect(receipt.warnings).toEqual([]);
    const closed = found((await loadAll(repo)).stages.find((candidate) => candidate.id === "S01"));
    expect(/### Deviations\n\n([\s\S]*?)\n\n### Evidence/.exec(closed.outcome ?? "")?.[1]).toBe("None.");
  });
});

describe("planning-basis revision", () => {
  test("ignores dates, status, logs, title, dependencies and outcome but follows objective, scope, criteria and design constraints", () => {
    const revision = planningRevision(stageFixture());
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    const unchanged: Array<Partial<StageDoc>> = [
      { status: "closed" },
      { started: "2026-10-09", closed: "2026-10-10", target: "2027-01-01" },
      { amendments: "### 2026-10-09 — Retarget\n\n- TARGET 2027-01-01 (was: none)\n- Reason: later" },
      { free_work_log: '- 2026-10-09 · session x · "look"' },
      { outcome: "### Delivered\n\nDone." },
      { title: "Renamed", depends_on: ["S09"], follows: "S08", risks: "Other risk" },
    ];
    for (const change of unchanged) expect(planningRevision(stageFixture(change))).toBe(revision);
    const changed: Array<Partial<StageDoc>> = [
      { objective: "Another objective" },
      { scope_in: "- Another slice" },
      { scope_out: "- Other rounds" },
      { done_criteria: "- DC1 — Users can complete the workflow\n  - Verify: manual walkthrough only" },
      { design_constraints: "Another constraint" },
    ];
    for (const change of changed) expect(planningRevision(stageFixture(change))).not.toBe(revision);
    expect(planningRevision(stageFixture({ design_constraints: undefined }))).toBe(
      planningRevision(stageFixture({ design_constraints: "" })),
    );
  });
});

describe("atlas:plans requests", () => {
  function responder(answer: (request: Record<string, unknown>) => unknown) {
    const events = contractEvents();
    events.on("atlas:plans-request", (payload) => {
      const request = payload as Record<string, unknown>;
      events.emit("atlas:plans", answer(request));
    });
    return events;
  }
  const reply = (request: Record<string, unknown>, plans: unknown) => ({
    v: 1,
    sessionId: request.sessionId,
    requestId: request.requestId,
    plans,
  });

  test("a valid answer keeps contract fields only and filters plans of other repositories or stages", () => {
    const plan = planFixture({
      revision: "a".repeat(64),
      gates: [{ gateId: "F1", verdict: "PASS", summary: "ok" }],
      delivery: { mode: "pr", summary: "Opened PR 4" },
      deferred: [
        { id: "O1", title: "Flaky test" },
        { id: "O2", title: "Docs", disposition: "todo", reference: "T009" },
      ],
    });
    const events = responder((request) =>
      reply(request, [
        { ...plan, extra: true },
        planFixture({ planId: "foreign", repoRoot: "/other" }),
        planFixture({ planId: "other-stage", stage: "S02" }),
      ]),
    );
    expect(requestPlans(events, { sessionId: "s1", repoRoot: "/repo", stage: "S01" })).toEqual([plan]);
    const request = events.emitted.find((entry) => entry.channel === "atlas:plans-request")?.payload as Record<string, unknown>;
    expect(request).toMatchObject({ v: 1, sessionId: "s1", repoRoot: "/repo", stage: "S01" });
    expect(typeof request.requestId).toBe("string");
    expect(requestPlans(events, { sessionId: "s1", repoRoot: "/repo" })?.map((entry) => entry.planId)).toEqual(["plan-a", "other-stage"]);
  });

  test("malformed answers and answers to another request, session or version are dropped", () => {
    const malformed: Array<Partial<Record<keyof AtlasStagePlan, unknown>>> = [
      { planId: "" },
      { stage: "stage-1" },
      { criteria: ["DC0"] },
      { criteria: ["DC1", "DC1"] },
      { criteria: "DC1" },
      { revision: "not-a-hash" },
      { status: "running" },
      { done: 4, total: 3 },
      { done: -1 },
      { directory: "relative/path" },
      { gates: [{ gateId: "F1", verdict: "PASS", summary: null }] },
      { delivery: { mode: "direct", summary: "x" } },
      { deferred: [{ id: "O1", title: "x", disposition: "maybe" }] },
      { deferred: [{ id: "O1", title: "x", reference: 3 }] },
    ];
    for (const change of malformed) {
      const events = responder((request) => reply(request, [planFixture(), { ...planFixture(), ...change }]));
      expect(requestPlans(events, { sessionId: "s1", repoRoot: "/repo", stage: "S01" })).toBeUndefined();
    }
    const answers: Array<(request: Record<string, unknown>) => unknown> = [
      (request) => ({ ...reply(request, []), requestId: "another" }),
      (request) => ({ ...reply(request, []), sessionId: "another" }),
      (request) => ({ ...reply(request, []), v: 2 }),
      (request) => ({ ...reply(request, []), plans: {} }),
    ];
    for (const answer of answers) expect(requestPlans(responder(answer), { sessionId: "s1", repoRoot: "/repo" })).toBeUndefined();
    expect(requestPlans(contractEvents(), { sessionId: "s1", repoRoot: "/repo" })).toBeUndefined();
    expect(
      requestPlans(
        responder((request) => reply(request, [])),
        { sessionId: "s1", repoRoot: "/repo" },
      ),
    ).toEqual([]);
  });
});

describe("readiness", () => {
  test("only planned stages of the active round are startable or blocked, by unclosed dependencies", () => {
    const model = modelFixture();
    model.rounds = [roundFixture(), roundFixture({ id: "R2", title: "Next", status: "planned", opened: null })];
    model.stages = [
      stageFixture({ id: "S01", status: "closed" }),
      stageFixture({ id: "S02", depends_on: ["S01"] }),
      stageFixture({ id: "S03", depends_on: ["S01", "S02"] }),
      stageFixture({ id: "S04", status: "dropped" }),
      stageFixture({ id: "S05", depends_on: ["S04"] }),
      stageFixture({ id: "S06", status: "active", depends_on: ["S01"] }),
      stageFixture({ id: "S07", round: "R2", depends_on: ["S03"] }),
    ];
    const status = roadmapStatus("/repo", model, undefined, "2026-10-08");
    expect(Object.fromEntries(status.stages.map((entry) => [entry.id, [entry.startable, entry.blockedBy, entry.dependsOn]]))).toEqual({
      S01: [false, [], []],
      S02: [true, [], ["S01"]],
      S03: [false, ["S02"], ["S01", "S02"]],
      S04: [false, [], []],
      S05: [false, ["S04"], ["S04"]],
      S06: [false, [], ["S01"]],
      S07: [false, [], ["S03"]],
    });
    const readiness = renderInjection(model, undefined, "2026-10-08")
      .split("\n")
      .filter((line) => line.startsWith("Readiness:"));
    expect(readiness).toHaveLength(1);
    for (const id of ["S02", "S03", "S05"]) expect(readiness[0]).toContain(id);
    for (const id of ["S06", "S07"]) expect(readiness[0]).not.toContain(id);
  });
});

describe("planning handoff and close reminder", () => {
  function activeModel() {
    const model = modelFixture();
    const long = `Shipped ${"payments ".repeat(200)}END-OF-DELIVERED`;
    model.stages = [
      stageFixture({
        id: "S01",
        status: "closed",
        outcome: `### Delivered\n\n${long}\n\n### Deviations\n\nRefunds moved to S04.\n\n### Evidence\n\n- DC1 — pass — Verify: a → b`,
      }),
      stageFixture({
        id: "S02",
        path: "docs/roadmap/01-launch/stages/02-receipts.md",
        title: "Receipts",
        status: "active",
        depends_on: ["S01"],
        done_criteria: threeCriteria,
      }),
    ];
    return { model, current: found(model.stages[1]) };
  }

  test("the handoff carries the round charter, predecessor outcomes and per-criterion plan coverage", () => {
    const { model, current } = activeModel();
    const round = found(model.rounds[0]);
    const plans = [
      planFixture({
        planId: "p-done",
        name: "First",
        stage: "S02",
        status: "complete",
        done: 3,
        total: 3,
        revision: planningRevision(current),
      }),
      planFixture({ planId: "p-open", name: "Second", stage: "S02", criteria: ["DC2"], revision: "0".repeat(64) }),
      planFixture({ planId: "p-legacy", name: "Legacy", stage: "S02", criteria: undefined }),
    ];
    const handoff = renderHandoff(model, current, "2026-10-08", plans);
    for (const text of [round.goal, round.constraints, round.non_goals]) expect(handoff).toContain(text);
    expect(handoff).toContain("Refunds moved to S04.");
    expect(handoff).toContain("Shipped payments");
    expect(handoff).not.toContain("END-OF-DELIVERED");
    expect(handoff).toContain("docs/roadmap/01-launch/stages/01-launch.md");
    const section = found(/## Plans for this stage\n\n([\s\S]*?)(?=\n## )/.exec(handoff)?.[1]);
    const line = (prefix: string) => found(section.split("\n").find((entry) => entry.startsWith(prefix)));
    expect(line("- DC1 —")).toContain("p-done");
    expect(line("- DC2 —")).toContain("p-open");
    expect(line("- DC2 —")).not.toContain("p-done");
    expect(line("- DC3 —")).not.toMatch(/p-/);
    const planLine = (id: string) => found(section.split("\n").find((entry) => entry.includes(`(${id})`) && entry.startsWith("- ")));
    expect(planLine("p-open")).toContain("drift");
    expect(planLine("p-done")).not.toContain("drift");
    expect(planLine("p-legacy")).toContain("undeclared");
    expect(renderHandoff(model, current, "2026-10-08")).not.toContain("## Plans for this stage");
  });

  test("the close reminder reports coverage across plans, unfinished, undeclared, drifted and untriaged work, bounded", () => {
    const { current } = activeModel();
    const pending: PendingClose[] = [
      {
        v: 1,
        repoRoot: "/repo",
        stage: "S02",
        at: "2026-10-08T00:00:00.000Z",
        planId: "p-done",
        gates: [{ gateId: "F1", verdict: "PASS", summary: "ok" }],
      },
    ];
    const done = planFixture({
      planId: "p-done",
      name: "First",
      stage: "S02",
      status: "complete",
      done: 3,
      total: 3,
      revision: planningRevision(current),
    });
    const open = planFixture({
      planId: "p-open",
      name: "Second",
      stage: "S02",
      criteria: ["DC2"],
      revision: "0".repeat(64),
      deferred: [
        { id: "O1", title: "Flaky retry" },
        { id: "O2", title: "Docs gap", disposition: "todo", reference: "T009" },
      ],
    });
    const legacy = planFixture({ planId: "p-legacy", name: "Legacy", stage: "S02", criteria: undefined, status: "complete" });
    const text = renderCloseReminder(current, pending, [done, open, legacy]).join("\n");
    expect(text).toContain("First (p-done)");
    expect(text).toContain("F1: PASS — ok");
    for (const id of ["p-open", "p-legacy", "O1", "Flaky retry"]) expect(text).toContain(id);
    expect(text).not.toContain("O2");
    const last = found(text.split("\n").at(-1));
    expect(last).toContain("DC2");
    expect(last).toContain("DC3");
    const covered = renderCloseReminder(current, pending, [planFixture({ ...done, criteria: ["DC1", "DC2", "DC3"] })]);
    expect(found(covered.at(-1))).not.toMatch(/DC[23]/);

    const many = Array.from({ length: 40 }, (_, index) =>
      planFixture({
        planId: `p-${index}`,
        name: `Plan ${"x".repeat(200)} ${index}`,
        stage: "S02",
        revision: "1".repeat(64),
        criteria: index % 2 ? undefined : ["DC1"],
        deferred: Array.from({ length: 10 }, (_, finding) => ({ id: `O${finding + 1}`, title: "y".repeat(300) })),
      }),
    );
    const bounded = renderCloseReminder(current, [...pending, { ...found(pending[0]), planId: "p-1" }], many);
    expect(bounded.length).toBeLessThanOrEqual(16);
    for (const entry of bounded) expect(entry.length).toBeLessThan(1500);

    const alone = renderCloseReminder(current, pending, undefined);
    expect(alone).toHaveLength(3);
    expect(alone.join("\n")).toContain("p-done");
  });

  test("the close reminder counts a completion that atlas:plans does not list as a complete plan with undeclared coverage", () => {
    const { current } = activeModel();
    const completion = (planId: string, stage = "S02"): PendingClose => ({
      v: 1,
      repoRoot: "/repo",
      stage,
      at: "2026-10-08T00:00:00.000Z",
      planId,
      gates: [{ gateId: "F1", verdict: "PASS", summary: "ok" }],
    });
    const open = planFixture({ planId: "p-open", name: "Second", stage: "S02", criteria: ["DC2"], revision: planningRevision(current) });
    // Approved before S02 was bound, p-late completed for the stage the executing session had bound; the answer omits it.
    const text = renderCloseReminder(current, [completion("p-other", "S09"), completion("p-late")], [open]).join("\n");
    expect(text).toContain("Criteria coverage across 2 plans");
    expect(text).toContain("Coverage undeclared: p-late.");
    expect(text).not.toContain("p-other");
    const verdict = found(text.split("\n").find((line) => line.startsWith("Not ready by declarations")));
    expect(verdict).toContain("DC1, DC2, DC3 have no complete plan");
    expect(verdict).toContain("(complete plans with undeclared coverage may still supply evidence)");
    // A plan the answer lists keeps its reported coverage and status.
    const listed = renderCloseReminder(current, [completion("p-open")], [open]).join("\n");
    expect(listed).not.toContain("Coverage undeclared");
    expect(found(listed.split("\n").at(-1))).not.toContain("undeclared coverage");
  });
});

describe("roadmap:binding and roadmap:stage answers", () => {
  function contract(cwd: string, sessionId = "contract-session") {
    const events = contractEvents();
    const handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
    const entries: unknown[] = [];
    const pi = {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers[name] ??= [];
        handlers[name].push(handler);
      },
      events,
      logger: { warn() {}, info() {}, error() {}, debug() {} },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
    } as unknown as ExtensionAPI;
    const ses = new RoadmapSession(pi);
    registerPrometheusContract(pi, ses);
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
      agent: { kind: "main" },
    } as unknown as ExtensionContext;
    for (const handler of handlers.session_start ?? []) handler({ type: "session_start" }, ctx);
    const ask = (channel: string, answer: string, payload: object): unknown[] => {
      const answers: unknown[] = [];
      const off = events.on(answer, (value) => answers.push(value));
      events.emit(channel, payload);
      off();
      return answers;
    };
    return { ses, ctx, ask, sessionId, events, entries };
  }

  test("stage requests answer the current planning basis and validate requests", async () => {
    const repo = await initialized();
    const { ask, sessionId } = contract(repo.repoRoot);
    const request = { v: 1, sessionId, requestId: "r1", repoRoot: repo.repoRoot, stage: "S01" };
    const current = found((await loadAll(repo)).stages[0]);
    expect(ask("roadmap:stage-request", "roadmap:stage", request)).toEqual([
      {
        v: 1,
        sessionId,
        requestId: "r1",
        repoRoot: repo.repoRoot,
        stage: {
          id: "S01",
          title: "Checkout",
          round: "R1",
          status: "planned",
          criteria: ["DC1", "DC2"],
          revision: planningRevision(current),
          activation: { action: "start" },
        },
      },
    ]);
    expect(ask("roadmap:stage-request", "roadmap:stage", { ...request, stage: "S09" })).toEqual([
      { v: 1, sessionId, requestId: "r1", repoRoot: repo.repoRoot },
    ]);
    for (const invalid of [
      { ...request, v: 2 },
      { ...request, sessionId: "another" },
      { ...request, requestId: "" },
      { ...request, stage: "R1" },
      { ...request, repoRoot: "/another/repository" },
    ])
      expect(ask("roadmap:stage-request", "roadmap:stage", invalid)).toEqual([]);
    const index = join(repo.roadmapDir, "README.md");
    const text = await readFile(index, "utf8");
    await writeFile(index, "not a roadmap");
    expect(ask("roadmap:stage-request", "roadmap:stage", request)).toEqual([{ v: 1, sessionId, requestId: "r1", repoRoot: repo.repoRoot }]);
    await writeFile(index, text);
  });

  test("an active stage with no commit yet owes its stage, round and index files", async () => {
    const repo = await initialized();
    const { ask, sessionId } = contract(repo.repoRoot);
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const current = found((await loadAll(repo)).stages[0]);
    const relative = (path: string) => path.slice(repo.repoRoot.length + 1);
    const [answer] = ask("roadmap:stage-request", "roadmap:stage", {
      v: 1,
      sessionId,
      requestId: "c1",
      repoRoot: repo.repoRoot,
      stage: "S01",
    });
    expect(answer).toMatchObject({
      stage: {
        status: "active",
        activation: {
          action: "commit",
          files: [relative(current.path), relative(join(current.path, "../../README.md")), "docs/roadmap/README.md"],
        },
      },
    });
  });

  test("the binding answer adds the bound stage's current criteria and revision", async () => {
    const repo = await initialized();
    const { ses, ctx, ask, sessionId } = contract(repo.repoRoot);
    success(await stage(repo, main, { action: "start", id: "S01" }));
    ses.bind(ctx, repo.repoRoot, "S01");
    const binding = (): Record<string, unknown> | undefined => {
      const [answer] = ask("roadmap:binding-request", "roadmap:binding", { v: 1, sessionId, requestId: "b1" });
      if (!answer || typeof answer !== "object" || !("stage" in answer) || !answer.stage || typeof answer.stage !== "object")
        return undefined;
      return { ...answer.stage };
    };
    const before = found(binding());
    expect(before).toMatchObject({ id: "S01", title: "Checkout", round: "R1", criteria: ["DC1", "DC2"] });
    expect(before.revision).toBe(planningRevision(found((await loadAll(repo)).stages[0])));
    success(await stage(repo, main, { action: "amend", id: "S01", reason: "Receipts moved", amendments: { remove: ["DC2"] } }));
    const after = found(binding());
    expect(after.criteria).toEqual(["DC1"]);
    expect(after.revision).not.toBe(before.revision);
  });

  test("a start in plan mode binds a planned stage without writing; execution then owes the start and its commit", async () => {
    const repo = await initialized();
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo.repoRoot, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
    };
    git("add", "-A");
    git("commit", "-qm", "roadmap");
    const { ses, ctx, ask, sessionId, entries } = contract(repo.repoRoot);
    const owed = () =>
      ask("roadmap:stage-request", "roadmap:stage", { v: 1, sessionId, requestId: "a1", repoRoot: repo.repoRoot, stage: "S01" })[0];
    entries.push({ type: "mode_change", id: "plan", mode: "plan" });
    expect(planModeActive(ctx)).toBe(true);
    const before = await readFile(found((await loadAll(repo)).stages[0]).path, "utf8");
    const bound = success(await stage(repo, main, { action: "start", id: "S01" }, { planning: true }));
    expect(bound.changedFiles).toEqual([]);
    expect(bound.handoff).toBeDefined();
    const planned = found((await loadAll(repo)).stages[0]);
    expect(planned.status).toBe("planned");
    expect(await readFile(planned.path, "utf8")).toBe(before);
    ses.bind(ctx, repo.repoRoot, "S01");
    const model = await loadAll(repo);
    expect(ses.validateBinding(ctx, repo.repoRoot, model)).toBeUndefined();
    expect(roadmapStatus(repo.repoRoot, model, ses.getBinding(repo.repoRoot)).boundStage).toBe("S01");
    const [binding] = ask("roadmap:binding-request", "roadmap:binding", { v: 1, sessionId, requestId: "b1" });
    expect(binding).toMatchObject({ stage: { id: "S01" } });
    expect(owed()).toMatchObject({ stage: { status: "planned", activation: { action: "start" } } });

    entries.push({ type: "mode_change", id: "exit", mode: "none" });
    expect(planModeActive(ctx)).toBe(false);
    const started = success(await stage(repo, main, { action: "start", id: "S01" }));
    expect(owed()).toMatchObject({ stage: { status: "active", activation: { action: "commit", files: started.changedFiles } } });
    expect(started.changedFiles).toHaveLength(3);
    git("add", "-A");
    git("commit", "-qm", "start S01");
    expect(owed()).toMatchObject({ stage: { status: "active" } });
    expect(owed()).not.toHaveProperty("stage.activation");
  });

  test("the binding answer says whether the roadmap is usable in the repository: Git, an initialized roadmap and the adr plugin", async () => {
    const usable = (cwd: string, adr: boolean): unknown => {
      const { ask, sessionId, events } = contract(cwd);
      if (adr)
        events.on("adr:binding-request", (raw) =>
          events.emit("adr:binding", { ...(raw as object), v: 1, toolSourcePath: "/plugins/adr/src/index.ts", api: adrApi() }),
        );
      const [answer] = ask("roadmap:binding-request", "roadmap:binding", { v: 1, sessionId, requestId: "u1" });
      return (answer as { usable?: unknown } | undefined)?.usable;
    };
    const repo = await initialized();
    expect(usable(repo.repoRoot, true)).toBe(true);
    // roadmap_todo refuses without the adr plugin, so the roadmap is not usable either.
    expect(usable(repo.repoRoot, false)).toBe(false);
    const index = join(repo.roadmapDir, "README.md");
    const text = await readFile(index, "utf8");
    await writeFile(index, "not a roadmap");
    expect(usable(repo.repoRoot, true)).toBe(false);
    await writeFile(index, text);
    const uninitialized = await mkdtemp(join(tmpdir(), "roadmap-uninitialized-"));
    temporary.push(uninitialized);
    if ((await Bun.spawn(["git", "init", "-q", uninitialized]).exited) !== 0) throw new Error("git init failed");
    expect(usable(uninitialized, true)).toBe(false);
    // A roadmap index outside a Git work tree is still unusable: roadmap tools refuse without Git.
    const plain = await mkdtemp(join(tmpdir(), "roadmap-no-git-"));
    temporary.push(plain);
    await mkdir(join(plain, "docs/roadmap"), { recursive: true });
    await writeFile(join(plain, "docs/roadmap/README.md"), text);
    expect(usable(plain, true)).toBe(false);
  });
});
