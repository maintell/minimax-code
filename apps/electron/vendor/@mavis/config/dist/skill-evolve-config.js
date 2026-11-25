/**
 * Skill-evolve configuration types, defaults, lifecycle helpers and the
 * runtime parser. Extracted from `config.ts` to keep the main schema file
 * under the source-size guard. The resolved beta gates are passed in by
 * `config.ts` so this module never imports it back.
 */
/**
 * v3 helper: check whether an agent is in the proposal eligibility list.
 *
 * - `["*"]` matches every agent
 * - Otherwise an exact name match
 *
 * Empty list always returns false.
 */
export function isProposalEligibleAgent(agentName, eligibleAgents) {
    if (eligibleAgents.length === 0)
        return false;
    if (eligibleAgents.includes('*'))
        return true;
    return eligibleAgents.includes(agentName);
}
export const SKILL_EVOLVE_CONFIG_DEFAULTS = {
    enabled: true,
    inSession: {
        N: 20,
        minIntervalSeconds: 30,
        maxPendingPerSession: 1,
    },
    signalCooldownHours: 24,
    minConfidence: 0.7,
    excludeAgents: ['skill-editor'],
    disableModelPrefixes: ['MiniMax-M2'],
    builtinMrEnabled: false,
    sourceRepo: undefined,
    proposal: {
        enabled: false,
        eligibleAgents: ['mavis'],
        minMessageCount: 40,
        skipPassiveSessionEnd: true,
    },
    lifecycle: { staleThresholdDays: 15, archiveThresholdDays: 30 }, // tightened from legacy 30d/90d
};
// ── Skill Evolve config parsing ─────────────────────────────────
/**
 * Collect all model IDs from the provider config.
 * Returns an empty array when no models are configured.
 */
function collectModelIds(raw) {
    const providerRaw = raw.provider;
    if (providerRaw == null || typeof providerRaw !== 'object' || Array.isArray(providerRaw)) {
        return [];
    }
    const ids = [];
    for (const prov of Object.values(providerRaw)) {
        if (prov == null || typeof prov !== 'object' || Array.isArray(prov))
            continue;
        const { models } = prov;
        if (models == null || typeof models !== 'object' || Array.isArray(models))
            continue;
        ids.push(...Object.keys(models));
    }
    return ids;
}
/**
 * Auto-derive the `skillEvolve.enabled` flag from the configured model list.
 *
 * When **every** configured model ID starts with one of the
 * `disableModelPrefixes` (case-insensitive), skill-evolve has no capable
 * model to work with, so it is disabled automatically.
 * If at least one model does NOT match, the feature is enabled.
 *
 * Edge cases: no providers / no models configured → `false`
 * (no capable model means the feature cannot operate).
 */
