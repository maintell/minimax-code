import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LocalPluginHookPermissionMutationError, } from './plugin-hook-permission-contracts.js';
import { applyUpdate, clonePersisted, cloneScope, emptyPersisted, emptyScope, freezeScope, matchingWorkspaceState, normalizeWorkspace, parsePersisted, toPermissionRules, validateMutationInput, validateRuntimeModes, workspaceKey, } from './plugin-hook-permission-state.js';
const MAX_STORE_BYTES = 8 * 1024 * 1024;
/**
 * MiniMax-owned projection of Compatible permission updates.
 *
 * All persistent destinations live in one versioned document, so a mixed
 * user/project/local update commits with one atomic rename. Session state is
 * assigned only after that rename succeeds. An in-process lane plus a
 * cross-process file lock prevents lost updates between concurrent runtimes.
 */
export class LocalPluginHookPermissionStore {
    filePath;
    writeAtomic;
    sessions = new Map();
    lane = Promise.resolve();
    closed = false;
    closePromise;
    constructor(options) {
        this.filePath = path.join(options.dataDir, 'plugin-hook-permissions', 'state.json');
        this.writeAtomic = options.writeAtomic ?? writeAtomicFile;
    }
    async applyAtomic(input) {
        await this.serialized(async () => this.withPersistenceLock(async () => {
            validateMutationInput(input);
            validateRuntimeModes(input);
            const workspace = normalizeWorkspace(input.cwd);
            const persisted = await this.readPersisted();
            const { nextPersisted, nextSession, persistentChanged } = applyUpdates(input, workspace, persisted, this.sessions.get(input.sessionId) ?? emptyScope());
            if (persistentChanged) {
                const content = `${JSON.stringify(nextPersisted, null, 2)}\n`;
                if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
                    throw new LocalPluginHookPermissionMutationError('Plugin Hook permission store exceeds its managed size limit.', 'INVALID_UPDATE');
                }
                try {
                    await this.writeAtomic(this.filePath, content);
                }
                catch (error) {
                    throw new LocalPluginHookPermissionMutationError(`Plugin Hook permission update could not be persisted: ${boundedError(error)}`, 'STORE_WRITE_FAILED');
                }
            }
            this.sessions.set(input.sessionId, freezeScope(nextSession));
        }));
    }
    async effective(input) {
        return await this.serialized(async () => {
            const workspace = normalizeWorkspace(input.cwd);
            const persisted = await this.readPersisted();
            const key = workspaceKey(workspace);
            const project = matchingWorkspaceState(persisted.projects[key], workspace);
            const local = matchingWorkspaceState(persisted.locals[key], workspace);
            const session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
            const scopes = [
                { state: persisted.user, source: 'global' },
                ...(project ? [{ state: project, source: 'agent' }] : []),
                ...(local ? [{ state: local, source: 'agent' }] : []),
                ...(session ? [{ state: session, source: 'session' }] : []),
            ];
            const mode = [...scopes].reverse().find((scope) => scope.state.mode !== undefined)
                ?.state.mode;
            const rules = scopes.flatMap((scope) => toPermissionRules(scope.state, scope.source));
            if (mode === 'acceptEdits') {
                for (const toolName of ['edit', 'write', 'apply_patch']) {
                    rules.push({
                        source: session ? 'session' : 'global',
                        ruleBehavior: 'allow',
                        ruleValue: { toolName },
                    });
                }
            }
            return {
                ...(mode ? { mode } : {}),
                rules,
                directories: [...new Set(scopes.flatMap((scope) => scope.state.directories))],
            };
        });
    }
    async clearSession(sessionId) {
        await this.serialized(async () => {
            this.sessions.delete(sessionId);
        });
    }
    close() {
        this.closed = true;
        this.closePromise ??= (async () => {
            await this.lane;
            this.sessions.clear();
        })();
        return this.closePromise;
    }
    async readPersisted() {
        let content;
        try {
            content = await readFile(this.filePath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return emptyPersisted();
            throw new LocalPluginHookPermissionMutationError(`Plugin Hook permission store could not be read: ${boundedError(error)}`, 'STORE_CORRUPT');
        }
        if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
            throw new LocalPluginHookPermissionMutationError('Plugin Hook permission store exceeds its managed size limit.', 'STORE_CORRUPT');
        }
        try {
            return parsePersisted(JSON.parse(content));
        }
        catch (error) {
            if (error instanceof LocalPluginHookPermissionMutationError)
                throw error;
            throw new LocalPluginHookPermissionMutationError(`Plugin Hook permission store is invalid: ${boundedError(error)}`, 'STORE_CORRUPT');
        }
    }
    async serialized(operation) {
        if (this.closed)
            throw new Error('Plugin Hook permission owner has been closed.');
        const previous = this.lane;
        let release = () => undefined;
        this.lane = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async withPersistenceLock(operation) {
        const directory = path.dirname(this.filePath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let release;
        try {
            release = await lockfile.lock(directory, {
                stale: 10_000,
                // Disk sync can hold the lock beyond 100 ms under concurrent runtime load.
                retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
            });
            return await operation();
        }
        finally {
            try {
                await release?.();
            }
            catch {
                /* Preserve the operation outcome if lock cleanup fails. */
            }
        }
    }
}
async function writeAtomicFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, filePath);
    }
    catch (error) {
        try {
            await rm(temporary, { force: true });
        }
        catch {
            /* Preserve the original write failure. */
        }
        throw error;
    }
}
function boundedError(error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
function applyUpdates(input, workspace, persisted, session) {
    const nextPersisted = clonePersisted(persisted);
    let nextSession = cloneScope(session);
    let persistentChanged = false;
    for (const update of input.updates) {
        if (update.type === 'setMode' && update.mode === 'bypassPermissions') {
            // Compatible defines these entries as a no-op: Hooks cannot create the
            // launch-time capability. When available they affect this Session
            // regardless of destination, but are never persisted as defaultMode.
            if (!input.bypassAvailable)
                continue;
            nextSession = applyUpdate(nextSession, { ...update, destination: 'session' }, workspace);
            continue;
        }
        if (update.destination === 'session') {
            nextSession = applyUpdate(nextSession, update, workspace);
            continue;
        }
        persistentChanged = true;
        if (update.destination === 'userSettings') {
            nextPersisted.user = applyUpdate(nextPersisted.user, update, workspace);
            continue;
        }
        const collection = update.destination === 'projectSettings' ? nextPersisted.projects : nextPersisted.locals;
        const key = workspaceKey(workspace);
        const existing = collection[key];
        assertWorkspaceIdentity(existing, workspace);
        collection[key] = {
            workspace,
            state: applyUpdate(existing?.state ?? emptyScope(), update, workspace),
        };
    }
    return { nextPersisted, nextSession, persistentChanged };
}
function assertWorkspaceIdentity(existing, workspace) {
    if (existing && existing.workspace !== workspace) {
        throw new LocalPluginHookPermissionMutationError('Plugin Hook permission workspace identity collision.', 'STORE_CORRUPT');
    }
}
//# sourceMappingURL=plugin-hook-permissions.js.map