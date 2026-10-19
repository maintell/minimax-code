import { DEFAULT_PROJECT_KEY, requireWorkspaceProjectDir, } from '../../service/session-system/index.js';
const DEFAULT_PROJECT_ORDER_INDEX = 2_147_483_647;
export function toProjectReference(reference) {
    let projectKey;
    if ('projectKey' in reference)
        projectKey = reference.projectKey;
    else if ('key' in reference)
        projectKey = reference.key;
    return {
        ...(reference.projectId !== undefined ? { projectId: reference.projectId } : {}),
        ...(projectKey !== undefined ? { projectKey } : {}),
        ...(reference.workspaceDir !== undefined ? { workspaceDir: reference.workspaceDir } : {}),
    };
}
export function toProjectDetail(project, sessionCount) {
    const defaultProject = project.projectKind === 'default';
    const workspaceDir = defaultProject ? undefined : requireWorkspaceProjectDir(project);
    return {
        key: defaultProject ? DEFAULT_PROJECT_KEY : `workspace:${workspaceDir}`,
        projectId: project.projectId,
        ...(workspaceDir ? { workspaceDir } : {}),
        displayName: defaultProject ? 'No project selected' : displayName(workspaceDir ?? ''),
        archived: false,
        latestActivityAt: project.latestActivityAtMs,
        sessionCount,
        state: {
            pinned: project.pinned,
            hidden: project.hidden,
            ...(project.orderIndex !== DEFAULT_PROJECT_ORDER_INDEX
                ? { orderIndex: project.orderIndex }
                : {}),
            ...(project.recentAtMs !== null ? { recentAt: project.recentAtMs } : {}),
        },
        extraDataJson: project.extraDataJson,
        createdAt: project.createdAtMs,
        updatedAt: project.updatedAtMs,
    };
}
function displayName(workspaceDir) {
    return (workspaceDir
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? workspaceDir);
}
//# sourceMappingURL=wire.js.map