import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

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

function routeLine(route: ParsedTaskRoute, item: Record<string, unknown>, outcome: RouteOutcome, choice: RouteChoice | undefined): string {
  const requested = singleLine(route.requestedAgent ?? "default");
  const parts: string[] = [];
  if (typeof outcome === "string") parts.push(`${requested} kept (${outcome})`);
  else if (choice?.agent !== undefined && choice.agent !== route.requestedAgent) {
    parts.push(`${requested} → ${singleLine(choice.agent)}${confidence(choice.agentConfidence)}`);
  } else if (choice?.agent !== undefined) parts.push(`${requested} kept${confidence(choice.agentConfidence)}`);
  else parts.push(outcome.agentUndecided ? `${requested} kept (no confident choice)` : requested);

  if (choice?.effort !== undefined) {
    const current = item.effort;
    const change = choice.effort === current ? choice.effort : `${singleLine(current ?? "default")} → ${choice.effort}`;
    parts.push(`effort ${change}${confidence(choice.effortConfidence)}`);
  } else if (typeof outcome !== "string" && outcome.difficulty) {
    parts.push(`difficulty ${outcome.difficulty}${confidence(outcome.difficultyConfidence)}`);
  }

  const model = choice?.model;
  const fit = model?.fit === undefined ? "" : ` (fit ${model.fit.toFixed(2)})`;
  if (route.explicitModel) parts.push(`model pinned to ${singleLine(route.explicitModel)}`);
  else if (route.modelPinned) parts.push("model pinned by call");
  else if (model?.chosen && model.chosen.key !== model.primary)
    parts.push(`model ${singleLine(model.primary)} → ${singleLine(model.chosen.key)}${fit}`);
  else if (model?.chosen) parts.push(`model ${singleLine(model.primary)} kept${fit}`);
  else if (model) parts.push(`model ${singleLine(model.primary)} kept (${model.keptReason ?? "no choice"})`);
  return `${route.index === null ? "" : `#${route.index + 1} `}${parts.join(" · ")}`;
}

/** One status line per `task` call covering every routed item, changed or kept. */
export function showRouteOutcomes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: Record<string, unknown>,
  routes: readonly ParsedTaskRoute[],
  outcomes: readonly RouteOutcome[],
  choices: readonly (RouteChoice | undefined)[],
): void {
  const lines: string[] = [];
  for (const [index, route] of routes.entries()) {
    const item = route.index === null ? input : (input.tasks as Record<string, unknown>[] | undefined)?.[route.index];
    const outcome = outcomes[index];
    if (!item || outcome === undefined) continue;
    lines.push(routeLine(route, item, outcome, choices[index]));
  }
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
