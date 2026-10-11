import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTheme, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import { type ConsoleChoice, type ConsoleState, type PreviewRequest, PreviewView, RoadmapConsole } from "../plugins/roadmap/src/console.ts";
import { type Model, renderRound, renderStage } from "../plugins/roadmap/src/documents.ts";
import { PACKAGE_NAME, parseUiMenu, type UiMenu, uiMenuReader } from "../plugins/roadmap/src/settings.ts";
import { createTuiUi, HeadlessUi, type RoadmapUiContext } from "../plugins/roadmap/src/ui.ts";
import { consoleModelFixture, planFixture } from "./roadmap-fixtures.ts";

beforeAll(async () => {
  await initTheme();
});

const ON = "2026-10-11";
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  home: "\x1b[H",
  end: "\x1b[F",
  pageDown: "\x1b[6~",
  tab: "\t",
  shiftTab: "\x1b[Z",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
};

const text = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n"));

function tuiOf(rows: number): TUI {
  return { requestRender() {}, terminal: { rows } } as unknown as TUI;
}

/** Atlas answers: two plans for S05 (one drifted), none yet for S06; other stages get no answer, as without omo-prometheus. */
const PLANS: Readonly<Record<string, AtlasStagePlan[]>> = {
  S05: [
    planFixture({ planId: "plan-a", name: "Card payments", stage: "S05", criteria: ["DC1"], status: "complete", done: 6, total: 6 }),
    planFixture({
      planId: "plan-b",
      name: "Webhook hardening",
      stage: "S05",
      criteria: ["DC2"],
      done: 2,
      total: 5,
      revision: "0".repeat(64),
    }),
  ],
  S06: [],
};

function mount(model: Model = consoleModelFixture(), state: ConsoleState = {}, rows = 24) {
  const choices: Array<ConsoleChoice | undefined> = [];
  const asked: string[] = [];
  const component = new RoadmapConsole(
    model,
    { on: ON, ...state },
    theme,
    tuiOf(rows),
    (choice) => choices.push(choice),
    (stage) => {
      asked.push(stage);
      return PLANS[stage];
    },
  );
  return {
    component,
    choices,
    asked,
    screen: (width = 100) => text(component.render(width)),
    type: (...keys: string[]) => {
      for (const key of keys) component.handleInput(key);
    },
  };
}

/** The sidebar column of the body rows. */
function sidebar(screen: string): string[] {
  return screen
    .split("\n")
    .map((line) => line.split("│")[1]?.trim() ?? "")
    .filter(Boolean);
}

const EMPTY: Model = { index: { format: 2, path: "", title: "Fresh", body: "" }, rounds: [], stages: [], todos: [] };

test("console frames fill 80x24 and 160x48 exactly in every section and item, long titles included", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
  ] as const) {
    for (const model of [consoleModelFixture(), EMPTY]) {
      const { component, type } = mount(model, {}, rows);
      for (let section = 0; section < 3; section++) {
        for (let item = 0; item < 6; item++) {
          const lines = component.render(width);
          expect(lines).toHaveLength(rows);
          expect(lines.filter((line) => visibleWidth(line) !== width)).toEqual([]);
          type(KEY.down, KEY.pageDown);
        }
        type(KEY.tab);
      }
    }
  }
});

test("console frames never exceed narrow widths", () => {
  for (const width of [8, 20, 30, 40, 60]) {
    const { component, type } = mount(undefined, {}, 12);
    for (let section = 0; section < 3; section++) {
      expect(component.render(width).filter((line) => visibleWidth(line) > width)).toEqual([]);
      type(KEY.tab);
    }
  }
});

