import { relative } from "node:path";

import {
  type Component,
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
  editorKey,
  rawKeyHint,
  renderSegmentTrack,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
} from "@oh-my-pi/pi-tui/chrome";

import { type Model, overdue, type RoundDoc, type StageDoc, type StageStatus, type TodoItem, today } from "#src/documents.ts";
import { byId, plannedRoundCounts, roundActual, schedule, stageReadiness } from "#src/state.ts";
import type { PreviewFile, StatusMenuChoice } from "#src/ui.ts";

export type ConsoleSection = "stages" | "rounds" | "todos";

/** Where the console stood when it closed, so a reopened console shows the same section, search and item. */
export interface ConsoleView {
  section: ConsoleSection;
  query: string;
  selected?: string;
}

/** The one-line result of the last action; `error` marks a refused or failed one. */
export interface ConsoleMessage {
  text: string;
  level: "info" | "error";
}

export interface ConsoleState {
  view?: ConsoleView;
  message?: ConsoleMessage;
  /** YYYY-MM-DD deciding which unfinished targets are overdue; defaults to today. */
  on?: string;
}

/** The same actions the inline status menu returns, plus the view to restore when the console reopens. */
export interface ConsoleChoice extends StatusMenuChoice {
  view: ConsoleView;
}

export interface PreviewRequest {
  title: string;
  root: string;
  files: PreviewFile[];
}

const SECTIONS: readonly ConsoleSection[] = ["stages", "rounds", "todos"];
const SECTION_LABELS: Readonly<Record<ConsoleSection, string>> = { stages: "Stages", rounds: "Rounds", todos: "Open TODOs" };
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;
const LABEL_WIDTH = 10;
/** Below this many columns the frame cannot hold both panes; lines are clipped instead of overflowing. */
const MIN_FRAME_WIDTH = 24;

type Entry =
  | { kind: "stage"; id: string; title: string; stage: StageDoc }
  | { kind: "round"; id: string; title: string; round: RoundDoc }
  | { kind: "todo"; id: string; title: string; todo: TodoItem; round: string };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stage and round status glyphs from the host's symbol preset, colored like Atlas rows. */
export function statusMark(theme: Theme, status: StageStatus): string {
  if (status === "closed") return theme.fg("success", theme.status.success);
  if (status === "active") return theme.fg("accent", theme.status.running);
  if (status === "dropped") return theme.fg("muted", theme.status.disabled);
  return theme.fg("dim", theme.status.pending);
}

function todoMark(theme: Theme, item: TodoItem): string {
  if (item.severity === "high") return theme.fg("error", theme.status.warning);
  if (item.severity === "low") return theme.fg("dim", theme.status.info);
  return theme.fg("warning", theme.status.info);
}

function hintLines(hints: readonly string[], width: number): string[] {
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

/** Keeps the end of a path, which names the file, when the sidebar is too narrow for all of it. */
function truncateStart(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return truncateToWidth(text, width);
  const chars = [...text];
  let tail = "";
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = `${chars[index]}${tail}`;
    if (visibleWidth(next) > width - 1) break;
    tail = next;
  }
  return `…${tail}`;
}

/** Field rows with a hanging indent, wrapped paragraphs and Markdown sections for a detail pane. */
class DetailLines {
  readonly lines: string[] = [];

  constructor(
    readonly theme: Theme,
    readonly width: number,
    readonly markdown: (text: string, width: number) => readonly string[],
  ) {}

  heading(text: string): void {
    this.lines.push(...wrapTextWithAnsi(this.theme.bold(this.theme.fg("accent", text)), this.width));
  }

  blank(): void {
    this.lines.push("");
  }

  text(text: string): void {
    for (const paragraph of text.split("\n")) this.lines.push(...wrapTextWithAnsi(paragraph, this.width));
  }

  field(label: string, value: string): void {
    if (this.width < 30) {
      this.lines.push(...wrapTextWithAnsi(`${this.theme.fg("muted", label.padEnd(LABEL_WIDTH))}${value}`, this.width));
      return;
    }
    const wrapped = wrapTextWithAnsi(value, this.width - LABEL_WIDTH);
    for (const [index, line] of wrapped.entries())
      this.lines.push(`${index ? padding(LABEL_WIDTH) : this.theme.fg("muted", label.padEnd(LABEL_WIDTH))}${line}`);
  }

  /** One row per value, cut to the pane: lists name items whose detail is elsewhere. The label shows on the first. */
  list(label: string, values: readonly string[]): void {
    values.forEach((value, index) => {
      const head = index ? padding(LABEL_WIDTH) : this.theme.fg("muted", label.padEnd(LABEL_WIDTH));
      this.lines.push(truncateToWidth(`${head}${value}`, this.width));
    });
  }

