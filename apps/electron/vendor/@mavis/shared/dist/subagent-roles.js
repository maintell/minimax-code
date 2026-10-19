/** Single source of truth for canonical desktop SubAgent role names. */
export const SUBAGENT_ROLES = {
    explore: {
        whenToUse: 'Locate code and collect evidence with read-only Git and code investigation; cannot create or edit files. Use verifier for code review, audits, and acceptance checks.',
    },
    worker: {
        whenToUse: 'Bounded production work with explicit scope, ownership, deliverable, and acceptance.',
    },
    verifier: {
        whenToUse: 'Independently review code, audit, or validate an existing deliverable against acceptance criteria and report evidence-backed findings; no project-file changes. Temporary validation artifacts require an explicitly designated temporary location.',
    },
};
export const CANONICAL_SUBAGENT_ROLES = Object.keys(SUBAGENT_ROLES);
/** Model-visible built-in targets. */
const TASK_AGENT_TARGETS = ['mavis', ...CANONICAL_SUBAGENT_ROLES];
const TASK_AGENT_TARGET_DESCRIPTIONS = {
    mavis: 'Broad or mixed-scope work that does not fit a specialist role.',
    explore: SUBAGENT_ROLES.explore.whenToUse,
    worker: SUBAGENT_ROLES.worker.whenToUse,
    verifier: SUBAGENT_ROLES.verifier.whenToUse,
};
/** Names whose bare form is interpreted as a canonical role or primary alias. */
export const RESERVED_SUBAGENT_NAMES = [
    ...CANONICAL_SUBAGENT_ROLES,
    'main',
    'mavis',
];
const RESERVED_SUBAGENT_NAME_SET = new Set(RESERVED_SUBAGENT_NAMES);
/**
 * The desktop service currently returns the thrift enum value for built-ins,
 * while a few adapters expose the already-decoded string. Everything else is
 * intentionally treated as non-builtin so a manual/unknown row cannot be
 * selected through a role or primary alias by accident.
 */
export function isTrustedBuiltinCreationSource(value) {
    return value === 3 || value === 'builtin';
}
export function toAgentRequestRef(agent) {
    if (typeof agent?.name !== 'string')
        return undefined;
    const name = agent.name;
    if (name.toLowerCase().startsWith('agent:'))
        return name;
    if (RESERVED_SUBAGENT_NAME_SET.has(name.toLowerCase()) &&
        !isTrustedBuiltinCreationSource(agent.creationSource)) {
        return `agent:${name}`;
    }
    return name;
}
export const AGENT_REQUEST_REF_DESCRIPTION = 'Use the `requestRef` returned by the native `mavis` tool with command "agent list". For built-in work use mavis, explore, worker, or verifier. Use `agent:<stable-name>` to select the exact manual/custom Agent when its name collides with a reserved role or primary alias; ordinary custom names use their raw stable name.';
export const LOCAL_MAVIS_AGENT_NAME_DESCRIPTION = `${AGENT_REQUEST_REF_DESCRIPTION} "me" selects the current Agent.`;
const TASK_AGENT_REQUEST_REF_DESCRIPTION = 'Built-in name or stable custom `requestRef`. Use `agent:<stable-name>` for a custom Agent whose name collides with a reserved role or primary alias; ordinary custom names use their raw stable name. Use the native `mavis` tool with command "agent list" for discovery only when needed and available.';
const WITHOUT_MAVIS_AGENT_REQUEST_REF_DESCRIPTION = 'Use explore, worker, or verifier for built-in work. For a known custom Agent, use its stable `requestRef`. Use `agent:<stable-name>` to select the exact manual/custom Agent when its name collides with a reserved role or primary alias; ordinary custom names use their raw stable name.';
export function isCanonicalSubagentRole(value) {
    return Object.hasOwn(SUBAGENT_ROLES, value);
}
export function resolveCanonicalSubagentRole(requestedName) {
    const normalized = requestedName.trim().toLowerCase();
    return isCanonicalSubagentRole(normalized) ? normalized : undefined;
}
export function roleDirectoryText() {
    return TASK_AGENT_TARGETS.map((target) => `- ${target} — ${TASK_AGENT_TARGET_DESCRIPTIONS[target]}`).join('\n');
}
/**
 * Returns model-visible Task target guidance for the currently exposed
 * capability surface. Resolver compatibility stays unchanged.
 */
export function agentNameDescription(options = {}) {
    return options.includeMavis === false
        ? WITHOUT_MAVIS_AGENT_REQUEST_REF_DESCRIPTION
        : TASK_AGENT_REQUEST_REF_DESCRIPTION;
}
//# sourceMappingURL=subagent-roles.js.map