test("console opens on the active round's stages with the active stage selected and its detail", () => {
  const { screen } = mount();
  const shown = screen(160);
  expect(shown).toMatch(/Roadmap · Shop platform/);
  expect(shown).toMatch(/R2 Checkout and payments · 2\/5 stages settled · 4 open TODOs/);
  expect(shown).toMatch(/1 overdue stage · 2 planned rounds/);
  expect(sidebar(shown).find((row) => row.includes("❯"))).toMatch(/S05 Payment provider/);
  expect(shown).toMatch(/S05 — Payment provider integration/);
  expect(shown).toMatch(/Target {4}2026-10-05 · overdue/);
  expect(shown).toMatch(/ADR-0004 Retry webhooks with exponential backoff · proposed/);
  expect(shown).toMatch(/T010 Handle a provider timeout/);
  // The resolved T013 targets S05 too but is not open.
  expect(shown).not.toMatch(/T013/);
  expect(shown).toMatch(/shift\+x|⇧X/i);
});

test("console navigation moves within a section and Tab cycles sections, remembering each selection", () => {
  const { screen, type } = mount();
  type(KEY.down);
  expect(screen()).toMatch(/S06 — Order confirmation emails/);
  expect(screen()).toMatch(/blocked by S05/);
  type(KEY.down);
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  expect(screen()).toMatch(/ready to start/);
  type(KEY.home);
  expect(screen()).toMatch(/S04 — Cart persistence/);
  type(KEY.end);
  expect(screen()).toMatch(/S08 — Legacy coupon import/);
  type(KEY.end, KEY.down);
  expect(screen()).toMatch(/S08 — Legacy coupon import/);

  type(KEY.tab);
  expect(screen()).toMatch(/R2 — Checkout and payments/);
  type(KEY.down);
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  expect(screen()).toMatch(/next to activate/);
  type(KEY.tab);
  expect(screen()).toMatch(/T010 — Handle a provider timeout/);
  type(KEY.tab);
  expect(screen()).toMatch(/S08 — Legacy coupon import/);
  type(KEY.shiftTab);
  expect(screen()).toMatch(/T010 — /);
  type(KEY.shiftTab);
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
});

test("console typing searches the section; Esc clears the search first and then closes", () => {
  const { screen, type, choices } = mount();
  type("s", "0", "7");
  expect(screen()).toMatch(/Search: s07 {2}1\/5/);
  expect(sidebar(screen()).filter((row) => /S0\d/.test(row))).toHaveLength(1);
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  type("x");
  expect(screen()).toMatch(/Nothing matches the search/);
  type(KEY.backspace);
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  type(KEY.escape);
  expect(choices).toEqual([]);
  expect(screen()).toMatch(/Type to search/);
  // The cleared search keeps the item it had found.
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  type(KEY.escape);
  expect(choices).toEqual([undefined]);
  type(KEY.escape, KEY.enter);
  expect(choices).toEqual([undefined]);
});

test("console Enter navigates without answering: a stage to its round, a round to its stages", () => {
  const { screen, type, choices } = mount();
  type(KEY.enter);
  expect(screen()).toMatch(/R2 — Checkout and payments/);
  type(KEY.down, KEY.enter);
  // Stages now lists R3 and says so; its planned stage is selected.
  expect(screen()).toMatch(/◀ Stages R3 1 ▶/);
  expect(screen()).toMatch(/S09 — Refund API/);
  type(KEY.enter);
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  type(KEY.up, KEY.up, KEY.enter);
  expect(screen()).toMatch(/◀ Stages R1 2 ▶/);
  expect(screen()).toMatch(/S01 — Product catalog/);
  type(KEY.tab, KEY.down, KEY.enter);
  expect(screen()).toMatch(/◀ Stages 5 ▶/);
  expect(choices).toEqual([]);
  // The stage list travels with the view, so a reopened console shows the same round's stages.
  type(KEY.tab, KEY.down, KEY.enter, "C");
  expect(choices).toEqual([{ action: "check", view: { section: "stages", query: "", selected: "S09", stageRound: "R3" } }]);
  const reopened = mount(undefined, { view: { section: "stages", query: "", selected: "S09", stageRound: "R3" } });
  expect(reopened.screen()).toMatch(/S09 — Refund API/);
});

