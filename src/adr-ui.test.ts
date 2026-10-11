import { beforeAll, expect, test } from "bun:test";

import { initTheme, type TUI, theme } from "@oh-my-pi/pi-tui";

import type { AdrRecord } from "../plugins/adr/src/documents.ts";
import { type AdrUiContext, createTuiUi, HeadlessUi, type MenuEntry } from "../plugins/adr/src/ui.ts";

beforeAll(async () => {
  await initTheme();
});

function entry(id: string, status: AdrRecord["status"], extra: Partial<AdrRecord> = {}): MenuEntry {
  return {
    record: {
      id,
      title: `Decision ${id}`,
      status,
      date: "2026-10-01",
      supersedes: [],
      decision_makers: [],
      consulted: [],
      informed: [],
      path: `docs/adr/${id.slice(4)}-decision.md`,
      body: "## Context and Problem Statement\nWhy.\n",
      legacy: false,
      ...extra,
    },
    detail: `${id} detail`,
  };
}

type Mounted = { handleInput(key: string): void; render(width: number): readonly string[] };

/**
 * Answers each select with the first option matching the next pattern; undefined answers act like Escape.
 * Each `custom` call mounts the component and feeds it the next key list. `custom` throws when no keys are queued,
 * which is how the dialog tests prove the fullscreen surface is never used.
 */
function scripted(answers: Array<RegExp | undefined>, mode = "tui", keys: string[][] = []) {
  const titles: string[] = [];
  const options: string[][] = [];
  const viewed: string[] = [];
  const frames: string[] = [];
  const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;
  const ui = {
    async select(title: string, labels: string[]) {
      titles.push(title);
      options.push(labels);
      const answer = answers.shift();
      return answer ? labels.find((label) => answer.test(label)) : undefined;
    },
    async editor(_title: string, content: string) {
      viewed.push(content);
      return undefined;
    },
    async input() {
      return "typed";
    },
    notify() {},
    custom(factory: (tui: TUI, th: typeof theme, keybindings: unknown, done: (value: unknown) => void) => Mounted) {
      const script = keys.shift();
      if (!script) throw new Error("custom must not be called");
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const component = factory(tui, theme, undefined, resolve);
      frames.push(Bun.stripANSI(component.render(80).join("\n")));
      for (const key of script) component.handleInput(key);
      return promise;
    },
  };
  return { ctx: { hasUI: true, mode, ui } as unknown as AdrUiContext, titles, options, viewed, frames };
}

const pi = { sendMessage() {} };
const entries = [
  entry("ADR-0001", "accepted"),
  entry("ADR-0002", "proposed"),
  entry("ADR-0003", "superseded", { superseded_by: "ADR-0004" }),
];

test("the menu filters by status, opens a detail view and returns the chosen decision", async () => {
  const run = scripted([/^Proposed \(1\)$/, /ADR-0002/, /^View the decision$/, /^Accept$/]);
  expect(await createTuiUi(run.ctx, pi, "inline").menu(entries)).toEqual({ action: "accept", id: "ADR-0002" });
  expect(run.titles[0]).toBe("ADRs: 1 proposed, 1 accepted, 1 superseded");
  expect(run.options[0]).toEqual([
    "All ADRs (3)",
    "Proposed (1)",
    "Accepted (1)",
    "Superseded (1)",
    "New decision…",
    "Run check",
    "Run check and regenerate the index",
  ]);
  expect(run.options[1]).toEqual(["○ ADR-0002 Decision ADR-0002 [proposed]", "← Back"]);
  expect(run.options[2]).toEqual(["View the decision", "Accept", "Reject", "Deprecate", "Append a dated note", "← Back"]);
  expect(run.viewed).toEqual(["ADR-0002 detail"]);
});

test("accepted ADRs offer supersede, superseded ones only notes, and Escape climbs back up", async () => {
  const accepted = scripted([/^All ADRs/, /ADR-0001/, /^Supersede/]);
  expect(await createTuiUi(accepted.ctx, pi, "inline").menu(entries)).toEqual({ action: "supersede", id: "ADR-0001" });
  expect(accepted.options[2]).toEqual([
    "View the decision",
    "Reject",
    "Deprecate",
    "Append a dated note",
    "Supersede with a new decision…",
    "← Back",
  ]);
  const superseded = scripted([/^All ADRs/, /ADR-0003/, undefined, /^← Back$/, /^Run check$/]);
  expect(await createTuiUi(superseded.ctx, pi, "inline").menu(entries)).toEqual({ action: "check" });
  expect(superseded.options[2]).toEqual(["View the decision", "Append a dated note", "← Back"]);
  expect(superseded.titles[2]).toBe("ADR-0003 Decision ADR-0003 [superseded] · 2026-10-01 · superseded by ADR-0004");
  expect(await createTuiUi(scripted([undefined]).ctx, pi, "inline").menu(entries)).toBeUndefined();
  expect(await createTuiUi(scripted([/^New decision/]).ctx, pi, "inline").menu([])).toEqual({ action: "new" });
});

