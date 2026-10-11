import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { AdrConsole, AdrPreview, type ConsoleMessage, type ConsoleResult, type ConsoleState, type DecisionAction } from "#src/console.ts";
import { type AdrRecord, type AdrStatus, STATUSES } from "#src/documents.ts";
import type { UiMenu } from "#src/settings.ts";

export type MenuAction = "accept" | "reject" | "deprecate" | "note" | "supersede" | "new" | "check" | "check-fix";

/** `id` is set for actions on one ADR; `new` and the checks carry none. */
export interface MenuChoice {
  action: MenuAction;
  id?: string;
}

export interface MenuEntry {
  record: AdrRecord;
  /** The `adr_status` detail text, shown read-only from the detail view. */
  detail: string;
}

/** Where a re-opened console resumes: the ADR last acted on and the result of that action. */
export interface MenuOptions {
  selectedId?: string;
  message?: ConsoleMessage;
}
export interface PreviewFile {
  /** Repository-relative path. */
  path: string;
  content: string;
}

export interface AdrUi {
  /** False when no dialog can be answered (`hasUI === false`); callers then take their non-interactive path. */
  readonly interactive: boolean;
  /** True when `menu` is the fullscreen console, which the caller re-opens after an action that completes locally. */
  readonly console: boolean;
  /** Resolves with the chosen action, or undefined when the menu is closed. Inline: status filter, then list, then detail. */
  menu(entries: MenuEntry[], options?: MenuOptions): Promise<MenuChoice | undefined>;
  /** Single-line text; undefined when cancelled. */
  text(title: string, placeholder: string): Promise<string | undefined>;
  previewConfirm(p: { title: string; files: PreviewFile[] }): Promise<boolean | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export type AdrUiContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode">;
export type AdrMessenger = Pick<ExtensionAPI, "sendMessage">;
const NOTICE_TYPE = "wows-omp-adr.notice";

/** No dialogs; notices become displayed session messages so headless and SDK clients still see them. */
export class HeadlessUi implements AdrUi {
  readonly interactive = false;
  readonly console = false;

  constructor(private readonly pi: AdrMessenger) {}

  async menu(): Promise<undefined> {
    return undefined;
  }

  async text(): Promise<undefined> {
    return undefined;
  }

