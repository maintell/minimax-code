import path from 'node:path';
import { pluginAgentKey } from '@mavis/harness';
/** Child Sessions (subagents, verifiers) rarely nest deeper; the cap bounds lookups. */
const MAX_LINEAGE_DEPTH = 8;
/**
 * Resolves every registered source for one Session. A failing source is
 * logged and contributes nothing; the others still apply, so one broken
 * lookup never widens access and never removes unrelated grants.
 */
export function createSessionReadableGrantResolver(options) {
    return async (sessionId) => {
        const subject = await loadSubject(options, sessionId);
        const resolved = await Promise.all(options.sources.map(async (source) => {
            try {
                return await source.resolve(subject);
            }
            catch (error) {
                options.logger?.warn?.({
                    session_id: sessionId,
                    grant_kind: source.kind,
                    error: error instanceof Error ? error.message : String(error),
                }, 'permission.session_readable_grant_source_failed');
                return [];
            }
        }));
        return [...new Set(resolved.flat().filter((grant) => grant.length > 0))];
    };
}
async function loadSubject(options, sessionId) {
    const current = await options.loadSession(sessionId);
    return {
        sessionId,
        lineage: await collectLineage(options, sessionId, current),
        ...(current?.agentName ? { agentName: current.agentName } : {}),
        ...(current?.workspaceDir ? { workspaceDir: current.workspaceDir } : {}),
    };
}
/**
 * The lineage every source walks, nearest first. A SideChat's Main conversation is part of it,
 * so attachments, assignment spaces and emergency files all treat Main as the Side's parent.
 *
 * An ancestor whose record is gone still contributes its own id: the paths a Session registered
 * outlive the Session record, so a promoted Side keeps reading what it inherited after Main is
 * deleted. Its own edges can no longer be walked, which only stops the walk there.
 */
async function collectLineage(options, sessionId, current) {
    const lineage = [];
    const seen = new Set();
    const pending = [{ id: sessionId, depth: 0 }];
    for (let index = 0; index < pending.length; index += 1) {
        const next = pending[index];
        if (!next || seen.has(next.id) || next.depth > MAX_LINEAGE_DEPTH)
            continue;
        seen.add(next.id);
        lineage.push(next.id);
        const view = next.id === sessionId ? current : await options.loadSession(next.id);
        for (const ancestor of ancestorSessionIds(view)) {
            if (!seen.has(ancestor))
                pending.push({ id: ancestor, depth: next.depth + 1 });
        }
    }
    return lineage;
}
/** A Session's parents: an ordinary child names one, a SideChat names its Main conversation. */
function ancestorSessionIds(view) {
    if (!view)
        return [];
    return [view.parentSessionId, view.sideChatOrigin?.mainSessionId].filter((id) => typeof id === 'string' && id.length > 0);
}
/**
 * The home the runtime keeps for an Agent inside its private data directory,
 * such as a coordinator's product home. Only Sessions running that Agent read
 * it; its sub-Agents do not inherit it.
 */
export function agentHomeGrantSource(input) {
    return {
        kind: 'agent-home',
        resolve: async ({ agentName }) => (agentName ? input.homeDirectories(agentName) : []),
    };
}
/** The Session's externalized oversized tool results (read back by the Agent). */
export function toolOutputGrantSource(input) {
    return {
        kind: 'tool-outputs',
        resolve: async ({ sessionId }) => {
            const directory = await input.readableDirectory(sessionId);
            return directory ? [directory] : [];
        },
    };
}
/** Compaction tells the Agent to read the full history it replaced. */
export function compactionSnapshotGrantSource(input) {
    return {
        kind: 'compaction-snapshots',
        resolve: async ({ sessionId }) => {
            const directory = await input.inspectSnapshotsDirectory(sessionId);
            return directory ? [directory] : [];
        },
    };
}
/**
 * The Session's working directory when the runtime allocated it inside its
 * own data directory: the per-Session default `sessions/<id>/workspace`, the
 * runtime-wide `workspace` used by cron / IM Sessions, or an Agent's internal
 * `agents/<name>/workspace`. Writes there already follow the working-directory
 * rule; reads were refused as private data.
 *
 * Only these runtime-allocated shapes qualify. A user project that happens to
 * point elsewhere inside the data directory (e.g. `v2/`) is not granted.
 */
export function runtimeWorkspaceGrantSource(input) {
    return {
        kind: 'session-workspace',
        resolve: async ({ workspaceDir }) => workspaceDir &&
            isRuntimeAllocatedWorkspace(workspaceDir, input.dataDir(), input.platform ?? process.platform)
            ? [workspaceDir]
            : [],
    };
}
/**
 * Attachments and generated media registered by this Session or a parent
 * Session (a subagent receives its parent's attachment paths in its task).
 * Exact files only: the asset store is shared by every Session.
 */
