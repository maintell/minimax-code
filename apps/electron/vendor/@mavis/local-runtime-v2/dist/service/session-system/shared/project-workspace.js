import { normalizeAbsolutePath } from './path-normalization.js';
import { isAgentInternalDefaultWorkspaceDir, isSessionDefaultWorkspaceDir, } from './workspace.js';
/**
 * Classify whether a Session belongs to the default Project.
 *
 * An explicit run location always wins over default-workspace compatibility;
 * this preserves the Project selected by a worktree Session even when an
 * older record carries a stale default flag.
 */
export function isDefaultProjectWorkspace(input) {
    if (input.explicitIsDefaultWorkspace === false)
        return false;
    if (hasWorkspaceProjectRunLocation(input.runLocation))
        return false;
    if (input.implicitDefaultWorkspace === true)
        return true;
    if (input.explicitIsDefaultWorkspace === true)
        return true;
    const workspaceDir = normalizeAbsolutePath(input.workspaceDir);
    if (!workspaceDir)
        return true;
    return isKnownDefaultProjectWorkspace(input, workspaceDir);
}
function isKnownDefaultProjectWorkspace(input, workspaceDir) {
    return (matchesDefaultWorkspace(workspaceDir, input.defaultWorkspaceDir) ||
        matchesAgentInternalWorkspace(input, workspaceDir) ||
        matchesDefaultWorkspace(workspaceDir, input.sessionDefaultWorkspaceDir) ||
        isSessionDefaultWorkspaceDir(workspaceDir, input.sessionId));
}
function matchesDefaultWorkspace(workspaceDir, candidate) {
    return workspaceDir === normalizeAbsolutePath(candidate);
}
function matchesAgentInternalWorkspace(input, workspaceDir) {
    const agentName = input.agentName;
    return (agentName !== undefined &&
        isAgentInternalDefaultWorkspaceDir(workspaceDir, input.agentInternalWorkspaceDir, agentName));
}
function hasWorkspaceProjectRunLocation(runLocation) {
    return runLocation !== undefined;
}
/**
 * Recover daemon-era Sessions that reused another default Session's runtime-owned workspace.
 * Persisted false values are not authoritative for legacy-opencode rows because the old source
 * schema did not store this provenance.
 */
export function deriveLegacyDefaultProjectSessionIds(input) {
    const existingById = new Map(input.existing.map((session) => [session.sessionId, session]));
    const defaultWorkspaces = new Set(input.existing.flatMap((session) => session.isDefaultWorkspace === true && session.runLocation === undefined
        ? normalizedWorkspace(session.workspaceDir)
        : []));
    const eligibleWorkspaceById = new Map();
    const defaults = new Set();
    input.sources.forEach((source) => {
        const existing = existingById.get(source.sessionId);
        if (existing?.runLocation !== undefined)
            return;
        const workspaceDir = existing?.workspaceDir || source.workspaceDir || input.defaultWorkspaceDir;
        const workspace = normalizeAbsolutePath(workspaceDir);
        if (workspace)
            eligibleWorkspaceById.set(source.sessionId, workspace);
        const classified = isDefaultProjectWorkspace({
            sessionId: source.sessionId,
            workspaceDir,
            explicitIsDefaultWorkspace: source.isDefaultWorkspace === true || existing?.isDefaultWorkspace === true
                ? true
                : undefined,
            defaultWorkspaceDir: input.defaultWorkspaceDir,
        });
        if (!classified)
            return;
        defaults.add(source.sessionId);
        if (workspace)
            defaultWorkspaces.add(workspace);
    });
    eligibleWorkspaceById.forEach((workspace, sessionId) => {
        if (defaultWorkspaces.has(workspace))
            defaults.add(sessionId);
    });
    return defaults;
}
function normalizedWorkspace(workspaceDir) {
    const normalized = normalizeAbsolutePath(workspaceDir);
    return normalized ? [normalized] : [];
}
//# sourceMappingURL=project-workspace.js.map