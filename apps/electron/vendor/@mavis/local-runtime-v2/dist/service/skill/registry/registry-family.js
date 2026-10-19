import {} from '@mavis/skills';
import { isLocalBuiltinSkillEnabled } from '../assets/builtin.js';
import { emitResourceAmbiguityTelemetry } from '../telemetry.js';
import { LocalSkillResolutionError, } from '../contracts.js';
export { LocalSkillResolutionError } from '../contracts.js';
const DEFAULT_LOCAL_AGENT_NAME = 'mavis';
/** Contract-level resolution failure without adding fields to DesktopService. */
export function filterSkillsVisibleToAgent(entries, options = {}) {
    const visibleAgentNames = new Set([
        options.agentName || DEFAULT_LOCAL_AGENT_NAME,
        ...(options.compatibleAgentNames ?? []),
    ]);
    return entries.filter((entry) => isVisibleLocalSkill(entry) && (!entry.rootScope || visibleAgentNames.has(entry.rootScope)));
}
function isEntryVisibleToAgent(entry, options) {
    const visibleAgentNames = new Set([
        options.agentName || DEFAULT_LOCAL_AGENT_NAME,
        ...(options.compatibleAgentNames ?? []),
    ]);
    return !entry.rootScope || visibleAgentNames.has(entry.rootScope);
}
export function getManagementEntries(registry, options) {
    // Keep the management projection compatible with lightweight registry
    // doubles used by callers/tests that only expose the stable read API.
    const snapshot = registry.getSnapshot?.();
    if (!snapshot)
        return registry.getAvailableSkills();
    const winners = filterSkillsVisibleToAgent(snapshot.winners, options);
    const namesToExpose = ambiguousLegacySkillNames(registry, options);
    if (namesToExpose.size === 0)
        return winners;
    const existing = new Set(winners.map((entry) => entry.locationUri));
    const legacyEntries = snapshot.entries.filter((entry) => namesToExpose.has(entry.name) &&
        entry.rootKind === 'agent' &&
        isEntryVisibleToAgent(entry, options) &&
        !existing.has(entry.locationUri));
    return [...winners, ...legacyEntries];
}
export function ambiguousLegacySkillNames(registry, options) {
    const snapshot = registry.getSnapshot?.();
    if (!snapshot)
        return new Set();
    const canonical = options.agentName || DEFAULT_LOCAL_AGENT_NAME;
    const names = new Set([canonical, ...(options.compatibleAgentNames ?? [])]);
    const byName = new Map();
    for (const entry of snapshot.entries) {
        if (entry.rootKind !== 'agent' ||
            !entry.rootScope ||
            entry.rootScope === canonical ||
            !names.has(entry.rootScope)) {
            continue;
        }
        const sources = byName.get(entry.name) ?? new Set();
        sources.add(entry.rootScope);
        byName.set(entry.name, sources);
    }
    const canonicalNames = new Set(snapshot.entries
        .filter((entry) => entry.rootKind === 'agent' && entry.rootScope === canonical)
        .map((entry) => entry.name));
    return new Set([...byName.entries()]
        .filter(([name, sources]) => sources.size > 1 && !canonicalNames.has(name))
        .map(([name]) => name));
}
export function ambiguousLegacyLocations(registry, name, options) {
    const snapshot = registry.getSnapshot?.();
    if (!snapshot)
        return [];
    const canonical = options.agentName || DEFAULT_LOCAL_AGENT_NAME;
    const names = new Set([canonical, ...(options.compatibleAgentNames ?? [])]);
    return snapshot.entries
        .filter((entry) => entry.name === name &&
        entry.rootKind === 'agent' &&
        entry.rootScope !== canonical &&
        Boolean(entry.rootScope) &&
        names.has(entry.rootScope))
        .map((entry) => entry.locationUri)
        .sort();
}
export function ambiguousSkillNameError(name, locations, telemetryHost) {
    emitResourceAmbiguityTelemetry(telemetryHost, 'skill', new Set(locations).size);
    return new LocalSkillResolutionError(409, `Skill name "${name}" is ambiguous; use location_uri`, 'AMBIGUOUS_SKILL_NAME', { name, locations });
}
export function readShippedBuiltinSkillNames(registry) {
    const snapshot = registry.getSnapshot?.();
    return new Set(snapshot?.entries.filter((entry) => entry.rootKind === 'builtin').map((entry) => entry.name) ??
        []);
}
export function isVisibleLocalSkill(entry) {
    return entry.rootKind !== 'builtin' || isLocalBuiltinSkillEnabled(entry.name);
}
export function isSkillAllowedByBetaFlags(entry, betaFlags = {}) {
    const requiresBeta = frontmatterString(entry.frontmatter.requiresBeta) ??
        frontmatterString(entry.frontmatter.requires_beta);
    return !requiresBeta || betaFlags[requiresBeta] === true;
}
export function filterInjectableRegistrySkills(entries, options = {}) {
    const betaFlags = options.betaFlags ?? {};
    const builtinSkillNames = options.builtinSkillNames ?? new Set();
    return filterSkillsVisibleToAgent(entries, options)
        .filter((entry) => !options.ambiguousSkillNames?.has(entry.name))
        .filter((entry) => entry.frontmatter.listed !== false)
        .filter((entry) => !entry.name.startsWith('mcp-') || !options.mcpServerNames?.has(entry.name.slice(4)))
        .filter((entry) => options.allowedSkillNames?.has(normalizeSkillSelectorName(entry.name)) ?? true)
        .filter((entry) => entry.rootKind === 'builtin' ||
        (options.allowedExtensionSkillNames?.has(normalizeSkillSelectorName(entry.name)) ?? true))
        .filter((entry) => {
        if (!options.injectableBuiltinSkillNames)
            return true;
        return (!builtinSkillNames.has(entry.name) ||
            (entry.rootKind !== 'builtin' && entry.rootKind !== 'agent') ||
            options.injectableBuiltinSkillNames.has(entry.name));
    })
        .filter((entry) => isSkillAllowedByBetaFlags(entry, betaFlags));
}
function normalizeSkillSelectorName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
export function toNormalizedSkillSelectorSet(values) {
    return values === undefined
        ? undefined
        : new Set(values.map(normalizeSkillSelectorName).filter(Boolean));
}
export function frontmatterString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=registry-family.js.map