import {
  type Component,
  extractPrintableText,
  getMarkdownTheme,
  Markdown,
  matchesKey,
  padding,
  routeSgrMouseInput,
  type SgrMouseEvent,
  type Theme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
  bottomBorder,
  dividerSplit,
  rawKeyHint,
  renderSegmentTrack,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
} from "@oh-my-pi/pi-tui/chrome";

import { type AdrRecord, type AdrStatus, STATUSES } from "#src/documents.ts";

/** One line under the console body; failures render in the error color. */
export interface ConsoleMessage {
  text: string;
  level: "info" | "error";
}

/** Per-ADR keys, in the order the hints list them. `key` is the uppercase letter; Shift+letter sends it too. */
export const DECISION_KEYS = [
  ["A", "accept"],
  ["R", "reject"],
  ["D", "deprecate"],
  ["N", "note"],
  ["S", "supersede"],
] as const;
export type DecisionAction = (typeof DECISION_KEYS)[number][1];
export type GlobalAction = "new" | "check" | "check-fix";
const GLOBAL_KEYS: ReadonlyArray<readonly [string, GlobalAction, string]> = [
  ["C", "new", "new decision"],
  ["V", "check", "check"],
  ["F", "check-fix", "check + index"],
];

export type ConsoleResult =
  | { kind: "close" }
  | { kind: "decide"; id: string }
  | { kind: "action"; action: DecisionAction; id: string }
  | { kind: "action"; action: GlobalAction };

export interface ConsoleEntry {
  record: AdrRecord;
  detail: string;
  /** Actions `decisions()` offers for this ADR. */
  offered: readonly DecisionAction[];
}

/** Filter and search survive a console re-open after a local action. */
export interface ConsoleState {
  filter?: AdrStatus;
  query: string;
  selectedId?: string;
}

const PLUGIN = "ADR";
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;

type StatusStyle = { glyph: (theme: Theme) => string; color: "warning" | "success" | "error" | "muted" | "dim" };
const STATUS_STYLE: Record<AdrStatus, StatusStyle> = {
  proposed: { glyph: (t) => t.status.pending, color: "warning" },
  accepted: { glyph: (t) => t.status.success, color: "success" },
  rejected: { glyph: (t) => t.status.error, color: "error" },
  deprecated: { glyph: (t) => t.status.disabled, color: "muted" },
  superseded: { glyph: (t) => t.status.shadowed, color: "dim" },
};

/** Preset glyphs differ in cell width (unicode ✔ vs ⏳, ascii [ok] vs [*]); pad them to one column. */
function statusMarks(theme: Theme): Record<AdrStatus, string> {
  const raw = STATUSES.map((status) => theme.fg(STATUS_STYLE[status].color, STATUS_STYLE[status].glyph(theme)));
  const width = Math.max(1, ...raw.map((mark) => visibleWidth(mark)));
  return Object.fromEntries(
    STATUSES.map((status, index) => [status, (raw[index] ?? "") + padding(width - visibleWidth(raw[index] ?? ""))]),
  ) as Record<AdrStatus, string>;
}

