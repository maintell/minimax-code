import { AgentConfigError } from '../storage/canonical-agent-config.js';
import { isHarnessAgent } from '../domain/names.js';
export async function materializeLegacyCustomAgentRows(input) {
    if (!input.repository.materializeLegacyCustomAgent) {
        return { materialized: 0, alreadyCanonical: 0, notLegacy: 0, invalid: 0 };
    }
    const metas = (input.repository.listLegacyCustomAgents
        ? await input.repository.listLegacyCustomAgents()
        : await input.repository.list()).filter((meta) => !input.isBuiltin(meta) && !isHarnessAgent(meta));
    const result = { materialized: 0, alreadyCanonical: 0, notLegacy: 0, invalid: 0 };
    let canonicalIdentityReconciled = 0;
    let failed = 0;
    for (const meta of metas) {
        const attempt = await materializeLegacyCustomAgentAttempt(input.repository, input.report, meta.name);
        if (typeof attempt === 'string') {
            result.invalid += Number(attempt === 'invalid');
            failed += Number(attempt === 'failed');
            continue;
        }
        switch (attempt.outcome) {
            case 'materialized':
                result.materialized += 1;
                break;
            case 'canonical_identity_reconciled':
                canonicalIdentityReconciled += 1;
                break;
            case 'already_canonical':
                result.alreadyCanonical += 1;
                break;
            case 'not_legacy':
                result.notLegacy += 1;
                break;
        }
    }
    await input.repository.reconcileCanonicalCustomAgents?.();
    const receipt = await completeLegacyCustomIdentityReconciliation(input.repository, result.invalid, failed);
    emitLegacyCustomMaterialization(input.report, {
        kind: 'summary',
        materialized: result.materialized,
        canonicalIdentityReconciled,
        alreadyCanonical: result.alreadyCanonical,
        notLegacy: result.notLegacy,
        invalid: result.invalid,
        failed: failed + receipt.failed,
        receiptCompleted: receipt.completed,
    });
    return result;
}
async function materializeLegacyCustomAgentAttempt(repository, report, name) {
    try {
        if (!repository.materializeLegacyCustomAgent) {
            return legacyMaterializationFallback('not-legacy');
        }
        const materialization = repository.materializeLegacyCustomAgentForStartup
            ? await repository.materializeLegacyCustomAgentForStartup(name)
            : legacyMaterializationFallback(await repository.materializeLegacyCustomAgent(name));
        emitLegacyCustomMaterialization(report, { kind: 'agent', agentName: name, ...materialization });
        return materialization;
    }
    catch (error) {
        if (!isPerAgentConfigFailure(error))
            throw error;
        return reportLegacyCustomMaterialization(report, name, error);
    }
}
async function completeLegacyCustomIdentityReconciliation(repository, invalid, failed) {
    if (invalid > 0 || failed > 0 || !repository.completeLegacyCustomIdentityReconciliation) {
        return { completed: false, failed: 0 };
    }
    await repository.completeLegacyCustomIdentityReconciliation();
    return { completed: true, failed: 0 };
}
function emitLegacyCustomMaterialization(report, event) {
    try {
        report?.(event);
    }
    catch {
        // Observability must never change startup recovery.
    }
}
function reportLegacyCustomMaterialization(report, agentName, error) {
    const unreadable = isPerAgentReadAccessError(error);
    const outcome = isExistingInvalidCanonicalConfig(error) || unreadable ? 'invalid' : 'failed';
    emitLegacyCustomMaterialization(report, {
        kind: 'agent',
        agentName,
        outcome,
        errorCode: materializationErrorCode(error, unreadable),
        identitySource: 'none',
        recoveredFields: [],
        stage: 'materialization',
        reason: unreadable ? 'unreadable' : materializationFailureReason(error),
    });
    return outcome;
}
function materializationErrorCode(error, unreadable) {
    if (error instanceof AgentConfigError)
        return error.code;
    if (unreadable)
        return 'AGENT_CONFIG_INVALID';
    return 'unknown';
}
function legacyMaterializationFallback(outcome) {
    switch (outcome) {
        case 'materialized':
            return { outcome: 'materialized', identitySource: 'none', recoveredFields: [] };
        case 'already-canonical':
            return { outcome: 'already_canonical', identitySource: 'none', recoveredFields: [] };
        case 'not-legacy':
            return { outcome: 'not_legacy', identitySource: 'none', recoveredFields: [] };
    }
}
function isExistingInvalidCanonicalConfig(error) {
    return (error instanceof AgentConfigError &&
        (error.code === 'AGENT_CONFIG_NOT_FOUND' ||
            error.code === 'AGENT_CONFIG_INVALID' ||
            error.code === 'AGENT_CONFIG_AVATAR_INVALID' ||
            error.code === 'AGENT_CONFIG_UNSTABLE'));
}
function isPerAgentConfigFailure(error) {
    return isExistingInvalidCanonicalConfig(error) || isPerAgentReadAccessError(error);
}
function isPerAgentReadAccessError(error) {
    const code = error?.code;
    return code === 'EACCES' || code === 'EPERM';
}
function materializationFailureReason(error) {
    if (!(error instanceof AgentConfigError))
        return 'invalid';
    return error.code === 'AGENT_CONFIG_NOT_FOUND' ? 'missing' : 'invalid';
}
//# sourceMappingURL=legacy-custom-materialization.js.map