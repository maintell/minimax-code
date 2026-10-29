import { LocalRuntimeHost, } from '../runtime/host.js';
import { DEFAULT_LOCAL_APP_MODE, resolveLocalAppMode, } from '../runtime/app-mode.js';
import { LocalSessionRouter } from './router.js';
import { applyLocalSessionListOptions } from './record-list-options.js';
export { applyLocalSessionListOptions } from './record-list-options.js';
/**
 * Bump when the per-session persisted data shape gains a new invariant.
 * Version 2 = sessions whose display-message writes maintain the session
 * asset index incrementally. Version 3 = branch sessions capture the effective
 * application mode used by the runtime; root sessions intentionally retain
 * their existing shape. Branch records without the field remain compatible
 * and resolve to the Coding default at the policy boundary.
 */
export const CURRENT_SESSION_DATA_VERSION = 3;
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
export class LocalSessionResumeError extends Error {
    constructor(sessionId) {
        super(`Local session ${sessionId} cannot resume into a new turn.`);
        this.name = 'LocalSessionResumeError';
    }
}
export class LocalSessionController {
    store;
    router;
    nowMs;
    evalReporterFactory;
    assertTurnStartAllowed;
    assertSessionMutationAllowed;
    constructor(options = {}) {
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.evalReporterFactory = options.evalReporterFactory;
        this.assertTurnStartAllowed = options.assertTurnStartAllowed ?? (() => undefined);
        this.assertSessionMutationAllowed = options.assertSessionMutationAllowed ?? (() => undefined);
        this.store = options.store ?? new InMemoryLocalSessionStore();
        this.router =
            options.router ??
                new LocalSessionRouter({
                    runtimeHost: options.runtimeHost ??
                        new LocalRuntimeHost({
                            authContextGetter: options.authContextGetter,
                            routingContextGetter: options.routingContextGetter,
                            ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
                            fetchImpl: options.fetchImpl,
                            ...(options.errorReporter ? { errorReporter: options.errorReporter } : {}),
                            ...(options.llmRequestFailureHook
                                ? { llmRequestFailureHook: options.llmRequestFailureHook }
                                : {}),
                            ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
                            ...(options.evalReporterFactory
                                ? { evalReporterFactory: options.evalReporterFactory }
                                : {}),
                        }),
                    legacyOpencodeEnabled: options.legacyOpencodeEnabled,
                    telemetry: options.telemetry,
                });
    }
    getCachedContextUsageToolCalibration(input) {
        return this.router.getCachedContextUsageToolCalibration(input);
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
            ...(input.isDefaultWorkspace !== undefined
                ? { isDefaultWorkspace: input.isDefaultWorkspace }
                : {}),
            runtime: 'pi-agent',
            sessionType,
            archived: input.archived ?? false,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
            ...(input.runLocation !== undefined ? { runLocation: input.runLocation } : {}),
            ...(sessionType === 'branch' ? { appMode: resolveLocalAppMode(input.appMode) } : {}),
            ...(input.effectiveModel !== undefined ? { effectiveModel: input.effectiveModel } : {}),
            ...(input.effectiveModelVariant !== undefined
                ? { effectiveModelVariant: input.effectiveModelVariant }
                : {}),
            ...(input.effectiveModelThinking !== undefined
                ? { effectiveModelThinking: input.effectiveModelThinking }
                : {}),
            ...(input.origin !== undefined ? { origin: input.origin } : {}),
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
        const clearsStaleError = fields.status !== undefined && fields.status !== 'error';
        const updated = {
            ...session,
            ...fields,
            ...(clearsStaleError && !Object.hasOwn(fields, 'errorMessage')
                ? { errorMessage: undefined }
                : {}),
            ...(clearsStaleError && !Object.hasOwn(fields, 'errorCode') ? { errorCode: undefined } : {}),
            ...(clearsStaleError && !Object.hasOwn(fields, 'canRetry') ? { canRetry: undefined } : {}),
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
    async startTurn(input) {
        this.assertTurnStartAllowed();
        const session = await this.store.get(input.sessionId);
        if (!session) {
            throw new Error(`Local session ${input.sessionId} not found.`);
        }
        if (session.archived) {
            throw new LocalSessionResumeError(input.sessionId);
        }
        const output = await this.router.startTurn(session, input);
        const latest = await this.store.get(input.sessionId);
        if (latest) {
            await this.store.upsert({
                ...latest,
                updatedAtMs: this.nowMs(),
            });
        }
        return output;
    }
}
//# sourceMappingURL=controller.js.map