import { beforeAll, expect, test } from "bun:test";

import { initTheme, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

import {
  AdrConsole,
  AdrPreview,
  type ConsoleEntry,
  type ConsoleResult,
  type ConsoleState,
  type DecisionAction,
} from "../plugins/adr/src/console.ts";
import type { AdrRecord } from "../plugins/adr/src/documents.ts";

beforeAll(async () => {
  await initTheme();
});

function entry(id: string, status: AdrRecord["status"], offered: DecisionAction[], extra: Partial<AdrRecord> = {}): ConsoleEntry {
  const title = extra.title ?? `Decision ${id}`;
  return {
    record: {
      id,
      title,
      status,
      date: "2026-10-01",
      supersedes: [],
      decision_makers: [],
      consulted: [],
      informed: [],
      path: `docs/adr/${id.slice(4)}-decision.md`,
      body: "",
      legacy: false,
      ...extra,
    },
    detail: [
      `${id} — ${title}`,
      `Status: ${status}; date 2026-10-01`,
      `File: docs/adr/${id.slice(4)}-decision.md`,
      "",
      "## Context and Problem Statement",
      "",
      Array.from({ length: 40 }, (_, index) => `Paragraph line ${index + 1} explains the context in some detail.`).join("\n\n"),
    ].join("\n"),
    offered,
  };
}

const entries = [
  entry("ADR-0001", "accepted", ["reject", "deprecate", "note", "supersede"]),
  entry("ADR-0002", "proposed", ["accept", "reject", "deprecate", "note"], {
    title: "A very long decision title that keeps going well past the width of any reasonable sidebar column",
  }),
  entry("ADR-0003", "superseded", ["note"], { superseded_by: "ADR-0004" }),
  entry("ADR-0004", "accepted", ["reject", "deprecate", "note", "supersede"], { title: "Cache reads" }),
];

function tuiOf(rows: number): TUI {
  return { requestRender() {}, terminal: { rows } } as unknown as TUI;
}

function mount(list = entries, state: ConsoleState = { query: "" }, rows = 24) {
  const results: Array<{ result: ConsoleResult; state: ConsoleState }> = [];
  const component = new AdrConsole(list, state, theme, tuiOf(rows), (result, next) => results.push({ result, state: next }));
  return { component, results };
}

const text = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n"));

test("frames fill the terminal and never exceed the width, including empty and narrow consoles", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
    [40, 12],
  ] as const) {
    for (const list of [entries, []]) {
      const lines = mount(list, { query: "" }, rows).component.render(width);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const preview = new AdrPreview(
      "Initialize ADR management: docs/adr/README.md becomes the marker and generated index.",
      [{ path: "docs/adr/README.md", content: entries[0]?.detail ?? "" }],
      theme,
      tuiOf(rows),
      () => {},
    );
    const lines = preview.render(width);
    expect(lines).toHaveLength(rows);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  expect(text(mount([]).component.render(80))).toMatch(/No ADRs yet; press Shift\+C/);
});

test("arrows move the selection and the detail pane shows the selected decision", () => {
  const { component } = mount();
  expect(text(component.render(100))).toMatch(/ADR-0001 {2}Decision ADR-0001/);
  component.handleInput("\x1b[B");
  expect(text(component.render(100))).toMatch(/ADR-0002 {2}A very long decision title/);
  component.handleInput("\x1b[F");
  expect(text(component.render(100))).toMatch(/ADR-0004 {2}Cache reads/);
  component.handleInput("\x1b[H");
  expect(text(component.render(100))).toMatch(/ADR-0001 {2}Decision ADR-0001/);
});

test("Tab cycles status filters with counts, and typing searches until Esc clears it", () => {
  const { component, results } = mount();
  const screen = text(component.render(120));
  expect(screen).toMatch(/All 4.*Proposed 1.*Accepted 2.*Superseded 1/);
  expect(screen).toMatch(/ADR · 1 proposed, 2 accepted, 1 superseded/);
  component.handleInput("\t");
  expect(text(component.render(120))).toMatch(/ADR-0002 {2}A very long/);
  component.handleInput("\x1b[Z");
  for (const key of "cache") component.handleInput(key);
  const searched = text(component.render(120));
  expect(searched).toMatch(/Search: cache/);
  expect(searched).toMatch(/ADR-0004 {2}Cache reads/);
  expect(searched).not.toMatch(/ADR-0001 Decision/);
  component.handleInput("\x1b");
  expect(results).toEqual([]);
  expect(text(component.render(120))).toMatch(/Type to search/);
  component.handleInput("\x1b");
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: "ADR-0004" } }]);
});

test("Enter asks to decide, offered shortcuts act, and refused ones explain why", () => {
  const { component, results } = mount();
  component.handleInput("A");
  expect(results).toEqual([]);
  expect(text(component.render(100))).toMatch(/Accept is not available for ADR-0001 \(accepted\)/);
  component.handleInput("\r");
  component.handleInput("S");
  component.handleInput("C");
  component.handleInput("V");
  expect(results.map(({ result }) => result)).toEqual([
    { kind: "decide", id: "ADR-0001" },
    { kind: "action", action: "supersede", id: "ADR-0001" },
    { kind: "action", action: "new" },
    { kind: "action", action: "check" },
  ]);
  const empty = mount([]);
  empty.component.handleInput("\r");
  expect(empty.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "new" }]);
});

test("a re-opened console restores filter, search and selection and shows the result line", () => {
  const component = new AdrConsole(entries, { filter: "accepted", query: "", selectedId: "ADR-0004" }, theme, tuiOf(24), () => {}, {
    text: "ADR-0004 deprecated.",
    level: "info",
  });
  const screen = text(component.render(100));
  expect(screen).toMatch(/ADR-0004 {2}Cache reads/);
  expect(screen).toMatch(/ADR-0004 deprecated\./);
  expect(screen).not.toMatch(/ADR-0002/);
});

test("PgDn and the wheel scroll the detail; the wheel over the sidebar moves the selection", () => {
  const { component } = mount();
  const body = (): string[] =>
    component
      .render(100)
      .slice(3, 8)
      .map((line) => Bun.stripANSI(line).split("│")[2]?.trim() ?? "");
  const top = body();
  component.handleInput("\x1b[6~");
  expect(body()).not.toEqual(top);
  component.handleInput("\x1b[5~");
  expect(body()).toEqual(top);
  component.handleInput("\x1b[<65;80;6M");
  expect(body()).not.toEqual(top);
  component.handleInput("\x1b[<65;5;6M");
  expect(text(component.render(100))).toMatch(/ADR-0002 {2}A very long/);
});

test("the preview starts on the first file, Enter writes or cancels only on those rows", () => {
  const results: boolean[] = [];
  const files = [
    { path: "docs/adr/README.md", content: "# Decisions\n\nThe index." },
    { path: "docs/adr/template.txt", content: "plain text body" },
  ];
  const preview = new AdrPreview("Write these", files, theme, tuiOf(24), (write) => results.push(write));
  expect(text(preview.render(100))).toMatch(/Decisions/);
  preview.handleInput("\r");
  expect(results).toEqual([]);
  expect(text(preview.render(100))).toMatch(/Shift\+W to write every file/);
  preview.handleInput("\x1b[B");
  expect(text(preview.render(100))).toMatch(/plain text body/);
  preview.handleInput("\x1b[B");
  preview.handleInput("\r");
  preview.handleInput("\x1b[H");
  expect(text(preview.render(100))).toMatch(/Files to write:/);
  preview.handleInput("\r");
  expect(results).toEqual([false, true]);
});
