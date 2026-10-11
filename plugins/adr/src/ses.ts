import { createHash } from "node:crypto";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { AdrUi } from "#src/ui.ts";

/** Async because the terminal UI reads the `uiMenu` setting from `ctx.cwd` each time a UI is built. */
export type UiFactory = (ctx: ExtensionContext) => Promise<AdrUi>;

/** An `/adr init` preview no dialog could confirm, held until `/adr confirm <token>`. */
export interface HeldPreview {
  token: string;
  repoRoot: string;
  files: Array<{ path: string; content: string }>;
}

/** In-memory per-session state; a restart, switch, branch or tree change needs a fresh preview. */
export class AdrSession {
  #sessionId?: string;
  readonly #previews = new Map<string, HeldPreview>();

  ensure(ctx: ExtensionContext): void {
    if (this.#sessionId !== ctx.sessionManager.getSessionId()) this.rebuild(ctx);
  }

  rebuild(ctx: ExtensionContext): void {
    this.#sessionId = ctx.sessionManager.getSessionId();
    this.#previews.clear();
  }

  /** The latest preview per repository replaces older ones; the token names its exact files. */
  holdPreview(ctx: ExtensionContext, repoRoot: string, files: HeldPreview["files"]): string {
    this.ensure(ctx);
    const token = createHash("sha256")
      .update(JSON.stringify(["init", repoRoot, files]))
      .digest("hex")
      .slice(0, 12);
    for (const [held, preview] of this.#previews) if (preview.repoRoot === repoRoot) this.#previews.delete(held);
    this.#previews.set(token, { token, repoRoot, files });
    return token;
  }

  takePreview(ctx: ExtensionContext, token: string): HeldPreview | undefined {
    this.ensure(ctx);
    const preview = this.#previews.get(token);
    this.#previews.delete(token);
    return preview;
  }
}
