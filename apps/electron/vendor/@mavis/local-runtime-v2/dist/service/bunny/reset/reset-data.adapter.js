import { BUNNY_AGENT_NAME, isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNNY_SETTING_PREFIX, clearBunnyFirstUses, } from '../../../infra/db/bunny-store.js';
import { bunnyMemoryCursors, bunnySettings } from '../../../infra/db/schema/bunny-store.js';
import { restoreBunnyStore } from '../../../infra/db/bunny-store-restore.js';
import { createAgentRoutines, } from '../../cron/index.js';
import { clearMessageSearchIndex, createAssignerTasks, createLibraryReset, isAssignedByBunny, } from '../../session-system/index.js';
import { createMediaDescriptionReset } from '../conversation-search/media-descriptions.js';
/**
 * Every Session Bunny owns: its own roots, the tasks it assigned and the tasks
 * those tasks assigned, the Sessions its routines ran in, and all of their
 * descendants. Reset and feedback both read ownership here.
 */
export async function listBunnyOwnedSessions(db, system) {
    const routines = createAgentRoutines({ db, agentName: BUNNY_AGENT_NAME }).snapshot();
    const runSessionIds = new Set(routines.runs.flatMap((row) => (row.sessionId ? [row.sessionId] : [])));
    const all = await system.repositories.sessions.list({ includeHidden: true });
    const assignments = new Map((await system.repositories.assignmentTasks.list()).map((task) => [
        task.sessionId,
        task.assignment,
    ]));
    const owned = new Set(all
        .filter((session) => isBunnyAgentName(session.agentName) ||
        isAssignedByBunny(assignments.get(session.sessionId)) ||
        runSessionIds.has(session.sessionId))
        .map((session) => session.sessionId));
    for (;;) {
        const before = owned.size;
        for (const session of all) {
            const assigner = assignments.get(session.sessionId)?.assignerSessionId;
            if ((session.parentSessionId && owned.has(session.parentSessionId)) ||
                (assigner && owned.has(assigner)))
                owned.add(session.sessionId);
        }
        if (owned.size === before)
            break;
    }
    return { ...routines, all, assignments, owned };
}
/**
 * The owned Sessions that are Bunny's own conversations: every one outside a delegated
 * task's tree. A task (Bunny's or one its tasks assigned) and its sub-Sessions belong to
 * the work, not to Bunny's conversation.
 */
function bunnyConversationIds(sessions, assignedSessionIds) {
    const work = new Set(assignedSessionIds);
    for (;;) {
        const before = work.size;
        for (const session of sessions)
            if (session.parentSessionId && work.has(session.parentSessionId))
                work.add(session.sessionId);
        if (work.size === before)
            break;
    }
    return new Set(sessions.flatMap((session) => (work.has(session.sessionId) ? [] : [session.sessionId])));
}
/**
 * Capture all Bunny-owned facts before resetting the product, preserving files and history.
 * Each owner backs up, clears and puts back its own rows (routines, the library's spaces and
 * imported files, media descriptions, the search index, the ledger and delivery baseline);
 * this only decides what runs, in which transaction and in which order.
 */