export function hintLines(hints: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}   ${hint}` : hint;
    if (line && visibleWidth(next) > width) {
      lines.push(truncateToWidth(line, width));
      line = hint;
    } else {
      line = next;
    }
  }
  if (line) lines.push(truncateToWidth(line, width));
  return lines;
}

/** Sidebar column width shared by the console and the preview, as in Atlas. */
function sidebarWidthFor(width: number): number {
  return Math.max(18, Math.min(52, Math.floor(width * 0.36)));
}

/** Scrollable split-pane frame both components draw: title, header, sidebar|body, message, hints. */
class SplitFrame {
  bodyRows = 1;
  bodyTop = 0;
  dividerCol = 0;
  scroll = 0;
  scrollMax = Number.MAX_SAFE_INTEGER;

  constructor(readonly theme: Theme) {}

  scrollBy(delta: number): void {
    this.scroll = Math.max(0, Math.min(this.scrollMax, this.scroll + delta));
  }

  render(
    width: number,
    height: number,
    parts: {
      title: string;
      header: string;
      sidebarWidth: number;
      sidebar: (rows: number) => string[];
      body: (width: number) => string[];
      message?: ConsoleMessage;
      hints: readonly string[];
    },
  ): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    // Short terminals keep at least three body rows; the hints that do not fit are dropped.
    const hints = hintLines(parts.hints, inner).slice(0, Math.max(1, height - 9));
    const sidebarWidth = parts.sidebarWidth;
    const bodyWidth = Math.max(1, splitBodyWidth(width, sidebarWidth));
    // Title, header, split rule, divider, message, bottom border.
    this.bodyRows = Math.max(1, height - 6 - hints.length);
    this.bodyTop = 3;
    this.dividerCol = sidebarWidth + 3;
    const body = parts.body(bodyWidth);
    this.scrollMax = Math.max(0, body.length - this.bodyRows);
    this.scroll = Math.min(this.scroll, this.scrollMax);
    const shown = body.slice(this.scroll, this.scroll + this.bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - this.scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn/wheel to scroll`);
    const sidebar = parts.sidebar(this.bodyRows);
    const box = t.boxRound;
    const splitOpen = t.fg(
      "border",
      box.teeRight +
        box.horizontal.repeat(sidebarWidth + 2) +
        box.teeDown +
        box.horizontal.repeat(Math.max(0, width - sidebarWidth - 5)) +
        box.teeLeft,
    );
    const message = parts.message ? t.fg(parts.message.level === "error" ? "error" : "warning", parts.message.text) : "";
    return [
      topBorder(width, parts.title),
      row(truncateToWidth(parts.header, inner), width),
      splitOpen,
      ...Array.from({ length: this.bodyRows }, (_, index) =>
        splitRow(truncateToWidth(sidebar[index] ?? "", sidebarWidth), truncateToWidth(shown[index] ?? "", bodyWidth), width, sidebarWidth),
      ),
      dividerSplit(width, sidebarWidth),
      row(truncateToWidth(message, inner), width),
      ...hints.map((line) => row(line, width)),
      bottomBorder(width),
    ];
  }

  /** Wheel over the sidebar calls `select`, over the body scrolls it; every other report is swallowed. */
  mouse(event: SgrMouseEvent, select: (delta: number) => void): void {
    if (event.wheel === null) return;
    const line = event.row - this.bodyTop;
    if (line < 0 || line >= this.bodyRows) return;
    if (event.col < this.dividerCol) select(event.wheel);
    else if (event.col > this.dividerCol) this.scrollBy(event.wheel * WHEEL_ROWS);
  }

  pageRows(): number {
    return Math.max(1, this.bodyRows - 2);
  }
}

function terminalRows(tui: TUI): number {
  return Math.max(12, tui.terminal?.rows || process.stdout.rows || 40);
}

/** The pressed uppercase letter for `A` or Shift+a (legacy or Kitty encoding); undefined otherwise. */
function shiftLetter(key: string): string | undefined {
  const text = extractPrintableText(key);
  if (text && /^[A-Z]$/.test(text)) return text;
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (matchesKey(key, `shift+${letter.toLowerCase()}` as never)) return letter;
  return undefined;
}

/** Fullscreen `/adr` console: status filters, a searchable ADR sidebar, and the selected decision's full text. */
export class AdrConsole implements Component {
  readonly #frame: SplitFrame;
  readonly #marks: Record<AdrStatus, string>;
  readonly #markdown = new Map<string, Markdown>();
  #filter: AdrStatus | undefined;
  #query: string;
  #selectedId: string | undefined;
  #message: ConsoleMessage | undefined;

  constructor(
    readonly entries: readonly ConsoleEntry[],
    state: ConsoleState,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly done: (result: ConsoleResult, state: ConsoleState) => void,
    message?: ConsoleMessage,
  ) {
    this.#frame = new SplitFrame(theme);
    this.#marks = statusMarks(theme);
    this.#filter = state.filter && entries.some((entry) => entry.record.status === state.filter) ? state.filter : undefined;
    this.#query = state.query;
    this.#selectedId = state.selectedId;
    this.#message = message;
  }

