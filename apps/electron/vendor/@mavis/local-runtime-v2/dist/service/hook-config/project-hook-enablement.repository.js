import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { hookSettingsDirectory, writeAtomicPrivateFile } from './hook-config-files.js';
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 500;
const MAX_HOOK_IDS_PER_PROJECT = 256;
const DISABLED = { enabled: false, hooks: new Set() };
/**
 * Local, per-project record of which repository-declared hooks may run.
 * Callers that mutate must hold the hook settings lock.
 */
export class ProjectHookEnablementRepository {
    nowMs;
    logger;
    filePath;
    cache;
    constructor(dataDir, nowMs, logger) {
        this.nowMs = nowMs;
        this.logger = logger;
        this.filePath = path.join(hookSettingsDirectory(dataDir), 'state.json');
    }
    async read(projectKey) {
        const project = (await this.readState()).projects[projectKey];
        if (!project)
            return DISABLED;
        return { enabled: project.enabled, hooks: new Set(Object.keys(project.hooks)) };
    }
    async update(projectKey, mutation) {
        const state = structuredClone(await this.readState());
        const previous = state.projects[projectKey];
        const hooks = { ...(previous?.hooks ?? {}) };
        for (const hookId of mutation.disable ?? [])
            delete hooks[hookId];
        for (const hookId of mutation.enable ?? []) {
            delete hooks[hookId];
            hooks[hookId] = true;
        }
        const ids = Object.keys(hooks);
        for (const hookId of ids.slice(0, Math.max(0, ids.length - MAX_HOOK_IDS_PER_PROJECT))) {
            delete hooks[hookId];
        }
        state.projects[projectKey] = {
            enabled: mutation.enabled ?? previous?.enabled ?? false,
            hooks,
            updatedAtMs: this.nowMs(),
        };
        pruneProjects(state);
        await writeAtomicPrivateFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
        this.cache = undefined;
        const project = state.projects[projectKey];
        return project
            ? { enabled: project.enabled, hooks: new Set(Object.keys(project.hooks)) }
            : DISABLED;
    }
    async readState() {
        let fingerprint;
        try {
            const info = await stat(this.filePath);
            fingerprint = `${info.ino}:${info.size}:${info.mtimeMs}`;
            if (info.size > MAX_STATE_BYTES)
                return this.corrupt('size');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return emptyState();
            return this.corrupt('stat');
        }
        if (this.cache?.fingerprint === fingerprint)
            return this.cache.state;
        try {
            const state = parseState(JSON.parse(await readFile(this.filePath, 'utf8')));
            if (!state)
                return this.corrupt('schema');
            this.cache = { fingerprint, state };
            return state;
        }
        catch {
            return this.corrupt('parse');
        }
    }
    corrupt(reason) {
        this.logger?.warn({ event: 'hook_config_enablement_state_unreadable', reason }, 'Project hook enablement state is unreadable; treating every project hook as disabled');
        return emptyState();
    }
}
function emptyState() {
    return { version: STATE_VERSION, projects: {} };
}
function parseState(value) {
    if (!isRecord(value) || value.version !== STATE_VERSION || !isRecord(value.projects)) {
        return undefined;
    }
    const projects = {};
    for (const [key, raw] of Object.entries(value.projects)) {
        const project = parseProject(raw);
        if (project)
            projects[key] = project;
    }
    return { version: STATE_VERSION, projects };
}
function parseProject(value) {
    if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isRecord(value.hooks)) {
        return undefined;
    }
    const hooks = {};
    for (const [hookId, enabled] of Object.entries(value.hooks)) {
        if (enabled === true)
            hooks[hookId] = true;
    }
    return {
        enabled: value.enabled,
        hooks,
        updatedAtMs: typeof value.updatedAtMs === 'number' ? value.updatedAtMs : 0,
    };
}
function pruneProjects(state) {
    const entries = Object.entries(state.projects);
    if (entries.length <= MAX_PROJECTS)
        return;
    entries
        .sort(([, left], [, right]) => left.updatedAtMs - right.updatedAtMs)
        .slice(0, entries.length - MAX_PROJECTS)
        .forEach(([key]) => delete state.projects[key]);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=project-hook-enablement.repository.js.map