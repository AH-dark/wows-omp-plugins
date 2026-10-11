import { relative } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { type ConsoleChoice, type ConsoleState, PreviewView, RoadmapConsole } from "#src/console.ts";
import {
  type Model,
  overdue,
  ROUND_ASSESSMENTS,
  type RoundAssessment,
  type RoundDoc,
  type StageDoc,
  type StageStatus,
  type TodoItem,
  today,
} from "#src/documents.ts";
import type { UiMenuReader } from "#src/settings.ts";
import { byId, plannedRoundCounts, roundActual, schedule, stageActual } from "#src/state.ts";

export type OverlapAnswer = "roadmap" | "free" | "unrelated";
export type StatusMenuAction = "check" | "stage" | "new-round" | "plan-round" | "round" | "close-round" | "close";
export type RoundTodoDisposition = "resolved" | "wontfix" | "carried";

export interface OverlapQuestion {
  stage: { id: string; title: string; status: StageStatus };
  intent: string;
}

export interface PreviewFile {
  path: string;
  content: string;
}

/** `stage` is set for `stage`/`close`, `round` for `round` (a planned round); other actions carry neither. */
export interface StatusMenuChoice {
  action: StatusMenuAction;
  stage?: string;
  round?: string;
}

export interface RoundTodoDispositionChoice {
  id: string;
  disposition: RoundTodoDisposition;
  reference?: string;
}

export interface RoundOutcomeChoice {
  assessment: RoundAssessment;
  summary: string;
}

/** `upgrade` asks whether to adopt format 2 now; `round-outcome` offers it so a closing format-1 round can record its outcome. */
export type UpgradePurpose = "upgrade" | "round-outcome";

export interface RoadmapUi {
  /** False when no dialog can be answered (`hasUI === false`); callers then take their non-interactive path. */
  readonly interactive: boolean;
  overlap(q: OverlapQuestion): Promise<OverlapAnswer | undefined>;
  /** Fullscreen with the uiMenu setting in a terminal UI, where Esc declines; the select/editor menu otherwise. */
  previewConfirm(p: { title: string; root: string; files: PreviewFile[] }): Promise<boolean | undefined>;
  /** Whether bare `/roadmap` opens the fullscreen console now: a terminal UI with the uiMenu setting `fullscreen`. */
  fullscreenMenu(): Promise<boolean>;
  /** One showing of the fullscreen console; undefined when the user closes it. */
  statusConsole(m: Model, state: ConsoleState): Promise<ConsoleChoice | undefined>;
  /** The inline status menu. `on` (YYYY-MM-DD, default today) decides which unfinished targets are overdue. */
  statusMenu(m: Model, on?: string): Promise<StatusMenuChoice | undefined>;
  closeRoundDispositions(todos: TodoItem[]): Promise<RoundTodoDispositionChoice[] | undefined>;
  /** The round's goal assessment and summary for its Outcome. */
  roundOutcome(round: RoundDoc): Promise<RoundOutcomeChoice | undefined>;
  /** The one-step format-2 upgrade question: true writes it, false keeps format 1, undefined is no answer. */
  upgradePrompt(purpose: UpgradePurpose, signal?: AbortSignal): Promise<boolean | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export type RoadmapUiContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode" | "cwd">;
export type RoadmapMessenger = Pick<ExtensionAPI, "sendMessage">;
export const NOTICE_TYPE = "wows-omp-roadmap.notice";

/** No dialogs; notices become displayed session messages so headless and SDK clients still see them. */
export class HeadlessUi implements RoadmapUi {
  readonly interactive = false;

  constructor(private readonly pi: RoadmapMessenger) {}

  async overlap(): Promise<undefined> {
    return undefined;
  }

  async previewConfirm(): Promise<undefined> {
    return undefined;
  }

  async fullscreenMenu(): Promise<boolean> {
    return false;
  }

  async statusConsole(): Promise<undefined> {
    return undefined;
  }

  async statusMenu(): Promise<undefined> {
    return undefined;
  }

  async closeRoundDispositions(): Promise<undefined> {
    return undefined;
  }

  async roundOutcome(): Promise<undefined> {
    return undefined;
  }