  #filters(): Array<AdrStatus | undefined> {
    return [undefined, ...STATUSES.filter((status) => this.entries.some((entry) => entry.record.status === status))];
  }

  #visible(): ConsoleEntry[] {
    const words = this.#query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter((entry) => {
      if (this.#filter && entry.record.status !== this.#filter) return false;
      const haystack = `${entry.record.id} ${entry.record.title} ${entry.record.status}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** The selected entry among the visible ones; when it is filtered out the first visible one becomes the selection. */
  #current(visible = this.#visible()): { entry?: ConsoleEntry; index: number } {
    const index = visible.findIndex((entry) => entry.record.id === this.#selectedId);
    if (index >= 0) return { entry: visible[index], index };
    if (visible[0]) this.#selectedId = visible[0].record.id;
    return { entry: visible[0], index: 0 };
  }

  #select(index: number): void {
    const visible = this.#visible();
    if (!visible.length) return;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!next || next.record.id === this.#current(visible).entry?.record.id) return;
    this.#selectedId = next.record.id;
    this.#frame.scroll = 0;
  }

  #state(): ConsoleState {
    return { filter: this.#filter, query: this.#query, selectedId: this.#current().entry?.record.id ?? this.#selectedId };
  }

  #finish(result: ConsoleResult): void {
    this.done(result, this.#state());
  }

  #cycle(delta: 1 | -1): void {
    const filters = this.#filters();
    const index = filters.indexOf(this.#filter);
    this.#filter = filters[(index + delta + filters.length) % filters.length];
    this.#frame.scroll = 0;
  }

  #decision(letter: string): void {
    const action = DECISION_KEYS.find(([key]) => key === letter)?.[1];
    if (!action) return;
    const entry = this.#current().entry;
    if (!entry) {
      this.#message = { text: "No ADR selected", level: "error" };
      return;
    }
    if (!entry.offered.includes(action)) {
      this.#message = {
        text: `${action[0]?.toUpperCase()}${action.slice(1)} is not available for ${entry.record.id} (${entry.record.status})`,
        level: "error",
      };
      return;
    }
    this.#finish({ kind: "action", action, id: entry.record.id });
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the notice or act as a key.
    if (
      routeSgrMouseInput(key, (event) => {
        this.#frame.mouse(event, (delta) => this.#select(this.#current().index + delta));
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.#message = undefined;
    const letter = shiftLetter(key);
    const global = GLOBAL_KEYS.find(([key]) => key === letter);
    if (matchesKey(key, "escape")) {
      if (this.#query) this.#query = "";
      else this.#finish({ kind: "close" });
    } else if (matchesKey(key, "shift+tab")) this.#cycle(-1);
    else if (matchesKey(key, "tab")) this.#cycle(1);
    else if (matchesKey(key, "up")) this.#select(this.#current().index - 1);
    else if (matchesKey(key, "down")) this.#select(this.#current().index + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(Number.MAX_SAFE_INTEGER);
    else if (matchesKey(key, "pageDown")) this.#frame.scrollBy(this.#frame.pageRows());
    else if (matchesKey(key, "pageUp")) this.#frame.scrollBy(-this.#frame.pageRows());
    else if (matchesKey(key, "enter")) {
      const entry = this.#current().entry;
      if (entry) this.#finish({ kind: "decide", id: entry.record.id });
      else if (!this.entries.length) this.#finish({ kind: "action", action: "new" });
    } else if (global) this.#finish({ kind: "action", action: global[1] });
    else if (letter) this.#decision(letter);
    else if (matchesKey(key, "backspace")) {
      this.#query = this.#query.slice(0, -1);
      this.#frame.scroll = 0;
    } else {
      const text = extractPrintableText(key);
      if (text !== undefined && (this.#query || text.trim())) {
        this.#query += text;
        this.#frame.scroll = 0;
      }
    }
    this.tui.requestRender();
  }

  #header(width: number): string {
    const t = this.theme;
    const filters = this.#filters();
    const count = (status: AdrStatus | undefined) =>
      status ? this.entries.filter((entry) => entry.record.status === status).length : this.entries.length;
    const search = this.#query ? `Search: ${this.#query}` : t.fg("dim", "Type to search");
    const track = (short: boolean) =>
      renderSegmentTrack(
        filters.map((status) => {
          const label = status ? `${status[0]?.toUpperCase()}${status.slice(1)}` : "All";
          return { label: `${short ? label.slice(0, 3) : label} ${count(status)}` };
        }),
        filters.indexOf(this.#filter),
      );
    const full = track(false);
    const tabs = visibleWidth(`${full}  ${search}`) <= width ? full : track(true);
    return `${tabs}  ${search}`;
  }

  #sidebar(width: number, rows: number, visible: ConsoleEntry[]): string[] {
    const t = this.theme;
    if (!visible.length)
      return wrapTextWithAnsi(
        t.fg(
          "dim",
          this.entries.length ? "No ADRs match; Esc clears the search, Tab changes the filter" : "No ADRs yet; press Shift+C to start one",
        ),
        width,
      );
    const { index: selected } = this.#current(visible);
    const idWidth = Math.max(0, ...visible.map((entry) => entry.record.id.length));
    const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), visible.length - rows));
    return visible.slice(start, start + rows).map((entry, offset) => {
      const isSelected = start + offset === selected;
      const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : "  ";
      const prefix = `${cursor}${this.#marks[entry.record.status]} ${t.fg("muted", entry.record.id.padEnd(idWidth))} `;
      const title = truncateToWidth(entry.record.title, Math.max(1, width - visibleWidth(prefix)));
      return truncateToWidth(`${prefix}${t.fg(isSelected ? "accent" : "text", title)}`, width);
    });
  }

  #body(width: number, entry: ConsoleEntry | undefined): string[] {
    const t = this.theme;
    if (!entry) return [t.fg("dim", "No ADR selected")];
    const { record } = entry;
    const lines: string[] = [];
    lines.push(...wrapTextWithAnsi(t.bold(t.fg("accent", `${record.id}  ${record.title}`)), width));
    const where = [
      record.date,
      record.stage ? `stage ${record.stage}` : "",
      record.superseded_by ? `superseded by ${record.superseded_by}` : "",
    ];
    lines.push(
      ...wrapTextWithAnsi(
        `${this.#marks[record.status]} ${t.fg(STATUS_STYLE[record.status].color, record.status)}  ${t.fg("dim", where.filter(Boolean).join(" · "))}`,
        width,
      ),
      "",
    );
    // detailText: a metadata block (first line repeats the title), a blank line, then the MADR body.
    const split = entry.detail.indexOf("\n\n");
    // The status row above already shows the status, and the MADR body opens with the title as a heading.
    const meta = (split < 0 ? entry.detail : entry.detail.slice(0, split))
      .split("\n")
      .slice(1)
      .filter((line) => !line.startsWith("Status: "));
    const body = split < 0 ? "" : entry.detail.slice(split + 2).replace(/^# [^\n]*\n+/, "");
    const fields = meta.map((line) => {
      const colon = line.indexOf(": ");
      return colon > 0 ? ([line.slice(0, colon), line.slice(colon + 2)] as const) : (["", line] as const);
    });
    const labelWidth = Math.max(0, ...fields.map(([label]) => label.length)) + 2;
    for (const [label, value] of fields) {
      if (width < labelWidth + 20) {
        lines.push(...wrapTextWithAnsi(`${t.fg("muted", label ? `${label}: ` : "")}${value}`, width));
        continue;
      }
      const wrapped = wrapTextWithAnsi(value, width - labelWidth);
      for (const [index, line] of wrapped.entries())
        lines.push(`${index ? padding(labelWidth) : t.fg("muted", label.padEnd(labelWidth))}${line}`);
    }
    if (body.trim()) {
      lines.push("");
      let markdown = this.#markdown.get(record.id);
      if (!markdown) {
        markdown = new Markdown(body, 0, 0, getMarkdownTheme());
        this.#markdown.set(record.id, markdown);
      }
      lines.push(...markdown.render(width));
    }
    return lines;
  }

  #hints(entry: ConsoleEntry | undefined): string[] {
    const offered = entry?.offered ?? [];
    return [
      rawKeyHint(["up", "down"], "select"),
      this.theme.fg("dim", "PgUp/PgDn/wheel") + this.theme.fg("muted", " scroll"),
      ...(entry ? [rawKeyHint("enter", "decide")] : []),
      ...DECISION_KEYS.filter(([, action]) => offered.includes(action)).map(([key, action]) =>
        rawKeyHint(`shift+${key.toLowerCase()}` as never, action),
      ),
      ...GLOBAL_KEYS.map(([key, , label]) => rawKeyHint(`shift+${key.toLowerCase()}` as never, label)),
      rawKeyHint(["tab", "shift+tab"], "filter"),
      rawKeyHint("escape", this.#query ? "clear search" : "close"),
    ];
  }

  render(width: number): readonly string[] {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const sidebarWidth = sidebarWidthFor(width);
    const records = this.entries.map((item) => item.record);
    const summary = STATUSES.map((status) => [status, records.filter((record) => record.status === status).length] as const)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");
    return this.#frame.render(width, terminalRows(this.tui), {
      title: `${PLUGIN} · ${summary || "no ADRs yet"}`,
      header: this.#header(Math.max(1, width - 4)),
      sidebarWidth,
      sidebar: (rows) => this.#sidebar(sidebarWidth, rows, visible),
      body: (bodyWidth) => this.#body(bodyWidth, entry),
      message: this.#message,
      hints: this.#hints(entry),
    });
  }
}

