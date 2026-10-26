import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AftProjection } from "#src/aft-contract.ts";
import { loadRepo } from "#src/documents.ts";
import { discoverRepo, type GitRepo } from "#src/git.ts";
import {
  editInspect,
  expandDelimitedPathEntries,
  normalizePathLikeInput,
  parseSearchPath,
  resolveToCwd,
  unwrapHashlineHeaderPath,
} from "#src/host.ts";

/** Resolves a bound AFT tool's projection for one call; undefined when toolName is not AFT-bound this session. */
export type AftProjector = (toolName: string, input: Record<string, unknown>, cwd: string) => Promise<AftProjection | undefined>;

export interface AftIntegration {
  /** Exact-source-bound AFT projection for this call; undefined when toolName is not AFT-bound this session. */
  project: AftProjector;
  /** Whether toolName's live host sourceInfo is `extension`, independent of AFT binding verification. */
  isExtensionSourced(toolName: string): boolean;
}

const NATIVE_MUTATING_TOOLS = ["write", "edit", "apply_patch", "ast_edit", "lsp", "bash"];

/** AFT tool names with no native OMP equivalent; a managed repo cannot trust these unverified, even unbound. */
const AFT_ONLY_MUTATION_TOOLS = ["aft_move", "aft_delete", "aft_import", "aft_safety", "ast_grep_replace"];