  async upgradePrompt(): Promise<undefined> {
    return undefined;
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.pi.sendMessage({
      customType: NOTICE_TYPE,
      content: level === "info" ? message : `Roadmap ${level}: ${message}`,
      display: true,
      attribution: "agent",
    });
  }
}

export const STATUS_GLYPHS: Record<StageStatus, string> = {
  planned: "○",
  active: "◐",
  closed: "●",
  dropped: "×",
};

const OVERLAP_OPTIONS: ReadonlyArray<readonly [string, OverlapAnswer]> = [
  ["Use the roadmap: bind this session to the stage", "roadmap"],
  ["Free work: proceed and log it on the stage", "free"],
  ["Unrelated: do not ask again for this stage", "unrelated"],
];

const DISPOSITION_OPTIONS: ReadonlyArray<readonly [string, RoundTodoDisposition]> = [
  ["Resolved", "resolved"],
  ["Won't fix", "wontfix"],
  ["Carry to the next round", "carried"],
];

const ASSESSMENT_LABELS: Readonly<Record<RoundAssessment, string>> = {
  achieved: "Achieved: the round goal was met",
  partial: "Partial: the goal was met in part",
  not_achieved: "Not achieved: the goal was not met",
  cancelled: "Cancelled: the goal was abandoned",
};

const UPGRADE_CONSEQUENCES =
  "Roadmap plugin 0.2.3 and earlier can no longer read an upgraded repository. Closed rounds and closed stages are not rewritten: only docs/roadmap/README.md changes now, and other files adopt format 2 when a write needs it.";

const UPGRADE_DIALOGS: Readonly<Record<UpgradePurpose, { title: string; yes: string; no: string }>> = {
  upgrade: {
    title: `This repository uses roadmap format 1. Upgrade it to format 2 now?\nFormat 2 adds planned rounds, target dates and round goal outcomes. ${UPGRADE_CONSEQUENCES}`,
    yes: "Yes, upgrade to format 2",
    no: "No, keep format 1",
  },
  "round-outcome": {
    title: `Recording how the round goal turned out needs roadmap format 2, and this repository uses format 1.\nUpgrade now and record the outcome, or close without one? ${UPGRADE_CONSEQUENCES}`,
    yes: "Upgrade to format 2 and record the round outcome",
    no: "Skip: close the round without an outcome",
  },
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function stageLabel(stage: StageDoc, todos: readonly TodoItem[], on: string): string {
  const count = todos.filter((item) => item.target === stage.id).length;
  const dates = schedule(stage, stageActual(stage), on);
  const suffix = `${dates ? ` · ${dates}` : ""}${count > 0 ? ` · ${plural(count, "open TODO")}` : ""}`;
  return `${STATUS_GLYPHS[stage.status]} ${stage.id} ${stage.title} [${stage.status}]${suffix}`;
}

/** One compact row per planned round: id, title, stage count, open TODOs and target. */
function plannedRoundLabel(m: Model, round: RoundDoc, on: string): string {
  const { stageCount, openTodos } = plannedRoundCounts(m, round.id);
  const dates = schedule(round, null, on);
  return `${STATUS_GLYPHS[round.status]} ${round.id} ${round.title} [planned] · ${plural(stageCount, "stage")}${
    openTodos > 0 ? ` · ${plural(openTodos, "open TODO")}` : ""
  }${dates ? ` · ${dates}` : ""}`;
}

const FULLSCREEN = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
} as const;

/** `uiMenu` reads the setting on every use; without one the setting's default, fullscreen, applies. */
export function createTuiUi(ctx: RoadmapUiContext, pi: RoadmapMessenger, uiMenu?: UiMenuReader): RoadmapUi {
  if (!ctx.hasUI) return new HeadlessUi(pi);
  const ui = ctx.ui;
  // RPC and ACP report hasUI but render no custom components, so they keep the select/editor dialogs.
  const fullscreen = async (): Promise<boolean> =>
    ctx.mode === "tui" && typeof ui.custom === "function" && (uiMenu ? await uiMenu(ctx.cwd) : "fullscreen") === "fullscreen";

  async function choose<T>(title: string, options: ReadonlyArray<readonly [string, T]>): Promise<T | undefined> {
    const picked = await ui.select(
      title,
      options.map(([label]) => label),
    );
    return options.find(([label]) => label === picked)?.[1];
  }

  return {
    interactive: true,
    overlap: (q) =>
      choose(`This request overlaps stage ${q.stage.id} "${q.stage.title}" [${q.stage.status}]\nRequest: ${q.intent}`, OVERLAP_OPTIONS),

    async previewConfirm(p) {
      if (await fullscreen())
        return ui.custom<boolean | undefined>((tui, theme, _keys, done) => new PreviewView(p, theme, tui, done), FULLSCREEN);
      const write = `Write ${plural(p.files.length, "file")}`;
      const cancel = "Cancel";
      const labels = [write, ...p.files.map((file) => `View ${relative(p.root, file.path)}`), cancel];
      let initialIndex = 0;
      for (;;) {
        const picked = await ui.select(`${p.title}\nSelect a file to view it, or write all of them.`, labels, { initialIndex });
        if (picked === undefined) return undefined;
        if (picked === write) return true;
        if (picked === cancel) return false;
        initialIndex = labels.indexOf(picked);
        const file = p.files[initialIndex - 1];
        if (file) await ui.editor(`${relative(p.root, file.path)} (read-only preview, edits are discarded)`, file.content);
      }
    },

    fullscreenMenu: fullscreen,

    statusConsole: (m, state) =>
      ui.custom<ConsoleChoice | undefined>((tui, theme, _keys, done) => new RoadmapConsole(m, state, theme, tui, done), FULLSCREEN),

    statusMenu(m, on = today()) {
      const round = m.rounds.find((candidate) => candidate.status === "active");
      const planned = m.rounds.filter((candidate) => candidate.status === "planned").sort(byId);
      const options: Array<readonly [string, StatusMenuChoice]> = [];
      const plannedOptions = planned.map(
        (candidate) => [plannedRoundLabel(m, candidate, on), { action: "round", round: candidate.id }] as const,
      );
      let title: string;
      if (round) {
        const stages = m.stages.filter((stage) => stage.round === round.id).sort(byId);
        const todos = m.todos.filter((doc) => doc.round === round.id).flatMap((doc) => doc.items.filter((item) => item.status === "open"));
        const untargeted = todos.filter((item) => !stages.some((stage) => stage.id === item.target)).length;
        title = `Roadmap ${round.id} ${round.title} [active] · ${plural(stages.length, "stage")} · ${plural(todos.length, "open TODO")}`;
        if (untargeted > 0) title += ` (${untargeted} by trigger)`;
        const dates = schedule(round, roundActual(round), on);
        if (dates) title += ` · ${dates}`;
        const late = stages.filter((stage) => overdue(stage, on)).length;
        if (late > 0) title += ` · ${plural(late, "overdue stage")}`;
        if (planned.length) title += ` · ${plural(planned.length, "planned round")}`;
        for (const stage of stages) options.push([stageLabel(stage, todos, on), { action: "stage", stage: stage.id }]);
        for (const stage of stages.filter((candidate) => candidate.status === "active")) {
          options.push([`Close stage ${stage.id}`, { action: "close", stage: stage.id }]);
        }
        options.push(...plannedOptions);
        options.push(["Run check", { action: "check" }]);
        if (stages.every((stage) => stage.status === "closed" || stage.status === "dropped")) {
          options.push([`Close round ${round.id}`, { action: "close-round" }]);
        }
      } else {
        const last = m.rounds
          .filter((candidate) => candidate.status !== "planned")
          .sort(byId)
          .at(-1);
        title = last
          ? `Roadmap: no active round (last: ${last.id} ${last.title}, ${last.status})`
          : planned.length
            ? "Roadmap: no active round"
            : "Roadmap: no rounds yet";
        if (planned.length) title += ` · ${plural(planned.length, "planned round")}`;
        options.push(...plannedOptions);
        options.push(["Run check", { action: "check" }]);
        // Only the lowest-numbered planned round can be activated; a brand-new round is refused while any is planned.
        const next = planned[0];
        options.push([next ? `Activate ${next.id} ${next.title}` : "Open a new round", { action: "new-round" }]);
      }
      options.push(["Plan a future round", { action: "plan-round" }]);
      return choose(title, options);
    },

    async closeRoundDispositions(todos) {
      const result: RoundTodoDispositionChoice[] = [];
      for (const [index, item] of todos.entries()) {
        const where = item.target ? `target ${item.target}` : item.trigger ? `trigger: ${item.trigger}` : "no target";
        const disposition = await choose(
          `Close round: ${item.id} ${item.title} (${index + 1}/${todos.length}, ${item.severity ?? "normal"}, ${where})`,
          DISPOSITION_OPTIONS,
        );
        if (disposition === undefined) return undefined;
        if (disposition === "carried") {
          result.push({ id: item.id, disposition });
          continue;
        }
        const prompt = disposition === "resolved" ? "commit, stage or document that resolved it" : "reason it will not be fixed";
        const reference = await ui.input(`${item.id} reference`, prompt);
        if (reference === undefined) return undefined;
        const trimmed = reference.trim();
        result.push(trimmed ? { id: item.id, disposition, reference: trimmed } : { id: item.id, disposition });
      }
      return result;
    },

    async roundOutcome(round) {
      const goal = round.goal.replace(/\s+/g, " ").trim();
      const assessment = await choose(
        `Close round ${round.id} ${round.title}: how did its goal turn out?\nGoal: ${goal.length > 300 ? `${goal.slice(0, 297)}...` : goal}`,
        ROUND_ASSESSMENTS.map((value) => [ASSESSMENT_LABELS[value], value] as const),
      );
      if (assessment === undefined) return undefined;
      const summary = await ui.input(`${round.id} outcome summary`, "What was delivered against the goal and what remains");
      return summary === undefined ? undefined : { assessment, summary: summary.trim() };
    },

    async upgradePrompt(purpose, signal) {
      const dialog = UPGRADE_DIALOGS[purpose];
      const picked = await ui.select(dialog.title, [dialog.yes, dialog.no], signal ? { signal } : undefined);
      return picked === dialog.yes ? true : picked === dialog.no ? false : undefined;
    },

    notify(message, level) {
      ui.notify(message, level);
    },
  };
}
