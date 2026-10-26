import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

/** The AFT interoperability contract v1's `tools[].capabilities` values. */
export type AftCapability = "observation" | "mutation" | "execution" | "native-url";

/** The AFT interoperability contract v1's `AftProjection.kind` values. */
export type AftProjectionKind = "observation" | "mutation" | "execution" | "native" | "unknown";

/** A single bound tool call's projected mutation scope, as the AFT interoperability contract v1 defines it. */
export interface AftProjection {
  kind: AftProjectionKind;
  /** Exact mutation targets or scopes, already resolved against the cwd passed to `project`. */
  paths: string[];
  /** True for a recursive/glob/ancestor scope; managed descendants must be protected too. */
  broad: boolean;
}

/** One tool AFT advertises in its `aft:binding` reply. */
export interface AftBoundTool {
  name: string;
  sourcePath: string;
  capabilities: AftCapability[];
}

export type AftProject = (toolName: string, input: Record<string, unknown>, cwd: string) => Promise<AftProjection>;

interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

/** The slice of `ExtensionAPI.getAllTools()` needed to verify a bound tool's provenance. */
export interface ToolProvenance {
  name: string;
  sourceInfo?: { source: string; path: string };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CAPABILITIES: ReadonlySet<string> = new Set<AftCapability>(["observation", "mutation", "execution", "native-url"]);
const PROJECTION_KINDS: ReadonlySet<string> = new Set<AftProjectionKind>(["observation", "mutation", "execution", "native", "unknown"]);

function validTool(value: unknown): value is AftBoundTool {
  return (
    object(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.sourcePath === "string" &&
    isAbsolute(value.sourcePath) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.every((capability) => typeof capability === "string" && CAPABILITIES.has(capability))
  );
}

/** Validates one call's live projection; a malformed shape fails closed rather than silently falling back. */
export function normalizeProjection(value: unknown): AftProjection {
  if (
    !object(value) ||
    typeof value.kind !== "string" ||
    !PROJECTION_KINDS.has(value.kind) ||
    !Array.isArray(value.paths) ||
    value.paths.some((path) => typeof path !== "string") ||
    typeof value.broad !== "boolean"
  ) {
    throw new Error("The bound AFT tool returned a malformed projection");
  }
  return { kind: value.kind as AftProjectionKind, paths: value.paths as string[], broad: value.broad };
}

interface AftBinding {
  tools: Map<string, AftBoundTool>;
  project: AftProject;
}

/**
 * Optional synchronous `aft` v1 handshake (AFT interoperability contract). AFT advertises the same-name
 * tools it registers and a pure projection function; a tool is admitted only when the live host
 * `sourceInfo` for that name is `extension` and its path equals the tool's advertised `sourcePath`, so an
 * unrelated extension cannot spoof AFT's binding or claim one of its tool names. This is extension
 * cooperation, not a sandbox against malicious in-process code. No answer means AFT is not loaded.
 */
export class AftContract {
  readonly #bindings = new Map<string, AftBinding>();

  constructor(
    private readonly events: ContractEvents,
    private readonly getAllTools: () => readonly ToolProvenance[],
  ) {}

  #requestBinding(sessionId: string): AftBinding | undefined {
    const requestId = randomUUID();
    let reply: Record<string, unknown> | undefined;
    const unsubscribe = this.events.on("aft:binding", (payload) => {
      if (object(payload) && payload.sessionId === sessionId && payload.requestId === requestId) reply ??= payload;
    });
    try {
      this.events.emit("aft:binding-request", { v: 1, sessionId, requestId });
    } finally {
      unsubscribe();
    }
    if (reply?.v !== 1 || typeof reply.project !== "function" || !Array.isArray(reply.tools)) return undefined;
    const names = new Set<string>();
    const advertised: AftBoundTool[] = [];
    for (const candidate of reply.tools) {
      if (!validTool(candidate) || names.has(candidate.name)) return undefined;
      names.add(candidate.name);
      advertised.push(candidate);
    }
    const live = this.getAllTools();
    const verified = new Map<string, AftBoundTool>();
    for (const tool of advertised) {
      const info = live.find((candidate) => candidate.name === tool.name)?.sourceInfo;
      if (info?.source === "extension" && info.path === tool.sourcePath) verified.set(tool.name, tool);
    }
    return { tools: verified, project: reply.project as AftProject };
  }

  /** The handshake is cached for the session, re-verified against live tool provenance each time; a miss is retried on the next call. */
  #binding(sessionId: string): AftBinding | undefined {
    const cached = this.#bindings.get(sessionId);
    if (cached) return cached;
    const binding = this.#requestBinding(sessionId);
    if (binding) this.#bindings.set(sessionId, binding);
    return binding;
  }

  /** The exact-source-verified bound tool for toolName in this session, if any. */
  tool(sessionId: string, toolName: string): AftBoundTool | undefined {
    const tool = this.#binding(sessionId)?.tools.get(toolName);
    if (!tool) return undefined;
    const source = this.getAllTools().find((candidate) => candidate.name === toolName)?.sourceInfo;
    return source?.source === "extension" && source.path === tool.sourcePath ? tool : undefined;
  }

  /** Projects toolName's mutation scope through AFT's own grammar; undefined when toolName is not AFT-bound. */
  async project(sessionId: string, toolName: string, input: Record<string, unknown>, cwd: string): Promise<AftProjection | undefined> {
    const binding = this.#binding(sessionId);
    if (!binding || !this.tool(sessionId, toolName)) return undefined;
    return normalizeProjection(await binding.project(toolName, input, cwd));
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }
}

/** Whether toolName's live host sourceInfo is `extension`, independent of AFT binding verification. */
export function isExtensionSourced(getAllTools: () => readonly ToolProvenance[], toolName: string): boolean {
  return getAllTools().find((candidate) => candidate.name === toolName)?.sourceInfo?.source === "extension";
}
