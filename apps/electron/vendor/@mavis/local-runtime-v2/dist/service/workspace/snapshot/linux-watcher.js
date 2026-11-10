import { watch } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { buildLinuxWatchPlan, isMissing } from './linux-watch-plan.js';
export async function createLinuxWorkspaceGitWatcher(options, dependencies = {}) {
    const owner = new LinuxWorkspaceGitWatcher(await realpath(options.workspace), options, dependencies);
    await owner.start();
    return owner;
}
/** Linux only: non-recursive directory watches, pruned before registration by Git semantics. */
class LinuxWorkspaceGitWatcher {
    workspace;
    options;
    dependencies;
    registrations = new Map();
    abort = new AbortController();
    callbacks;
    nextPlan = new Map();
    closed = false;
    rebuilding = false;
    rebuildRequested = false;
    potential = false;
    flushing = false;
    kind;
    paths = new Set();
    quietTimer;
    maxTimer;
    constructor(workspace, options, dependencies) {
        this.workspace = workspace;
        this.options = options;
        this.dependencies = dependencies;
        this.callbacks = options.callbacks;
    }
    async start() {
        try {
            await this.rebuild();
            this.assertActive();
            if (this.potential)
                this.schedule();
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    isActive() {
        return !this.closed;
    }
    assertActive() {
        if (!this.isActive())
            throw new Error('Linux watcher stopped');
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.abort.abort();
        this.clearTimers();
        this.releaseAll();
        this.paths.clear();
    }
    async rebuild() {
        if (this.rebuilding || !this.isActive())
            return;
        this.rebuilding = true;
        try {
            let attempts = 0;
            do {
                this.rebuildRequested = false;
                this.nextPlan = new Map();
                await buildLinuxWatchPlan(this.workspace, (directory, role) => this.register(directory, role), this.abort.signal);
                if (!this.isActive())
                    return;
                this.applyPlan();
                // Continuous renames must not hold every Snapshot reader indefinitely.
                if (++attempts >= 3 && this.rebuildRequested)
                    throw new Error('Unstable directory tree');
            } while (this.rebuildRequested);
        }
        finally {
            this.rebuilding = false;
        }
    }
    applyPlan() {
        for (const [directory, registration] of this.registrations) {
            const roles = this.nextPlan.get(directory);
            if (roles)
                registration.roles = roles;
            else
                this.release(directory);
        }
    }
    async register(path, role) {
        const directory = resolve(path);
        this.assertActive();
        const identity = await directoryIdentity(directory, role);
        if (!identity)
            return false;
        this.assertActive();
        const roles = this.nextPlan.get(directory) ?? [];
        roles.push(role);
        this.nextPlan.set(directory, roles);
        const existing = this.registrations.get(directory);
        if (existing?.identity === identity)
            return true;
        if (existing)
            this.release(directory);
        this.attach(directory, identity, roles);
        return true;
    }
    attach(directory, identity, roles) {
        const watcher = (this.dependencies.watchDirectory ?? watch)(directory, { recursive: false }, (event, fileName) => this.onEvent(directory, event, fileName));
        const registration = { watcher, identity, roles };
        this.registrations.set(directory, registration);
        watcher.on('error', (error) => {
            if (this.registrations.get(directory) === registration)
                this.failClosed(error);
        });
    }
    onEvent(directory, event, fileName) {
        if (!this.isActive())
            return;
        const registration = this.registrations.get(directory);
        if (!registration)
            return;
        const name = fileName === null ? '' : fileName.toString();
        // Both plans matter while rebuilding: neither removed nor newly admitted paths may go stale.
        const roles = [...registration.roles, ...(this.nextPlan.get(directory) ?? [])];
        const kinds = roles.map((role) => eventKind(role, name));
        const kind = kinds.includes('repository') ? 'repository' : kinds.find(Boolean);
        if (!kind)
            return;
        this.recordPath(kind, directory, name);
        if (kind === 'repository' || event === 'rename')
            this.rebuildRequested = true;
        if (!this.potential) {
            this.potential = true;
            this.callbacks.onPotentialChange();
        }
        this.schedule();
    }
    recordPath(kind, directory, name) {
        if (kind === 'repository')
            this.kind = 'repository';
        else if (this.paths.size < 1_000) {
            this.paths.add(relative(this.workspace, join(directory, name)).split(sep).join('/'));
        }
        else
            this.kind ??= 'workspace';
    }
    schedule() {
        if (this.closed || this.rebuilding || this.flushing)
            return;
        if (this.quietTimer)
            clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => void this.flush(), this.options.quietWindowMs ?? 120);
        this.maxTimer ??= setTimeout(() => void this.flush(), this.options.maxWaitMs ?? 800);
    }
    async flush() {
        if (!this.isActive() || this.flushing || this.rebuilding || !this.potential)
            return;
        this.flushing = true;
        this.clearTimers();
        try {
            const kind = await this.drainPending();
            if (!this.isActive())
                return;
            this.potential = false;
            if (kind)
                this.callbacks.onChange(kind);
            else
                this.callbacks.onIgnoredOnly();
        }
        catch (error) {
            this.failClosed(error);
        }
        finally {
            this.flushing = false;
            if (this.potential)
                this.schedule();
        }
    }
    async drainPending() {
        let kind;
        let batches = 0;
        do {
            // Even ignored log writes must not keep Snapshot validation pending forever.
            if (++batches > 3)
                throw new Error('Unstable file event stream');
            if (this.rebuildRequested)
                await this.rebuild();
            if (!this.isActive())
                return undefined;
            const pendingKind = this.kind;
            const paths = [...this.paths];
            this.kind = undefined;
            this.paths.clear();
            kind = await this.classifyBatch(kind, pendingKind, paths);
        } while (this.kind || this.paths.size || this.rebuildRequested);
        return kind;
    }
    async classifyBatch(current, pending, paths) {
        if (pending === 'repository')
            return 'repository';
        if (current)
            return current;
        if (pending || !paths.length)
            return 'workspace';
        return (await this.options.classifyIgnored(paths)) ? undefined : 'workspace';
    }
    failClosed(error) {
        if (this.closed)
            return;
        this.close();
        this.potential = false;
        this.callbacks.onError(error);
    }
    release(directory) {
        const registration = this.registrations.get(directory);
        if (!registration)
            return;
        this.registrations.delete(directory);
        registration.watcher.close();
    }
    releaseAll() {
        for (const directory of this.registrations.keys())
            this.release(directory);
        this.nextPlan.clear();
    }
    clearTimers() {
        if (this.quietTimer)
            clearTimeout(this.quietTimer);
        if (this.maxTimer)
            clearTimeout(this.maxTimer);
        this.quietTimer = undefined;
        this.maxTimer = undefined;
    }
}
function eventKind(role, name) {
    if (!name)
        return 'repository';
    if (role.kind === 'control')
        return name === role.name ? 'repository' : undefined;
    if (role.kind === 'repository')
        return !role.names || role.names.includes(name) ? 'repository' : undefined;
    return name === '.git' || basename(name) === '.gitignore' ? 'repository' : 'workspace';
}
async function directoryIdentity(directory, role) {
    try {
        const stats = await lstat(directory);
        // Git tracks workspace symlinks, not their targets; unsupported control paths must fail closed.
        if (stats.isSymbolicLink() && role.kind !== 'workspace')
            throw new Error('Git control directory is a symlink');
        if (!stats.isDirectory() || stats.isSymbolicLink())
            return undefined;
        return `${stats.dev}:${stats.ino}`;
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
//# sourceMappingURL=linux-watcher.js.map