function deriveSkillEvolveEnabled(raw, disableModelPrefixes) {
    if (disableModelPrefixes.length === 0)
        return true;
    const modelIds = collectModelIds(raw);
    if (modelIds.length === 0)
        return false;
    const lowerPrefixes = disableModelPrefixes.map((p) => p.toLowerCase());
    return !modelIds.every((id) => lowerPrefixes.some((p) => id.toLowerCase().startsWith(p)));
}
function parsePositiveDays(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
export function parseSkillEvolveConfig(raw, betaConfig) {
    const defaults = SKILL_EVOLVE_CONFIG_DEFAULTS;
    const se = raw.skillEvolve;
    const hasSection = se != null && typeof se === 'object' && !Array.isArray(se);
    const obj = hasSection ? se : {};
    const inSessionRaw = obj.inSession;
    let { inSession } = defaults;
    if (inSessionRaw != null && typeof inSessionRaw === 'object' && !Array.isArray(inSessionRaw)) {
        const ins = inSessionRaw;
        inSession = {
            N: typeof ins.N === 'number' && ins.N > 0 ? ins.N : defaults.inSession.N,
            minIntervalSeconds: typeof ins.minIntervalSeconds === 'number' && ins.minIntervalSeconds >= 0
                ? ins.minIntervalSeconds
                : defaults.inSession.minIntervalSeconds,
            maxPendingPerSession: typeof ins.maxPendingPerSession === 'number' && ins.maxPendingPerSession >= 1
                ? ins.maxPendingPerSession
                : defaults.inSession.maxPendingPerSession,
        };
    }
    const excludeRaw = obj.excludeAgents;
    const excludeAgents = Array.isArray(excludeRaw) && excludeRaw.every((e) => typeof e === 'string')
        ? excludeRaw
        : defaults.excludeAgents;
    const disableModelPrefixes = Array.isArray(obj.disableModelPrefixes) &&
        obj.disableModelPrefixes.every((e) => typeof e === 'string')
        ? obj.disableModelPrefixes
        : defaults.disableModelPrefixes;
    // `enabled` — beta gate wins first; then explicit config; then auto-derive from model list.
    const enabled = !betaConfig.skillEvolve
        ? false
        : typeof obj.enabled === 'boolean'
            ? obj.enabled
            : deriveSkillEvolveEnabled(raw, disableModelPrefixes);
    // `builtinMrEnabled` — beta gate wins first; then explicit config; then default.
    // Implicitly false when the parent `enabled` is false (no point evolving built-ins
    // when the pipeline as a whole is off).
    const builtinMrEnabled = !enabled
        ? false
        : !betaConfig.skillEvolveBuiltinMr
            ? false
            : typeof obj.builtinMrEnabled === 'boolean'
                ? obj.builtinMrEnabled
                : defaults.builtinMrEnabled;
    const sourceRepoRaw = obj.sourceRepo;
    const sourceRepo = typeof sourceRepoRaw === 'string' && sourceRepoRaw.trim().length > 0
        ? sourceRepoRaw.trim()
        : defaults.sourceRepo;
    // v3: `proposal` — beta gate + parent gate must both be true; otherwise
    // resolved sub-config still parses but `enabled` is forced false. Other
    // fields (eligibleAgents, minMessageCount, skipPassiveSessionEnd) are
    // honored even when the gate is off so operators can pre-stage config.
    const proposalRaw = obj.proposal;
    const proposalDefaults = defaults.proposal;
    const proposalObj = proposalRaw != null && typeof proposalRaw === 'object' && !Array.isArray(proposalRaw)
        ? proposalRaw
        : {};
    const proposalEligibleAgents = Array.isArray(proposalObj.eligibleAgents) &&
        proposalObj.eligibleAgents.every((e) => typeof e === 'string')
        ? proposalObj.eligibleAgents
        : proposalDefaults.eligibleAgents;
    const proposalMinMessageCount = typeof proposalObj.minMessageCount === 'number' && proposalObj.minMessageCount >= 1
        ? Math.floor(proposalObj.minMessageCount)
        : proposalDefaults.minMessageCount;
    const proposalSkipPassiveSessionEnd = typeof proposalObj.skipPassiveSessionEnd === 'boolean'
        ? proposalObj.skipPassiveSessionEnd
        : proposalDefaults.skipPassiveSessionEnd;
    const proposalEnabledExplicit = typeof proposalObj.enabled === 'boolean' ? proposalObj.enabled : null;
    const proposalEnabled = !enabled
        ? false
        : !betaConfig.skillProposal
            ? false
            : (proposalEnabledExplicit ?? true);
    // `lifecycle` — strict invariant stale < archive (fail-fast at boot).
    const lcRaw = obj.lifecycle;
    const lc = lcRaw && typeof lcRaw === 'object' && !Array.isArray(lcRaw)
        ? lcRaw
        : {};
    const staleThresholdDays = parsePositiveDays(lc.staleThresholdDays, defaults.lifecycle.staleThresholdDays); // prettier-ignore
    const archiveThresholdDays = parsePositiveDays(lc.archiveThresholdDays, defaults.lifecycle.archiveThresholdDays); // prettier-ignore
    if (!(staleThresholdDays < archiveThresholdDays)) {
        throw new Error(`Invalid skillEvolve.lifecycle config: staleThresholdDays (${staleThresholdDays}) must be strictly less than archiveThresholdDays (${archiveThresholdDays}).`);
    }
    return {
        enabled,
        inSession,
        signalCooldownHours: typeof obj.signalCooldownHours === 'number' && obj.signalCooldownHours > 0
            ? obj.signalCooldownHours
            : defaults.signalCooldownHours,
        minConfidence: typeof obj.minConfidence === 'number' && obj.minConfidence >= 0 && obj.minConfidence <= 1
            ? obj.minConfidence
            : defaults.minConfidence,
        scannerModel: typeof obj.scannerModel === 'string' ? obj.scannerModel : undefined,
        excludeAgents,
        disableModelPrefixes,
        builtinMrEnabled,
        sourceRepo,
        proposal: {
            enabled: proposalEnabled,
            eligibleAgents: proposalEligibleAgents,
            minMessageCount: proposalMinMessageCount,
            skipPassiveSessionEnd: proposalSkipPassiveSessionEnd,
        },
        lifecycle: { staleThresholdDays, archiveThresholdDays },
    };
}
//# sourceMappingURL=skill-evolve-config.js.map