import { compareHandoffPaths } from './admission/recommendation.js';
import { SessionHandoffError } from './errors.js';
export async function resolveResultTransferTicket(input) {
    const retained = input.materialization.workspaceTransfer;
    if (retained) {
        if (retained.expiresAt <= input.nowMs) {
            throw new SessionHandoffError('HANDOFF_EXPIRED', 'Result download transfer has expired');
        }
        return retained;
    }
    return input.cloud.syncResult({
        cloudSessionId: input.delivery.cloudSessionId,
        resultId: input.delivery.resultId,
        selectedPaths: input.changes.map((change) => change.relativePath),
        sourceDeviceToken: input.source.sourceDeviceToken,
    });
}
export function publishedResultMaterialization(materialization, workspacePath, updatedAtMs) {
    return {
        cloudSessionId: materialization.cloudSessionId,
        resultId: materialization.resultId,
        selection: materialization.selection,
        state: 'published',
        workspacePath,
        createdAtMs: materialization.createdAtMs,
        updatedAtMs,
    };
}
export function resetResultMaterialization(materialization, updatedAtMs) {
    return {
        cloudSessionId: materialization.cloudSessionId,
        resultId: materialization.resultId,
        selection: materialization.selection,
        state: 'selected',
        createdAtMs: materialization.createdAtMs,
        updatedAtMs,
    };
}
export function retryableResultApplyFailure(error) {
    return error instanceof SessionHandoffError ? error.retryable : error instanceof Error;
}
export function retryableResultPublicationFailure(error) {
    if (error instanceof SessionHandoffError)
        return error;
    return new SessionHandoffError('HANDOFF_UNAVAILABLE', error instanceof Error ? error.message : 'Result Workspace publication failed', true);
}
export function requirePublishedWorkspacePath(materialization) {
    if (!materialization.workspacePath) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Published Result Workspace identity is missing');
    }
    return materialization.workspacePath;
}
export function resultMaterializationInProgress(materialization, prepared, updatedAtMs) {
    return {
        ...materialization,
        state: 'materializing',
        workspacePath: prepared.workspacePath,
        workingPath: prepared.workingPath,
        transferPath: prepared.transferPath,
        operationId: prepared.operationId,
        kind: prepared.kind,
        ...(prepared.ownershipToken ? { ownershipToken: prepared.ownershipToken } : {}),
        ...(prepared.fingerprint ? { fingerprint: prepared.fingerprint } : {}),
        updatedAtMs,
    };
}
export function preparedResultWorkspaceFromState(materialization) {
    if (materialization.state !== 'materializing' ||
        !materialization.workspacePath ||
        !materialization.workingPath ||
        !materialization.transferPath ||
        !materialization.operationId ||
        !materialization.kind) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Persisted Result Workspace preparation is incomplete');
    }
    return {
        workspacePath: materialization.workspacePath,
        workingPath: materialization.workingPath,
        transferPath: materialization.transferPath,
        operationId: materialization.operationId,
        kind: materialization.kind,
        ...(materialization.ownershipToken ? { ownershipToken: materialization.ownershipToken } : {}),
        ...(materialization.fingerprint ? { fingerprint: materialization.fingerprint } : {}),
    };
}
export function normalizeResultChanges(changes) {
    const result = new Map();
    for (const change of changes) {
        const relativePath = change.relativePath.trim().replaceAll('\\', '/');
        if (!safeResultPath(relativePath) || !['add', 'modify', 'delete'].includes(change.kind)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result selection contains an invalid change');
        }
        const existing = result.get(relativePath);
        if (existing && existing.kind !== change.kind) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result selection contains conflicting changes');
        }
        result.set(relativePath, { relativePath, kind: change.kind });
    }
    if (result.size === 0) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result selection is empty');
    }
    return [...result.values()].sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath));
}
function safeResultPath(path) {
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path))
        return false;
    const segments = path.replaceAll('\\', '/').split('/');
    return !segments.some((segment) => {
        const lower = segment.toLowerCase();
        return segment === '' || segment === '.' || segment === '..' || lower === '.git';
    });
}
export async function discardResultWorkspace(resultWorkspace, prepared, primaryError) {
    try {
        await resultWorkspace.discard(prepared);
    }
    catch (cleanupError) {
        throw new AggregateError([primaryError, cleanupError], 'Result Workspace materialization and cleanup failed');
    }
}
export async function discardPublishedResultBestEffort(resultWorkspace, prepared) {
    try {
        await resultWorkspace.discard({ ...prepared, published: true });
    }
    catch {
        // A published record is authoritative; temporary transfer cleanup is best-effort.
    }
}
//# sourceMappingURL=result-resume.js.map