test("console Enter on a TODO goes to its target in that round's stages, or explains a trigger", () => {
  const { screen, type, choices } = mount();
  type(KEY.tab, KEY.tab, KEY.enter);
  expect(screen()).toMatch(/S05 — Payment provider/);
  expect(screen()).toMatch(/◀ Stages 5 ▶/);
  type(KEY.shiftTab, KEY.down, KEY.down, KEY.enter);
  expect(screen()).toMatch(/T012 waits on a trigger \(Traffic passes 1k orders a day\), not a stage/);
  type(KEY.down, KEY.enter);
  expect(screen()).toMatch(/◀ Stages R3 1 ▶/);
  expect(screen()).toMatch(/S09 — Refund API/);
  expect(choices).toEqual([]);
});

test("console stage detail shows the Atlas plan coverage the status report lists, asking once per stage", () => {
  const { screen, type, asked } = mount(undefined, {}, 48);
  const shown = screen(160);
  expect(shown).toMatch(/Atlas plans/);
  expect(shown).toMatch(/Card payments \(plan-a\) · complete · 6\/6 rows · DC1/);
  expect(shown).toMatch(/Webhook hardening \(plan-b\) · unfinished · 2\/5 rows · DC2 · drift/);
  expect(shown).toMatch(/DC1 {7}covered by complete Card payments \(plan-a\)/);
  expect(shown).toMatch(/DC2 {7}only by unfinished Webhook hardening \(plan-b\)/);
  expect(shown).toMatch(/Drift: Webhook hardening \(plan-b\) approved before/);
  expect(shown).toMatch(/File {6}docs\/roadmap\/R2\/stages\/S05\.md/);
  type(KEY.down);
  expect(screen(160)).toMatch(/No Atlas plan is bound to this stage yet/);
  expect(screen(160)).toMatch(/DC1 {7}uncovered/);
  type(KEY.down);
  // No answer, as without omo-prometheus: no plan section at all.
  expect(screen(160)).not.toMatch(/Atlas plans/);
  type(KEY.up, KEY.up);
  screen(160);
  expect(asked).toEqual(["S05", "S06", "S07"]);

  const broken = consoleModelFixture();
  const s05 = broken.stages.find((stage) => stage.id === "S05");
  if (s05) s05.done_criteria = "not a criteria list";
  expect(mount(broken).screen(160)).toMatch(/Coverage unavailable: /);
});