test("inline keeps the dialogs in the terminal, and fullscreen falls back to them outside it", async () => {
  const inline = scripted([/^View docs/, /^Write 1 file$/]);
  const ui = createTuiUi(inline.ctx, pi, "inline");
  expect(ui.console).toBe(false);
  expect(await ui.previewConfirm({ title: "Init", files: [{ path: "docs/adr/README.md", content: "# ADRs" }] })).toBe(true);
  expect(inline.options[0]).toEqual(["Write 1 file", "View docs/adr/README.md", "Cancel"]);
  expect(inline.viewed).toEqual(["# ADRs"]);
  const rpc = scripted([/^Run check$/], "rpc");
  const fallback = createTuiUi(rpc.ctx, pi, "fullscreen");
  expect(fallback.console).toBe(false);
  expect(await fallback.menu(entries)).toEqual({ action: "check" });
  expect(rpc.titles[0]).toBe("ADRs: 1 proposed, 1 accepted, 1 superseded");
});

test("fullscreen opens the console, keeps its filter across re-opens, and Enter asks for the decision", async () => {
  // Tab moves to Proposed; Enter on ADR-0002 opens the decision dialog, whose Back re-mounts the console.
  const run = scripted([/^← Back$/, /^Reject$/], "tui", [["\t", "\r"], ["\r"], ["\x1b"]]);
  const ui = createTuiUi(run.ctx, pi, "fullscreen");
  expect(ui.console).toBe(true);
  expect(await ui.menu(entries)).toEqual({ action: "reject", id: "ADR-0002" });
  expect(run.titles).toEqual(["ADR-0002 Decision ADR-0002 [proposed] · 2026-10-01", "ADR-0002 Decision ADR-0002 [proposed] · 2026-10-01"]);
  expect(run.options[0]).toEqual(["Accept", "Reject", "Deprecate", "Append a dated note", "← Back"]);
  expect(run.frames[1]).toMatch(/ADR-0002 {2}Decision ADR-0002/);
  expect(run.frames[1]).not.toMatch(/ADR-0001 Decision/);
  // The caller re-opens on the ADR it acted on with the result line; Esc closes.
  expect(await ui.menu(entries, { selectedId: "ADR-0002", message: { text: "ADR-0002 rejected.", level: "info" } })).toBeUndefined();
  expect(run.frames[2]).toMatch(/ADR-0002 rejected\./);
  const shortcut = scripted([], "tui", [["S"]]);
  expect(await createTuiUi(shortcut.ctx, pi, "fullscreen").menu(entries)).toEqual({ action: "supersede", id: "ADR-0001" });
  const global = scripted([], "tui", [["F"]]);
  expect(await createTuiUi(global.ctx, pi, "fullscreen").menu(entries)).toEqual({ action: "check-fix" });
});

test("the fullscreen preview writes on Shift+W and declines on Esc", async () => {
  const files = [{ path: "docs/adr/README.md", content: "# Decisions\n\nIndex." }];
  const write = scripted([], "tui", [["W"]]);
  expect(await createTuiUi(write.ctx, pi, "fullscreen").previewConfirm({ title: "Initialize ADR management", files })).toBe(true);
  expect(write.frames[0]).toMatch(/Decisions/);
  const cancel = scripted([], "tui", [["\x1b"]]);
  expect(await createTuiUi(cancel.ctx, pi, "fullscreen").previewConfirm({ title: "Initialize ADR management", files })).toBe(false);
});

test("without a UI there are no dialogs and notices become displayed messages", async () => {
  const sent: unknown[] = [];
  const ui = createTuiUi({ hasUI: false } as AdrUiContext, { sendMessage: (message: unknown) => sent.push(message) }, "fullscreen");
  expect(ui).toBeInstanceOf(HeadlessUi);
  expect(ui.interactive).toBe(false);
  expect(ui.console).toBe(false);
  expect(await ui.menu(entries)).toBeUndefined();
  expect(await ui.previewConfirm({ title: "x", files: [] })).toBeUndefined();
  ui.notify("Nothing to do", "warning");
  expect(sent).toEqual([{ customType: "wows-omp-adr.notice", content: "ADR warning: Nothing to do", display: true, attribution: "agent" }]);
});
