/** A member call past this many open calls is asked last (never queued or refused). @internal */
export const FAILOVER_SOFT_INFLIGHT_LIMIT = 8;
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/** A backup serves the model only with at least the primary's context and output limits. */
function modelBlocked(input, member) {
    if (member.primary && !input.plan.grouped)
        return undefined;
    const model = input.catalog(member.providerKey, input.modelId);
    if (!model || model.enabled === false)
        return { until: Infinity, reason: 'model_missing' };
    if (input.plan.grouped)
        return groupedModelBlocked(model, input.requirement);
    return legacyLimits(input, model);
}
function legacyLimits(input, model) {
    const primary = input.catalog(input.plan.primaryKey, input.modelId);
    const wantContext = positive(primary?.limit?.context);
    const wantOutput = positive(primary?.limit?.output);
    if (wantContext !== undefined && !((positive(model.limit?.context) ?? 0) >= wantContext))
        return { until: Infinity, reason: 'context_smaller' };
    if (wantOutput !== undefined && !((positive(model.limit?.output) ?? 0) >= wantOutput))
        return { until: Infinity, reason: 'output_smaller' };
    return undefined;
}
function groupedModelBlocked(model, requirement) {
    if (requirement?.effort && !model.thinking?.effortOptions?.includes(requirement.effort))
        return { until: Infinity, reason: 'effort_unsupported' };
    if (requirement?.images && !model.modalities?.input?.includes('image'))
        return { until: Infinity, reason: 'image_unsupported' };
    return requestedLimits(model, requirement);
}
function requestedLimits(model, requirement) {
    if (requirement?.context &&
        model.limit?.context !== undefined &&
        model.limit.context < requirement.context)
        return { until: Infinity, reason: 'context_smaller' };
    if (requirement?.output &&
        model.limit?.output !== undefined &&
        model.limit.output < requirement.output)
        return { until: Infinity, reason: 'output_smaller' };
    return undefined;
}
/** Reasons a free model is spared from: the account's allowance or money, nothing else. */
const ALLOWANCE_REASONS = new Set(['quota', 'credit']);
/** The member's committed model is free (creditMultiplier 0) and the rest is about allowance. */
function freeBeside(input, member, reason) {
    return (ALLOWANCE_REASONS.has(reason) &&
        input.catalog(member.providerKey, input.modelId)?.creditMultiplier === 0);
}
/**
 * A sign-in mark sets a member aside for its mates. A pool of one has no mate: like a single
 * account, it is refused only for a revoked direct sign-in and otherwise asked again.
 */
function needsSignIn(input, providerKey, stamp) {
    if (!input.state.needsReauth(providerKey, stamp))
        return false;
    return input.plan.members.length > 1 || input.state.revoked(providerKey, stamp);
}
function blocked(input, member) {
    if (input.installationActive?.(member.installationId) === false)
        return { until: Infinity, reason: 'installation_inactive' };
    const stamp = input.bindingStamp(member.providerKey);
    if (stamp === undefined)
        return { until: Infinity, reason: 'binding_missing' };
    if (needsSignIn(input, member.providerKey, stamp))
        return { until: Infinity, reason: 'reauth_required' };
    const model = modelBlocked(input, member);
    if (model)
        return model;
    if (member.providerKey === input.probe)
        return undefined;
    const own = input.state.memberCooldown(member.providerKey);
    const cooling = [
        // An account out of quota or credit still serves its free models
        // (creditMultiplier 0, e.g. Devin's free tier) — they draw on no allowance.
        own && freeBeside(input, member, own.reason) ? undefined : own,
        input.state.modelCooldown(member.providerKey, input.modelId),
    ].filter((item) => item !== undefined);
    if (cooling.length === 0)
        return undefined;
    const longest = cooling.reduce((a, b) => (b.until > a.until ? b : a));
    return { until: longest.until, reason: longest.reason };
}
/**
 * The members that may take this call, in order: the session's member first when it may, then
 * the configured order. A member whose hard concurrency limit or minute is full gives way to one
 * with room now, then members at the soft concurrency limit go last; nobody is
 * dropped for being busy (a full member is queued, never refused).
 */
export function availableMembers(input) {
    const usable = input.plan.members.filter((member) => !input.exclude?.has(member.providerKey) && !blocked(input, member));
    const bound = input.state.boundMember(input.sessionId, input.plan.primaryKey);
    const ordered = [
        ...usable.filter((member) => member.providerKey === bound),
        ...usable.filter((member) => member.providerKey !== bound),
    ];
    const rank = (member) => (member.providerId && input.matesLast?.has(member.providerId) ? 4 : 0) +
        (input.ready?.(member.providerKey) === false ? 2 : 0) +
        (input.state.inflightCount(member.providerKey) >= FAILOVER_SOFT_INFLIGHT_LIMIT ? 1 : 0);
    // Array.prototype.sort is stable: the bound / configured order holds within each rank.
    return ordered
        .map((member) => ({ member, rank: rank(member) }))
        .sort((a, b) => a.rank - b.rank)
        .map((item) => item.member);
}
/**
 * When no member may take the call, the one whose rest ends soonest (first in
 * order on a tie) is asked once — its answer tells whether it is back. Only a rest qualifies;
 * a member that needs a new sign-in, lacks the model or whose package is off never does.
 */
export function probeMember(input) {
    let best;
    for (const member of input.plan.members) {
        if (input.exclude?.has(member.providerKey))
            continue;
        const item = blocked({ ...input, probe: undefined }, member);
        if (!item || !Number.isFinite(item.until))
            continue;
        if (!best || item.until < best.until)
            best = { member, until: item.until };
    }
    return best?.member;
}
/** Why no member may take the call, and the earliest time one may (when a wait mends it). */
export function earliestRecovery(input) {
    let best;
    for (const member of input.plan.members) {
        const item = blocked(input, member) ?? { until: Infinity, reason: 'unavailable' };
        if (!best || item.until < best.until)
            best = item;
    }
    if (!best)
        return { reason: 'unavailable' };
    return Number.isFinite(best.until)
        ? { reason: best.reason, retryAt: best.until }
        : { reason: best.reason };
}
//# sourceMappingURL=pool-selector.js.map