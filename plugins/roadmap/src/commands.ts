import { lstat } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { AdrConnection } from "#src/adr.ts";
import { check } from "#src/check.ts";
import type { ConsoleChoice, ConsoleMessage, ConsoleState } from "#src/console.ts";
import {
  loadAll,
  loadRepo,
  type Model,
  type Repo,
  ROUND_ASSESSMENTS,
  type RoundAssessment,
  roundFiles,
  roundSha256,
} from "#src/documents.ts";
import {
  autoCarryTodos,
  closeRound,
  type PreparationReceipt,
  prepareRetarget,
  prepareRoundDrop,
  prepareUpgrade,
  type RoundCloseInput,
} from "#src/operations.ts";
import { type ArmedKind, actor, type RoadmapSession, type UiFactory } from "#src/ses.ts";
import {
  applyPreview,
  awaitConfirmation,
  checkReceipt,
  dialogGuard,
  planLookup,
  requireRepo,
  resolveOverlap,
  statusReceipt,
  type ToolReceipt,
  toolResult,
} from "#src/tools.ts";
import type { RoadmapUi, RoundTodoDispositionChoice } from "#src/ui.ts";

export interface RoadmapCommands {
  refresh(ctx: ExtensionContext): Promise<void>;
}

const CLOSE_ROUND_USAGE =
  'Usage: /roadmap close-round [outcome=<achieved|partial|not_achieved|cancelled>:<summary>] [<todo>=resolved:<reference> | <todo>=wontfix[:<reason>] | <todo>=carried ...]; quote text with spaces, e.g. outcome=partial:"checkout shipped, refunds moved" T03=wontfix:"out of scope". Format-2 repositories need the outcome.';
const USAGE =
  "Usage: /roadmap [check [--fix] | upgrade | plan-round [<id>] | new-round | drop-round <id> <reason> | retarget <round-or-stage> <YYYY-MM-DD|none> | close-round [outcome=<assessment>:<summary>] [<todo>=<disposition>[:<reference>] ...] | stage <id> | overlap <stage> roadmap|free|unrelated [intent] | confirm <token>]";
const OVERLAP_ANSWERS: readonly Completion[] = [
  { value: "roadmap", description: "Track this work under the stage" },
  { value: "free", description: "Log it as free work outside the roadmap" },
  { value: "unrelated", description: "Treat it as unrelated to the stage" },
];
const ACTIONS: readonly Completion[] = [
  { value: "check", description: "Check Roadmap documents for consistency" },
  { value: "check --fix", description: "Check documents and regenerate eligible generated blocks" },
  { value: "upgrade", description: "Preview upgrading the repository to the current document format" },
  { value: "plan-round", description: "Interview for a new planned round" },
  { value: "plan-round ", label: "plan-round <id>", description: "Revise a planned round's charter" },
  { value: "new-round", description: "Open the next round, activating the lowest planned round if any" },
  { value: "drop-round ", label: "drop-round <id> <reason>", description: "Drop a planned round with a reason" },
  { value: "retarget ", label: "retarget <round-or-stage> <YYYY-MM-DD|none>", description: "Set or clear a round or stage target date" },
  { value: "close-round", description: "Close the active round with its goal outcome and dispose its open TODOs" },
  { value: "stage ", label: "stage <id>", description: "Show a stage's document and planning handoff" },
  { value: "overlap ", label: "overlap <stage> roadmap|free|unrelated", description: "Answer the overlap question for a stage" },
  { value: "confirm ", label: "confirm <token>", description: "Apply a pending preview by its token" },
];

/** `label` is what the menu shows; actions that take arguments name them so they stay distinguishable from the bare action. */
interface Completion {
  value: string;
  label?: string;
  description: string;
}

