import path from 'node:path';
import { isAssignedByBunny } from '../../session-system/index.js';
import { createProtectedRootDecisions } from '../../permission/index.js';
import { PERMISSION_UNKNOWN_OWNER } from '../../coordinator-text/index.js';
import { assignmentProtectedRoots, isProtectedSpacePath, } from './protected-paths.js';
import { isDefaultWorkspaceAssignment, isProjectApprovedAssignmentTool, } from './tool-input.js';
/**
 * Bunny's permission decisions on top of the ordinary MCode policy.
 *
 * - Bunny's runtime protected roots apply to every Session first
 *   ({@link assignmentProtectedRoots}).
 * - Assignment-aware decisions apply to coordinator-owned Sessions only: Bunny,
 *   the task Sessions it assigns and the subagent Sessions under either, at any
 *   depth. Bunny assigning work to its own space directory never asks; these
 *   Sessions use Bunny's permission mode, and `follow` keeps the global mode.
 *   Every other Session keeps the ordinary policy untouched, and nothing here
 *   reads the Bunny store for it.
 */
export function createAssignmentPermissionDecisions(readers, decisions, bunnyPermissionMode, roots) {
    return createProtectedRootDecisions({
        sessions: readers.sessions,
        roots: assignmentProtectedRoots(roots, readers.ownership.roster),
    }, createOwnedAssignmentDecisions(readers, decisions, bunnyPermissionMode));
}
function createOwnedAssignmentDecisions(readers, decisions, bunnyPermissionMode) {
    return {
        check: async (request) => {
            const session = await readers.sessions.get(request.sessionId);
            const owner = session ? await readOwner(readers, session) : { owned: false };
            if (!owner.owned && !owner.unknown)
                return decisions.check(request);
            const owned = await readOwnership(readers, owner.owned ? session : undefined, request, bunnyPermissionMode);
            const unknownOwner = owner.unknown === true || owned.unknownOwner;
            const decision = await decisions.check(owned.input);
            // Bunny's own dispatch is never blocked; every other call keeps the
            // ordinary policy's answer untouched.
            const dispatch = await dispatchAllowance(request, { ...owned, unknownOwner }, decision, readers.localPermissionMode);
            return ownedDecision(dispatch ?? decision, { ...owned, unknownOwner });
        },
    };
}
/**
 * A deny that stays fail-closed: the hosted project resolver could not name a
 * project. That is a system failure, not a decision about dispatching, so it is
 * kept (Bunny, 11-10: 解析失败不是用户意志). A deny it built from a rule the user
 * configured — the project rule, a tool rule — is overridden.
 *
 * ⚠️ `assignmentProjectError` can also return a thrown `error.message`, which is
 * not enumerable here and is therefore overridden. Dispatch then reaches the
 * assignment service, which fails on the same unresolvable project.
 */
const UNRESOLVED_PROJECT_DENIES = new Set([
    'Assignment project resolver is unavailable',
    'Assignment project could not be resolved',
    'Invalid assignment project',
]);
/**
 * Bunny's own dispatch tools are never blocked, in any permission mode.
 *
 * The hosted project-approval rule (`checkAssignmentPermission`) exempts only
 * `bypassPermissions` / `off`, so every dispatch re-prompted even though the work
 * stays on the user's own machine, in their own project — and the approval card
 * rendered the whole task brief into the conversation. Sean's decision (11-10
 * 16:50): assignment 完全不卡, including a deny the user configured for a project.
 * Users can therefore no longer stop Bunny from dispatching at the permission
 * layer.
 *
 * Assignment tools are Bunny-only (`requireBunny`), and `assignment_send` is
 * already limited to Bunny's own assignments by the assignment service, so this
 * widens nothing the main-line mavis agent can reach.
 *
 * The mode is read through an injected reader — `owned.input.permissionMode` is
 * absent whenever Bunny follows the global mode — and only names the decision
 * and keeps a failed read fail-closed. Everything else stays on the ordinary
 * policy: a Session that is not coordinator-owned never reaches this branch, an
 * unknown owner keeps asking, and Side Session and Plugin Hook approvals are
 * resolved outside these decisions. Outbound sends have no dedicated approval
 * gate any more: they follow the ordinary permission policy and the Agent
 * prompt's own constraints.
 */
