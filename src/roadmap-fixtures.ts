import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { type AdrDoc, buildAdrBody, renderAdr, renderIndex } from "../plugins/adr/src/documents.ts";
import { registerService } from "../plugins/adr/src/service.ts";
import { type AdrApi, type AdrRecord, type ContractEvents, resolveStage } from "../plugins/roadmap/src/adr.ts";
import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import {
  generatedBlock,
  loadAll,
  type Model,
  parseRoadmapIndex,
  type Repo,
  type RoundDoc,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  type StageDoc,
  type TodoDoc,
} from "../plugins/roadmap/src/documents.ts";

/**
 * The adr plugin's real v1 service without a host session, with roadmap's stage resolver registered the way the roadmap
 * extension registers it. Operation tests attach it to a Repo as the extension's requireRepo does.
 */
export function adrApi(): AdrApi {
  const host = { on() {}, events: { on: () => () => {}, emit() {} } } as unknown as ExtensionAPI;
  const { api } = registerService(host, () => {});
  api.registerStageResolver(resolveStage);
  return api;
}

/** A synchronous pi.events stand-in: listeners run inside emit, like the host bus's handlers before their first await. */
export function contractEvents(): ContractEvents & { emitted: Array<{ channel: string; payload: unknown }> } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  return {
    emitted,
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel, payload) {
      emitted.push({ channel, payload });
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
  };
}

/** An `atlas:plans` entry as omo-prometheus answers it. */
export function planFixture(overrides: Partial<AtlasStagePlan> = {}): AtlasStagePlan {
  return {
    planId: "plan-a",
    name: "Checkout plan",
    repoRoot: "/repo",
    stage: "S01",
    criteria: ["DC1"],
    status: "unfinished",
    done: 1,
    total: 3,
    gates: [],
    deferred: [],
    directory: "/sessions/atlas/checkout-plan--plan-a",
    ...overrides,
  };
}

export function stageFixture(overrides: Partial<StageDoc> = {}): StageDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/stages/01-launch.md",
    id: "S01",
    title: "Launch: usable | increment",
    round: "R1",
    status: "planned",
    target: null,
    depends_on: [],
    follows: null,
    created: "2026-10-06",
    started: null,
    closed: null,
    closed_sha256: null,
    objective: "An end-to-end usable increment.  \n\nKeep **free Markdown**, [a link](https://example.com) and trailing spaces.  ",
    scope_in: "- First slice\n- Second slice",
    scope_out: "- Later rounds",
    done_criteria: "- DC1 — Users can complete the workflow\n  - Verify: `bun test` and a manual walkthrough",
    design_constraints: "See ADR-0001.",
    risks: "A risk.\n\n### Mitigation\n\nTest it first.",
    amendments: "### 2026-10-06 — A note\n\n- Reason: retain free Markdown",
    free_work_log: '- 2026-10-06 · session abc123 · "inspect code"',
    ...overrides,
  };
}

export function roundFixture(overrides: Partial<RoundDoc> = {}): RoundDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/README.md",
    id: "R1",
    title: "Launchable v1",
    status: "active",
    target: null,
    opened: "2026-10-06",
    closed: null,
    frozen_sha256: null,
    goal: "A working launch.  \n\nMeasurable and usable.",
    constraints: "- Keep the host floor",
    non_goals: "- No new storage engine",
    principles: "- Use the documented choice (ADR-0001).",
    stages: generatedBlock("stages", renderStageTable([], 1)),
    known_limitations: "",
    ...overrides,
  };
}

export function todoFixture(overrides: Partial<TodoDoc> = {}): TodoDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/TODO.md",
    round: "R1",
    items: [
      {
        id: "T001",
        title: "Carry-over",
        status: "open",
        severity: "normal",
        source: "S01 (2026-10-06)",
        target: "S01",
        body: "See ADR-0001.\n\nFree **Markdown**.  ",
      },
    ],
    ...overrides,
  };
}

/** An ADR in the adr plugin's format; `path` is repository-relative until diskFixture places it. */
export function adrFixture(overrides: Partial<AdrDoc> = {}): AdrDoc {
  const title = "Choose the shared host";
  return {
    legacy: false,
    format: 1,
    path: "docs/adr/0001-shared-host.md",
    id: "ADR-0001",
    title,
    supersedes: [],
    stage: "S01",
    status: "accepted",
    date: "2026-10-06",
    decision_makers: ["Project owner", "Engineer, developer"],
    consulted: [],
    informed: [],
    body: buildAdrBody(title, {
      context: "We need a shared host.  \n\nFree-form context.",
      drivers: "* Compatibility\n* Reliability",
      options: ["Use the host", "Build a replacement"],
      outcome: 'Chosen option: "Use the host", because compatibility matters.',
      consequences: "* Good, because it avoids duplicated state\n* Bad, because it needs a supported host",
      confirmation: "Run the host smoke test.",
      pros_cons: "### Use the host\n\n* Good, because it is already available",
      more_info: "### 2026-10-06\n\nA dated note.  ",
    }),
    ...overrides,
  };
}

