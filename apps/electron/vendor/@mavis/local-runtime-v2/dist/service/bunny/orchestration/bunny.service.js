import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { cp, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNNY_AGENT_NAME, BUNNY_TEMPLATE_VERSION, BunnyTaskModelInvalidError, isBunnyPermissionMode, } from '../contracts.js';
import { BUNNY_MAIN_MEMORY_PATH } from '../memory/disk-layout.js';
import { BUNNY_DATABASE_BACKUP_NAME, BUNNY_HOME_BACKUP_NAME, createBackupDir, listBackups, readBackup, writeBackupFiles, } from '../reset/bunny-backups.js';
const PERMISSION_MODE_KEY = 'bunny.permissionMode';
/** Home entry holding the Bunny database; reset backs it up but never moves it. */
const BUNNY_DATABASE_ENTRY = 'data';
/** Serializes entry, reset and restore so concurrent clicks never create duplicate Agents or roots. */
export class BunnyService {
    options;
    operation = Promise.resolve();
    latestView;
    reportViewState(input) {
        this.latestView = { ...input, reportedAtMs: this.options.now?.().getTime() ?? Date.now() };
    }
    viewState() {
        return this.latestView;
    }
    async initializedAtMs() {
        const value = await this.options.preferences.get('bunny.initializedAtMs');
        return typeof value === 'number' ? value : 0;
    }
    constructor(options) {
        this.options = options;
    }
    async ensure() {
        return this.serialize(() => this.ensureBunny());
    }
    reset() {
        return this.serialize(() => this.options.withMemoryLock(async () => {
            const { bunny } = await this.ensureBunny();
            const date = this.options.now?.() ?? new Date();
            const backupDir = await this.backUpAndClear(bunny.mainSessionId, date, 'initialize');
            await this.options.preferences.set(PERMISSION_MODE_KEY, 'follow');
            // Reset means "as never set", so the row goes away instead of holding null: a null row
            // still records a choice and would keep a remote default from ever applying again.
            await this.options.preferences.delete('bunny.taskModel');
            await this.options.preferences.set('bunny.initializedAtMs', date.getTime());
            const homeDir = resolveBunnyHomeDir(this.options.dataDir);
            await this.initializeDirectory(homeDir);
            await this.options.ensureDefaultSpace();
            const root = await this.options.roots.replaceRoot(BUNNY_AGENT_NAME);
            return { bunny: await this.state(root.sessionId), backupDir };
        }));
    }
    /** Backups reset and restore wrote, newest first (spec 5.4 恢复备份). */
    listBackups() {
        return listBackups(this.options.dataDir);
    }
    /**
     * Returns Bunny to the state a backup holds. The current state is backed up and cleared
     * first, the same way initialization does, so a restore can itself be restored; the
     * returned `backupDir` is that new backup. The chosen backup is copied, never consumed.
     */
    restore(backupId) {
        return this.serialize(() => this.options.withMemoryLock(async () => {
            const backup = await readBackup(this.options.dataDir, backupId);
            const { bunny } = await this.ensureBunny();
            const date = this.options.now?.() ?? new Date();
            const backupDir = await this.backUpAndClear(bunny.mainSessionId, date, 'restore');
            const homeDir = resolveBunnyHomeDir(this.options.dataDir);
            await cp(join(backup.dir, BUNNY_HOME_BACKUP_NAME), homeDir, { recursive: true });
            const { skippedRoutines } = await this.options.resetData.restore(backup);
            for (const routine of skippedRoutines)
                this.options.logger.warn({ backupId, routine }, 'Bunny restore could not recreate a routine from the backup');
            await this.initializeDirectory(homeDir);
            await this.options.ensureDefaultSpace();
            const root = await this.options.roots.adoptRoot(BUNNY_AGENT_NAME, backup.manifest.mainSessionId);
            return { bunny: await this.state(root.sessionId), backupDir };
        }));
    }
    /** Keep explicit handoffs on the same coordinator generation as entry/reset. */
    withMainSession(run) {
        return this.serialize(async () => run((await this.ensureBunny()).bunny.mainSessionId));
    }
    /** Read on every permission check, so a change applies to the next tool call. */
    async permissionMode() {
        const stored = await this.options.preferences.get(PERMISSION_MODE_KEY);
        return isBunnyPermissionMode(stored) ? stored : 'follow';
    }
    async setPermissionMode(mode) {
        await this.options.preferences.set(PERMISSION_MODE_KEY, mode);
        return mode;
    }
    async taskModel() {
        const stored = await this.options.preferences.get('bunny.taskModel');
        return stored == null ? undefined : stored;
    }
    /**
     * The raw task-model setting, which `taskModel()` cannot express: `stored` is false only while
     * the user has never saved or cleared it — the single case a remote default may fill — and
     * `model` is the saved model, absent when the user cleared it on purpose.
     */
    async taskModelState() {
        const raw = await this.options.preferences.get('bunny.taskModel');
        return { stored: raw !== undefined, ...(raw == null ? {} : { model: raw }) };
    }
    async setTaskModel(model) {
        // Clearing always succeeds; a model is saved only when the Runtime could resolve it.
        if (model && this.options.validateTaskModel) {
            try {
                await this.options.validateTaskModel(model);
            }
            catch (error) {
                throw new BunnyTaskModelInvalidError(`任务模型 ${model.providerId}/${model.modelId} 不可用，没有保存：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await this.options.preferences.set('bunny.taskModel', model ?? null);
        return model;
    }
    /**
     * Stops Bunny's Sessions, writes a complete backup, then clears: routines deleted,
     * Bunny's own conversations archived, Bunny-store and shared rows removed, home moved into
     * the backup. Delegated tasks stay where they are and only lose their Bunny facts.
     * Nothing is moved or cleared until every export has been written.
     */
    async backUpAndClear(mainSessionId, date, reason) {
        const cleanup = this.options.resetData;
        await cleanup.stopSession(mainSessionId);
        const snapshot = await cleanup.snapshot();
        await Promise.all(snapshot.sessions.map((session) => cleanup.stopSession(session.sessionId)));
        const backupDir = await createBackupDir(this.options.dataDir, date);
        await writeBackupFiles(backupDir, {
            snapshot,
            history: (sessionId) => cleanup.history(sessionId),
            manifest: {
                createdAtMs: date.getTime(),
                reason,
                mainSessionId,
                counts: { sessions: snapshot.sessions.length, ...snapshot.counts },
                settings: {
                    permissionMode: await this.permissionMode(),
                    taskModel: await this.taskModel(),
                    initializedAtMs: await this.initializedAtMs(),
                },
            },
        });
        // The Bunny database stays open in `bunny/data/`: copy it with online backup and
        // move every other entry of the home aside, so the live database is never renamed.
        await cleanup.backupStore(join(backupDir, BUNNY_DATABASE_BACKUP_NAME));
        await moveHomeEntries(resolveBunnyHomeDir(this.options.dataDir), join(backupDir, BUNNY_HOME_BACKUP_NAME));
        // All durable data and messages are backed up before destructive database cleanup.
        await cleanup.deleteRoutines();
        for (const sessionId of snapshot.conversationSessionIds)
            await cleanup.archiveSession(sessionId);
        cleanup.clear();
        this.latestView = undefined;
        return backupDir;
    }
    async serialize(run) {
        const previous = this.operation;
        let release;
        this.operation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await run();
        }
        finally {
            release?.();
        }
    }
    async ensureBunny() {
        await this.options.agents.requireBuiltin(BUNNY_AGENT_NAME);
        const homeDir = resolveBunnyHomeDir(this.options.dataDir);
        let created = false;
        // Opening the Bunny database already creates `bunny/data/`, so the home directory
        // alone no longer means Bunny was entered: any other entry does. A home whose memory
        // directory is mid-publication (`memory.previous`) is not a first entry either; the
        // memory owner restores it.
        if (!(await hasEntriesBesidesDatabase(homeDir))) {
            await this.initializeDirectory(homeDir);
            created = true;
        }
        await this.options.ensureDefaultSpace();
        if (!(await this.options.roots.hasRoot(BUNNY_AGENT_NAME)))
            created = true;
        const root = await this.options.roots.getRootSessionByAgent(BUNNY_AGENT_NAME);
        return { bunny: await this.state(root.sessionId), created };
    }
    async state(mainSessionId) {
        return {
            agentName: BUNNY_AGENT_NAME,
            mainSessionId,
            homeDir: resolveBunnyHomeDir(this.options.dataDir),
            mainMemoryPath: BUNNY_MAIN_MEMORY_PATH,
            templateVersion: BUNNY_TEMPLATE_VERSION,
            permissionMode: await this.permissionMode(),
            taskModel: await this.taskModel(),
            initializedAtMs: await this.initializedAtMs(),
        };
    }
    async initializeDirectory(homeDir) {
        await mkdir(join(homeDir, 'memory'), { recursive: true });
        await mkdir(join(homeDir, 'spaces', 'default'), { recursive: true });
    }
}
async function hasEntriesBesidesDatabase(homeDir) {
    try {
        return (await readdir(homeDir)).some((name) => name !== BUNNY_DATABASE_ENTRY);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
/** Moves every home entry except the live database directory into `target`. */
async function moveHomeEntries(homeDir, target) {
    let names;
    try {
        names = await readdir(homeDir);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    await mkdir(target, { recursive: true });
    for (const name of names) {
        if (name === BUNNY_DATABASE_ENTRY)
            continue;
        await rename(join(homeDir, name), join(target, name));
    }
}
//# sourceMappingURL=bunny.service.js.map