import { resolveAgentCapabilities, } from '@mavis/config';
export const PRIMARY_AGENT_NAME = 'mavis';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
export const BUILTIN_ROSTER_FILE = 'builtin-agents.json';
export const FEATURE_FILES = {
    delegation: 'delegation.md.hbs',
    taskManagement: 'task-management.md.hbs',
    webSearch: 'web-search.md.hbs',
    cron: 'cron.md.hbs',
    memory: 'memory.md.hbs',
};
export function surfacePromptFiles(surface) {
    return surface === 'task-child'
        ? {
            template: 'prompt-session-branch.md.hbs',
            fallback: 'prompt-session-branch.md',
        }
        : {
            template: 'prompt-session-root.md.hbs',
            fallback: 'prompt-session-root.md',
        };
}
export function toSurfaceRenderInput(input) {
    return {
        agentName: input.agentName,
        surface: input.surface,
        ...(input.promptProfile === undefined ? {} : { promptProfile: input.promptProfile }),
        promptMode: input.promptMode,
        promptVersion: input.promptVersion,
        appMode: input.appMode,
        locale: input.locale,
        promptChannel: input.promptChannel,
        capabilities: input.capabilities,
        memoryEnabled: input.memoryEnabled,
        cronEnabled: input.cronEnabled,
        dataDirToken: input.dataDirToken,
        ...(input.promptReadContext === undefined
            ? {}
            : { promptReadContext: input.promptReadContext }),
    };
}
export function defaultLocale() {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
}
export function canonicalBuiltinName(name) {
    const normalized = name.trim().toLowerCase();
    return normalized === LEGACY_PRIMARY_AGENT_NAME ? PRIMARY_AGENT_NAME : normalized;
}
export function legacyNamesFor(name) {
    return name === PRIMARY_AGENT_NAME ? [LEGACY_PRIMARY_AGENT_NAME] : [];
}
export function resolveCanonicalCapabilities(configured, override) {
    const base = isResolvedCapabilities(configured)
        ? configured
        : resolveAgentCapabilities(configured);
    if (!override)
        return base;
    return {
        persona: { enabled: base.persona.enabled && override.persona?.enabled !== false },
        tools: intersect(base.tools, override.tools),
        builtinTools: intersect(base.builtinTools, override.builtinTools),
        skills: intersect(base.skills, override.skills),
        features: {
            mavis: base.features.mavis && override.features?.mavis !== false,
            delegation: base.features.delegation && override.features?.delegation !== false,
            webSearch: base.features.webSearch && override.features?.webSearch !== false,
        },
    };
}
function isResolvedCapabilities(value) {
    return Boolean(value && 'persona' in value && 'features' in value);
}
function intersect(base, override) {
    if (base === undefined)
        return override === undefined ? undefined : [...override];
    if (override === undefined)
        return [...base];
    const allowed = new Set(override);
    return base.filter((value) => allowed.has(value));
}
//# sourceMappingURL=definitions.js.map