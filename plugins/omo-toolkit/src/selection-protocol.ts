/**
 * Modified-port notice: the agent selection protocol below adapts the "MANDATORY: Category + Skill Selection Protocol"
 * and "Category Domain Matching" guidance from oh-my-openagent revision fe427efeed97e95f009dc6ca7fb17a3ac857f79f
 * (`packages/omo-opencode/src/agents/dynamic-agent-category-skills-guide.ts`), Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see `LICENSE-SUL-1.0` and `NOTICE`).
 */

/** omo-toolkit agents in the order the protocol lists their lanes, each with the work that belongs to it. */
const TOOLKIT_LANES: ReadonlyArray<readonly [agent: string, lane: string]> = [
  ["visual-engineering", "anything with a visual-design side: UI, UX, CSS, styling, layout, animation, design systems."],
  ["ultrabrain", "genuinely hard logic or architecture reasoning. Give it goals and constraints, not steps."],
  ["architect", "read-only comparison of designs, ending in a recommendation."],
  ["deep-low", "default for implementation, backend, logic, algorithms, browser use and multimodal work."],
  [
    "deep-high",
    "a goal whose central decision cannot be settled from evidence: a trade-off, a contract crossing a package boundary, a mechanism with no in-repo pattern.",
  ],
  ["writing", "documentation, prose and technical writing."],
  ["artistry", "unconventional, creative problem solving."],
  ["librarian", "remote repositories, open-source code and library documentation."],
];

const AVAILABLE_AGENTS_HEADING = "# Available Agents";
const AGENT_HEADING_PATTERN = /^###\s+([A-Za-z0-9_-]+)(?:\s|$)/;
const AGENT_BULLET_PATTERN = /^-\s+`([A-Za-z0-9_-]+)`(?:\s|:|$)/;

/**
 * Reads the spawnable agent names from the live `task` tool description. The host renders that roster after
 * applying spawn policy and disabled-agent settings, either as ``- `name`: ...`` bullets or `### name` headings.
 */
export function parseListedAgents(taskDescription: string): string[] {
  const headingIndex = taskDescription.indexOf(AVAILABLE_AGENTS_HEADING);
  if (headingIndex < 0) return [];
  const names: string[] = [];
  for (const line of taskDescription.slice(headingIndex + AVAILABLE_AGENTS_HEADING.length).split("\n")) {
    if (/^#{1,2}(?:\s|$)/.test(line)) break;
    const name = AGENT_HEADING_PATTERN.exec(line)?.[1] ?? AGENT_BULLET_PATTERN.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Builds the parent-side protocol for the listed omo-toolkit agents, or nothing when none is listed. */
export function buildSelectionProtocol(listedAgents: readonly string[]): string | undefined {
  const listed = new Set(listedAgents);
  const lanes = TOOLKIT_LANES.filter(([agent]) => listed.has(agent));
  if (lanes.length === 0) return undefined;
  const hasDeepLow = listed.has("deep-low");
  const hasDeepHigh = listed.has("deep-high");

  const lines = [
    "# Agent selection protocol",
    "",
    "When you delegate through `task`, give each item the agent whose lane matches its domain. The user configured each lane's model and thinking level for that domain, so a mismatched lane produces worse output.",
    "",
    ...lanes.map(([agent, lane]) => `- \`${agent}\`: ${lane}`),
    "",
  ];
  if (hasDeepLow) lines.push("When unsure, choose `deep-low`.");
  lines.push("Split independent goals into separate items of one `task` call, each in its own lane.");

  if (hasDeepLow || hasDeepHigh) {
    lines.push("", "Escalation, judged by the first line of a child's result:");
    if (hasDeepLow) {
      lines.push(
        hasDeepHigh
          ? "- `ESCALATE: deep-high`: if the user's decision on that choice is already recorded, settle it and re-dispatch the goal with the decision. Otherwise re-dispatch the same goal to `deep-high`, passing the child's findings and options. Either way reuse the task's `name`."
          : "- `ESCALATE: deep-high`: if the user's decision on that choice is already recorded, settle it and re-dispatch the goal with the decision, reusing the task's `name`. Otherwise ask the user.",
      );
    }
    if (hasDeepHigh) {
      lines.push(
        "- `ESCALATE: parent`: ask the user, presenting the options and recommendation, then re-dispatch the goal with the decision, reusing the task's `name`.",
      );
    }
  }

  lines.push(
    "",
    "Explicit workflow instructions that name an agent, such as an approved plan or an audit loop, take precedence over this protocol.",
  );
  return lines.join("\n");
}