async function dispatchAllowance(request, owned, decision, localPermissionMode) {
    if (owned.unknownOwner || !isProjectApprovedAssignmentTool(request.toolName))
        return undefined;
    if (decision.behavior === 'deny' && UNRESOLVED_PROJECT_DENIES.has(decision.reason))
        return undefined;
    const mode = owned.input.permissionMode ?? (await readMode(localPermissionMode));
    return mode === undefined ? undefined : { behavior: 'allow', reason: `Bunny dispatch (${mode})` };
}
/** An unreadable mode keeps the ordinary policy; the user confirms instead. */
async function readMode(read) {
    try {
        return await read();
    }
    catch {
        return undefined;
    }
}
/** The ordinary policy's answer for a coordinator-owned Session, adjusted for its ownership. */
function ownedDecision(decision, owned) {
    if (owned.unknownOwner && decision.behavior === 'allow')
        return {
            behavior: 'ask',
            reason: PERMISSION_UNKNOWN_OWNER,
            ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
        };
    if (owned.defaultAssignment && decision.behavior !== 'deny')
        return { behavior: 'allow', reason: 'Default workspace assignment' };
    // The decision was built for this very call: nothing rewrites an assignment
    // tool's input into a `mavis` command any more, so its plan still matches.
    return decision;
}
/**
 * Whether the Session is coordinator-owned. Only a Session with a parent reads
 * anything (its parent chain, in the shared database); a chain that cannot be
 * read leaves the owner unknown.
 */
async function readOwner({ ownership }, session) {
    try {
        return { owned: (await ownership.owner(session)) !== undefined };
    }
    catch {
        return { owned: false, unknown: true };
    }
}
/**
 * What a decision reads for a coordinator-owned Session from the Bunny store:
 * its task row, whether the call is a default workspace assignment, and Bunny's
 * permission mode. A read that fails leaves the owner unknown; the decision then
 * never falls back to the ordinary policy's auto-approval, the user confirms instead.
 */
async function readOwnership({ sessions, tasks, resolveAssignmentProject }, session, mapped, bunnyPermissionMode) {
    let unknownOwner = false;
    const unless = async (read, fallback) => {
        try {
            return await read();
        }
        catch {
            unknownOwner = true;
            return fallback;
        }
    };
    const assignment = session
        ? await unless(() => tasks.get(session.sessionId), undefined)
        : undefined;
    const defaultAssignment = await unless(() => isDefaultWorkspaceAssignment({ sessions, tasks, resolveProject: resolveAssignmentProject }, mapped.sessionId, mapped.toolName, mapped.toolInput), false);
    const input = session
        ? await unless(() => withBunnyMode(session, assignment, mapped, bunnyPermissionMode), mapped)
        : mapped;
    return { input, defaultAssignment, unknownOwner };
}
/** Coordinator-owned work: trust its own space write target and apply Bunny's permission mode. */
async function withBunnyMode(session, assignment, request, bunnyPermissionMode) {
    let input = request;
    const target = spaceWriteTarget(session, assignment, input);
    if (target)
        input = {
            ...input,
            trustedExactWritePaths: [...(input.trustedExactWritePaths ?? []), target],
        };
    const mode = await bunnyPermissionMode();
    return mode === 'follow' ? input : { ...input, permissionMode: mode };
}
function spaceWriteTarget(session, assignment, input) {
    if (!session.isDefaultWorkspace ||
        !isAssignedByBunny(assignment) ||
        !['write', 'edit'].includes(input.toolName))
        return undefined;
    const target = input.toolInput.path ?? input.toolInput.file_path;
    if (typeof target !== 'string')
        return undefined;
    const resolved = path.resolve(session.workspaceDir, target);
    const relative = path.relative(session.workspaceDir, resolved);
    return withinDirectory(relative) && !isProtectedSpacePath(relative) ? resolved : undefined;
}
function withinDirectory(relative) {
    // The filesystem policy still checks canonical runtime ownership and symlinks.
    return Boolean(relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
}
//# sourceMappingURL=decisions.js.map