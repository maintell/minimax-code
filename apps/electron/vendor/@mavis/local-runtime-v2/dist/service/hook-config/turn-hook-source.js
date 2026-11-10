import { parseHookDocumentText } from './hook-config-document.js';
import { probeHookConfigFile, projectHookLocation, readHookConfigFile, userHookLocation, } from './hook-config-files.js';
const TURN_LOAD_BUDGET_MS = 500;
const MAX_OWNER_READ_ATTEMPTS = 3;
export class ConfigHookSource {
    dataDir;
    enablement;
    logger;
    cache = new Map();
    /** Keyed by config file, so each worktree of a project keeps its own owners. */
    owners = new Map();
    /**
     * Bumped by each settings edit of one owner scope. A read that started before
     * an edit of its scope must not overwrite the owners that edit recorded.
     */
    ownerVersions = new Map();
    constructor(dataDir, enablement, logger) {
        this.dataDir = dataDir;
        this.enablement = enablement;
        this.logger = logger;
    }
    async load(input) {
        const [user, project] = await Promise.all([
            this.withinBudget('user', () => this.loadScope(userHookLocation(this.dataDir))),
            input.isDefaultWorkspace
                ? Promise.resolve([])
                : this.withinBudget('project', () => this.loadProjectScope(input)),
        ]);
        return [...user, ...project];
    }
    async loadProjectScope(input) {
        let location;
        try {
            location = await projectHookLocation(this.dataDir, input.workspaceDir, input.parentRepoDir);
        }
        catch {
            return [];
        }
        return this.loadScope(location);
    }
    enabledOwnerNames() {
        const names = new Set();
        for (const remembered of this.owners.values()) {
            for (const name of remembered.owners.keys())
                names.add(name);
        }
        return names;
    }
    /** `fresh` bypasses the metadata cache for revision checks around writes. */
    async readScope(location, options = {}) {
        const cached = this.cache.get(location.configPath);
        if (!options.fresh && cached) {
            const fingerprint = await probeHookConfigFile(location);
            if (fingerprint === cached.fingerprint)
                return { ...cached.snapshot, location };
        }
        const read = await readHookConfigFile(location);
        const snapshot = {
            location,
            read,
            ...(read.kind === 'file' ? { parsed: parseHookDocumentText(read.text) } : {}),
        };
        if (read.kind === 'file') {
            this.cache.set(location.configPath, { fingerprint: read.fingerprint, snapshot });
        }
        else {
            this.cache.delete(location.configPath);
        }
        return snapshot;
    }
    readEnablement(location) {
        return this.enablement.read(enablementKey(location));
    }
    /** Take before reading a scope, then pass to `rememberRead`. */
    ownerVersion(location) {
        return this.ownerVersions.get(ownerScopeKey(location)) ?? 0;
    }
    /** Records the live owner set of one config file after a settings edit. */
    remember(location, handlers, enablement) {
        this.ownerVersions.set(ownerScopeKey(location), this.ownerVersion(location) + 1);
        this.applyOwners(location, handlers, enablement);
    }
    /**
     * Records owners from a read that started at `version`. Returns false, and
     * records nothing, when a settings edit of the same scope landed since.
     */
    rememberRead(location, version, handlers, enablement) {
        if (this.ownerVersion(location) !== version)
            return false;
        this.applyOwners(location, handlers, enablement);
        return true;
    }
    /**
     * A project enablement read alongside also prunes the project's other
     * checkouts, since another runtime may have changed it.
     */
    applyOwners(location, handlers, enablement) {
        this.owners.set(location.configPath, {
            ...(location.scope === 'project' ? { projectKey: enablementKey(location) } : {}),
            owners: new Map(handlers.map((handler) => [handler.pluginName, handler.activationKey ?? ''])),
        });
        if (enablement)
            this.restrictProjectOwners(enablementKey(location), enablement);
    }
    restrictProjectOwners(projectKey, enablement) {
        for (const [configPath, remembered] of this.owners) {
            if (remembered.projectKey !== projectKey)
                continue;
            const allowed = [...remembered.owners].filter(([, hookId]) => enablement.enabled && enablement.hooks.has(hookId));
            this.owners.set(configPath, { projectKey, owners: new Map(allowed) });
        }
    }
    effectiveHandlers(snapshot, enablement) {
        const parsed = snapshot.parsed;
        if (!parsed?.ok)
            return [];
        const { location } = snapshot;
        if (location.scope === 'user' ? !parsed.enabled : !enablement?.enabled)
            return [];
        return parsed.entries.flatMap((entry) => {
            const executable = entry.executable;
            if (!executable)
                return [];
            const enabled = location.scope === 'user' ? entry.enabledInFile : enablement?.hooks.has(entry.hookId);
            if (!enabled)
                return [];
            return [
                {
                    kind: 'command',
                    sourceFormat: 'MINIMAX',
                    origin: location.scope,
                    pluginName: configHookOwnerName(location, entry.hookId),
                    pluginRoot: location.configDir,
                    pluginDataDir: location.hookDataDir,
                    activationKey: entry.hookId,
                    sourcePath: location.configPath,
                    event: executable.event,
                    ...(executable.matcher ? { matcher: executable.matcher } : {}),
                    command: executable.command,
                    timeoutMs: executable.timeoutMs,
                    declarationOrder: entry.declarationOrder,
                },
            ];
        });
    }
    /** Rereads when a settings edit of this scope lands mid-read, so its owners still get recorded. */
    async loadScope(location) {
        for (let attempt = 1;; attempt += 1) {
            const version = this.ownerVersion(location);
            const snapshot = await this.readScope(location);
            const enablement = location.scope === 'project' ? await this.readEnablement(location) : undefined;
            const handlers = this.effectiveHandlers(snapshot, enablement);
            const recorded = this.rememberRead(location, version, handlers, enablement);
            if (!recorded && attempt < MAX_OWNER_READ_ATTEMPTS)
                continue;
            if (snapshot.read.kind === 'unreadable' || snapshot.parsed?.ok === false) {
                this.logger?.warn({ event: 'hook_config_unreadable', scope: location.scope }, 'Hook config file was skipped because it is unreadable or invalid');
            }
            return handlers;
        }
    }
    async withinBudget(scope, load) {
        let timer;
        try {
            return await Promise.race([
                load(),
                new Promise((resolve) => {
                    timer = setTimeout(() => {
                        this.logger?.warn({ event: 'hook_config_load_timeout', scope }, 'Hook config loading exceeded its budget; continuing without these hooks');
                        resolve([]);
                    }, TURN_LOAD_BUDGET_MS);
                    timer.unref?.();
                }),
            ]);
        }
        catch {
            this.logger?.warn({ event: 'hook_config_load_failed', scope }, 'Hook config loading failed; continuing without these hooks');
            return [];
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
}
function configHookOwnerName(location, hookId) {
    return location.scope === 'user'
        ? `@user/${hookId}`
        : `@project/${location.projectHash}/${hookId}`;
}
function enablementKey(location) {
    return location.projectKey ?? location.root;
}
/** Checkouts of one project share a scope: their enablement is one record. */
function ownerScopeKey(location) {
    return location.scope === 'user' ? 'user' : `project:${enablementKey(location)}`;
}
//# sourceMappingURL=turn-hook-source.js.map