  section(title: string, body: string | undefined): void {
    if (!body?.trim()) return;
    this.lines.push("", this.theme.bold(title));
    this.lines.push(...this.markdown(body.trim(), this.width));
  }
}

/**
 * Fullscreen two-pane frame shared by the console and the preview: title bar, header rows, a selectable sidebar,
 * an independently scrolling detail pane, one message row and wrapped key hints.
 */
abstract class SplitPane implements Component {
  protected selected = 0;
  protected message: ConsoleMessage | undefined;
  #scroll = 0;
  #scrollMax = Number.MAX_SAFE_INTEGER;
  #bodyRows = 1;
  /** Last frame's geometry: mouse reports hit-test against what was painted. */
  #bodyTop = 0;
  #dividerCol = 0;
  readonly #markdown = new Map<string, Markdown>();

  constructor(
    readonly theme: Theme,
    readonly tui: TUI,
  ) {}

  protected abstract count(): number;
  protected abstract title(): string;
  /** Rows between the title bar and the split, at most `width` columns each once truncated. */
  protected abstract header(width: number): string[];
  protected abstract sidebarRow(index: number, width: number): string;
  protected abstract emptySidebar(): string;
  protected abstract body(width: number): string[];
  protected abstract hints(): string[];
  /** Keys other than mouse reports and the shared navigation keys. */
  protected abstract handleKey(key: string): void;

  protected select(index: number): void {
    const next = Math.max(0, Math.min(this.count() - 1, index));
    if (next === this.selected) return;
    this.selected = next;
    this.#scroll = 0;
    this.#scrollMax = Number.MAX_SAFE_INTEGER;
  }

  /** Jumps to `index` even when it equals the current row, so a changed list starts at the top of its detail. */
  protected reset(index: number): void {
    this.selected = Math.max(0, Math.min(this.count() - 1, index));
    this.#scroll = 0;
    this.#scrollMax = Number.MAX_SAFE_INTEGER;
  }

  protected markdown(text: string, width: number): readonly string[] {
    let component = this.#markdown.get(text);
    if (!component) {
      component = new Markdown(text, 0, 0, getMarkdownTheme());
      this.#markdown.set(text, component);
    }
    return component.render(width);
  }

  protected detail(width: number): DetailLines {
    return new DetailLines(this.theme, width, (text, at) => this.markdown(text, at));
  }

