import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

const PACKAGE_NAME = "wows-omp-plugin-adr";

/** `inline` keeps the select/editor dialogs; `fullscreen` opens the /adr console and the fullscreen write preview. */
export type UiMenu = "inline" | "fullscreen";

/**
 * Reads `uiMenu` from the plugin settings for `cwd` on every call, because settings are project-scoped and several
 * sessions can share one process. A missing value means the default; an invalid or unreadable one warns and falls back.
 */
export async function readUiMenu(cwd: string, warn: (message: string, data: Record<string, unknown>) => void): Promise<UiMenu> {
  let value: unknown;
  try {
    value = (await getPluginSettings(PACKAGE_NAME, cwd)).uiMenu;
  } catch (error) {
    warn("ADR settings could not be read; using uiMenu fullscreen", { error: error instanceof Error ? error.message : String(error) });
    return "fullscreen";
  }
  if (value === undefined || value === "fullscreen") return "fullscreen";
  if (value === "inline") return "inline";
  warn("ADR uiMenu setting is invalid; using fullscreen", { value });
  return "fullscreen";
}