  async previewConfirm(): Promise<undefined> {
    return undefined;
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.pi.sendMessage({
      customType: NOTICE_TYPE,
      content: level === "info" ? message : `ADR ${level}: ${message}`,
      display: true,
      attribution: "agent",
    });
  }
}

const STATUS_GLYPHS: Record<AdrStatus, string> = {
  proposed: "○",
  accepted: "●",
  rejected: "×",
  deprecated: "◌",
  superseded: "→",
};

/** Counts by status, nonzero only, in lifecycle order. */
export function statusCounts(records: readonly Pick<AdrRecord, "status">[]): string {
  const parts = STATUSES.map((status) => [status, records.filter((record) => record.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  return parts.length ? parts.join(", ") : "no ADRs yet";
}

/** Status transitions the menu offers for one ADR; a superseded ADR offers none. */
function decisions(record: AdrRecord): Array<readonly [string, DecisionAction]> {
  if (record.status === "superseded" || record.superseded_by) return [["Append a dated note", "note"]];
  const result: Array<readonly [string, DecisionAction]> = [];
  if (record.status !== "accepted") result.push(["Accept", "accept"]);
  if (record.status !== "rejected") result.push(["Reject", "reject"]);
  if (record.status !== "deprecated") result.push(["Deprecate", "deprecate"]);
  result.push(["Append a dated note", "note"]);
  if (record.status === "accepted" || record.status === "deprecated") result.push(["Supersede with a new decision…", "supersede"]);
  return result;
}

/** Dialog title for one ADR's actions: id, title, status, date, stage and successor. */
function decisionTitle(record: AdrRecord): string {
  const where = [
    record.date,
    record.stage ? `stage ${record.stage}` : "",
    record.superseded_by ? `superseded by ${record.superseded_by}` : "",
  ];
  return `${record.id} ${record.title} [${record.status}] · ${where.filter(Boolean).join(" · ")}`;
}

const FULLSCREEN = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
} as const;

/** `uiMenu` matters only in the terminal UI; RPC and ACP clients cannot mount components and keep the dialogs. */
export function createTuiUi(ctx: AdrUiContext, pi: AdrMessenger, uiMenu: UiMenu): AdrUi {
  if (!ctx.hasUI) return new HeadlessUi(pi);
  const ui = ctx.ui;
  const fullscreen = uiMenu === "fullscreen" && ctx.mode === "tui" && typeof ui.custom === "function";
  const BACK = "← Back";

  async function choose<T>(title: string, options: ReadonlyArray<readonly [string, T]>): Promise<T | undefined> {
    const picked = await ui.select(
      title,
      options.map(([label]) => label),
    );
    return options.find(([label]) => label === picked)?.[1];
  }

  async function detail(entry: MenuEntry): Promise<MenuChoice | "back"> {
    const { record } = entry;
    for (;;) {
      const options: Array<readonly [string, MenuAction | "view" | "back"]> = [
        ["View the decision", "view"],
        ...decisions(record),
        [BACK, "back"],
      ];
      const picked = await choose(decisionTitle(record), options);
      if (picked === undefined || picked === "back") return "back";
      if (picked !== "view") return { action: picked, id: record.id };
      await ui.editor(`${record.path} (read-only, edits are discarded)`, entry.detail);
    }
  }

  async function list(entries: MenuEntry[], label: string): Promise<MenuChoice | "back"> {
    for (;;) {
      const options: Array<readonly [string, MenuEntry | "back"]> = [
        ...entries.map(
          (entry) =>
            [`${STATUS_GLYPHS[entry.record.status]} ${entry.record.id} ${entry.record.title} [${entry.record.status}]`, entry] as const,
        ),
        [BACK, "back"],
      ];
      const picked = await choose(`${label}: ${entries.length} ADR${entries.length === 1 ? "" : "s"}`, options);
      if (picked === undefined || picked === "back") return "back";
      const choice = await detail(picked);
      if (choice !== "back") return choice;
    }
  }

  async function inlineMenu(entries: MenuEntry[]): Promise<MenuChoice | undefined> {
    for (;;) {
      const records = entries.map((entry) => entry.record);
      const filters = [
        ["All ADRs", undefined] as const,
        ...STATUSES.filter((status) => records.some((record) => record.status === status)).map(
          (status) => [`${status[0]?.toUpperCase()}${status.slice(1)}`, status] as const,
        ),
      ];
      const options: Array<readonly [string, { filter: AdrStatus | undefined; label: string } | MenuAction]> = [
        ...(entries.length
          ? filters.map(([label, filter]) => {
              const count = filter ? records.filter((record) => record.status === filter).length : records.length;
              return [`${label} (${count})`, { filter, label }] as const;
            })
          : []),
        ["New decision…", "new"],
        ["Run check", "check"],
        ["Run check and regenerate the index", "check-fix"],
      ];
      const picked = await choose(`ADRs: ${statusCounts(records)}`, options);
      if (picked === undefined) return undefined;
      if (typeof picked === "string") return { action: picked };
      const choice = await list(
        entries.filter((entry) => !picked.filter || entry.record.status === picked.filter),
        picked.label,
      );
      if (choice !== "back") return choice;
    }
  }

  /** Filter and search persist while this UI lives, i.e. across re-opens within one /adr command. */
  let consoleState: ConsoleState = { query: "" };

  /** Enter on an ADR asks which decision to record in the small dialog; Back returns to the console. */
  async function consoleMenu(entries: MenuEntry[], options: MenuOptions): Promise<MenuChoice | undefined> {
    if (options.selectedId) consoleState = { ...consoleState, selectedId: options.selectedId };
    let message = options.message;
    const items = entries.map((entry) => ({ ...entry, offered: decisions(entry.record).map(([, action]) => action) }));
    for (;;) {
      const [result, state] = await ui.custom<[ConsoleResult, ConsoleState]>(
        (tui, theme, _keys, done) => new AdrConsole(items, consoleState, theme, tui, (picked, next) => done([picked, next]), message),
        FULLSCREEN,
      );
      consoleState = state;
      message = undefined;
      if (result.kind === "close") return undefined;
      if (result.kind === "action") return "id" in result ? { action: result.action, id: result.id } : { action: result.action };
      const record = entries.find((entry) => entry.record.id === result.id)?.record;
      if (!record) continue;
      const picked = await choose<DecisionAction | "back">(decisionTitle(record), [...decisions(record), [BACK, "back"]]);
      if (picked !== undefined && picked !== "back") return { action: picked, id: record.id };
    }
  }

  return {
    interactive: true,
    console: fullscreen,

    menu: (entries, options = {}) => (fullscreen ? consoleMenu(entries, options) : inlineMenu(entries)),

    text: (title, placeholder) => ui.input(title, placeholder),

    async previewConfirm(p) {
      if (fullscreen)
        return ui.custom<boolean>((tui, theme, _keys, done) => new AdrPreview(p.title, p.files, theme, tui, done), FULLSCREEN);
      const write = `Write ${p.files.length} file${p.files.length === 1 ? "" : "s"}`;
      const cancel = "Cancel";
      const labels = [write, ...p.files.map((file) => `View ${file.path}`), cancel];
      let initialIndex = 0;
      for (;;) {
        const picked = await ui.select(`${p.title}\nSelect a file to view it, or write all of them.`, labels, { initialIndex });
        if (picked === undefined) return undefined;
        if (picked === write) return true;
        if (picked === cancel) return false;
        initialIndex = labels.indexOf(picked);
        const file = p.files[initialIndex - 1];
        if (file) await ui.editor(`${file.path} (read-only preview, edits are discarded)`, file.content);
      }
    },

    notify(message, level) {
      ui.notify(message, level);
    },
  };
}
