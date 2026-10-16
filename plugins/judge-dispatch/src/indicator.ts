import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

import { ESCALATE_LINE } from "#src/escalation.ts";
import type { ParsedTaskRoute, RouteChoice, RouteOutcome } from "#src/routing.ts";

/** Transcript records written by 0.4.0 and earlier; sessions that hold them must still render them and keep them from the model. */
const LEGACY_ROUTE_MESSAGE = "wows-omp-judge-dispatch.route";

/** Presentation failures must never affect the task rewrite. */
export function setRoutingWorkingMessage(pi: ExtensionAPI, ctx: ExtensionContext, message?: string): void {
  try {
    if (ctx.hasUI === false || typeof ctx.ui?.setWorkingMessage !== "function") return;
    ctx.ui.setWorkingMessage(message);
  } catch (error) {
    pi.logger.warn("judge-dispatch working message failed", { error: String(error) });
  }
}

/** An `info` notice is the host's dim status line (the one Ctrl+O prints): shown at once, never persisted or sent to the model. */
export function showRoutingStatus(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI === false || typeof ctx.ui?.notify !== "function") return;
    ctx.ui.notify(`judge-dispatch  ${message}`, "info");
  } catch (error) {
    pi.logger.warn("judge-dispatch routing status failed", { error: String(error) });
  }
}

function singleLine(value: unknown): string {
  return String(value)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function confidence(value: number | undefined): string {
  return value === undefined ? "" : ` (${value.toFixed(2)})`;
}

function routeLine(route: ParsedTaskRoute, outcome: RouteOutcome, choice: RouteChoice | undefined): string {
  const requested = singleLine(route.requestedAgent ?? "default");
  const parts: string[] = [];
  if (typeof outcome === "string") parts.push(`${requested} kept (${outcome})`);
  else if (choice?.agent !== undefined && choice.agent !== route.requestedAgent) {
    parts.push(`${requested} → ${singleLine(choice.agent)}${confidence(choice.agentConfidence)}`);
  } else if (choice?.agent !== undefined) parts.push(`${requested} kept${confidence(choice.agentConfidence)}`);
  else parts.push(outcome.agentUndecided ? `${requested} kept (no confident choice)` : requested);

  // A forced difficulty has no confidence; the escalation note names its cause instead.
  const basis = choice?.escalation ? "" : confidence(choice?.difficultyConfidence);
  if (choice?.escalation === "escalate") parts.push(`escalated to ${choice.difficulty} after ${ESCALATE_LINE}`);
  else if (choice?.escalation === "failure") parts.push(`raised to ${choice.difficulty} after a failed lowered run`);

  const model = choice?.model;
  const primary = singleLine(model?.primary ?? "default");
  if (route.explicitModel) parts.push(`model pinned to ${singleLine(route.explicitModel)}`);
  else if (model?.keptReason !== undefined)
    parts.push(`model ${primary} kept (tier ${singleLine(model.tier)}: ${singleLine(model.keptReason)})`);
  else if (model) parts.push(`model ${primary} → ${singleLine(model.tier)}${basis}`);
  if (choice?.thinking) parts.push(`thinking ${choice.thinking.from} → ${choice.thinking.to}${basis}`);
  const applied = choice?.thinking !== undefined || (model !== undefined && model.keptReason === undefined);
  if (choice?.difficulty && !choice.escalation && !applied) parts.push(`difficulty ${choice.difficulty}${basis}`);
  return `${route.index === null ? "" : `#${route.index + 1} `}${parts.join(" · ")}`;
}

/** One status line per `task` call covering every routed item, changed or kept. */
export function showRouteOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  routes: readonly ParsedTaskRoute[],
  outcomes: readonly RouteOutcome[],
  choices: readonly (RouteChoice | undefined)[],
): void {
  const lines = routes.flatMap((route, index) => {
    const outcome = outcomes[index];
    return outcome === undefined ? [] : [routeLine(route, outcome, choices[index])];
  });
  if (lines.length > 0) showRoutingStatus(pi, ctx, lines.join(" ; "));
}

export function registerLegacyRouteRecords(pi: ExtensionAPI): void {
  try {
    pi.on("context", (event) => ({
      messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== LEGACY_ROUTE_MESSAGE),
    }));
    pi.registerMessageRenderer(LEGACY_ROUTE_MESSAGE, (message, _options, theme) => ({
      render: (width) => [theme.fg("dim", truncateToWidth(singleLine(message.content), Math.max(0, width)))],
      invalidate() {},
    }));
  } catch (error) {
    pi.logger.warn("judge-dispatch legacy route records unavailable", { error: String(error) });
  }
}