test("console secondary actions answer only where they apply and explain otherwise", () => {
  const active = mount();
  active.type("X");
  expect(active.choices).toEqual([{ action: "close", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);

  const planned = mount();
  planned.type(KEY.down, "X", "R", "N");
  expect(planned.choices).toEqual([]);
  expect(planned.screen()).toMatch(/Close R2 before opening another round/);
  planned.type("R");
  expect(planned.screen()).toMatch(/Close or drop every stage of R2 before closing the round/);
  planned.type("X");
  expect(planned.screen()).toMatch(/Select an active stage in Stages to close it/);
  planned.type("E");
  expect(planned.screen()).toMatch(/Select a planned round in Rounds to revise it/);
  planned.type("D");
  expect(planned.screen()).toMatch(/Select a planned round in Rounds to drop it/);
  planned.type("U");
  expect(planned.screen()).toMatch(/This repository already uses roadmap format 2/);
  // Any key clears the message.
  planned.type(KEY.up);
  expect(planned.screen()).not.toMatch(/This repository already/);

  for (const [key, action] of [
    ["C", "check"],
    ["P", "plan-round"],
    ["\x1b[99;2u", "check"],
  ] as const) {
    const run = mount();
    run.type(key);
    expect(run.choices.map((choice) => choice?.action)).toEqual([action]);
  }

  // Target dates: unclosed stages and rounds of a format-2 repository.
  const stageTarget = mount();
  expect(stageTarget.screen(160)).toMatch(/⇧T target date/);
  stageTarget.type("T");
  expect(stageTarget.choices).toEqual([{ action: "retarget", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);
  const closedStage = mount();
  closedStage.type(KEY.home, "T");
  expect(closedStage.screen()).toMatch(/Select an unclosed stage or round to change its target date/);
  const roundTarget = mount();
  roundTarget.type(KEY.tab, "T");
  expect(roundTarget.choices.map((choice) => [choice?.action, choice?.round])).toEqual([["retarget", "R2"]]);

  // Revise and drop act on the planned round selected in Rounds.
  for (const [key, action] of [
    ["E", "plan-round"],
    ["D", "drop-round"],
  ] as const) {
    const run = mount();
    run.type(KEY.tab, KEY.down);
    expect(run.screen(160)).toMatch(/⇧E revise R3 {3}⇧D drop R3/);
    run.type(key);
    expect(run.choices).toEqual([{ action, round: "R3", view: { section: "rounds", query: "", selected: "R3" } }]);
  }

  // Format 1 has no target dates and offers the upgrade.
  const legacy = consoleModelFixture();
  legacy.index.format = 1;
  const old = mount(legacy);
  expect(old.screen(160)).toMatch(/⇧U upgrade to format 2/);
  expect(old.screen(160)).not.toMatch(/target date/);
  old.type("T");
  expect(old.screen()).toMatch(/Target dates need roadmap format 2; Shift\+U upgrades the repository/);
  old.type("U");
  expect(old.choices.map((choice) => choice?.action)).toEqual(["upgrade"]);

  const settled = consoleModelFixture();
  for (const stage of settled.stages) if (stage.round === "R2" && stage.status !== "dropped") stage.status = "closed";
  const closing = mount(settled);
  expect(closing.screen()).toMatch(/close R2/);
  closing.type("R");
  expect(closing.choices.map((choice) => choice?.action)).toEqual(["close-round"]);

  const between = consoleModelFixture();
  for (const round of between.rounds) if (round.status === "active") round.status = "closed";
  const next = mount(between);
  expect(next.screen()).toMatch(/No active round \(last: R2 Checkout and payments, closed\) · 2 planned rounds/);
  expect(next.screen()).toMatch(/activate R3/);
  // Without an active round the console starts on Rounds at the next planned round.
  expect(next.screen()).toMatch(/R3 — Refunds and disputes/);
  next.type("N");
  expect(next.choices).toEqual([{ action: "new-round", view: { section: "rounds", query: "", selected: "R3" } }]);
});

test("console reopens on the saved view with the last result, and handles an empty roadmap", () => {
  const reopened = mount(undefined, {
    view: { section: "todos", query: "", selected: "T011" },
    message: { text: "Check passed; the report is in the conversation", level: "info" },
  });
  expect(reopened.screen()).toMatch(/T011 — Template review with legal/);
  expect(reopened.screen()).toMatch(/Check passed; the report is in the conversation/);
  // A vanished item falls back to the section's first.
  const vanished = mount(undefined, { view: { section: "stages", query: "", selected: "S99" } });
  expect(vanished.screen()).toMatch(/S04 — Cart persistence/);

  const empty = mount(EMPTY);
  expect(empty.screen()).toMatch(/No rounds yet/);
  empty.type(KEY.enter);
  expect(empty.screen()).toMatch(/No rounds yet/);
  empty.type(KEY.tab);
  expect(empty.screen()).toMatch(/No open TODOs/);
  empty.type(KEY.tab);
  expect(empty.screen()).toMatch(/No active round; Shift\+N opens a new/);
  empty.type("N");
  expect(empty.choices.map((choice) => choice?.action)).toEqual(["new-round"]);
});

test("console wheel over the sidebar moves the selection and over the detail scrolls it", () => {
  const { component, screen } = mount(undefined, {}, 24);
  const detailTop = () => screen(100).split("\n")[5] ?? "";
  const top = detailTop();
  expect(top).toMatch(/S05 — /);
  component.handleInput("\x1b[<65;80;8M");
  expect(detailTop()).not.toEqual(top);
  expect(screen(100)).toMatch(/S05/);
  component.handleInput("\x1b[<64;80;8M");
  expect(detailTop()).toEqual(top);
  component.handleInput("\x1b[<65;5;8M");
  expect(screen(100)).toMatch(/S06 — Order confirmation emails/);
});

const ROOT = "/work/shop";
function previewRequest(): PreviewRequest {
  const model = consoleModelFixture();
  const round = model.rounds.find((candidate) => candidate.id === "R3");
  const stage = model.stages.find((candidate) => candidate.id === "S09");
  if (!round || !stage) throw new Error("fixture changed");
  return {
    title: "Plan round R3 Refunds and disputes.\nThe files are rechecked after you confirm.",
    root: ROOT,
    files: [
      { path: `${ROOT}/docs/roadmap/R3/README.md`, content: renderRound(round) },
      { path: `${ROOT}/docs/roadmap/R3/stages/S09-refund-api.md`, content: renderStage(stage) },
      { path: `${ROOT}/docs/roadmap/R3/notes.txt`, content: "plain\n  indented line\n" },
    ],
  };
}

function preview(rows = 24) {
  const answers: boolean[] = [];
  const component = new PreviewView(previewRequest(), theme, tuiOf(rows), (answer) => answers.push(answer));
  return {
    component,
    answers,
    screen: (width = 100) => text(component.render(width)),
    type: (...keys: string[]) => {
      for (const key of keys) component.handleInput(key);
    },
  };
}

test("preview frames fill 80x24 and 160x48 on every row and stay within narrow widths", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
  ] as const) {
    const { component, type } = preview(rows);
    for (let row = 0; row < 5; row++) {
      for (const raw of [false, true]) {
        const lines = component.render(width);
        expect(lines).toHaveLength(rows);
        expect(lines.filter((line) => visibleWidth(line) !== width)).toEqual([]);
        if (raw) type(" ");
      }
      type(KEY.down);
    }
  }
  for (const width of [8, 24, 40])
    expect(
      preview(12)
        .component.render(width)
        .filter((line) => visibleWidth(line) > width),
    ).toEqual([]);
});

test("preview lists repo-relative files between Write and Cancel and shows each file rendered or raw", () => {
  const { screen, type } = preview();
  const shown = screen();
  expect(sidebar(shown).slice(1, 6)).toEqual([
    expect.stringMatching(/Write 3 files/),
    expect.stringMatching(/docs\/roadmap\/R3\/README\.md/),
    expect.stringMatching(/S09-refund-api\.md/),
    expect.stringMatching(/docs\/roadmap\/R3\/notes\.txt/),
    expect.stringMatching(/Cancel/),
  ]);
  expect(shown).not.toMatch(/\/work\/shop/);
  expect(shown).toMatch(/The files are rechecked after you confirm/);
  type(KEY.down);
  expect(screen()).toMatch(/status: "planned"/);
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  expect(screen()).not.toMatch(/Managed by the roadmap OMP plugin/);
  type(" ");
  expect(screen()).toMatch(/Managed by the roadmap OMP plugin/);
  type(" ");
  expect(screen()).not.toMatch(/Managed by the roadmap OMP plugin/);
  type(KEY.down, KEY.down);
  expect(screen()).toMatch(/ {2}indented line/);
});

test("preview answers once: Write or Shift+W writes, Cancel or Esc declines, Enter on a file explains", () => {
  const write = preview();
  write.type(KEY.enter, KEY.escape);
  expect(write.answers).toEqual([true]);

  const shifted = preview();
  shifted.type(KEY.down, KEY.enter);
  expect(shifted.answers).toEqual([]);
  expect(shifted.screen()).toMatch(/Shift\+W or the Write row writes every file; Esc cancels/);
  shifted.type("W");
  expect(shifted.answers).toEqual([true]);

  const cancel = preview();
  cancel.type(KEY.end, KEY.enter);
  expect(cancel.answers).toEqual([false]);

  const dismissed = preview();
  dismissed.type(KEY.down, KEY.escape);
  expect(dismissed.answers).toEqual([false]);
});

interface Stub {
  ctx: RoadmapUiContext;
  selects: string[];
  customs: unknown[];
  reads: string[];
  reader: (cwd: string) => Promise<UiMenu>;
}

/** A terminal UI whose custom components receive `keys`; select answers Write so the inline path ends. */
function stub(mode: "tui" | "rpc", setting: UiMenu, keys: string[] = []): Stub {
  const selects: string[] = [];
  const customs: unknown[] = [];
  const reads: string[] = [];
  const ui = {
    select: async (title: string, options: string[]) => {
      selects.push(title);
      return options[0];
    },
    editor: async () => undefined,
    input: async () => undefined,
    notify() {},
    custom: <T>(
      factory: (tui: TUI, th: typeof theme, keybindings: unknown, done: (value: T) => void) => { handleInput(key: string): void },
      options: unknown,
    ) =>
      new Promise<T>((resolve) => {
        customs.push(options);
        const component = factory(tuiOf(24), theme, undefined, resolve);
        for (const key of keys) component.handleInput(key);
      }),
  };
  return {
    ctx: { hasUI: true, mode, cwd: "/work/shop", ui } as unknown as RoadmapUiContext,
    selects,
    customs,
    reads,
    reader: async (cwd) => {
      reads.push(cwd);
      return setting;
    },
  };
}

const pi = { sendMessage() {} };

test("uiMenu inline keeps the select preview and the inline status menu, reading the setting on every use", async () => {
  const run = stub("tui", "inline");
  const ui = createTuiUi(run.ctx, pi, run.reader);
  expect(await ui.fullscreenMenu()).toBe(false);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(run.selects[0]).toMatch(/Select a file to view it, or write all of them/);
  expect(run.customs).toEqual([]);
  expect(run.reads).toEqual(["/work/shop", "/work/shop"]);
});

test("uiMenu fullscreen mounts the preview and the console as fullscreen overlays", async () => {
  const run = stub("tui", "fullscreen", ["W"]);
  const ui = createTuiUi(run.ctx, pi, run.reader);
  expect(await ui.fullscreenMenu()).toBe(true);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(run.selects).toEqual([]);
  expect(run.customs).toEqual([
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
  ]);
  const menu = stub("tui", "fullscreen", ["C"]);
  const choice = await createTuiUi(menu.ctx, pi, menu.reader).statusConsole(consoleModelFixture(), {});
  expect(choice).toEqual({ action: "check", view: { section: "stages", query: "", selected: "S05" } });
  // Without a reader the setting's default applies.
  expect(await createTuiUi(stub("tui", "inline").ctx, pi).fullscreenMenu()).toBe(true);
});

test("RPC-style hosts and headless sessions never read the setting and keep their paths", async () => {
  const rpc = stub("rpc", "fullscreen");
  const ui = createTuiUi(rpc.ctx, pi, rpc.reader);
  expect(await ui.fullscreenMenu()).toBe(false);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(rpc.selects).toHaveLength(1);
  expect(rpc.customs).toEqual([]);
  expect(rpc.reads).toEqual([]);

  const reads: string[] = [];
  const headless = createTuiUi({ hasUI: false } as RoadmapUiContext, pi, async (cwd) => {
    reads.push(cwd);
    return "fullscreen";
  });
  expect(headless).toBeInstanceOf(HeadlessUi);
  expect(await headless.fullscreenMenu()).toBe(false);
  expect(await headless.statusConsole(EMPTY, {})).toBeUndefined();
  expect(reads).toEqual([]);
});

const temporary: string[] = [];
afterAll(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true });
});

async function projectWith(settings: Record<string, unknown> | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-ui-menu-"));
  temporary.push(root);
  if (settings) {
    await mkdir(join(root, ".omp"));
    await writeFile(join(root, ".omp/plugin-overrides.json"), JSON.stringify({ settings: { [PACKAGE_NAME]: settings } }));
  }
  return root;
}

test("uiMenu reads project settings; a missing value means fullscreen and an invalid one warns and falls back", async () => {
  expect(parseUiMenu(undefined)).toBe("fullscreen");
  expect(parseUiMenu("inline")).toBe("inline");
  expect(() => parseUiMenu("sideways")).toThrow(/invalid uiMenu "sideways"/);
  const warnings: unknown[][] = [];
  const read = uiMenuReader({ warn: (...args: unknown[]) => void warnings.push(args) });
  expect(await read(await projectWith({ uiMenu: "inline" }))).toBe("inline");
  expect(await read(await projectWith(undefined))).toBe("fullscreen");
  expect(warnings).toEqual([]);
  expect(await read(await projectWith({ uiMenu: "sideways" }))).toBe("fullscreen");
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0]?.[0])).toMatch(/uiMenu/);
});