  #scrollBy(delta: number): void {
    this.#scroll = Math.max(0, Math.min(this.#scrollMax, this.#scroll + delta));
  }

  /** Wheel over the sidebar moves the selection, over the detail scrolls it; every other report is swallowed. */
  #handleMouse(event: SgrMouseEvent): void {
    if (event.wheel === null) return;
    const line = event.row - this.#bodyTop;
    if (line < 0 || line >= this.#bodyRows) return;
    if (event.col < this.#dividerCol) this.select(this.selected + event.wheel);
    else if (event.col > this.#dividerCol) this.#scrollBy(event.wheel * WHEEL_ROWS);
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the message or act as a key.
    if (
      routeSgrMouseInput(key, (event) => {
        this.#handleMouse(event);
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.message = undefined;
    if (matchesKey(key, "up")) this.select(this.selected - 1);
    else if (matchesKey(key, "down")) this.select(this.selected + 1);
    else if (matchesKey(key, "home")) this.select(0);
    else if (matchesKey(key, "end")) this.select(this.count() - 1);
    else if (matchesKey(key, "pageDown")) this.#scrollBy(Math.max(1, this.#bodyRows - 2));
    else if (matchesKey(key, "pageUp")) this.#scrollBy(-Math.max(1, this.#bodyRows - 2));
    else this.handleKey(key);
    this.tui.requestRender();
  }

  /** Shared hints for the navigation keys this frame handles. */
  protected navigationHints(item: string): string[] {
    return [
      this.theme.fg("dim", `${editorKey("tui.select.up")}/${editorKey("tui.select.down")}`) + this.theme.fg("muted", ` ${item}`),
      this.theme.fg("dim", "PgDn/wheel") + this.theme.fg("muted", " scroll"),
    ];
  }

  render(width: number): readonly string[] {
    const t = this.theme;
    const height = Math.max(12, this.tui.terminal?.rows || process.stdout.rows || 40);
    const frameWidth = Math.max(width, MIN_FRAME_WIDTH);
    const inner = frameWidth - 4;
    let sidebarWidth = Math.max(18, Math.min(52, Math.floor(frameWidth * 0.36)));
    if (splitBodyWidth(frameWidth, sidebarWidth) < 16) sidebarWidth = Math.max(4, Math.floor((frameWidth - 7) / 2));
    const bodyWidth = Math.max(1, splitBodyWidth(frameWidth, sidebarWidth));
    const header = this.header(inner);
    // Short terminals keep most rows for the panes: hints get at most a third, dropped from the end.
    const hints = hintLines(this.hints(), inner).slice(0, Math.max(1, Math.floor((height - header.length - 5) / 3)));
    const message = this.message
      ? t.fg(this.message.level === "error" ? "error" : "warning", truncateToWidth(singleLine(this.message.text), inner))
      : "";

    // Title, header, split rule, body, closing rule, message, hints and bottom border fill the terminal.
    this.#bodyRows = Math.max(3, height - header.length - hints.length - 5);
    this.#bodyTop = 1 + header.length + 1;
    this.#dividerCol = sidebarWidth + 3;
    const body = this.body(bodyWidth);
    this.#scrollMax = Math.max(0, body.length - this.#bodyRows);
    this.#scroll = Math.min(this.#scroll, this.#scrollMax);
    const shown = body.slice(this.#scroll, this.#scroll + this.#bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - this.#scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn/wheel to scroll`);

    const total = this.count();
    let sidebar: string[];
    if (!total) sidebar = wrapTextWithAnsi(t.fg("dim", this.emptySidebar()), sidebarWidth);
    else {
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.#bodyRows / 2), total - this.#bodyRows));
      sidebar = Array.from({ length: Math.min(this.#bodyRows, total - start) }, (_, offset) =>
        truncateToWidth(this.sidebarRow(start + offset, sidebarWidth), sidebarWidth),
      );
    }

    const box = t.boxRound;
    const splitOpen = t.fg(
      "border",
      box.teeRight +
        box.horizontal.repeat(sidebarWidth + 2) +
        box.teeDown +
        box.horizontal.repeat(Math.max(0, frameWidth - sidebarWidth - 5)) +
        box.teeLeft,
    );
    const lines = [
      topBorder(frameWidth, this.title()),
      ...header.map((line) => row(truncateToWidth(line, inner), frameWidth)),
      splitOpen,
      ...Array.from({ length: this.#bodyRows }, (_, index) =>
        splitRow(sidebar[index] ?? "", truncateToWidth(shown[index] ?? "", bodyWidth), frameWidth, sidebarWidth),
      ),
      dividerSplit(frameWidth, sidebarWidth),
      row(message, frameWidth),
      ...hints.map((line) => row(line, frameWidth)),
      bottomBorder(frameWidth),
    ];
    return frameWidth === width ? lines : lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

/**
 * The fullscreen `/roadmap` console: Stages of the active round, every Round and the Open TODOs as Tab sections,
 * the selected item's detail on the right. Actions close it with a {@link ConsoleChoice}; Esc closes with undefined.
 */
export class RoadmapConsole extends SplitPane {
  readonly #on: string;
  readonly #active: RoundDoc | undefined;
  readonly #nextPlanned: RoundDoc | undefined;
  readonly #entries: Readonly<Record<ConsoleSection, Entry[]>>;
  /** The last selected id per section, so Tab returns to it. */
  readonly #remembered = new Map<ConsoleSection, string>();
  #section: ConsoleSection;
  #query: string;
  #visible: Entry[] = [];
  #finished = false;

  constructor(
    readonly model: Model,
    state: ConsoleState,
    theme: Theme,
    tui: TUI,
    readonly done: (choice: ConsoleChoice | undefined) => void,
  ) {
    super(theme, tui);
    this.#on = state.on ?? today();
    this.#active = model.rounds.find((round) => round.status === "active");
    this.#nextPlanned = model.rounds.filter((round) => round.status === "planned").sort(byId)[0];
    const rounds = [...model.rounds].sort(byId);
    const stages = this.#active ? model.stages.filter((stage) => stage.round === this.#active?.id).sort(byId) : [];
    const todos = model.todos
      .flatMap((doc) => doc.items.filter((item) => item.status === "open").map((todo) => ({ todo, round: doc.round })))
      .sort((a, b) => byId(a.todo, b.todo));
    this.#entries = {
      stages: stages.map((stage) => ({ kind: "stage", id: stage.id, title: stage.title, stage })),
      rounds: rounds.map((round) => ({ kind: "round", id: round.id, title: round.title, round })),
      todos: todos.map(({ todo, round }) => ({ kind: "todo", id: todo.id, title: todo.title, todo, round })),
    };
    this.#section = state.view?.section ?? (this.#active ? "stages" : "rounds");
    this.#query = state.view?.query ?? "";
    this.message = state.message;
    this.#refilter(state.view?.selected ?? this.#defaultSelection(this.#section));
  }

  #defaultSelection(section: ConsoleSection): string | undefined {
    if (section === "stages") {
      const stages = this.#entries.stages.flatMap((entry) => (entry.kind === "stage" ? [entry.stage] : []));
      return (stages.find((stage) => stage.status === "active") ?? stages.find((stage) => stage.status === "planned"))?.id;
    }
    if (section === "rounds") return (this.#active ?? this.#nextPlanned ?? [...this.model.rounds].sort(byId).at(-1))?.id;
    return undefined;
  }

  #matches(entry: Entry, query: string): boolean {
    const extra =
      entry.kind === "stage"
        ? entry.stage.status
        : entry.kind === "round"
          ? entry.round.status
          : `${entry.todo.severity ?? ""} ${entry.todo.target ?? ""} ${entry.todo.trigger ?? ""}`;
    return `${entry.id} ${entry.title} ${extra}`.toLowerCase().includes(query);
  }

  #refilter(selectedId: string | undefined): void {
    const query = this.#query.trim().toLowerCase();
    this.#visible = this.#entries[this.#section].filter((entry) => !query || this.#matches(entry, query));
    this.reset(
      Math.max(
        0,
        this.#visible.findIndex((entry) => entry.id === selectedId),
      ),
    );
  }

  #current(): Entry | undefined {
    return this.#visible[this.selected];
  }

  #switchTo(section: ConsoleSection, selectedId?: string): void {
    const current = this.#current();
    if (current) this.#remembered.set(this.#section, current.id);
    this.#section = section;
    this.#query = "";
    this.#refilter(selectedId ?? this.#remembered.get(section) ?? this.#defaultSelection(section));
  }

  #view(): ConsoleView {
    const current = this.#current();
    return { section: this.#section, query: this.#query, ...(current ? { selected: current.id } : {}) };
  }

  #choose(choice: StatusMenuChoice): void {
    if (this.#finished) return;
    this.#finished = true;
    this.done({ ...choice, view: this.#view() });
  }

  #roundSettled(): boolean {
    return this.#entries.stages.every(
      (entry) => entry.kind === "stage" && (entry.stage.status === "closed" || entry.stage.status === "dropped"),
    );
  }

  #primary(): void {
    const entry = this.#current();
    if (!entry) this.message = { text: this.emptySidebar(), level: "info" };
    else if (entry.kind === "stage") this.#choose({ action: "stage", stage: entry.id });
    else if (entry.kind === "round") this.#choose({ action: "round", round: entry.id });
    else this.#goToTarget(entry.todo);
  }

  #goToTarget(item: TodoItem): void {
    if (!item.target) {
      this.message = {
        text: `${item.id} waits on a trigger${item.trigger ? ` (${singleLine(item.trigger)})` : ""}, not a stage`,
        level: "info",
      };
      return;
    }
    const stage = this.model.stages.find((candidate) => candidate.id === item.target);
    if (stage && stage.round === this.#active?.id) this.#switchTo("stages", stage.id);
    else if (stage) {
      this.#switchTo("rounds", stage.round);
      this.message = { text: `${item.id} targets ${stage.id}, a stage of ${stage.round}`, level: "info" };
    } else if (this.model.rounds.some((round) => round.id === item.target)) this.#switchTo("rounds", item.target);
    else this.message = { text: `${item.id} targets ${item.target}, which is not in the roadmap`, level: "error" };
  }

  #closeStage(): void {
    const entry = this.#current();
    if (entry?.kind === "stage" && entry.stage.status === "active") this.#choose({ action: "close", stage: entry.id });
    else this.message = { text: "Select an active stage in Stages to close it", level: "info" };
  }

  #closeRound(): void {
    if (!this.#active) this.message = { text: "There is no active round to close", level: "info" };
    else if (!this.#roundSettled())
      this.message = { text: `Close or drop every stage of ${this.#active.id} before closing the round`, level: "info" };
    else this.#choose({ action: "close-round" });
  }

  #newRound(): void {
    if (this.#active) this.message = { text: `Close ${this.#active.id} before opening another round`, level: "info" };
    else this.#choose({ action: "new-round" });
  }

  protected handleKey(key: string): void {
    if (matchesKey(key, "escape")) {
      if (this.#query) {
        const current = this.#current();
        this.#query = "";
        this.#refilter(current?.id);
      } else if (!this.#finished) {
        this.#finished = true;
        this.done(undefined);
      }
    } else if (matchesKey(key, "tab") || matchesKey(key, "shift+tab")) {
      const step = matchesKey(key, "tab") ? 1 : SECTIONS.length - 1;
      this.#switchTo(SECTIONS[(SECTIONS.indexOf(this.#section) + step) % SECTIONS.length] as ConsoleSection);
    } else if (matchesKey(key, "enter")) this.#primary();
    else if (key === "C" || matchesKey(key, "shift+c")) this.#choose({ action: "check" });
    else if (key === "X" || matchesKey(key, "shift+x")) this.#closeStage();
    else if (key === "R" || matchesKey(key, "shift+r")) this.#closeRound();
    else if (key === "N" || matchesKey(key, "shift+n")) this.#newRound();
    else if (key === "P" || matchesKey(key, "shift+p")) this.#choose({ action: "plan-round" });
    else if (matchesKey(key, "backspace")) {
      if (!this.#query) return;
      this.#query = [...this.#query].slice(0, -1).join("");
      this.#refilter(this.#current()?.id);
    } else if ([...key].length === 1 && !/[\p{Cc}]/u.test(key)) {
      this.#query += key;
      this.#refilter(this.#current()?.id);
    }
  }

  protected count(): number {
    return this.#visible.length;
  }

  protected title(): string {
    return `Roadmap · ${this.model.index.title}`;
  }

  protected header(width: number): string[] {
    const t = this.theme;
    let summary: string;
    const round = this.#active;
    const planned = this.model.rounds.filter((candidate) => candidate.status === "planned").length;
    const open = this.#entries.todos.length;
    if (round) {
      const stages = this.#entries.stages.flatMap((entry) => (entry.kind === "stage" ? [entry.stage] : []));
      const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      const late = stages.filter((stage) => overdue(stage, this.#on)).length;
      const dates = schedule(round, roundActual(round), this.#on);
      summary = [
        `${statusMark(t, round.status)} ${t.bold(`${round.id} ${round.title}`)}`,
        `${settled}/${plural(stages.length, "stage")} settled`,
        plural(open, "open TODO"),
        ...(dates ? [dates] : []),
        ...(late ? [t.fg("warning", plural(late, "overdue stage"))] : []),
        ...(planned ? [plural(planned, "planned round")] : []),
      ].join(" · ");
    } else {
      const last = this.model.rounds
        .filter((candidate) => candidate.status !== "planned")
        .sort(byId)
        .at(-1);
      summary = [
        last ? `No active round (last: ${last.id} ${last.title}, ${last.status})` : planned ? "No active round" : "No rounds yet",
        ...(planned ? [plural(planned, "planned round")] : []),
        ...(open ? [plural(open, "open TODO")] : []),
      ].join(" · ");
    }
    if (this.model.index.format === 1) summary += t.fg("dim", " · format 1");
    const tabs = renderSegmentTrack(
      SECTIONS.map((section) => ({ label: `${SECTION_LABELS[section]} ${this.#entries[section].length}` })),
      SECTIONS.indexOf(this.#section),
    );
    const search = this.#query
      ? `Search: ${this.#query}${t.fg("dim", `  ${this.#visible.length}/${this.#entries[this.#section].length}`)}`
      : t.fg("dim", "Type to search");
    // Long round titles wrap onto a second row rather than hiding the counts.
    return [...wrapTextWithAnsi(summary, width).slice(0, 2), `${tabs}  ${search}`];
  }

  protected emptySidebar(): string {
    if (this.#query) return "Nothing matches the search; Esc clears it";
    if (this.#section === "stages") {
      if (this.#active) return `${this.#active.id} has no stages yet`;
      return `No active round; Shift+N ${this.#nextPlanned ? `activates ${this.#nextPlanned.id}` : "opens a new round"}`;
    }
    if (this.#section === "rounds") return "No rounds yet";
    return "No open TODOs";
  }

  #mark(entry: Entry): string {
    if (entry.kind === "stage") return statusMark(this.theme, entry.stage.status);
    if (entry.kind === "round") return statusMark(this.theme, entry.round.status);
    return todoMark(this.theme, entry.todo);
  }

  protected sidebarRow(index: number, width: number): string {
    const t = this.theme;
    const entry = this.#visible[index] as Entry;
    const isSelected = index === this.selected;
    const cursorWidth = visibleWidth(t.nav.cursor) + 1;
    const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : padding(cursorWidth);
    // Preset glyphs differ in cell width (unicode ✔ vs ascii [ok]); pad them to one column.
    const markWidth = Math.max(1, ...this.#visible.map((candidate) => visibleWidth(this.#mark(candidate))));
    const mark = this.#mark(entry);
    const idWidth = Math.max(0, ...this.#visible.map((candidate) => candidate.id.length));
    const prefix = `${cursor}${mark}${padding(markWidth - visibleWidth(mark))} ${t.fg("muted", entry.id.padEnd(idWidth))} `;
    const late = entry.kind === "stage" ? overdue(entry.stage, this.#on) : entry.kind === "round" ? overdue(entry.round, this.#on) : false;
    const tail = late ? ` ${t.fg("warning", t.status.warning)}` : "";
    const titleWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(tail));
    const title = t.fg(isSelected ? "accent" : "text", truncateToWidth(singleLine(entry.title), titleWidth));
    return `${prefix}${title}${tail}`;
  }

  protected hints(): string[] {
    const entry = this.#current();
    const round = this.#active;
    return [
      ...this.navigationHints("select"),
      ...(entry ? [rawKeyHint("enter", entry.kind === "todo" ? "go to target" : "post status")] : []),
      rawKeyHint("tab", "section"),
      ...(entry?.kind === "stage" && entry.stage.status === "active" ? [rawKeyHint("shift+x", "close stage")] : []),
      ...(round && this.#roundSettled() ? [rawKeyHint("shift+r", `close ${round.id}`)] : []),
      ...(!round ? [rawKeyHint("shift+n", this.#nextPlanned ? `activate ${this.#nextPlanned.id}` : "new round")] : []),
      rawKeyHint("shift+p", "plan a round"),
      rawKeyHint("shift+c", "check"),
      rawKeyHint("escape", this.#query ? "clear search" : "close"),
    ];
  }

  protected body(width: number): string[] {
    const entry = this.#current();
    if (!entry) return [this.theme.fg("dim", "Nothing selected")];
    const detail = this.detail(width);
    if (entry.kind === "stage") this.#stageDetail(detail, entry.stage);
    else if (entry.kind === "round") this.#roundDetail(detail, entry.round);
    else this.#todoDetail(detail, entry.todo, entry.round);
    return detail.lines;
  }

  #stageLine(stage: StageDoc): string {
    return `${statusMark(this.theme, stage.status)} ${stage.id} ${singleLine(stage.title)}`;
  }

  #openTodos(target: string): string[] {
    return this.#entries.todos.flatMap((entry) =>
      entry.kind === "todo" && entry.todo.target === target
        ? [
            `${todoMark(this.theme, entry.todo)} ${entry.id} ${singleLine(entry.title)}${this.theme.fg("dim", ` · ${entry.todo.severity ?? "normal"}`)}`,
          ]
        : [],
    );
  }

  #stageDetail(detail: DetailLines, stage: StageDoc): void {
    const t = this.theme;
    detail.heading(`${stage.id} — ${stage.title}`);
    detail.blank();
    const readiness = stageReadiness(this.model, stage);
    const ready = readiness.startable
      ? t.fg("success", " · ready to start")
      : readiness.blockedBy.length
        ? t.fg("warning", ` · blocked by ${readiness.blockedBy.join(", ")}`)
        : "";
    detail.field("Status", `${statusMark(t, stage.status)} ${stage.status}${ready}`);
    const round = this.model.rounds.find((candidate) => candidate.id === stage.round);
    detail.field("Round", round ? `${round.id} ${singleLine(round.title)} [${round.status}]` : stage.round);
    if (stage.target) detail.field("Target", `${stage.target}${overdue(stage, this.#on) ? t.fg("warning", " · overdue") : ""}`);
    detail.field(
      "Dates",
      [`created ${stage.created}`, stage.started ? `started ${stage.started}` : "", stage.closed ? `${stage.status} ${stage.closed}` : ""]
        .filter(Boolean)
        .join(" · "),
    );
    const dependencies = stage.depends_on.map((id) => {
      const other = this.model.stages.find((candidate) => candidate.id === id);
      return other ? this.#stageLine(other) : id;
    });
    detail.list("Depends", dependencies.length ? dependencies : [t.format.dash]);
    if (stage.follows) detail.field("Follows", stage.follows);
    const adrs = (this.model.adrs?.records ?? [])
      .filter((record) => record.stage === stage.id)
      .sort(byId)
      .map(
        (record) =>
          `${record.id} ${singleLine(record.title)}${t.fg(record.status === "proposed" ? "warning" : "dim", ` · ${record.status}`)}`,
      );
    if (adrs.length) detail.list("ADRs", adrs);
    const todos = this.#openTodos(stage.id);
    detail.list("TODOs", todos.length ? todos : [t.fg("dim", "none open")]);
    detail.section("Objective", stage.objective);
    detail.section("In scope", stage.scope_in);
    detail.section("Out of scope", stage.scope_out);
    detail.section("Done criteria", stage.done_criteria);
    detail.section("Design constraints", stage.design_constraints);
    detail.section("Risks", stage.risks);
    detail.section("Amendments", stage.amendments);
    detail.section("Free-work log", stage.free_work_log);
    detail.section("Outcome", stage.outcome);
  }

  #roundDetail(detail: DetailLines, round: RoundDoc): void {
    const t = this.theme;
    detail.heading(`${round.id} — ${round.title}`);
    detail.blank();
    detail.field(
      "Status",
      `${statusMark(t, round.status)} ${round.status}${round === this.#nextPlanned ? t.fg("dim", " · next to activate") : ""}`,
    );
    if (round.target) detail.field("Target", `${round.target}${overdue(round, this.#on) ? t.fg("warning", " · overdue") : ""}`);
    const actual = roundActual(round);
    if (actual) detail.field("Dates", actual);
    const stages = this.model.stages.filter((stage) => stage.round === round.id).sort(byId);
    const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
    detail.field("Stages", stages.length ? `${settled}/${stages.length} settled` : t.fg("dim", "none yet"));
    detail.list(
      "",
      stages.map((stage) => `${this.#stageLine(stage)}${overdue(stage, this.#on) ? t.fg("warning", " · overdue") : ""}`),
    );
    const { openTodos } = plannedRoundCounts(this.model, round.id);
    detail.field("TODOs", openTodos ? `${openTodos} open` : t.fg("dim", "none open"));
    detail.section("Goal", round.goal);
    detail.section("Constraints", round.constraints);
    detail.section("Non-goals", round.non_goals);
    detail.section("Principles", round.principles);
    detail.section("Known limitations", round.known_limitations);
    detail.section("Outcome", round.outcome);
  }

  #todoDetail(detail: DetailLines, item: TodoItem, round: string): void {
    const t = this.theme;
    detail.heading(`${item.id} — ${item.title}`);
    detail.blank();
    detail.field("Status", `${todoMark(t, item)} ${item.status} · ${item.severity ?? "normal"} severity`);
    const owner = this.model.rounds.find((candidate) => candidate.id === round);
    detail.field("Round", owner ? `${owner.id} ${singleLine(owner.title)} [${owner.status}]` : round);
    if (item.target) {
      const stage = this.model.stages.find((candidate) => candidate.id === item.target);
      detail.field("Target", stage ? `${this.#stageLine(stage)}${t.fg("dim", ` · ${stage.round}`)}` : item.target);
    }
    if (item.trigger) detail.field("Trigger", singleLine(item.trigger));
    if (item.source) detail.field("Source", singleLine(item.source));
    if (item.carried_from) detail.field("Carried", `from ${item.carried_from}`);
    if (item.reference) detail.field("Reference", singleLine(item.reference));
    detail.section("Details", item.body);
  }
}

/** Frontmatter stays plain so the YAML that will be written reads exactly; the rest renders as Markdown. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  return match ? { frontmatter: match[0].trimEnd(), body: content.slice(match[0].length) } : { frontmatter: "", body: content };
}

/**
 * Fullscreen write preview: the write and cancel actions around the repo-relative file list on the left, the selected
 * file on the right. Resolves true to write every file and false to write nothing.
 */
export class PreviewView extends SplitPane {
  #raw = false;
  #finished = false;
  readonly #paths: string[];

  constructor(
    readonly preview: PreviewRequest,
    theme: Theme,
    tui: TUI,
    readonly done: (answer: boolean) => void,
  ) {
    super(theme, tui);
    this.#paths = preview.files.map((file) => relative(preview.root, file.path));
  }

  #answer(answer: boolean): void {
    if (this.#finished) return;
    this.#finished = true;
    this.done(answer);
  }

  /** Index of the selected file, or undefined on the write and cancel rows. */
  #file(): number | undefined {
    const index = this.selected - 1;
    return index >= 0 && index < this.preview.files.length ? index : undefined;
  }

  protected handleKey(key: string): void {
    if (matchesKey(key, "escape")) this.#answer(false);
    else if (key === "W" || matchesKey(key, "shift+w")) this.#answer(true);
    else if (matchesKey(key, "enter")) {
      if (this.selected === 0) this.#answer(true);
      else if (this.selected === this.count() - 1) this.#answer(false);
      else this.message = { text: "Shift+W or the Write row writes every file; Esc cancels", level: "info" };
    } else if ((matchesKey(key, "space") || key === " ") && this.#file() !== undefined) this.#raw = !this.#raw;
  }

  protected count(): number {
    return this.preview.files.length + 2;
  }

  protected title(): string {
    return `Roadmap preview · ${plural(this.preview.files.length, "file")}`;
  }

  protected header(): string[] {
    return [this.theme.bold(singleLine(this.preview.title.split("\n")[0] ?? ""))];
  }

  protected emptySidebar(): string {
    return "";
  }

  #writeLabel(): string {
    return `Write ${plural(this.preview.files.length, "file")}`;
  }

  protected sidebarRow(index: number, width: number): string {
    const t = this.theme;
    const isSelected = index === this.selected;
    const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : padding(visibleWidth(t.nav.cursor) + 1);
    const marks = [t.fg("success", t.status.success), t.fg("error", t.status.error)];
    const markWidth = Math.max(...marks.map((mark) => visibleWidth(mark)));
    const style = (text: string): string => t.fg(isSelected ? "accent" : "text", text);
    if (index === 0) return `${cursor}${marks[0]}${padding(markWidth - visibleWidth(marks[0] as string))} ${style(this.#writeLabel())}`;
    if (index === this.count() - 1)
      return `${cursor}${marks[1]}${padding(markWidth - visibleWidth(marks[1] as string))} ${style("Cancel")}`;
    const prefix = `${cursor}${padding(markWidth + 1)}`;
    return `${prefix}${style(truncateStart(this.#paths[index - 1] ?? "", Math.max(1, width - visibleWidth(prefix))))}`;
  }

  protected hints(): string[] {
    const onFile = this.#file() !== undefined;
    return [
      ...this.navigationHints("file"),
      ...(this.selected === 0 ? [rawKeyHint("enter", "write")] : this.selected === this.count() - 1 ? [rawKeyHint("enter", "cancel")] : []),
      rawKeyHint("shift+w", "write all"),
      ...(onFile ? [rawKeyHint("space", this.#raw ? "rendered" : "raw text")] : []),
      rawKeyHint("escape", "cancel"),
    ];
  }

  protected body(width: number): string[] {
    const t = this.theme;
    const detail = this.detail(width);
    const index = this.#file();
    if (index === undefined) {
      if (this.selected === 0) {
        detail.text(this.preview.title);
        detail.blank();
        detail.lines.push(t.bold("Files"));
        this.#paths.forEach((path, at) => {
          const lines = (this.preview.files[at]?.content ?? "").split("\n").length;
          detail.lines.push(...wrapTextWithAnsi(`${path}${t.fg("dim", ` · ${plural(lines, "line")}`)}`, width));
        });
        detail.blank();
        detail.lines.push(...wrapTextWithAnsi(t.fg("dim", "Enter or Shift+W writes every file. Esc cancels and writes nothing."), width));
      } else detail.lines.push(...wrapTextWithAnsi(t.fg("dim", "Enter cancels: nothing is written."), width));
      return detail.lines;
    }
    const file = this.preview.files[index] as PreviewFile;
    detail.heading(this.#paths[index] ?? file.path);
    detail.lines.push(t.fg("dim", this.#raw ? "Raw text" : "Rendered; Space shows the raw text"));
    detail.blank();
    if (this.#raw || !/\.md$/i.test(file.path)) {
      for (const line of file.content.replace(/\n$/, "").split("\n")) detail.lines.push(...wrapTextWithAnsi(line, width));
      return detail.lines;
    }
    const { frontmatter, body } = splitFrontmatter(file.content);
    for (const line of frontmatter ? frontmatter.split(/\r?\n/) : []) detail.lines.push(...wrapTextWithAnsi(t.fg("dim", line), width));
    if (frontmatter) detail.blank();
    // The managed-file comment renders as nothing; drop the blank rows it leaves before the title.
    const rendered = body.trim() ? this.markdown(body.trim(), width) : [];
    detail.lines.push(
      ...rendered.slice(
        Math.max(
          0,
          rendered.findIndex((line) => Bun.stripANSI(line).trim() !== ""),
        ),
      ),
    );
    return detail.lines;
  }
}
