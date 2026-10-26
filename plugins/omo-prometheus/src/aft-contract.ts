import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

/** Observation never mutates files or launches subprocesses; the other three are never trusted merely from a self-declared capability. */
export type AftCapability = "observation" | "mutation" | "execution" | "native-url";

/** `kind` mirrors `AftCapability` plus `native` (an internal-URL delegation) and `unknown` (dynamic/uninspectable, never presented as safe). */
export type AftProjectionKind = "observation" | "mutation" | "execution" | "native" | "unknown";

/**
 * AFT's classification of one real call it would make for `toolName`/`input`, resolved against `cwd` (not process cwd).
 * `paths` are exact mutation targets or scopes, including move/rename destinations. `broad` marks a recursive/glob/ancestor
 * scope, so consumers must also protect managed descendants, not just literal path matches.
 */
export interface AftProjection {
  kind: AftProjectionKind;
  paths: string[];
  broad: boolean;
}

/** One tool AFT actually registered on this host, with the capabilities it advertises for it. */
export interface AftTool {
  name: string;
  sourcePath: string;
  capabilities: ReadonlySet<AftCapability>;
}

/** The part of an `aft:binding` reply consumers use; validated structurally, never regex-matched against a path. */
export interface AftBinding {
  v: 1;
  sessionId: string;
  requestId: string;
  tools: ReadonlyMap<string, AftTool>;
  project(toolName: string, input: Record<string, unknown>, cwd: string): Promise<AftProjection>;
}

interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const VALID_CAPABILITIES: ReadonlySet<string> = new Set<AftCapability>(["observation", "mutation", "execution", "native-url"]);

/** Parses `tools`: unique nonempty names, absolute source paths, and a nonempty set of valid capabilities for each entry. */
function parseTools(value: unknown): Map<string, AftTool> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = new Map<string, AftTool>();
  for (const entry of value) {
    if (!object(entry)) return undefined;
    const { name, sourcePath, capabilities } = entry;
    if (typeof name !== "string" || !name || tools.has(name)) return undefined;
    if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) return undefined;
    if (!Array.isArray(capabilities) || capabilities.length === 0) return undefined;
    const parsedCapabilities = new Set<AftCapability>();
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !VALID_CAPABILITIES.has(capability)) return undefined;
      parsedCapabilities.add(capability as AftCapability);
    }
    tools.set(name, { name, sourcePath, capabilities: parsedCapabilities });
  }
  return tools;
}

/**
 * Optional synchronous `aft` v1 handshake: the same-name tools AFT actually registered on this host, each with the
 * capabilities it advertises, plus its `project` function for its own wire grammar. A late answer cannot grant tool
 * provenance (the listener is gone by then), and a missed one is retried on the next request. This is extension
 * cooperation, not a sandbox against malicious in-process code: an admitted tool is also re-verified by exact
 * `sourceInfo.path` against the actual host registration wherever it is used, never granted by name alone.
 */
export class AftContract {
  readonly #bindings = new Map<string, AftBinding>();

  constructor(readonly events: ContractEvents) {}

  requestBinding(sessionId: string): AftBinding | undefined {
    const requestId = randomUUID();
    let binding: AftBinding | undefined;
    const unsubscribe = this.events.on("aft:binding", (payload) => {
      if (!object(payload) || payload.v !== 1 || payload.sessionId !== sessionId || payload.requestId !== requestId) return;
      if (typeof payload.project !== "function") return;
      const tools = parseTools(payload.tools);
      if (!tools) return;
      binding = { v: 1, sessionId, requestId, tools, project: payload.project as AftBinding["project"] };
    });
    try {
      this.events.emit("aft:binding-request", { v: 1, sessionId, requestId });
    } finally {
      unsubscribe();
    }
    if (binding) this.#bindings.set(sessionId, binding);
    else this.#bindings.delete(sessionId);
    return binding;
  }

  /** The tool inventory is stable for a session, so a confirmed answer is reused; a miss is retried on every call. */
  binding(sessionId: string): AftBinding | undefined {
    return this.#bindings.get(sessionId) ?? this.requestBinding(sessionId);
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }
}
