import { and, eq, sql } from 'drizzle-orm';
import { TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER } from '@mavis/conversation-contract';
import { sessions as s } from '../../../infra/db/schema/sessions.js';
import { isAgentInternalDefaultWorkspaceDir } from './workspace.js';
/** 侧栏与归档共用内部默认主会话识别，在计数与分页前排除。 */
export function listInternalDefaultRootIds(db, agentInternalWorkspaceDir) {
    // Inspect only root identity metadata, before SQL counting/pagination. Older
    // Agent roots may lack isDefaultWorkspace, so compare against runtime-owned
    // paths using the same canonical/legacy recognition as workspace assignment.
    const roots = db
        .select({
        id: s.sessionId,
        agentName: s.agentName,
        workspaceDir: s.workspaceDir,
        defaultWorkspace: s.isDefaultWorkspace,
        purpose: s.purpose,
        runLocation: sql `json_extract(${s.extraDataJson}, '$.runLocation')`,
    })
        .from(s)
        .where(and(eq(s.sessionType, 'root'), eq(s.sessionKind, 'conversation')))
        .all();
    const internalRootIds = roots.flatMap((root) => {
        const trustedIm = root.purpose === TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER ||
            root.purpose?.endsWith(`\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`);
        if (trustedIm || root.runLocation != null)
            return [];
        const internal = root.defaultWorkspace === 1 ||
            (!!root.agentName &&
                !!agentInternalWorkspaceDir &&
                isAgentInternalDefaultWorkspaceDir(root.workspaceDir ?? undefined, agentInternalWorkspaceDir(root.agentName), root.agentName));
        return internal ? [root.id] : [];
    });
    return internalRootIds;
}
//# sourceMappingURL=internal-default-roots.js.map