export function sessionAttachmentGrantSource(input) {
    return {
        kind: 'session-attachments',
        resolve: ({ lineage }) => input.listSessionReadablePaths(lineage),
    };
}
/**
 * A task Bunny assigned works in, or is told to read, its space directory
 * under the private data directory (`bunny/spaces/<id>`). The space comes from
 * the trusted assignment record, never from the path itself. A subagent of
 * the task inherits it through its lineage. Only directories inside this
 * profile's spaces root qualify; the engine still rejects symlinked grants.
 */
export function assignmentSpaceGrantSource(input) {
    return {
        kind: 'assignment-space',
        resolve: async ({ lineage, workspaceDir }) => {
            let space;
            for (const sessionId of lineage) {
                space = await input.spaceDirectory(sessionId);
                if (space)
                    break;
            }
            if (!space)
                return [];
            const root = input.spacesRoot();
            const platform = input.platform ?? process.platform;
            return [space, ...(workspaceDir ? [workspaceDir] : [])].filter((directory) => relativeSegments(directory, root, platform) !== undefined);
        },
    };
}
/**
 * The files an emergency rebuild of Bunny's main conversation moved content
 * into (emergency rebuild spec 4.5): Bunny reads them, and so does a task
 * Bunny assigned once Bunny hands it a path. The conversation comes from the
 * Session itself or from the trusted assignment record, never from the path;
 * a subagent of the task inherits it through its lineage.
 */
export function emergencyFilesGrantSource(input) {
    return {
        kind: 'bunny-emergency-files',
        resolve: async ({ lineage }) => {
            for (const sessionId of lineage) {
                const conversation = await input.conversationOf(sessionId);
                if (!conversation)
                    continue;
                const directory = await input.readableDirectory(conversation);
                return directory ? [directory] : [];
            }
            return [];
        },
    };
}
/**
 * The directory of every Plugin Skill in the capability view the Session's
 * running Turns captured. The Skill tool hands the Agent its SKILL.md location,
 * which for an official or local Plugin lies inside the private data directory
 * (`v2/plugin-cache/official/<digest>/skills/<skill>`), and the Skill tells
 * the Agent to read the files next to it (MCT-202611-EF8GPZ1N: `references/`).
 *
 * Scope: that view holds the Skills of every Plugin enabled when the Turn
 * started, not only the ones the Agent loaded, and the Skill tool's per-Agent
 * selection is not applied. A Skill may be loaded in one Turn and its files
 * read in a later one (the ticket's second Turn did exactly that), so the
 * grant cannot depend on a load in the current Turn. What stays private:
 * Plugins not in the view (disabled or uninstalled), the rest of the cache
 * outside a Skill directory, a Skill directory reached through a symlink, and
 * every other runtime file. A Session with no running Turn gets nothing.
 */
export function pluginSkillGrantSource(input) {
    return {
        kind: 'plugin-skills',
        resolve: async ({ sessionId }) => input
            .capturedSkills(sessionId)
            .flatMap(({ location }) => (location ? [path.dirname(location)] : [])),
    };
}
/**
 * The package root of the Plugin Agent a Task Session runs. The Agent's prompt
 * names files in its package through `${PLUGIN_ROOT}`, which the runtime
 * expands to that root inside the private data directory
 * (`v2/plugin-cache/official/<digest>`).
 *
 * The identity comes from the Session's frozen definition, never from the
 * path; the root comes from the capability view its running Turn captured,
 * matched by scoped name and package digest. A Plugin updated since the Task
 * froze (another digest) grants nothing, nor does any other Session: only the
 * Session running the Agent, not its parents or children.
 */
export function pluginAgentPackageGrantSource(input) {
    return {
        kind: 'plugin-agent-package',
        resolve: async ({ sessionId }) => {
            const agents = input.capturedAgents(sessionId);
            // Ordinary Sessions skip the definition read while no Plugin Agent is enabled.
            if (agents.length === 0)
                return [];
            const identity = await input.pluginAgentOf(sessionId);
            if (!identity)
                return [];
            const name = pluginAgentKey(identity.scopedName);
            return agents
                .filter((agent) => pluginAgentKey(agent.scopedName) === name &&
                agent.packageDigest === identity.packageDigest)
                .map((agent) => agent.pluginRoot);
        },
    };
}
function isRuntimeAllocatedWorkspace(workspaceDir, dataDir, platform = process.platform) {
    const parts = relativeSegments(workspaceDir, dataDir, platform);
    if (!parts)
        return false;
    const shape = parts.map((part) => (platform === 'win32' ? part.toLowerCase() : part));
    if (shape.length === 1)
        return shape[0] === 'workspace';
    return (shape.length === 3 &&
        (shape[0] === 'sessions' || shape[0] === 'agents') &&
        shape[2] === 'workspace');
}
/** Segments of `target` strictly below `root`, or `undefined` when it is not below it. */
function relativeSegments(target, root, platform) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    if (!pathApi.isAbsolute(target) || !pathApi.isAbsolute(root))
        return undefined;
    const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
    if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative))
        return undefined;
    return relative.split(pathApi.sep);
}
//# sourceMappingURL=session-readable-grants.js.map