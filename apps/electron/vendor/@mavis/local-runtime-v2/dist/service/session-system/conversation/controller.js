import { CURRENT_SESSION_DATA_VERSION } from '../../../infra/conversation/session-record.js';
import { DEFAULT_LOCAL_APP_MODE, resolveLocalAppMode, } from '../../../infra/runtime-owner/app-mode.js';
import { applyLocalSessionListOptions } from '../../../infra/conversation/record-list-options.js';
export class InMemoryLocalSessionStore {
    records = new Map();
    async get(sessionId) {
        return this.records.get(sessionId);
    }
    async upsert(record) {
        this.records.set(record.sessionId, { ...record });
    }
    async delete(sessionId) {
        this.records.delete(sessionId);
    }
    async list(options) {
        return applyLocalSessionListOptions([...this.records.values()].map((record) => ({ ...record })), options);
    }
}
export class LocalSessionController {
    store;
    nowMs;
    evalReporterFactory;
    assertSessionMutationAllowed;
    constructor(options = {}) {
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.evalReporterFactory = options.evalReporterFactory;
        this.assertSessionMutationAllowed = options.assertSessionMutationAllowed ?? (() => undefined);
        this.store = options.store ?? new InMemoryLocalSessionStore();
    }
    async createPiSession(input) {
        this.assertSessionMutationAllowed('create');
        const now = this.nowMs();
        const createdAtMs = input.createdAtMs ?? now;
        const updatedAtMs = input.updatedAtMs ?? createdAtMs;
        const sessionType = input.sessionType ?? 'branch';
        const record = {
            sessionId: input.sessionId,
            agentName: input.agentName,
            workspaceDir: input.workspaceDir,
            ...sessionCreationMetadata(input),
            runtime: 'pi-agent',
            sessionType,
            archived: input.archived ?? false,
            ...(sessionType === 'branch' ? { appMode: resolveLocalAppMode(input.appMode) } : {}),
            ...sessionCreationModel(input),
            status: input.status ?? 'idle',
            sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
            sessionOrigin: input.sessionOrigin ?? 'local-runtime',
            createdAtMs,
            updatedAtMs,
        };
        await this.store.upsert(record);
        return record;
    }
    async registerLegacyOpencodeSession(input) {
        this.assertSessionMutationAllowed('create');
        const now = this.nowMs();
        const sessionType = input.sessionType ?? 'branch';
        const record = {
            sessionId: input.sessionId,
            agentName: input.agentName,
            workspaceDir: input.workspaceDir,
            ...(input.isDefaultWorkspace !== undefined
                ? { isDefaultWorkspace: input.isDefaultWorkspace }
                : {}),
            runtime: 'opencode',
            sessionType,
            archived: input.archived ?? false,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
            status: input.status ?? 'finished',
            ...(sessionType === 'branch' ? { appMode: DEFAULT_LOCAL_APP_MODE } : {}),
            sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
            sessionOrigin: 'legacy-opencode',
            createdAtMs: input.createdAtMs ?? now,
            updatedAtMs: input.updatedAtMs ?? now,
        };
        await this.store.upsert(record);
        return record;
    }
    async getSession(sessionId) {
        return this.store.get(sessionId);
    }
    async listSessions(options) {
        return this.store.list(options);
    }
    async updateSession(sessionId, fields) {
        this.assertSessionMutationAllowed('update');
        const session = await this.store.get(sessionId);
        if (!session)
            return undefined;
        const updated = {
            ...session,
            ...fields,
            ...clearedStaleErrorFields(fields),
            updatedAtMs: fields.updatedAtMs ?? this.nowMs(),
        };
        await this.store.upsert(updated);
        if (!session.archived && updated.archived) {
            this.evalReporterFactory?.releaseReporter(sessionId);
        }
        return updated;
    }
    async deleteSession(sessionId) {
        this.assertSessionMutationAllowed('delete');
        await this.store.delete(sessionId);
        this.evalReporterFactory?.releaseReporter(sessionId);
    }
    /** Retired entry; all Turn execution is owned by the V2 Turn System. */
    async startTurn(_input) {
        throw new Error('Local Runtime V1 Conversation is unavailable: turn-start');
    }
}
function sessionCreationMetadata(input) {
    return {
        ...(input.isDefaultWorkspace !== undefined
            ? { isDefaultWorkspace: input.isDefaultWorkspace }
            : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.runLocation !== undefined ? { runLocation: input.runLocation } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
    };
}
function sessionCreationModel(input) {
    return {
        ...(input.effectiveModel !== undefined ? { effectiveModel: input.effectiveModel } : {}),
        ...(input.effectiveModelVariant !== undefined
            ? { effectiveModelVariant: input.effectiveModelVariant }
            : {}),
        ...(input.effectiveModelThinking !== undefined
            ? { effectiveModelThinking: input.effectiveModelThinking }
            : {}),
    };
}
function clearedStaleErrorFields(fields) {
    if (fields.status === undefined || fields.status === 'error')
        return {};
    return {
        ...(!Object.hasOwn(fields, 'errorMessage') ? { errorMessage: undefined } : {}),
        ...(!Object.hasOwn(fields, 'errorCode') ? { errorCode: undefined } : {}),
        ...(!Object.hasOwn(fields, 'canRetry') ? { canRetry: undefined } : {}),
    };
}
//# sourceMappingURL=controller.js.map