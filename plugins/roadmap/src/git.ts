import { vcsGitRepoInfo } from "#src/host.ts";

export interface GitRepo {
  repoRoot: string;
  commonDir: string;
}

export function discoverRepo(path: string): GitRepo | null {
  const info = vcsGitRepoInfo(path);
  return info ? { repoRoot: info.repoRoot, commonDir: info.commonDir } : null;
}

/** No pager, fsmonitor hook or pathspec magic, and no index refresh that would take the repository lock. */
const GIT = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false"];

/** Synchronous because pi.events answers must be emitted inside the request's emit. */
function gitSync(repoRoot: string, args: string[]): { code: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...GIT, ...args], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

/** A repository-relative file as committed at HEAD; undefined when HEAD or the file does not exist there. */
export function committedFile(repoRoot: string, path: string): string | undefined {
  const { code, stdout } = gitSync(repoRoot, ["cat-file", "blob", `HEAD:${path}`]);
  return code === 0 ? stdout : undefined;
}

/** The given repository-relative files that differ from HEAD in the index or work tree, untracked ones included; [] when git fails. */
export function uncommittedFiles(repoRoot: string, paths: readonly string[]): string[] {
  const { code, stdout } = gitSync(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  if (code !== 0) return [];
  const dirty: string[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    dirty.push(record.slice(3));
    // A rename or copy is followed by its source path.
    if (/[RC]/.test(record.slice(0, 2))) index++;
  }
  return paths.filter((path) => dirty.includes(path));
}
