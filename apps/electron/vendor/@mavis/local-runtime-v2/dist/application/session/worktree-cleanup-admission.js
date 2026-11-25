import { sessionAwaitsWorktreeRestoreInTransaction } from '../../service/session-system/index.js';
const WORKTREE_CLEANED_ADMISSION_REASON = 'policy:worktree:cleaned';
/** A Session whose worktree was cleaned must be restored before it runs again. */
export function createWorktreeCleanedAdmissionPolicy() {
    return {
        applyInTransaction(db, input) {
            return sessionAwaitsWorktreeRestoreInTransaction(db, input.sessionId)
                ? WORKTREE_CLEANED_ADMISSION_REASON
                : undefined;
        },
    };
}
//# sourceMappingURL=worktree-cleanup-admission.js.map