export interface PreviewItem {
  path: string;
  content: string;
}

/** Fullscreen write preview: actions and files on the left, the selected file on the right. Resolves true to write. */
export class AdrPreview implements Component {
  readonly #frame: SplitFrame;
  readonly #markdown = new Map<number, Markdown>();
  /** Row 0 writes, rows 1..n are files, the last row cancels. */
  #selected: number;
  #message: ConsoleMessage | undefined;

  constructor(
    readonly title: string,
    readonly files: readonly PreviewItem[],
    readonly theme: Theme,
    readonly tui: TUI,
    readonly done: (write: boolean) => void,
  ) {
    this.#frame = new SplitFrame(theme);
    this.#selected = files.length ? 1 : 0;
  }

  /** Row 0 writes, rows 1..n are files, this last row cancels. */
  get #cancelRow(): number {
    return this.files.length + 1;
  }

  #select(index: number): void {
    const next = Math.max(0, Math.min(this.#cancelRow, index));
    if (next === this.#selected) return;
    this.#selected = next;
    this.#frame.scroll = 0;
  }

  handleInput(key: string): void {
    if (
      routeSgrMouseInput(key, (event) => {
        this.#frame.mouse(event, (delta) => this.#select(this.#selected + delta));
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.#message = undefined;
    if (matchesKey(key, "escape")) this.done(false);
    else if (shiftLetter(key) === "W") this.done(true);
    else if (matchesKey(key, "up")) this.#select(this.#selected - 1);
    else if (matchesKey(key, "down")) this.#select(this.#selected + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(this.#cancelRow);
    else if (matchesKey(key, "pageDown")) this.#frame.scrollBy(this.#frame.pageRows());
    else if (matchesKey(key, "pageUp")) this.#frame.scrollBy(-this.#frame.pageRows());
    else if (matchesKey(key, "enter")) {
      if (this.#selected === 0) this.done(true);
      else if (this.#selected === this.#cancelRow) this.done(false);
      else this.#message = { text: "Press Shift+W to write every file, or Esc to cancel", level: "info" };
    }
    this.tui.requestRender();
  }

  #sidebar(width: number, rows: number): string[] {
    const t = this.theme;
    const labels = [
      t.fg("success", `${t.status.success} Write ${this.files.length} file${this.files.length === 1 ? "" : "s"}`),
      ...this.files.map((file) => file.path),
      t.fg("error", `${t.status.error} Cancel`),
    ];
    const start = Math.max(0, Math.min(this.#selected - Math.floor(rows / 2), labels.length - rows));
    return labels.slice(start, start + rows).map((label, offset) => {
      const selected = start + offset === this.#selected;
      const cursor = selected ? t.fg("accent", `${t.nav.cursor} `) : "  ";
      const isFile = start + offset > 0 && start + offset <= this.files.length;
      return truncateToWidth(`${cursor}${isFile ? t.fg(selected ? "accent" : "text", label) : label}`, width);
    });
  }

  #body(width: number): string[] {
    const t = this.theme;
    const file = this.files[this.#selected - 1];
    if (!file) {
      const lines = wrapTextWithAnsi(t.bold(this.title), width);
      lines.push("", ...wrapTextWithAnsi(t.fg("muted", "Files to write:"), width));
      for (const item of this.files) lines.push(...wrapTextWithAnsi(`  ${item.path}`, width));
      lines.push(
        "",
        ...wrapTextWithAnsi(t.fg("dim", "Nothing is written until you choose Write. Select a file to read it before deciding."), width),
      );
      return lines;
    }
    const lines = [truncateToWidth(t.bold(t.fg("accent", file.path)), width), ""];
    if (/\.md$/i.test(file.path)) {
      // YAML front matter is not Markdown: show it verbatim, then render the document after it.
      const front = /^---\n[\s\S]*?\n---\n/.exec(file.content)?.[0] ?? "";
      for (const line of front.trimEnd().split("\n").filter(Boolean)) lines.push(...wrapTextWithAnsi(t.fg("muted", line), width));
      let markdown = this.#markdown.get(this.#selected);
      if (!markdown) {
        markdown = new Markdown(file.content.slice(front.length), 0, 0, getMarkdownTheme());
        this.#markdown.set(this.#selected, markdown);
      }
      lines.push(...markdown.render(width));
    } else {
      for (const line of file.content.replace(/\n$/, "").split("\n")) lines.push(...wrapTextWithAnsi(line, width));
    }
    return lines;
  }

  render(width: number): readonly string[] {
    const sidebarWidth = sidebarWidthFor(width);
    return this.#frame.render(width, terminalRows(this.tui), {
      title: `${PLUGIN} · write preview`,
      header: this.title,
      sidebarWidth,
      sidebar: (rows) => this.#sidebar(sidebarWidth, rows),
      body: (bodyWidth) => this.#body(bodyWidth),
      message: this.#message,
      hints: [
        rawKeyHint(["up", "down"], "select"),
        this.theme.fg("dim", "PgUp/PgDn/wheel") + this.theme.fg("muted", " scroll"),
        rawKeyHint("enter", "choose"),
        rawKeyHint("shift+w", "write all"),
        rawKeyHint("escape", "cancel"),
      ],
    });
  }
}
