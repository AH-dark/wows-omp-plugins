import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const PACKAGE_NAME = "wows-omp-plugin-roadmap";

/** `inline` keeps the select/editor dialogs; `fullscreen` opens the console and the fullscreen preview. */
export type UiMenu = "inline" | "fullscreen";
export type UiMenuReader = (cwd: string) => Promise<UiMenu>;

const DEFAULT_UI_MENU: UiMenu = "fullscreen";

export function parseUiMenu(value: unknown): UiMenu {
  if (value === undefined) return DEFAULT_UI_MENU;
  if (value === "inline" || value === "fullscreen") return value;
  throw new Error(`invalid uiMenu ${JSON.stringify(value)}`);
}

/** Reads `uiMenu` from the project-scoped plugin settings on every call; unreadable or invalid values fall back to fullscreen. */
export function uiMenuReader(logger: Pick<ExtensionAPI["logger"], "warn">): UiMenuReader {
  return async (cwd) => {
    try {
      return parseUiMenu((await getPluginSettings(PACKAGE_NAME, cwd)).uiMenu);
    } catch (error) {
      logger.warn("roadmap uiMenu setting is invalid or unreadable; using fullscreen", {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_UI_MENU;
    }
  };
}
