import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Stable error code for "one canonical Agent family owns two enabled records
 * on the same platform". Shared with the primary-family channel reconciler so
 * a reconcile refusal and a restore refusal are the same observable failure.
 */
export const PRIMARY_AGENT_CHANNEL_CONFLICT = 'PRIMARY_AGENT_CHANNEL_CONFLICT';
/** Thrown by the restore gate; carries only names, never credentials. */
export class PrimaryAgentChannelConflictError extends Error {
    code = PRIMARY_AGENT_CHANNEL_CONFLICT;
    platform;
    canonicalAgentName;
    agentNames;
    constructor(input) {
        super(`${PRIMARY_AGENT_CHANNEL_CONFLICT}: ${input.platform} has ${input.agentNames.length} enabled bindings for canonical agent ${input.canonicalAgentName}`);
        this.name = 'PrimaryAgentChannelConflictError';
        this.platform = input.platform;
        this.canonicalAgentName = input.canonicalAgentName;
        this.agentNames = input.agentNames;
    }
}
/**
 * V2 keeps its Agent service errors private to that package. Channel ingress
 * only needs to recognise the two reserved-primary failures and translate them
 * to its stable, platform-facing conflict contract. Do not turn arbitrary
 * status-409 errors into a channel conflict: those retain their own API
 * semantics.
 */
export function normalizePrimaryAgentResolutionConflict(error, input) {
    if (error instanceof PrimaryAgentChannelConflictError)
        return error;
    if (!error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'BUILTIN_AGENT_NAME_CONFLICT' &&
            error.code !== 'PRIMARY_AGENT_IDENTITY_CONFLICT')) {
        return undefined;
    }
    return new PrimaryAgentChannelConflictError(input);
}
/**
 * Resolve the canonical family key one record's `agentName` belongs to.
 *
 * Without a resolver (pure V1 / test wiring) every agentName is its own
 * family, which keeps the gate inert instead of inventing a family.
 */
async function resolveChannelFamilyKey(agentName, resolveAgentReadScope) {
    if (!resolveAgentReadScope)
        return agentName;
    try {
        const scope = await resolveAgentReadScope(agentName);
        return scope.canonicalName.trim() || agentName;
    }
    catch (err) {
        // An unresolvable agentName (deleted Agent, orphan credential) must not
        // fail startup here: it degrades to its own exact family, and the record's
        // own enabled/credential gates still decide whether it starts.
        logger.warn({ err, agentName }, 'Channel family resolve failed; using exact agentName');
        return agentName;
    }
}
/**
 * Fail closed when one canonical family owns more than one enabled record on a
 * single platform. Deliberately not "last writer wins": two enabled records
 * mean the wrong bot or the wider ACL could receive traffic, so the restore
 * refuses before any adapter, outbound client or inbound loop is created.
 */
export async function assertSingleEnabledRecordPerFamily(input) {
    const byFamily = new Map();
    for (const record of input.records) {
        if (!record.enabled)
            continue;
        const family = await resolveChannelFamilyKey(record.agentName, input.resolveAgentReadScope);
        byFamily.set(family, [...(byFamily.get(family) ?? []), record.agentName]);
    }
    for (const [canonicalAgentName, agentNames] of byFamily) {
        if (agentNames.length < 2)
            continue;
        logger.error({
            platform: input.platform,
            outcome: 'conflict',
            canonical_agent: canonicalAgentName,
            agents: agentNames,
            code: PRIMARY_AGENT_CHANNEL_CONFLICT,
        }, 'primary_agent_channel_reconcile');
        throw new PrimaryAgentChannelConflictError({
            platform: input.platform,
            canonicalAgentName,
            agentNames,
        });
    }
}
//# sourceMappingURL=family-gate.js.map