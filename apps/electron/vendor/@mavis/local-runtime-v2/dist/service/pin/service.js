import { ProjectServiceError, } from '../session-system/index.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
const PINNED_ITEMS_ORDER_PREFERENCE_KEY = 'pinned-items-order';
const PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY = 'pinned-items-preview-train-migrated';
export class PinServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'PinServiceError';
    }
}
export class PinService {
    options;
    nowMs;
    writeQueue = Promise.resolve();
    legacyMigrationPromise;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async isSessionPinned(sessionId) {
        return (await this.readRefs()).some((ref) => ref.type === 'session' && ref.id === sessionId);
    }
    async pinAgent(agentName, pinned, insertIndex) {
        const id = requireId(agentName, 'agent');
        return this.serializeWrite(async () => {
            const agent = await this.options.agents.get(id);
            if (!agent)
                throw new PinServiceError('agent-not-found', `Agent ${id} was not found`);
            const refs = updateRefs(await this.readRefsInWriteLane(), { type: 'agent', id }, pinned, insertIndex);
            await this.writeRefs(refs);
            return {
                item: pinned ? { ref: { type: 'agent', id }, agent } : undefined,
                items: await this.hydrate(refs),
            };
        });
    }
    async pinSession(sessionId, pinned, insertIndex) {
        const id = requireId(sessionId, 'session');
        return this.serializeWrite(async () => {
            const session = await this.options.sessions.get(id);
            if (!session)
                throw new PinServiceError('session-not-found', `Session ${id} was not found`);
            const refs = updateRefs(await this.readRefsInWriteLane(), { type: 'session', id }, pinned, insertIndex);
            await this.writeRefs(refs);
            return {
                item: pinned ? { ref: { type: 'session', id }, session } : undefined,
                items: await this.hydrate(refs),
            };
        });
    }
    async pinProject(reference, pinned) {
        return this.serializeWrite(async () => {
            const refs = await this.readRefsInWriteLane();
            const [canonicalReference] = await this.options.projects.canonicalizeReferences([reference]);
            if (!canonicalReference) {
                throw new ProjectServiceError('project-required', 'project reference is required');
            }
            await this.writeRefs(updateRefs(refs, projectReferencePinRef(canonicalReference), pinned));
            const project = await this.options.projects.resolve(canonicalReference, true);
            const projected = await this.options.projectRepository.setPinned(project.projectId, pinned, this.nowMs());
            if (!projected)
                throw new ProjectServiceError('project-not-found', 'project not found');
            return projected;
        });
    }
    async putProjectsOrder(references) {
        return this.serializeWrite(async () => {
            const refs = await this.readRefsInWriteLane();
            const canonicalReferences = await this.options.projects.canonicalizeReferences(references);
            await this.writeRefs(reorderProjectRefs(refs, canonicalReferences.map(projectReferencePinRef)));
            const projects = await this.options.projects.resolveOrder(canonicalReferences);
            await this.options.projectRepository.putOrder(projects.map(({ projectId }) => projectId), this.nowMs());
            return projects;
        });
    }
    async addImportedSession(sessionId) {
        const ref = { type: 'session', id: requireId(sessionId, 'session') };
        await this.serializeWrite(async () => {
            const refs = await this.readRefsInWriteLane();
            if (refs.some((candidate) => pinRefKey(candidate) === pinRefKey(ref)))
                return;
            await this.writeRefs([...refs, ref]);
        });
    }
    async removeSession(sessionId) {
        await this.mutateOwnedRef({ type: 'session', id: requireId(sessionId, 'session') }, false);
    }
    async removeAgent(agentName) {
        await this.mutateOwnedRef({ type: 'agent', id: requireId(agentName, 'agent') }, false);
    }
    async getOrder() {
        return this.hydrate(await this.readRefs(), true);
    }
    async putOrder(input) {
        const refs = validateRefs(input);
        return this.serializeWrite(async () => {
            const existingKeys = new Set((await this.readRefsForValidation()).map(pinRefKey));
            await this.validateEntities(refs, existingKeys);
            await this.readRefsInWriteLane();
            await this.writeRefs(refs);
            await this.syncProjects(refs);
            return this.hydrate(refs, true);
        });
    }
    async validateEntities(refs, existingKeys) {
        for (const ref of refs) {
            if (ref.type === 'agent' && !(await this.options.agents.get(ref.id))) {
                if (existingKeys.has(pinRefKey(ref)))
                    continue;
                throw new PinServiceError('agent-not-found', `Agent ${ref.id} was not found`);
            }
            if (ref.type === 'session' && !(await this.options.sessions.get(ref.id))) {
                if (existingKeys.has(pinRefKey(ref)))
                    continue;
                throw new PinServiceError('session-not-found', `Session ${ref.id} was not found`);
            }
        }
    }
    async syncProjects(refs) {
        const projectRefs = refs.filter((ref) => ref.type === 'project');
        const orderedProjectIds = [];
        for (const ref of projectRefs) {
            const project = await this.resolveProject(ref.id);
            if (project)
                orderedProjectIds.push(project.projectId);
        }
        await this.syncProjectPinnedStates(new Set(orderedProjectIds));
        if (orderedProjectIds.length > 0) {
            await this.options.projectRepository.putOrder(orderedProjectIds, this.nowMs());
        }
    }
    async syncProjectPinnedStates(selected) {
        let cursor;
        do {
            const page = await this.options.projectRepository.listPage({
                includeHiddenProjects: true,
                limit: 200,
                ...(cursor ? { cursor } : {}),
            });
            for (const project of page.projects) {
                if (project.pinned !== selected.has(project.projectId)) {
                    await this.options.projectRepository.setPinned(project.projectId, selected.has(project.projectId), this.nowMs());
                }
            }
            cursor = page.hasMore ? page.nextCursor : undefined;
        } while (cursor);
    }
    async resolveProject(id) {
        if (id !== 'default' && !id.startsWith('workspace:')) {
            throw new PinServiceError('invalid-ref', `Project ref ${id} is invalid`);
        }
        try {
            return await this.options.projects.resolve({ projectKey: id });
        }
        catch {
            return undefined;
        }
    }
    async readAgentPin(id) {
        try {
            return await this.options.agents.get(id);
        }
        catch (error) {
            if (error instanceof Error &&
                'code' in error &&
                (error.code === 'AGENT_CONFIG_INVALID' || error.code === 'AGENT_CONFIG_AVATAR_INVALID')) {
                // Invalid configurations are filtered; missing Agents retain the existing placeholder behavior.
                return null;
            }
            throw error;
        }
    }
    async hydrate(refs, preserveMissing = false) {
        const items = [];
        for (const ref of refs) {
            let item;
            if (ref.type === 'agent') {
                const agent = await this.readAgentPin(ref.id);
                if (agent === null)
                    continue;
                if (agent)
                    item = { ref, agent };
            }
            else if (ref.type === 'session') {
                const session = await this.options.sessions.get(ref.id);
                if (session)
                    item = { ref, session };
            }
            else {
                const project = await this.resolveProject(ref.id);
                if (project)
                    item = { ref, project };
            }
            if (item)
                items.push(item);
            else if (preserveMissing)
                items.push({ ref });
        }
        return items;
    }
    async readRefs() {
        if (!this.options.legacyOrder && !this.options.legacyPinnedAgents) {
            return this.readStoredRefs();
        }
        if (readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
            true) {
            return this.readStoredRefs();
        }
        this.legacyMigrationPromise ??= this.serializeWrite(() => this.readRefsInWriteLane());
        return this.legacyMigrationPromise;
    }
    async readRefsInWriteLane() {
        const refs = await this.readStoredRefs();
        const legacyOrder = this.options.legacyOrder ?? (async () => []);
        if (!this.options.legacyOrder && !this.options.legacyPinnedAgents)
            return refs;
        if (readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
            true) {
            return refs;
        }
        return this.migrateLegacyOrder(refs, legacyOrder);
    }
    async readRefsForValidation() {
        const refs = await this.readStoredRefs();
        if ((!this.options.legacyOrder && !this.options.legacyPinnedAgents) ||
            readPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY) ===
                true) {
            return refs;
        }
        return this.mergeLegacyOrder(refs, this.options.legacyOrder ?? (async () => []));
    }
    async readStoredRefs() {
        const raw = readPreferenceValue(this.options.db, PINNED_ITEMS_ORDER_PREFERENCE_KEY);
        return !Array.isArray(raw)
            ? []
            : raw.flatMap((value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    return [];
                const type = Reflect.get(value, 'type');
                const id = Reflect.get(value, 'id');
                if ((type !== 'agent' && type !== 'session' && type !== 'project') ||
                    typeof id !== 'string') {
                    return [];
                }
                try {
                    return [validateRef({ type, id })];
                }
                catch {
                    return [];
                }
            });
    }
    async migrateLegacyOrder(current, legacyOrder) {
        const merged = await this.mergeLegacyOrder(current, legacyOrder);
        await this.writeRefs(merged);
        upsertPreferenceValue(this.options.db, PINNED_ITEMS_PREVIEW_TRAIN_MIGRATED_PREFERENCE_KEY, true);
        return merged;
    }
    async mergeLegacyOrder(current, legacyOrder) {
        const legacy = (await legacyOrder()).flatMap((ref) => {
            try {
                return [validateRef(ref)];
            }
            catch {
                return [];
            }
        });
        const base = legacy.length > 0 ? legacy : current;
        const seen = new Set(base.map(pinRefKey));
        const appendedCurrent = current.filter((ref) => {
            const key = pinRefKey(ref);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        const legacyAgents = (await this.options.legacyPinnedAgents?.()) ?? [];
        const appendedAgents = legacyAgents
            .flatMap((item) => {
            try {
                return [{ ref: validateRef({ type: 'agent', id: item.id }), pinnedAt: item.pinnedAt }];
            }
            catch {
                return [];
            }
        })
            .sort((left, right) => (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) ||
            pinRefKey(left.ref).localeCompare(pinRefKey(right.ref)))
            .flatMap(({ ref }) => {
            const key = pinRefKey(ref);
            if (seen.has(key))
                return [];
            seen.add(key);
            return [ref];
        });
        return [...base, ...appendedCurrent, ...appendedAgents];
    }
    async writeRefs(refs) {
        upsertPreferenceValue(this.options.db, PINNED_ITEMS_ORDER_PREFERENCE_KEY, refs);
    }
    async mutateOwnedRef(ref, present) {
        await this.serializeWrite(async () => {
            const refs = updateRefs(await this.readRefsInWriteLane(), ref, present);
            await this.writeRefs(refs);
        });
    }
    async serializeWrite(operation) {
        const previous = this.writeQueue;
        let release;
        this.writeQueue = new Promise((resolve) => {
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
}
function requireId(value, type) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new PinServiceError('invalid-ref', `${type} id is required`);
    }
    return value.trim();
}
function validateRef(ref) {
    const id = requireId(ref.id, ref.type);
    if (ref.type === 'project' && id !== 'default' && !id.startsWith('workspace:')) {
        throw new PinServiceError('invalid-ref', `Project ref ${id} is invalid`);
    }
    return { type: ref.type, id };
}
function pinRefKey(ref) {
    const id = ref.type === 'agent' && ref.id.toLowerCase().startsWith('agent:')
        ? ref.id.slice('agent:'.length)
        : ref.id;
    return `${ref.type}:${id}`;
}
function projectReferencePinRef(reference) {
    if (!reference.projectKey) {
        throw new ProjectServiceError('project-required', 'project reference is required');
    }
    return validateRef({ type: 'project', id: reference.projectKey });
}
function reorderProjectRefs(refs, ordered) {
    const orderedKeys = new Set(ordered.map(pinRefKey));
    const projects = [
        ...ordered,
        ...refs.filter((ref) => ref.type === 'project' && !orderedKeys.has(pinRefKey(ref))),
    ];
    let projectIndex = 0;
    const reordered = refs.map((ref) => ref.type === 'project' ? (projects[projectIndex++] ?? ref) : ref);
    return [...reordered, ...projects.slice(projectIndex)];
}
function validateRefs(input) {
    const seen = new Set();
    return input.map((value) => {
        const ref = validateRef(value);
        const key = pinRefKey(ref);
        if (seen.has(key))
            throw new PinServiceError('duplicate-ref', 'Pinned items must be unique');
        seen.add(key);
        return ref;
    });
}
function updateRefs(refs, item, pinned, insertIndex) {
    const key = pinRefKey(item);
    const without = refs.filter((ref) => pinRefKey(ref) !== key);
    if (!pinned)
        return without;
    const index = insertIndex === undefined || !Number.isFinite(insertIndex)
        ? without.length
        : Math.max(0, Math.min(without.length, Math.trunc(insertIndex)));
    return [...without.slice(0, index), item, ...without.slice(index)];
}
//# sourceMappingURL=service.js.map