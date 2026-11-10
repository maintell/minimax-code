import { and, eq, exists, not } from 'drizzle-orm';
import { readPreferenceValue, upsertPreferenceValue } from '../../../infra/db/preference-values.js';
import { projects as p } from '../../../infra/db/schema/projects.js';
import { sessions as s } from '../../../infra/db/schema/sessions.js';
import { listInternalDefaultRootIds } from '../shared/internal-default-roots.js';
import { recordProjectRemoval } from '../shared/project-removal.js';
import { eligible } from './sidebar/predicate.js';
/**
 * Completion marker of the one-time archived-project sidebar baseline. Its
 * presence alone means "already applied"; the payload is kept for diagnosis.
 */
const ARCHIVED_PROJECT_SIDEBAR_BASELINE_KEY = 'archived-project-sidebar-baseline';
/**
 * Older builds dropped a workspace project from the sidebar once all of its
 * conversations were archived; the sidebar now keeps it until it is removed.
 * Run once per database, this records those already-vanished projects as
 * removed so an upgrade does not resurface them. Pinned projects are left
 * untouched. A failure leaves the marker unset, so the next startup retries.
 */
export async function applyArchivedProjectSidebarBaseline(input) {
    try {
        if (readPreferenceValue(input.db, ARCHIVED_PROJECT_SIDEBAR_BASELINE_KEY) !== undefined) {
            return report(input, { applied: false, hiddenProjectIds: [] });
        }
        const pinnedProjectIds = new Set(await input.pinnedProjectIds());
        const summary = input.db.transaction((tx) => {
            if (readPreferenceValue(tx, ARCHIVED_PROJECT_SIDEBAR_BASELINE_KEY) !== undefined) {
                return { applied: false, hiddenProjectIds: [] };
            }
            const nowMs = input.nowMs();
            const internalRootIds = listInternalDefaultRootIds(tx, input.agentInternalWorkspaceDir);
            const vanished = tx
                .select()
                .from(p)
                .where(and(eq(p.projectKind, 'workspace'), eq(p.hidden, 0), eq(p.pinned, 0), hasSidebarSession(tx, internalRootIds, true), not(hasSidebarSession(tx, internalRootIds, false))))
                .all()
                .filter((project) => !pinnedProjectIds.has(project.projectId));
            for (const project of vanished) {
                recordProjectRemoval(tx, project, nowMs);
                tx.update(p)
                    .set({ hidden: 1, updatedAtMs: nowMs })
                    .where(eq(p.projectId, project.projectId))
                    .run();
            }
            const hiddenProjectIds = vanished.map((project) => project.projectId);
            upsertPreferenceValue(tx, ARCHIVED_PROJECT_SIDEBAR_BASELINE_KEY, {
                completedAtMs: nowMs,
                hiddenProjectIds,
            });
            return { applied: true, hiddenProjectIds };
        });
        return report(input, summary);
    }
    catch (error) {
        input.diagnostics?.reportFailure(error instanceof Error ? error.message : String(error));
        return { applied: false, hiddenProjectIds: [] };
    }
}
function report(input, summary) {
    input.diagnostics?.reportSummary(summary);
    return summary;
}
/** Same eligibility as the sidebar project list, optionally counting archived sessions. */
function hasSidebarSession(db, internalRootIds, includeArchived) {
    return exists(db
        .select({ id: s.sessionId })
        .from(s)
        .where(and(eq(s.projectId, p.projectId), eligible(false, internalRootIds, includeArchived)))
        .limit(1));
}
//# sourceMappingURL=archived-project-sidebar-baseline.js.map