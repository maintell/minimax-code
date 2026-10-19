import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
export async function assertSameWorkspaceBinding(session, workspaceDir) {
    const current = session.status === 'skipped_timeout'
        ? path.resolve(workspaceDir)
        : await realpath(workspaceDir);
    if (path.resolve(current) !== path.resolve(session.workspaceRealPath)) {
        throw new Error('workspace_session_binding_mismatch');
    }
}
export function toSkippedResult(scan) {
    return {
        status: 'skipped_limit',
        reason: scan.reason,
        limit: scan.limit,
        observed: scan.observed,
    };
}
export function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
export function normalizeWorkspaceIndexingErrorCode(error) {
    if (error &&
        typeof error === 'object' &&
        typeof error.code === 'string') {
        return error.code;
    }
    return error instanceof Error && error.name ? error.name : 'workspace_remote_enqueue_failed';
}
//# sourceMappingURL=service-helpers.js.map