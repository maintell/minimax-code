export const SYSTEM_SUBAGENT_TYPES = ['explore', 'general', 'scout'];
export const SYSTEM_SUBAGENT_AGENT_IDS = {
    explore: 10001,
    general: 10002,
    scout: 10003,
};
export const DEFAULT_SYSTEM_SUBAGENT_CONFIGS = {
    explore: {
        agent_id: SYSTEM_SUBAGENT_AGENT_IDS.explore,
        description: 'Use for read-only codebase exploration when the parent needs a grounded map of relevant files, symbols, data flow, or constraints. Best for unfamiliar areas, architecture questions, and impact analysis before implementation.',
        system_prompt: `You are the explore subagent: a read-only codebase exploration specialist.

Mission:
- Build a grounded understanding of the requested area of the repository or runtime context.
- Identify relevant files, symbols, data flow, configuration, tests, and constraints.
- Separate direct evidence from inference, and call out uncertainty.

Rules:
- Do not edit files, run destructive commands, or make irreversible changes.
- Prefer targeted reads and searches over broad scans.
- Do not solve unrelated implementation tasks unless explicitly asked.
- Do not delegate to other subagents.
- If evidence is insufficient, say what is missing instead of guessing.

Return format:
- Summary: concise answer to the parent's question.
- Evidence: bullet list with concrete file paths, symbols, or observed facts.
- Inferences: what you believe based on the evidence, clearly marked.
- Risks / Unknowns: anything that may affect the parent's next step.
- Suggested next step: one or two actionable recommendations.`,
        tools: ['read', 'grep', 'glob', 'web_fetch'],
    },
    general: {
        agent_id: SYSTEM_SUBAGENT_AGENT_IDS.general,
        description: 'Use for a bounded delegated task that may require multiple steps or broader tool use. Best for self-contained execution where the parent provides clear scope, expected output, and constraints.',
        system_prompt: `You are the general subagent: a focused executor for one bounded delegated task.

Mission:
- Complete the parent agent's assigned task as directly as possible.
- Use the provided tools when they materially improve correctness.
- Keep scope limited to the prompt, constraints, and tool results you receive.

Rules:
- Do not delegate to other subagents.
- Do not invent missing requirements; state assumptions explicitly.
- Avoid unrelated refactors or opportunistic changes.
- Preserve user intent and respect any safety, permission, or repository constraints.
- If blocked, return the blocker with the exact missing input or failing condition.

Return format:
- Result: what you completed or concluded.
- Evidence: key files, commands, tool results, or observations.
- Changes made: list changed files, or say "none".
- Validation: tests/checks run, or explain why not run.
- Blockers / Risks: anything the parent must handle next.`,
    },
    scout: {
        agent_id: SYSTEM_SUBAGENT_AGENT_IDS.scout,
        description: 'Use for fast, read-only reconnaissance on one narrow question, especially external docs, dependency behavior, upstream examples, or a quick local/upstream confidence check. Best when the parent needs a concise answer before deeper work, not a broad codebase map.',
        system_prompt: `You are the scout subagent: a fast read-only reconnaissance specialist for narrow external, dependency, or local facts.

Mission:
- Answer exactly one narrow question quickly.
- Find the smallest amount of reliable evidence needed for the parent's next decision.
- Cross-check local files and, when URLs or source locations are available, official/upstream docs or examples.
- Optimize for speed, precision, and calibrated confidence; do not produce a broad codebase map.

Rules:
- Do not edit files or make broad architectural recommendations unless asked.
- Prefer official/upstream sources and local primary evidence over secondary commentary.
- Stop once you have enough evidence for the parent agent's next decision.
- Do not delegate to other subagents.
- If the question is too broad, narrow it and state the narrowed scope.

Return format:
- Answer: direct response in one or two sentences.
- Evidence: 2-5 bullets with file paths, URLs, symbols, or facts.
- Confidence: high / medium / low, with a short reason.
- Next step: the single most useful follow-up for the parent agent.`,
        tools: ['read', 'grep', 'glob', 'web_fetch'],
    },
};
const SYSTEM_SUBAGENT_TYPE_SET = new Set(SYSTEM_SUBAGENT_TYPES);
function compact(value) {
    const text = value?.trim();
    return text || undefined;
}
export function isSystemSubagentType(value) {
    return SYSTEM_SUBAGENT_TYPE_SET.has(value);
}
export function normalizeSubagentTypeConfigs(configs) {
    const normalized = [];
    const seen = new Set();
    for (const config of configs ?? []) {
        const type = compact(config.type);
        if (!type || !isSystemSubagentType(type) || seen.has(type))
            continue;
        const defaults = DEFAULT_SYSTEM_SUBAGENT_CONFIGS[type];
        const systemPrompt = compact(config.system_prompt) ?? defaults.system_prompt;
        const description = compact(config.description) ?? defaults.description;
        const tools = Array.isArray(config.tools)
            ? config.tools.map((tool) => tool.trim()).filter(Boolean)
            : defaults.tools;
        seen.add(type);
        normalized.push({
            type,
            description,
            system_prompt: systemPrompt,
            agent_id: defaults.agent_id,
            ...(config.model ? { model: config.model } : {}),
            ...(tools ? { tools } : {}),
            ...(config.hidden === true ? { hidden: true } : {}),
        });
    }
    return normalized;
}
export function getEffectiveSubagentTypeConfigs(configs) {
    const defaults = () => normalizeSubagentTypeConfigs(SYSTEM_SUBAGENT_TYPES.map((type) => ({ type })));
    if (configs === undefined)
        return defaults();
    // An explicit empty list disables system subagents. A non-empty list whose
    // entries are all unsupported (e.g. user Agent names pushed into
    // subagent_types) is a misconfiguration, not an opt-out: fall back to the
    // built-in types so `task` keeps a usable target.
    const normalized = normalizeSubagentTypeConfigs(configs);
    if (configs.length > 0 && normalized.length === 0)
        return defaults();
    return normalized;
}
export function getVisibleEffectiveSubagentTypeConfigs(configs) {
    return getEffectiveSubagentTypeConfigs(configs).filter((cfg) => cfg.hidden !== true);
}
function oneLine(value) {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text || undefined;
}
/** `<available_subagents>` — exact `task.subagent_type` values; undefined when none are visible. */
export function buildAvailableSubagentsBlock(subagentTypes) {
    const entries = getVisibleEffectiveSubagentTypeConfigs(subagentTypes).sort((a, b) => a.type.localeCompare(b.type));
    if (entries.length === 0)
        return undefined;
    const rows = entries.map((cfg) => {
        const exactName = cfg.type;
        const description = oneLine(cfg.description);
        const suffix = description ? ` — ${description}` : '';
        return `- <subagent_type>${exactName}</subagent_type>${suffix}`;
    });
    return `<available_subagents>
Use \`subagent_type\` only with one of these exact values:
${rows.join('\n')}
For a trusted Agent reference, use its exact \`agent_name\` instead. Do not provide both target fields.
</available_subagents>`;
}
//# sourceMappingURL=system-subagents.js.map