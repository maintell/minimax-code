import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { BUNNY_INITIALIZED_AT_KEY, writeBunnySetting, } from '../../../infra/db/bunny-store.js';
import { bunnyMemoryCursors } from '../../../infra/db/schema/bunny-store.js';
import { sessions } from '../../../infra/db/schema/sessions.js';
import { createAgentRoutines } from '../../cron/index.js';
import { createAgentQuestionnaires } from '../../questionnaire/index.js';
import { assertSpaceId, createAssignerTasks, createLibraryReset, scanSpaceDirectories, SPACE_CONTEXT_FILE, SPACE_META_FILE, } from '../../session-system/index.js';
export class BunnyDebugError extends Error {
    status;
    details;
    constructor(message, status, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
/**
 * Files Bunny generates inside a space directory; everything else, artifacts/ among it,
 * is user or task output.
 */
const GENERATED_SPACE_ENTRIES = [SPACE_META_FILE, SPACE_CONTEXT_FILE];
export class BunnyDebugResetService {
    options;
    /**
     * Tasks Bunny assigned. The task table also holds tasks other assigners recorded;
     * the reset never counts, deletes or clears anything of theirs.
     */
    tasks;
    library;
    questionnaires = createAgentQuestionnaires(BUNNY_AGENT_NAME);
    routines;
    constructor(options) {
        this.options = options;
        this.tasks = createAssignerTasks(options.bunnyDb, BUNNY_AGENT_NAME);
        this.library = createLibraryReset(options.bunnyDb);
        this.routines = createAgentRoutines({
            db: options.db,
            agentName: BUNNY_AGENT_NAME,
            remove: options.deleteRoutine,
        });
    }
    async preview() {
        const { db } = this.options;
        const links = this.library.links();
        const tasks = this.tasks.sessionIds();
        const taskSet = new Set(tasks);
        const spaces = this.library.spaces().map((space) => {
            const members = links.filter((link) => link.spaceId === space.id);
            return {
                id: space.id,
                name: space.name,
                sessionCount: members.length,
                taskCount: members.filter((link) => taskSet.has(link.sessionId)).length,
            };
        });
        return {
            spaces,
            spaceCount: spaces.length,
            taskCount: tasks.length,
            eventCount: this.tasks.eventCount(),
            markedSessionCount: this.markedSessionIds().length,
            questionnaireCount: this.questionnaires.count(db, [...bunnySessionIds(db), ...tasks]),
            sessionCount: sessionCount(db),
            runningTaskSessionIds: this.runningTaskSessions(tasks),
            optional: {
                memoryFiles: await countFiles(join(resolveBunnyHomeDir(this.options.dataDir), 'memory')),
                routines: this.routines.liveIds().length,
            },
        };
    }
    /** Makes this machine look like Bunny never handled anything; Sessions are kept intact. */
    async simulateOnboarding(scope = {}) {
        const { db, bunnyDb } = this.options;
        const tasks = this.tasks.sessionIds();
        this.assertNoRunningTasks(tasks);
        const markedSessions = this.markedSessionIds();
        const spaceIds = this.library.spaces().map((row) => row.id);
        const routineIds = scope.clearRoutines ? this.routines.liveIds() : [];
        const now = this.nowMs();
        const bunnyRemoved = bunnyDb.transaction((tx) => {
            const events = this.tasks.eventCount(tx);
            // Only tasks Bunny assigned; another assigner's task rows stay. Events cascade.
            const deletedTasks = this.tasks.clear(tx);
            // Every space and link goes; imported files keep their rows and fall back to no space.
            this.library.detach(tx);
            const cleared = scope.clearMemory ? tx.delete(bunnyMemoryCursors).run().changes : 0;
            if (scope.clearMemory)
                this.options.clearWorkingState?.(tx);
            this.options.clearDeliveryBaseline?.(tx);
            // Matches a real first use: history, library and memory capture start from now.
            writeBunnySetting(tx, BUNNY_INITIALIZED_AT_KEY, now);
            return { tasks: deletedTasks, events, memoryCursors: cleared };
        });
        this.options.reloadTaskIndex?.();
        const removed = db.transaction((tx) => {
            const questionnaires = this.questionnaires.clear(tx, [...bunnySessionIds(tx), ...tasks]);
            return {
                ...bunnyRemoved,
                spaces: spaceIds.length,
                markedSessions: markedSessions.length,
                questionnaires,
            };
        });
        const trash = new TrashBin(this.options.dataDir, now);
        for (const directories of scanSpaceDirectories(this.options.dataDir).values())
            for (const directory of directories)
                await cleanSpaceDirectory(directory, trash);
        if (scope.clearMemory)
            await this.trashMemory(trash);
        const routines = await this.routines.delete(routineIds);
        return {
            removed: { ...removed, routines },
            sessionCount: sessionCount(db),
            ...(trash.used ? { trashDir: trash.root } : {}),
        };
    }
    /** Deletes one space and every Bunny fact bound to it; its Sessions stay as ordinary ones. */
    async deleteSpace(spaceId) {
        try {
            assertSpaceId(spaceId);
        }
        catch {
            throw new BunnyDebugError('Invalid space ID', 400);
        }
        const { db, bunnyDb } = this.options;
        if (!this.library.spaces().some((space) => space.id === spaceId))
            throw new BunnyDebugError('Space not found', 404);
        const members = this.library.links(spaceId).map((row) => row.sessionId);
        const tasks = members.length ? this.tasks.sessionIds(members) : [];
        this.assertNoRunningTasks(tasks);
        const bunnyRemoved = bunnyDb.transaction((tx) => {
            // Events cascade from their task rows inside the Bunny database.
            const removedTasks = this.tasks.clearSessions(tx, tasks);
            // The space and its links go; its imported files keep their rows and fall back to no space.
            this.library.detach(tx, spaceId);
            this.options.clearDeliveryBaseline?.(tx);
            return removedTasks;
        });
        this.options.reloadTaskIndex?.();
        const removed = {
            ...bunnyRemoved,
            spaces: 1,
            markedSessions: members.length,
            questionnaires: null,
            memoryCursors: 0,
        };
        const trash = new TrashBin(this.options.dataDir, this.nowMs());
        for (const directory of scanSpaceDirectories(this.options.dataDir).get(spaceId) ?? [])
            await cleanSpaceDirectory(directory, trash);
        return {
            removed: { ...removed, routines: 0 },
            sessionCount: sessionCount(db),
            ...(trash.used ? { trashDir: trash.root } : {}),
        };
    }
    markedSessionIds() {
        const ids = new Set(this.tasks.sessionIds());
        for (const link of this.library.links())
            ids.add(link.sessionId);
        return [...ids];
    }
    runningTaskSessions(taskSessionIds) {
        const active = this.options.activeTurnId;
        return active ? taskSessionIds.filter((id) => active(id)) : [];
    }
    /** Refuses rather than aborting: a running task's report-back is the developer's to stop. */
    assertNoRunningTasks(taskSessionIds) {
        const running = this.runningTaskSessions(taskSessionIds);
        if (running.length)
            throw new BunnyDebugError(`有 ${running.length} 个任务正在运行，请先停止它们再重置`, 409, {
                runningTaskSessionIds: running,
            });
    }
    async trashMemory(trash) {
        const home = resolveBunnyHomeDir(this.options.dataDir);
        const move = async () => {
            await trash.move(join(home, 'memory'), 'memory');
            await trash.move(join(home, '.memory-state.json'), '.memory-state.json');
        };
        await (this.options.withMemoryLock ? this.options.withMemoryLock(move) : move());
    }
    nowMs() {
        return this.options.nowMs?.() ?? Date.now();
    }
}
function sessionCount(db) {
    return db.select({ value: count() }).from(sessions).get()?.value ?? 0;
}
/** Bunny's own Sessions: the questionnaires they asked go with the reset. */
function bunnySessionIds(db) {
    return db
        .select({ id: sessions.sessionId })
        .from(sessions)
        .where(eq(sessions.agentName, BUNNY_AGENT_NAME))
        .all()
        .map((row) => row.id);
}
/** A timestamped folder under the Bunny home, outside spaces/ so nothing scans it as a space. */
class TrashBin {
    root;
    used = false;
    constructor(dataDir, nowMs) {
        const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
        this.root = join(resolveBunnyHomeDir(dataDir), '.trash', stamp);
    }
    async move(source, relativeTarget) {
        if (!existsSync(source))
            return;
        let target = join(this.root, relativeTarget);
        for (let suffix = 1; existsSync(target); suffix++)
            target = join(this.root, `${relativeTarget}-${suffix}`);
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
        this.used = true;
    }
}
/**
 * The single place that knows a space directory's layout: Bunny-generated
 * entries are deleted, everything else (task deliverables under artifacts/, user
 * files) moves to `.trash/<stamp>/spaces/<directory name>/`, and the emptied
 * directory is removed.
 */
async function cleanSpaceDirectory(dir, trash) {
    if (!existsSync(dir))
        return;
    for (const entry of await readdir(dir)) {
        const source = join(dir, entry);
        if (GENERATED_SPACE_ENTRIES.includes(entry))
            await rm(source, { recursive: true, force: true });
        else
            await trash.move(source, join('spaces', basename(dir), entry));
    }
    try {
        await rmdir(dir);
    }
    catch {
        // A concurrent writer added a file; leave the directory in place.
    }
}
async function countFiles(dir) {
    if (!existsSync(dir))
        return 0;
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true }))
        total += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
    return total;
}
//# sourceMappingURL=debug-reset.service.js.map