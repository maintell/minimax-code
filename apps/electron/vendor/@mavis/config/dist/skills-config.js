/**
 * Skills external-source ingestion config (Unified Skill Ingestion).
 *
 * — user-authored skill directories that Mavis honours as external sources
 * independent of which runtime executes the agent session. See plan
 * `~/.claude/plans/ok-image-1-unified-tower.md`.
 *
 * Schema reasoning:
 *   - `enabled` master switch: legal/compliance kill-switch in case any
 *     enterprise deployment needs all external ingestion off.
 *   - `walkUp` toggles whether daemon walks parent dirs up to the git root
 *     when discovering project-level `.claude` / `.agents`. Matches the
 *     compatible external skill discovery behavior.
 *   - `duplicateWarn` controls collision diagnostics for same-named skills
 *     across sources. The visible skill roster still keeps only the priority
 *     winner.
 *   - `sources`: per-source-kind `{ enabled, priority }`. Higher priority
 *     wins on name collision. Only the externally-discoverable sources are
 *     surfaced — Mavis-internal sources (`builtin-*`, `agent-*`, `user-mavis`)
 *     are not user-configurable here (handled by the SkillStore directly).
 */
const EXTERNAL_SOURCE_KINDS = [
    'user-cc',
    'user-codex',
    'user-agents',
    'workspace-minimax',
    'workspace-cc',
    'workspace-agents',
];
// Persisted config identifiers from before the source-kind rename. Keep them
// as read-only aliases; normalized output always uses the current keys above.
const LEGACY_SOURCE_KEY_BY_KIND = {
    'user-cc': 'user-claude',
    'workspace-cc': 'workspace-claude',
};
export const DEFAULT_SKILLS_CONFIG = {
    external: {
        enabled: true,
        walkUp: true,
        duplicateWarn: true,
        sources: {
            'workspace-minimax': { enabled: true, priority: 65 },
            'workspace-cc': { enabled: true, priority: 60 },
            'workspace-agents': { enabled: true, priority: 55 },
            'user-cc': { enabled: true, priority: 40 },
            'user-codex': { enabled: true, priority: 35 },
            'user-agents': { enabled: true, priority: 30 },
        },
    },
};
function isObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}
function parseSource(raw, fallback) {
    if (!isObject(raw))
        return fallback;
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
        priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority)
            ? raw.priority
            : fallback.priority,
    };
}
export function parseSkillsConfig(raw) {
    const defaults = DEFAULT_SKILLS_CONFIG;
    const skillsObj = isObject(raw.skills) ? raw.skills : {};
    const externalObj = isObject(skillsObj.external)
        ? skillsObj.external
        : {};
    const sourcesObj = isObject(externalObj.sources)
        ? externalObj.sources
        : {};
    const sources = {
        ...defaults.external.sources,
    };
    for (const kind of EXTERNAL_SOURCE_KINDS) {
        const legacyKind = LEGACY_SOURCE_KEY_BY_KIND[kind];
        const sourceRaw = Object.hasOwn(sourcesObj, kind)
            ? sourcesObj[kind]
            : legacyKind
                ? sourcesObj[legacyKind]
                : undefined;
        sources[kind] = parseSource(sourceRaw, defaults.external.sources[kind]);
    }
    return {
        external: {
            enabled: typeof externalObj.enabled === 'boolean' ? externalObj.enabled : defaults.external.enabled,
            walkUp: typeof externalObj.walkUp === 'boolean' ? externalObj.walkUp : defaults.external.walkUp,
            duplicateWarn: typeof externalObj.duplicateWarn === 'boolean'
                ? externalObj.duplicateWarn
                : defaults.external.duplicateWarn,
            sources,
        },
    };
}
export const EXTERNAL_SOURCE_KIND_LIST = EXTERNAL_SOURCE_KINDS;
//# sourceMappingURL=skills-config.js.map