/** AFT-projected mutation/execution targets, filtered and cwd-resolved the same way native candidates are. */
function projectedCandidates(projection: AftProjection, cwd: string): string[] {
  return [
    ...new Set(
      projection.paths
        .filter((path) => path && (!/^@?[a-z][a-z\d+.-]*:\/\//i.test(path) || /^@?file:\/\//i.test(path)))
        .map((path) => resolveToCwd(path, cwd)),
    ),
  ];
}

const EDIT_MODES = ["hashline", "replace", "patch", "apply_patch", "sloppy"] as const;

/** Includes the managed directory itself, since removing it also mutates its files. docs/adr belongs to the adr plugin. */
export function isManaged(path: string, repoRoot: string): boolean {
  const name = relative(join(repoRoot, "docs/roadmap"), path);
  return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
}

function bashTargets(command: string): string[] {
  // Deliberately a static shell projection, not a shell evaluator or sandbox.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[12]?>>?|[|;&]|[^\s|;&<>]+/g) ?? [];
  const paths: string[] = [];
  let collecting = false;
  let sed = false;
  for (let index = 0; index < tokens.length; index++) {
    const raw = tokens[index] as string;
    const token = raw.replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (/^[|;&]$/.test(token)) {
      collecting = false;
      sed = false;
      continue;
    }
    if (/^[12]?>>?$/.test(token)) {
      const next = tokens[++index];
      if (next) paths.push(next.replace(/^(["'])([\s\S]*)\1$/, "$2"));
      continue;
    }
    if (["tee", "mv", "cp", "rm", "truncate"].includes(token)) {
      collecting = true;
      continue;
    }
    if (token === "sed") {
      sed = true;
      continue;
    }
    if (sed && /^-(?:[A-Za-z]*i|-[A-Za-z]*in-place)/.test(token)) collecting = true;
    if (collecting && !token.startsWith("-")) paths.push(token);
  }
  return paths;
}

/** Native editInspect projects every supported edit grammar, including move/delete intents. */
export async function managedTargets(
  toolName: string,
  input: Record<string, unknown>,
  editMode: string | undefined,
  cwd: string,
): Promise<string[]> {
  const paths: string[] = [];
  if (toolName === "write" && typeof input.path === "string") paths.push(input.path);
  if (toolName === "edit" || toolName === "apply_patch") {
    // The active host mode can depend on the model; inspect every grammar rather than guessing from wire fields.
    const modes = toolName === "apply_patch" ? ["apply_patch"] : editMode === undefined ? EDIT_MODES : [editMode];
    const payload = JSON.stringify(input);
    for (const mode of modes) {
      if (!EDIT_MODES.some((supported) => supported === mode)) throw new Error(`Unknown native edit mode: ${mode}`);
      const projection = editInspect(mode, payload);
      paths.push(...projection.paths, ...projection.entries.map((entry) => entry.path));
      for (const op of projection.fileOps) {
        paths.push(op.path);
        if (op.to) paths.push(op.to);
      }
    }
    if (!paths.length) throw new Error("Unrecognized native edit grammar; its mutation targets cannot be validated");
  }
  if (toolName === "ast_edit") {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some((path) => typeof path !== "string")) {
      throw new Error("AST edit scopes must be non-empty paths or globs");
    }
    const entries = input.paths.map(normalizePathLikeInput);
    if (entries.some((path) => !path)) throw new Error("AST edit scopes must be non-empty paths or globs");
    const scopes = await expandDelimitedPathEntries(entries, cwd);
    if (scopes.some((path) => !path)) throw new Error("AST edit scopes must be non-empty paths or globs");
    paths.push(...scopes.map((path) => parseSearchPath(path).basePath));
  }
  if (
    toolName === "lsp" &&
    (input.action === "rename" || input.action === "rename_file" || (input.action === "code_actions" && input.apply))
  ) {
    if (typeof input.file === "string") paths.push(input.file);
    if (input.action === "rename_file" && typeof input.new_name === "string") paths.push(input.new_name);
  }
  if (toolName === "bash" && typeof input.command === "string") {
    paths.push(...bashTargets(input.command));
    if (typeof input.cwd === "string") cwd = resolveToCwd(input.cwd, cwd);
  }
  return [
    ...new Set(
      paths
        .map((path) => (toolName === "write" ? unwrapHashlineHeaderPath(path) : path))
        .filter((path) => path && (!/^@?[a-z][a-z\d+.-]*:\/\//i.test(path) || /^@?file:\/\//i.test(path)))
        .map((path) => {
          const absolute = resolveToCwd(path, cwd);
          if (toolName !== "ast_edit" && toolName !== "bash") return absolute;
          const pattern = absolute.search(/[*?[\]{}]/);
          return pattern < 0 ? absolute : absolute.slice(0, absolute.lastIndexOf(sep, pattern) + 1);
        }),
    ),
  ];
}

function resolvedPath(path: string, links?: Set<string>): string {
  let ancestor = path;
  for (;;) {
    let isLink: boolean;
    try {
      isLink = lstatSync(ancestor).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    if (isLink) {
      links ??= new Set<string>();
      if (links.has(ancestor)) throw new Error(`Symlink cycle while resolving ${path}`);
      links.add(ancestor);
      const target = resolve(dirname(ancestor), readlinkSync(ancestor));
      return resolve(resolvedPath(target, links), relative(ancestor, path));
    }
    return resolve(realpathSync(ancestor), relative(ancestor, path));
  }
}

function targetRepo(path: string): GitRepo | null {
  let location = path;
  for (;;) {
    try {
      const info = statSync(location);
      return discoverRepo(info.isDirectory() ? location : dirname(location));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(location);
      if (parent === location) return null;
      location = parent;
    }
  }
}

function hardlinkIdentity(path: string): string | undefined {
  try {
    const info = statSync(path, { bigint: true });
    return info.isFile() && info.nlink > 1n ? `${info.dev}:${info.ino}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function managedFileIdentities(repoRoot: string): Set<string> {
  const files = new Set<string>();
  const directories = new Set<string>();
  function visit(path: string): void {
    const info = statSync(path, { bigint: true });
    const identity = `${info.dev}:${info.ino}`;
    if (info.isDirectory()) {
      if (directories.has(identity)) return;
      directories.add(identity);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (info.isFile() && info.nlink > 1n) files.add(identity);
  }
  visit(join(repoRoot, "docs/roadmap"));
  return files;
}

/**
 * Blocks native mutations of docs/roadmap/** once a roadmap is initialized there.
 * `aft`, when given, lets an exact-source-bound AFT tool report its own projected mutation scope instead of
 * native parsing; native/no-AFT tool calls keep exactly their prior behavior.
 */
export async function interceptionReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  aft?: AftIntegration,
): Promise<string | undefined> {
  const reason = "Managed Roadmap files must change through roadmap_stage or roadmap_todo (roadmap_check with fix for generated indexes).";
  async function managedHere(): Promise<GitRepo | undefined> {
    const currentRepo = targetRepo(cwd);
    if (currentRepo && (await loadRepo(currentRepo.repoRoot))) return currentRepo;
  }
  const projection = aft ? await aft.project(toolName, input, cwd) : undefined;
  if (projection?.kind === "observation") return;
  if (projection?.kind === "unknown") {
    if (!(await managedHere())) return;
    return `This AFT tool's mutation scope could not be determined while a roadmap is initialized, so it is refused. ${reason}`;
  }
  let candidates: string[];
  let broad: boolean;
  if (projection && projection.kind === "execution") {
    // Execution never trusts empty/absent paths as safe: AFT's own `bash`/`powershell` projections carry no paths
    // at all (no static command-text parsing on AFT's side), so the native shell projection still runs for `bash`,
    // the only execution tool this plugin can statically inspect; its own backup/undo capability is not a safety
    // substitute. A tool this plugin cannot inspect at all fails closed while a roadmap is initialized, like `unknown`.
    const inspectable = toolName === "bash";
    const commandInput = typeof input.workdir === "string" ? { ...input, cwd: input.workdir } : input;
    const native = inspectable ? await managedTargets("bash", commandInput, undefined, cwd) : [];
    candidates = [...new Set([...projectedCandidates(projection, cwd), ...native])];
    broad = inspectable || projection.broad;
    if (!candidates.length) {
      if (!inspectable && (await managedHere())) {
        return `This AFT tool's execution scope could not be determined while a roadmap is initialized, so it is refused. ${reason}`;
      }
      return;
    }
  } else if (projection && projection.kind !== "native") {
    candidates = projectedCandidates(projection, cwd);
    broad = projection.broad;
  } else {
    if (!projection && AFT_ONLY_MUTATION_TOOLS.includes(toolName) && aft?.isExtensionSourced(toolName) && (await managedHere())) {
      return `${toolName} looks like an AFT tool, but its v1 binding to this session is missing or does not match this call's extension source, so its mutation scope cannot be verified while a roadmap is initialized. Update or reinstall the AFT extension, or use roadmap_stage/roadmap_todo instead.`;
    }
    if (!NATIVE_MUTATING_TOOLS.includes(toolName)) return;
    candidates = await managedTargets(toolName, input, undefined, cwd);
    broad = toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch";
  }
  if (!candidates.length) return;
  const currentRepo = targetRepo(cwd);
  const marked = new Map<string, boolean>();
  const identities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    // Check both spellings: a symlink inside a managed directory must not grant an escape.
    for (const path of new Set([candidate, resolvedPath(candidate)])) {
      const git = targetRepo(path);
      const roots = new Set<string>();
      if (git) roots.add(git.repoRoot);
      if (currentRepo) roots.add(currentRepo.repoRoot);
      const identity = hardlinkIdentity(path);
      for (const repoRoot of roots) {
        const managed = isManaged(path, repoRoot);
        const below = relative(path, join(repoRoot, "docs/roadmap"));
        const ancestor = broad && (below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below)));
        if (!managed && !ancestor && !identity) continue;
        if (!marked.has(repoRoot)) marked.set(repoRoot, Boolean(await loadRepo(repoRoot)));
        if (!marked.get(repoRoot)) continue;
        if (managed || ancestor) return reason;
        if (identity) {
          let files = identities.get(repoRoot);
          if (!files) {
            files = managedFileIdentities(repoRoot);
            identities.set(repoRoot, files);
          }
          if (files.has(identity)) return reason;
        }
      }
    }
  }
}