/** Splits command arguments on whitespace; double quotes group text with spaces and are removed. */
export function splitArgs(args: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (const char of args) {
    if (char === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (!quoted && /\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + char;
  }
  if (quoted) throw new Error("Unterminated quote in command arguments.");
  if (word !== undefined) words.push(word);
  return words;
}

/** Parses `/roadmap close-round` arguments; closeRound validates TODO ids, completeness and whether the format needs the outcome. */
export function parseRoundCloseArguments(words: readonly string[]): Pick<RoundCloseInput, "dispositions" | "outcome"> {
  const dispositions: RoundTodoDispositionChoice[] = [];
  let outcome: RoundCloseInput["outcome"];
  for (const word of words) {
    const assessed = /^outcome=([a-z_]+):([\s\S]*)$/.exec(word);
    if (assessed) {
      const summary = assessed[2]?.trim();
      if (outcome || !(ROUND_ASSESSMENTS as readonly string[]).includes(assessed[1] as string) || !summary)
        throw new Error(`Invalid or repeated round outcome "${word}". ${CLOSE_ROUND_USAGE}`);
      outcome = { assessment: assessed[1] as RoundAssessment, summary };
      continue;
    }
    const match = /^([^=:\s]+)=(resolved|wontfix|carried)(?::([\s\S]*))?$/.exec(word);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid round-close disposition "${word}". ${CLOSE_ROUND_USAGE}`);
    const disposition = match[2] as RoundTodoDispositionChoice["disposition"];
    const reference = match[3]?.trim();
    dispositions.push(reference ? { id: match[1], disposition, reference } : { id: match[1], disposition });
  }
  return outcome ? { dispositions, outcome } : { dispositions };
}

/** The active round as a menu or console showed it; closing it later is refused once the round or its files changed. */
interface ReviewedRound {
  id: string;
  sha256: string;
}

function reviewedRound(model: Model): ReviewedRound | undefined {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  return round && { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
}

/** One /roadmap action: typed words, or the inline menu's or the console's choice. */
interface ActionRequest {
  action: string;
  words: readonly string[];
  /** The stage or round the action names: the second typed word or the menu selection. */
  selected: string | undefined;
  reviewedRound?: ReviewedRound;
  model: Model;
}

interface ActionResult {
  /** The model acts next, so the console closes and the conversation continues. */
  handoff?: true;
  /** The console's one-line result; typed commands and the inline menu leave results to the conversation. */
  summary?: ConsoleMessage;
}

/** The console line for a receipt the command also posted: the summary's first line on success, else the refusal. */
function resultLine(receipt: ToolReceipt): ConsoleMessage {
  return receipt.ok
    ? { text: receipt.summary.split("\n")[0] ?? "", level: "info" }
    : { text: receipt.reason.split("\n")[0] ?? "", level: "error" };
}

export function registerCommands(
  pi: ExtensionAPI,
  ses: RoadmapSession,
  uiFor: UiFactory,
  changed: (ctx: ExtensionContext) => void,
  adr: AdrConnection,
): RoadmapCommands {
  let stages: Completion[] = [];
  let plannedRounds: Completion[] = [];
  let rounds: Completion[] = [];

  function rememberStages(model: Model): void {
    stages = model.stages.map((stage) => ({ value: stage.id, description: `${stage.title} (${stage.status})` }));
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    stages = [];
    plannedRounds = [];
    rounds = [];
    const repo = await loadRepo(ctx.cwd);
    if (repo) {
      const model = await loadAll(repo);
      rememberStages(model);
      const sorted = [...model.rounds].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
      rounds = sorted.map((round) => ({ value: round.id, description: `${round.title} (${round.status})` }));
      plannedRounds = sorted.filter((round) => round.status === "planned").map((round) => ({ value: round.id, description: round.title }));
    }
  }

  pi.registerCommand("init-project", {
    description: "Interview the user, preview and initialize a Roadmap project and its first round",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const ui = uiFor(ctx);
      try {
        if (ctx.agent.kind !== "main") throw new Error("/init-project requires the main session.");
        if (args.trim()) throw new Error("Usage: /init-project");
        const api = adr.require(ctx.sessionManager.getSessionId());
        const repo = await requireRepo(ctx, api, true);
        try {
          await lstat(repo.roadmapDir);
          throw new Error("docs/roadmap/ already exists; this plugin does not adopt existing projects.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if ((await api.dirState(repo.repoRoot)) === "unmanaged")
          throw new Error("docs/adr/ is not empty and is not managed by the adr plugin; move its files out before initialization.");
        ses.arm(ctx, repo.repoRoot, "init");
        pi.sendUserMessage(
          "Use the roadmap skill's /init-project interview checklist: project identity and description; first-round goal, constraints, non-goals and principles; decisions already made as initial ADRs, which roadmap_init creates through the adr plugin (existing ADRs in docs/adr/ are cited by their ids); stage breakdown with objectives, scope, verifiable done criteria and dependencies. Interview me before drafting. Then call roadmap_init with the complete draft; it will show a preview for my confirmation before writing files.",
        );
      } catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  function show(customType: string, receipt: ToolReceipt, footer?: string): void {
    const text = toolResult(receipt).content.map((part) => part.text);
    pi.sendMessage({ customType, content: [...text, ...(footer ? [footer] : [])].join("\n"), display: true });
  }

  /** Shows a write preview; returns the console line for the written, refused or declined change. */
  async function commandPreview(
    ctx: ExtensionCommandContext,
    ui: RoadmapUi,
    repo: Repo,
    kind: ArmedKind,
    build: () => Promise<PreparationReceipt>,
    notice: RoadmapUi["notify"],
  ): Promise<ActionResult> {
    ses.arm(ctx, repo.repoRoot, kind);
    const generation = ses.currentGeneration(ctx);
    const prepared = await build();
    if (!prepared.ok) {
      show(`wows-omp-roadmap.${kind}`, prepared);
      return { summary: resultLine(prepared) };
    }
    if (!ui.interactive) {
      show(`wows-omp-roadmap.${kind}`, awaitConfirmation(ses, ctx, generation, kind, repo, prepared.prepared));
      return {};
    }
    const confirmed = await ui.previewConfirm({ title: prepared.summary, root: repo.repoRoot, files: prepared.files });
    if (confirmed !== true) {
      notice(confirmed === false ? "Roadmap preview declined." : "Roadmap preview: no answer available.", "info");
      return {};
    }
    const receipt = await applyPreview(ses, ctx, kind, repo, actor(ctx), generation, prepared.prepared);
    show(`wows-omp-roadmap.${kind}`, receipt);
    return { summary: resultLine(receipt) };
  }

  /** Runs one /roadmap action; typed words, the inline status menu and the console all resolve to these actions. */
  async function perform(
    ctx: ExtensionCommandContext,
    ui: RoadmapUi,
    repo: Repo,
    request: ActionRequest,
    notice: RoadmapUi["notify"],
  ): Promise<ActionResult> {
    const { action, words, reviewedRound } = request;
    const selectedStage = request.selected;
    let model = request.model;
    if (action === "close") {
      if (!selectedStage) return {};
      notice(
        `To close ${selectedStage}, call roadmap_stage with action: "close", id: "${selectedStage}", delivered, passing evidence for every done criterion, and TODO dispositions, after the main agent accepts or rejects the stage's proposed ADRs with adr_manage. This menu does not close the stage.`,
        "info",
      );
      return { handoff: true };
    }
    if (action === "round") {
      show("wows-omp-roadmap.status", await statusReceipt(repo, selectedStage));
      return {};
    }
    if (action === "upgrade") {
      if (words.length > 1) throw new Error("Usage: /roadmap upgrade");
      return await commandPreview(ctx, ui, repo, "upgrade", () => prepareUpgrade(repo, actor(ctx)), notice);
    } else if (action === "drop-round") {
      if (!words[1] || words.length < 3) throw new Error("Usage: /roadmap drop-round <id> <reason>");
      return await commandPreview(
        ctx,
        ui,
        repo,
        "drop-round",
        () => prepareRoundDrop(repo, actor(ctx), { id: words[1] as string, reason: words.slice(2).join(" ") }),
        notice,
      );
    } else if (action === "retarget") {
      if (!words[1] || !words[2] || words.length !== 3) throw new Error("Usage: /roadmap retarget <round-or-stage> <YYYY-MM-DD|none>");
      return await commandPreview(
        ctx,
        ui,
        repo,
        "retarget",
        () => prepareRetarget(repo, actor(ctx), { id: words[1] as string, target: words[2] as string }),
        notice,
      );
    } else if (action === "plan-round") {
      if (words.length > 2) throw new Error("Usage: /roadmap plan-round [<id>]");
      model = await loadAll(repo);
      if (selectedStage && !model.rounds.some((round) => round.id === selectedStage && round.status === "planned"))
        throw new Error(`Only a planned round's charter can be revised: ${selectedStage}.`);
      const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
      ses.arm(ctx, repo.repoRoot, "plan");
      pi.sendUserMessage(
        `Use the roadmap skill to interview me ${selectedStage ? `to revise planned round ${selectedStage}` : "for a future planned round"}: title, goal, constraints, non-goals, principles citing existing ADRs (adr_status lists them; record new decisions with adr_manage first) and an optional target date. Then call roadmap_round_plan with ${selectedStage ? `id=${selectedStage}, ` : ""}round and optional target; show the exact preview and wait for my confirmation. If this is the first format-2 feature, the same preview warns that roadmap plugin 0.2.3 and earlier cannot read the upgraded repository.`,
      );
      return { handoff: true };
    } else if (action === "stage") {
      if (!selectedStage || words.length > 2) throw new Error("Usage: /roadmap stage <id>");
      show("wows-omp-roadmap.status", await statusReceipt(repo, selectedStage, planLookup(pi.events, ctx, repo.repoRoot)));
    } else if (action === "check") {
      if (words.length > 2 || (words[1] && words[1] !== "--fix")) throw new Error("Usage: /roadmap check [--fix]");
      const receipt = await checkReceipt(repo, words[1] === "--fix");
      show("wows-omp-roadmap.check", receipt);
      const errors = receipt.diagnostics?.filter((diagnostic) => diagnostic.severity === "error").length ?? 0;
      const warnings = receipt.diagnostics?.filter((diagnostic) => diagnostic.severity === "warning").length ?? 0;
      return {
        summary: receipt.ok
          ? {
              text: `Check passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}; the report is in the conversation`,
              level: "info",
            }
          : { text: `Check found ${errors} error${errors === 1 ? "" : "s"}; the report is in the conversation`, level: "error" },
      };
    } else if (action === "overlap") {
      const [, stageId, answer, ...intent] = words;
      if (!stageId || (answer !== "roadmap" && answer !== "free" && answer !== "unrelated"))
        throw new Error("Usage: /roadmap overlap <stage> roadmap|free|unrelated [intent]");
      const receipt = await resolveOverlap({
        ses,
        ctx,
        repo,
        owner: actor(ctx),
        generation: ses.currentGeneration(ctx),
        stage: stageId,
        intent: intent.join(" "),
        plans: planLookup(pi.events, ctx, repo.repoRoot),
        ask: async () => answer,
      });
      show("wows-omp-roadmap.overlap", receipt);
    } else if (action === "new-round") {
      if (words.length > 1) throw new Error("Usage: /roadmap new-round");
      // Re-read after the status menu; its snapshot is only for presentation.
      model = await loadAll(repo);
      if (model.rounds.some((round) => round.status === "active")) throw new Error("Close the active round before opening another.");
      const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
      ses.arm(ctx, repo.repoRoot, "round");
      const first = model.rounds
        .filter((round) => round.status === "planned")
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
      pi.sendUserMessage(
        first
          ? `Use the roadmap skill to review the lowest-numbered planned round ${first.id} — ${first.title}. Only this planned round can be activated; revise its charter if agreed. Review trigger-based carried TODOs from frozen rounds and agree which to import as new IDs; same-ID auto-carried TODOs cannot be imported again. Call roadmap_round_open with activate=${first.id}, import_todos and optionally round to revise the charter. Show the preview and wait for my confirmation before writing.`
          : "Use the roadmap skill to interview me for the next round's charter: title, goal, constraints, non-goals and principles citing existing ADRs (adr_status lists them; record new decisions with adr_manage first). Review carried TODOs in frozen rounds and agree which to import as new TODO ids. Then call roadmap_round_open with round and import_todos; show the preview and wait for my confirmation before writing.",
      );
      return { handoff: true };
    } else if (action === "close-round") {
      const generation = ses.currentGeneration(ctx);
      // Typed arguments answer the dialogs; the status menu never supplies arguments.
      const typed = !reviewedRound && words.length > 1 ? parseRoundCloseArguments(words.slice(1)) : undefined;
      if (!reviewedRound) model = await loadAll(repo);
      const round = model.rounds.find((candidate) => candidate.status === "active");
      if (!round) throw new Error("There is no active round to close.");
      if (model.stages.some((stage) => stage.round === round.id && stage.status !== "closed" && stage.status !== "dropped")) {
        throw new Error("Every stage must be closed or dropped before the round can close.");
      }
      const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
      const expected = reviewedRound ?? { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
      const automatic = autoCarryTodos(model, round);
      const todos = model.todos
        .filter((doc) => doc.round === round.id)
        .flatMap((doc) => doc.items.filter((item) => item.status === "open" && !automatic.includes(item)));
      let outcome = typed?.outcome;
      let upgradeFirst = false;
      if (!outcome && ui.interactive) {
        // A format-1 round records its outcome only after the one-step upgrade; skipping closes without one.
        if (model.index.format === 1) {
          const answer = await ui.upgradePrompt("round-outcome");
          if (answer === undefined) {
            notice("Round close: no answer available.", "info");
            return {};
          }
          upgradeFirst = answer;
        }
        if (model.index.format === 2 || upgradeFirst) {
          outcome = await ui.roundOutcome(round);
          if (!outcome) {
            notice("Round close: no answer available.", "info");
            return {};
          }
        }
      }
      let dispositions = typed?.dispositions.length ? typed.dispositions : undefined;
      if (!dispositions) {
        if (ui.interactive) dispositions = await ui.closeRoundDispositions(todos);
        else if (todos.length) {
          throw new Error(
            `Round close needs a disposition for every open TODO: ${todos.map((item) => `${item.id} ${item.title}`).join("; ")}. ${CLOSE_ROUND_USAGE}`,
          );
        } else dispositions = [];
      }
      if (!dispositions) {
        notice("Round close: no answer available.", "info");
        return {};
      }
      if (!outcome && model.index.format === 2) throw new Error(`Closing ${round.id} records its goal outcome. ${CLOSE_ROUND_USAGE}`);
      // The README is outside the reviewed round directory, so upgrading in the same write leaves `expected` valid.
      const receipt = await closeRound(
        repo,
        actor(ctx),
        { expected, dispositions, ...(outcome ? { outcome } : {}), ...(upgradeFirst ? { upgrade: true } : {}) },
        upgradeFirst ? { guard: dialogGuard(ses, ctx, generation) } : {},
      );
      if (receipt.ok) {
        for (const stage of model.stages.filter((stage) => stage.round === round.id)) ses.clearStage(ctx, repo.repoRoot, stage.id);
        ses.disarm(ctx, repo.repoRoot);
      }
      show("wows-omp-roadmap.round-close", receipt);
      return { summary: resultLine(receipt) };
    } else throw new Error(USAGE);
    return {};
  }

  /** The typed words a console action stands for; drop and retarget ask their text in small dialogs. Undefined when dismissed. */
  async function consoleWords(ui: RoadmapUi, model: Model, choice: ConsoleChoice): Promise<string[] | undefined> {
    const id = choice.round ?? choice.stage;
    if ((choice.action !== "drop-round" && choice.action !== "retarget") || !id) return [];
    const current = [...model.rounds, ...model.stages].find((item) => item.id === id);
    const answer =
      choice.action === "drop-round"
        ? await ui.input(`Drop planned round ${id}: reason`, "Why this round is no longer needed")
        : await ui.input(`Target date for ${id} (now ${current?.target ?? "none"})`, "YYYY-MM-DD, or none to clear the target");
    return answer?.trim() ? [choice.action, id, answer.trim()] : undefined;
  }

  /**
   * Atlas Dispatch style: an action that completes here, previews included, reopens the console on the same item with a
   * one-line result; an action that hands the next step to the model closes it and returns to the conversation. Esc closes it.
   */
  async function statusConsole(ctx: ExtensionCommandContext, ui: RoadmapUi, repo: Repo): Promise<void> {
    let state: ConsoleState = {};
    for (;;) {
      // Every showing reads the files again, and the round it shows is the one a close from it may close.
      const model = await loadAll(repo);
      rememberStages(model);
      const reviewed = reviewedRound(model);
      const choice = await ui.statusConsole(model, state, planLookup(pi.events, ctx, repo.repoRoot));
      if (!choice) return;
      const notices: ConsoleMessage[] = [];
      let result: ActionResult;
      try {
        if (choice.action === "close-round" && !reviewed) throw new Error("There is no reviewed active round to close.");
        const words = await consoleWords(ui, model, choice);
        result = words
          ? await perform(
              ctx,
              ui,
              repo,
              {
                action: choice.action,
                words,
                selected: choice.stage ?? choice.round,
                ...(reviewed ? { reviewedRound: reviewed } : {}),
                model,
              },
              (text, level) => notices.push({ text, level: level === "error" ? "error" : "info" }),
            )
          : { summary: { text: "Nothing entered; nothing was written.", level: "info" } };
      } catch (error) {
        result = { summary: { text: error instanceof Error ? error.message : String(error), level: "error" } };
      }
      await refresh(ctx);
      changed(ctx);
      if (result.handoff) {
        for (const notice of notices) ui.notify(notice.text, notice.level);
        return;
      }
      const message = notices.at(-1) ?? result.summary;
      state = { view: choice.view, ...(message ? { message } : {}) };
    }
  }

  async function roadmapCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ui = uiFor(ctx);
    const notify: RoadmapUi["notify"] = (message, level) => ui.notify(message, level);
    try {
      if (ctx.agent.kind !== "main") throw new Error("/roadmap commands require the main session.");
      const api = adr.require(ctx.sessionManager.getSessionId());
      const words = splitArgs(args);
      const action = words[0];
      if (action === "confirm") {
        const token = words[1];
        if (!token || words.length > 2) throw new Error("Usage: /roadmap confirm <token>");
        const preview = ses.takePreview(ctx, token);
        if (!preview) {
          throw new Error(`No pending Roadmap preview ${token} in this session. Run its Roadmap command again for a fresh preview.`);
        }
        show(
          "wows-omp-roadmap.confirm",
          await applyPreview(ses, ctx, preview.kind, { ...preview.repo, adr: api }, actor(ctx), preview.generation, preview.prepared),
        );
        await refresh(ctx);
        return;
      }
      const repo = await requireRepo(ctx, api);
      const model = await loadAll(repo);
      rememberStages(model);
      if (action) await perform(ctx, ui, repo, { action, words, selected: words[1], model }, notify);
      else {
        if (!ui.interactive) {
          show("wows-omp-roadmap.status", await statusReceipt(repo), USAGE);
          return;
        }
        if (await ui.fullscreenMenu()) {
          await statusConsole(ctx, ui, repo);
          return;
        }
        const reviewed = reviewedRound(model);
        const choice = await ui.statusMenu(model);
        if (!choice) {
          ui.notify("Roadmap status menu: no answer available.", "info");
          return;
        }
        if (choice.action === "close-round" && !reviewed) throw new Error("There is no reviewed active round to close.");
        await perform(
          ctx,
          ui,
          repo,
          { action: choice.action, words, selected: choice.stage ?? choice.round, ...(reviewed ? { reviewedRound: reviewed } : {}), model },
          notify,
        );
      }
      await refresh(ctx);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      changed(ctx);
    }
  }

  pi.registerCommand("roadmap", {
    description: "View Roadmap status, plan/activate/drop rounds, retarget dates, upgrade formats, check documents or confirm a preview",
    getArgumentCompletions(prefix) {
      const prefixed = (head: string, options: readonly Completion[], tail = "") =>
        options.map(({ value, description }) => ({ value: `${head}${value}${tail}`, description }));
      const overlap = /^overlap (\S+) /.exec(prefix);
      const retarget = /^retarget (\S+) /.exec(prefix);
      let options: Completion[];
      if (overlap) options = prefixed(`overlap ${overlap[1]} `, OVERLAP_ANSWERS);
      else if (prefix.startsWith("overlap ")) options = prefixed("overlap ", stages, " ");
      else if (prefix.startsWith("stage ")) options = prefixed("stage ", stages);
      else if (prefix.startsWith("plan-round ")) options = prefixed("plan-round ", plannedRounds);
      else if (prefix.startsWith("drop-round ")) options = prefixed("drop-round ", plannedRounds, " ");
      else if (retarget) options = [{ value: `retarget ${retarget[1]} none`, description: "Clear the target date" }];
      else if (prefix.startsWith("retarget ")) options = prefixed("retarget ", [...rounds, ...stages], " ");
      else options = [...ACTIONS];
      const matches = options
        .filter(({ value }) => value.startsWith(prefix))
        .map(({ value, label, description }) => ({ value, label: label ?? value, description }));
      return matches.length ? matches : null;
    },
    handler: roadmapCommand,
  });
  return { refresh };
}