/** The record the adr service reports for `doc`, as roadmap's loadAll stores it in `Model.adrs`. */
export function adrRecord(doc: AdrDoc, repoRoot = ""): AdrRecord {
  const { legacy, format: _format, path, body, ...fields } = doc;
  return { ...fields, legacy, path: repoRoot ? relative(repoRoot, path) : path, body: body.replace(/^# [^\n]*\n\n?/, "") };
}

export function modelFixture(): Model {
  const stages = [stageFixture()];
  const rounds = [roundFixture({ stages: generatedBlock("stages", renderStageTable(stages, 1)) })];
  const index = { format: 1 as const, path: "docs/roadmap/README.md", title: "Example project", body: "" };
  return { index, rounds, stages, todos: [todoFixture()], adrs: { managed: true, records: [adrRecord(adrFixture())], parseErrors: [] } };
}

/** A format-2 roadmap in mid-flight for the fullscreen console: history, an active round with every stage status, planned rounds. */
export function consoleModelFixture(): Model {
  const stage = (id: string, round: string, title: string, overrides: Partial<StageDoc> = {}): StageDoc =>
    stageFixture({
      format: 2,
      path: `docs/roadmap/${round}/stages/${id}.md`,
      id,
      round,
      title,
      created: round === "R1" ? "2026-08-01" : round === "R2" ? "2026-09-12" : "2026-10-01",
      ...overrides,
    });
  const round = (id: string, title: string, overrides: Partial<RoundDoc>): RoundDoc =>
    roundFixture({ format: 2, path: `docs/roadmap/${id}/README.md`, id, title, ...overrides });
  const stages = [
    stage("S01", "R1", "Product catalog", { status: "closed", started: "2026-08-02", closed: "2026-08-20" }),
    stage("S02", "R1", "Search", { status: "closed", started: "2026-08-21", closed: "2026-09-08" }),
    stage("S04", "R2", "Cart persistence", { status: "closed", started: "2026-09-12", closed: "2026-09-19" }),
    stage("S05", "R2", "Payment provider integration with retries, idempotency keys and webhook signature verification", {
      status: "active",
      target: "2026-10-05",
      started: "2026-09-20",
      depends_on: ["S04"],
      objective: "Customers pay by card through the provider, and a failed or repeated webhook never charges twice.",
      scope_in: "- Card payments with 3-D Secure\n- Webhook verification and retries",
      scope_out: "- Refunds (R3)\n- Wallets",
      done_criteria:
        "- DC1 — A card payment completes end to end\n  - Verify: `bun test checkout` and a sandbox walkthrough\n- DC2 — A replayed webhook is ignored\n  - Verify: `bun test webhooks`",
      design_constraints: "Follow ADR-0003 and ADR-0004.",
      risks: "Provider sandbox outages slow testing.",
      amendments: "",
      free_work_log: "",
    }),
    stage("S06", "R2", "Order confirmation emails", { depends_on: ["S05"], target: "2026-10-25" }),
    stage("S07", "R2", "Checkout analytics", { depends_on: ["S04"] }),
    stage("S08", "R2", "Legacy coupon import", { status: "dropped", closed: "2026-09-25" }),
    stage("S09", "R3", "Refund API", { depends_on: [] }),
  ];
  const rounds = [
    round("R1", "Foundation", { status: "closed", opened: "2026-08-01", closed: "2026-09-10", frozen_sha256: "0".repeat(64) }),
    round("R2", "Checkout and payments", {
      status: "active",
      target: "2026-10-31",
      opened: "2026-09-12",
      goal: "A customer can pay for a cart by card and receives a confirmation.",
    }),
    round("R3", "Refunds and disputes", { status: "planned", target: "2026-12-15", opened: null, goal: "Support can refund an order." }),
    round("R4", "Internationalization of the storefront, currency handling and translated transactional emails", {
      status: "planned",
      opened: null,
      goal: "Shop in three languages and currencies.",
    }),
  ];
  const item = (id: string, title: string, overrides: Partial<TodoDoc["items"][number]>): TodoDoc["items"][number] => ({
    id,
    title,
    status: "open",
    severity: "normal",
    source: "S05 (2026-09-28)",
    body: "",
    ...overrides,
  });
  const todos: TodoDoc[] = [
    todoFixture({
      format: 2,
      path: "docs/roadmap/R2/TODO.md",
      round: "R2",
      items: [
        item("T010", "Handle a provider timeout during the 3-D Secure challenge", {
          severity: "high",
          target: "S05",
          body: "Seen twice in the sandbox; the order stays pending.",
        }),
        item("T011", "Template review with legal", { target: "S06" }),
        item("T012", "Shard the order table", { severity: "low", trigger: "Traffic passes 1k orders a day" }),
        item("T013", "Retry budget alerting", { status: "resolved", target: "S05", reference: "abc1234" }),
      ],
    }),
    todoFixture({
      format: 2,
      path: "docs/roadmap/R3/TODO.md",
      round: "R3",
      items: [item("T014", "Partial refunds for bundles", { target: "S09" })],
    }),
  ];
  const index = { format: 2 as const, path: "docs/roadmap/README.md", title: "Shop platform", body: "" };
  const adrs = [
    adrRecord(adrFixture({ id: "ADR-0003", title: "Use one card provider", stage: "S05", status: "accepted" })),
    adrRecord(adrFixture({ id: "ADR-0004", title: "Retry webhooks with exponential backoff", stage: "S05", status: "proposed" })),
  ];
  return { index, rounds, stages, todos, adrs: { managed: true, records: adrs, parseErrors: [] } };
}

const temporaryDirectories: string[] = [];
/** A git work tree with the fixture roadmap and one adr-plugin ADR; `repo` carries the real ADR service. */
export async function diskFixture(): Promise<{ repo: Repo; model: Model; adrs: AdrDoc[] }> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-t2-"));
  temporaryDirectories.push(root);
  const git = Bun.spawn(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  if ((await git.exited) !== 0) throw new Error(await new Response(git.stderr).text());
  const repo: Repo = {
    repoRoot: root,
    commonDir: join(root, ".git"),
    roadmapDir: join(root, "docs/roadmap"),
    adrDir: join(root, "docs/adr"),
    adr: adrApi(),
  };
  const model = modelFixture();
  const adrs = [adrFixture()];
  model.repo = repo;
  model.index.path = join(root, model.index.path);
  for (const doc of [...model.rounds, ...model.stages, ...model.todos, ...adrs]) doc.path = join(root, doc.path);
  const files = [
    { path: model.index.path, content: renderRoadmapIndex(model.index, model.rounds, model.stages) },
    ...model.rounds.map((doc) => ({ path: doc.path, content: renderRound(doc, model.stages) })),
    ...model.stages.map((doc) => ({ path: doc.path, content: renderStage(doc) })),
    ...model.todos.map((doc) => ({ path: doc.path, content: renderTodo(doc) })),
    ...adrs.map((doc) => ({ path: doc.path, content: renderAdr(doc) })),
    { path: join(root, "docs/adr/README.md"), content: renderIndex(undefined, adrs) },
  ];
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  return { repo, model, adrs };
}

/**
 * Rewrites a repository that /init-project just wrote as releases before format-2 initialization wrote it: every
 * managed roadmap file at format 1, with the format-1 directory text and generated tables. ADR files stay untouched.
 */
export async function asFormatOne(repo: Repo): Promise<void> {
  const model = await loadAll(repo);
  if (model.parseErrors?.length) throw new Error(`Cannot rewrite a damaged roadmap: ${JSON.stringify(model.parseErrors)}`);
  const directoryText = /## How this directory works\n[\s\S]*?(?=## Rounds\n)/;
  const legacy = parseRoadmapIndex(renderRoadmapIndex({ ...model.index, format: 1, body: "" })).body.match(directoryText)?.[0];
  if (!legacy) throw new Error("The format-1 directory text was not rendered.");
  model.index.body = model.index.body.replace(directoryText, () => legacy);
  model.index.format = 1;
  for (const doc of [...model.rounds, ...model.stages, ...model.todos]) {
    if ("target" in doc && doc.target !== null) throw new Error(`${doc.id} has a target date, which format 1 cannot hold.`);
    doc.format = 1;
  }
  for (const round of model.rounds)
    round.stages = generatedBlock(
      "stages",
      renderStageTable(
        model.stages.filter((stage) => stage.round === round.id),
        1,
      ),
    );
  const files = [
    { path: model.index.path, content: renderRoadmapIndex(model.index, model.rounds, model.stages) },
    ...model.rounds.map((doc) => ({ path: doc.path, content: renderRound(doc, model.stages) })),
    ...model.stages.map((doc) => ({ path: doc.path, content: renderStage(doc) })),
    ...model.todos.map((doc) => ({ path: doc.path, content: renderTodo(doc) })),
  ];
  for (const file of files) await writeFile(file.path, file.content);
}

export async function cleanupFixtures(): Promise<void> {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
}
