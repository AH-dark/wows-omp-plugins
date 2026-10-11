import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { registerCommands } from "#src/commands.ts";
import { loadInitialized } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { interceptionReason } from "#src/interception.ts";
import { PluginStatePublisher } from "#src/plugin-state.ts";
import { registerService } from "#src/service.ts";
import { AdrSession, type UiFactory } from "#src/ses.ts";
import { readUiMenu } from "#src/settings.ts";
import { adrStatus, renderInjection } from "#src/state.ts";
import { registerTools } from "#src/tools.ts";
import { createTuiUi } from "#src/ui.ts";

let testUiFactory: UiFactory | undefined;

/** Test-only injection; reset to undefined to restore the host UI. */
export function __setUiFactory(factory?: UiFactory): void {
  testUiFactory = factory;
}

export default function adr(pi: ExtensionAPI): void {
  const ses = new AdrSession();
  const uiFor: UiFactory = async (ctx) => {
    if (testUiFactory) return testUiFactory(ctx);
    // Only the terminal UI can show the fullscreen console, so other clients never read the setting.
    const uiMenu = ctx.hasUI && ctx.mode === "tui" ? await readUiMenu(ctx.cwd, (message, data) => pi.logger.warn(message, data)) : "inline";
    return createTuiUi(ctx, pi, uiMenu);
  };
  let warned = false;
  const warn = (error: unknown): void => {
    if (warned) return;
    warned = true;
    pi.logger.warn("ADR state sidecar could not be published", { error: error instanceof Error ? error.message : String(error) });
  };
  const publisher = new PluginStatePublisher("adr", warn);
  let publishing = Promise.resolve();
  /** Re-derives the sidecar from the files on disk; serialized so a slower read never overwrites a newer state. */
  const changed = (ctx: ExtensionContext): void => {
    if (ctx.agent.kind !== "main") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    publishing = publishing.then(async () => {
      try {
        const model = discoverRepo(cwd) ? await loadInitialized(cwd) : null;
        publisher.publish(sessionId, model ? adrStatus(model) : null);
      } catch (error) {
        warn(error);
      }
    });
  };
  const service = registerService(pi, changed);
  registerTools(pi, changed, service.resolver);
  const commands = registerCommands(pi, ses, uiFor, changed);

  async function rebuild(_event: unknown, ctx: ExtensionContext): Promise<void> {
    ses.rebuild(ctx);
    changed(ctx);
    try {
      await commands.refresh(ctx);
    } catch (error) {
      (await uiFor(ctx)).notify(`ADR state could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  pi.on("session_start", rebuild);
  pi.on("session_switch", rebuild);
  pi.on("session_branch", rebuild);
  pi.on("session_tree", rebuild);
  pi.on("session_shutdown", async () => {
    await publishing;
    await publisher.flush();
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const reason = await interceptionReason(event.toolName, { ...event.input }, ctx.cwd);
      if (reason) return { block: true, reason };
    } catch (error) {
      return {
        block: true,
        reason: `The adr plugin could not validate this mutation and refused it: ${error instanceof Error ? error.message : String(error)}. Run adr_check.`,
      };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Subagents and external edits change files without this session's tools; resync once per turn.
    changed(ctx);
    try {
      if (!discoverRepo(ctx.cwd)) return;
      const model = await loadInitialized(ctx.cwd);
      await commands.refresh(ctx);
      if (!model) return;
      return { systemPrompt: [...event.systemPrompt, renderInjection(model)] };
    } catch (error) {
      (await uiFor(ctx)).notify(`ADR context could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
}

// The host cache-busts the entry and its graph; tests use the actual prepared factory.
adr.__setUiFactory = __setUiFactory;
