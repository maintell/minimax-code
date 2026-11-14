import { logger } from '@mavis/shared/local-runtime-logging';
export function reportAgentCutover(event) {
    const fields = {
        migration_id: event.migrationId,
        ...(event.collisionMigrationId ? { collision_migration_id: event.collisionMigrationId } : {}),
        phase: event.phase,
        status: event.status,
        source_kind: event.sourceKind,
        target_kind: event.targetKind,
        conflict_count: event.conflictCount,
        mapping: event.mapping,
        reference_counts: event.referenceCounts,
        source_row_count: event.sourceRowCount,
        imported_row_count: event.importedRowCount,
        recovered_timestamp_count: event.recoveredTimestampCount,
        recoveries: event.recoveries,
        target_row_count: event.targetRowCount,
        duration_ms: event.durationMs,
        ...(event.failureStep ? { failure_step: event.failureStep } : {}),
        ...(event.secondaryFailureStep ? { secondary_failure_step: event.secondaryFailureStep } : {}),
        ...(event.skipCode ? { skip_code: event.skipCode } : {}),
        ...(event.errorCode ? { error_code: event.errorCode } : {}),
    };
    if (event.status === 'failed') {
        logger.error(fields, 'V2 Agent cutover failed');
        return;
    }
    logger.info(fields, 'V2 Agent cutover');
}
/**
 * Startup-only detached-identity record. The fields are deliberately bounded:
 * no Persona, Prompt, Memory, credential, avatar URL, or error text reaches
 * runtime logs.
 */
export function reportAgentIdentityDetach(event) {
    const fields = {
        event: 'legacy_builtin_identity_detach',
        agent_name: event.agentName,
        phase: event.phase,
        outcome: event.outcome,
        ...(event.asset ? { asset: event.asset } : {}),
        ...(event.action ? { action: event.action } : {}),
        ...(event.avatarDecision ? { avatar_decision: event.avatarDecision } : {}),
    };
    if (event.outcome === 'failed') {
        logger.error(fields, 'V2 Agent identity detach failed');
        return;
    }
    logger.info(fields, 'V2 Agent identity detach');
}
export function reportLegacyCustomAgentMaterialization(event) {
    if (event.kind === 'summary') {
        reportLegacyCustomAgentMaterializationSummary(event);
        return;
    }
    reportLegacyCustomAgentMaterializationAgent(event);
}
function reportLegacyCustomAgentMaterializationSummary(event) {
    const fields = {
        event: 'legacy_custom_agent_materialization_summary',
        materialized: event.materialized,
        canonical_identity_reconciled: event.canonicalIdentityReconciled,
        already_canonical: event.alreadyCanonical,
        not_legacy: event.notLegacy,
        invalid: event.invalid,
        failed: event.failed,
        receipt_completed: event.receiptCompleted,
    };
    if (event.invalid > 0 || event.failed > 0) {
        logger.warn(fields, 'V2 legacy Custom Agent materialization incomplete');
        return;
    }
    logger.info(fields, 'V2 legacy Custom Agent materialization summary');
}
function reportLegacyCustomAgentMaterializationAgent(event) {
    const deferred = event.outcome === 'invalid' || event.outcome === 'failed';
    const fields = {
        event: deferred
            ? 'legacy_custom_agent_materialization_deferred'
            : 'legacy_custom_agent_materialization',
        agent_name: event.agentName,
        outcome: event.outcome,
        identity_source: event.identitySource,
        recovered_fields: event.recoveredFields,
        ...(event.errorCode ? { error_code: event.errorCode } : {}),
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
    };
    if (deferred) {
        logger.warn(fields, 'V2 legacy Custom Agent materialization deferred');
        return;
    }
    logger.info(fields, 'V2 legacy Custom Agent materialization');
}
//# sourceMappingURL=runtime-agent-startup-reporting.js.map