export function createBunnyResetData({ db, bunnyStore }, system, stopSession, extras = {}) {
    const { owners = [] } = extras;
    const bunny = bunnyStore.db;
    const routines = createAgentRoutines({
        db,
        agentName: BUNNY_AGENT_NAME,
        create: extras.restoreRoutine,
        remove: extras.deleteRoutine,
    });
    const library = createLibraryReset(bunny);
    // The tasks Bunny assigned; another assigner's task rows are never touched.
    const bunnyTasks = createAssignerTasks(bunny, BUNNY_AGENT_NAME);
    const mediaDescriptions = createMediaDescriptionReset(bunny);
    let ownedSessionIds = [];
    // Imported files belong to a space, never to a Session.
    let ownedSpaceIds = [];
    return {
        snapshot: async () => {
            const { all, assignments, owned, ...routineRows } = await listBunnyOwnedSessions(db, system);
            const sessions = all.filter((session) => owned.has(session.sessionId));
            ownedSessionIds = sessions.map((session) => session.sessionId);
            const assignedSessionIds = new Set(ownedSessionIds.filter((sessionId) => assignments.has(sessionId)));
            const spaces = system.artifactCatalog.library.summary().spaces;
            ownedSpaceIds = spaces.map((space) => space.id);
            const settings = bunny
                .select()
                .from(bunnySettings)
                .all()
                .filter((row) => row.key.startsWith(BUNNY_SETTING_PREFIX));
            const assetMarks = library.imports(ownedSpaceIds);
            return {
                sessions,
                assignedSessionIds,
                conversationSessionIds: bunnyConversationIds(sessions, assignedSessionIds),
                counts: {
                    tasks: ownedSessionIds.filter((id) => assignments.has(id)).length,
                    spaces: spaces.length,
                    routines: routineRows.routines.filter((row) => row.deletedAtMs === null).length,
                    assets: assetMarks.length,
                },
                data: {
                    spaces,
                    assignments: sessions
                        .filter((session) => assignments.has(session.sessionId))
                        .map((session) => ({
                        sessionId: session.sessionId,
                        assignment: assignments.get(session.sessionId),
                        spaceId: system.artifactCatalog.library.sessionSpace(session.sessionId),
                    })),
                    routines: routineRows.routines,
                    routineSchedules: routineRows.routineSchedules,
                    runs: routineRows.runs,
                    assetMarks,
                    mediaDescriptions: mediaDescriptions.snapshot(),
                    memoryCursors: bunny.select().from(bunnyMemoryCursors).all(),
                    settings,
                    ...Object.fromEntries(owners.map((owner) => [owner.name, owner.snapshot()])),
                },
            };
        },
        history: async (sessionId) => {
            const display = await system.repositories.messages.listAfter(sessionId);
            if (display.status !== 'ok')
                throw new Error(`Could not export complete history: ${sessionId}`);
            const location = await system.historyLocations.inspectSession(sessionId);
            if (!location)
                throw new Error(`Could not locate history: ${sessionId}`);
            const files = await exportHistoryFiles(location.paths);
            return {
                display: display.messages,
                canonical: await system.canonicalHistory.read(sessionId),
                files,
            };
        },
        stopSession,
        archiveSession: async (sessionId) => {
            await system.repositories.sessions.update(sessionId, {
                archived: true,
                visibility: 'hidden',
                purpose: 'bunny-initialized',
            });
        },
        deleteRoutines: async () => {
            await routines.delete(routines.liveIds());
        },
        backupStore: (destinationPath) => bunnyStore.backup(destinationPath),
        clear: () => {
            // Two separate transactions, never nested, each committing on its own: the Bunny store
            // first (Bunny's tasks, memory cursors, first uses, the library, the owners' rows, media
            // descriptions), then the shared database (Bunny's routines and the search index).
            bunny.transaction((tx) => {
                // Deleting the task rows is what unlinks the task Sessions from Bunny: they stay
                // unarchived and read as Sessions an ordinary Agent created. Events cascade.
                bunnyTasks.clear(tx);
                tx.delete(bunnyMemoryCursors).run();
                library.clear(tx, ownedSpaceIds);
                // The other settings (permission mode, task model) survive a reset; introductions start over.
                clearBunnyFirstUses(tx);
                for (const owner of owners)
                    owner.clear(tx);
                mediaDescriptions.clear(tx);
            });
            system.repositories.assignmentTasks.reloadAssigners();
            db.transaction((tx) => {
                routines.clear(tx);
                clearMessageSearchIndex(tx);
            });
        },
        restore: async (backup) => {
            const data = backup.data;
            const nowMs = Date.now();
            // Bunny store first, then the shared database; each commits on its own like clear().
            restoreBunnyStore(bunny, backup.storePath);
            bunny.transaction((tx) => {
                library.restoreImports(tx, data.assetMarks);
                mediaDescriptions.restore(tx, data.mediaDescriptions);
            });
            system.repositories.assignmentTasks.reloadAssigners();
            await restoreSessionStates(system, backup.sessions);
            return routines.restore(data, nowMs);
        },
    };
}
/**
 * Puts back each backed-up Session's archive state, visibility and purpose, which the reset
 * changed when it archived the Session.
 */
async function restoreSessionStates(system, sessions) {
    for (const session of sessions) {
        await system.repositories.sessions.update(session.sessionId, {
            archived: session.archived === true,
            visibility: session.visibility ?? 'visible',
            // An own key with no value clears the purpose reset wrote.
            purpose: session.purpose,
        });
    }
}
async function exportHistoryFiles(paths) {
    let entries = [];
    try {
        entries = await readdir(paths.snapshots, { withFileTypes: true });
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    let active;
    try {
        active = await readFile(paths.messages, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const snapshots = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async (entry) => ({
        name: entry.name,
        content: await readFile(join(paths.snapshots, entry.name), 'utf8'),
    })));
    return { active, snapshots };
}
//# sourceMappingURL=reset-data.adapter.js.map