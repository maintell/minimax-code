import { resolve } from 'node:path';
import { LocalSessionHandoffUploadState, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { isTaskSession, SessionServiceError } from '../../service/session-system/index.js';
import { completedHandoffCheckpoint, SessionHandoffError, handoffStage, } from '../../service/session-handoff/index.js';
import { AppError } from '../errors.js';
const HISTORY_PAGE_SIZE = 500;
const MAX_HISTORY_PAGES = 20;
const HANDOFF_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const HANDOFF_ERROR_STATUS = {
    HANDOFF_UNAVAILABLE: 404,
    HANDOFF_SCAN_TOO_LARGE: 409,
    HANDOFF_SCAN_FAILED: 409,
    HANDOFF_HISTORY_INVALID: 409,
    HANDOFF_CLOUD_PREPARE_FAILED: 409,
    HANDOFF_UPLOAD_FAILED: 409,
    HANDOFF_MATERIALIZATION_FAILED: 409,
    HANDOFF_COMMIT_FAILED: 409,
    HANDOFF_RECORD_NOT_FOUND: 404,
    HANDOFF_SELECTION_INVALID: 400,
    // 选中文件已被删除同样是"这次选择需要修正",不是资源路由缺失:用 400 与
    // HANDOFF_SELECTION_INVALID 对齐,避免端上把它与 404 路由错误混为一谈。
    HANDOFF_FILE_NOT_FOUND: 400,
    RESULT_DOWNLOAD_EMPTY: 400,
    WORKSPACE_REVISION_STALE: 409,
    HANDOFF_OPERATION_CONFLICT: 409,
    HANDOFF_PROPOSAL_STALE: 409,
    HANDOFF_EXPIRED: 409,
    HANDOFF_ARTIFACT_INVALID: 409,
};
const SESSION_ERROR_STATUS = {
    'agent-not-found': { status: 404, key: 'AGENT_NOT_FOUND' },
    'workspace-required': { status: 400, key: 'WORKSPACE_REQUIRED' },
    'parent-not-found': { status: 404, key: 'SESSION_PARENT_NOT_FOUND' },
    'invalid-session-kind': { status: 400, key: 'INVALID_SESSION_KIND' },
    'parent-required': { status: 400, key: 'SESSION_PARENT_REQUIRED' },
    'session-not-found': { status: 404, key: 'SESSION_NOT_FOUND' },
    'session-busy': { status: 409, key: 'SESSION_BUSY' },
    'maintenance-lease-lost': { status: 409, key: 'SESSION_MAINTENANCE_LEASE_LOST' },
    'content-policy-rejected': { status: 422, key: 'CONTENT_POLICY_VIOLATION' },
    'runtime-unsupported': { status: 409, key: 'OPENCODE_MUTATION_UNAVAILABLE' },
    'session-id-conflict': { status: 409, key: 'SESSION_ID_CONFLICT' },
    'run-location-invalid': { status: 400, key: 'RUN_LOCATION_INVALID' },
    'memory-recall-locked': { status: 409, key: 'MEMORY_RECALL_LOCKED' },
    'task-agent-capture-unavailable': {
        status: 503,
        key: 'TASK_AGENT_CAPTURE_UNAVAILABLE',
    },
};
export class SessionHandoffApplication {
    options;
    backgroundUploads = new Map();
    finalizeRecoveries = new Map();
    detachedTasks = new Map();
    closed = false;
    closePromise;
    constructor(options) {
        this.options = options;
    }
    close() {
        if (this.closePromise)
            return this.closePromise;
        this.closed = true;
        this.closePromise = this.drainDetachedTasks();
        return this.closePromise;
    }
    async prepareHostedCloudHandoffAdmission(localSessionId, dispatchId, userQuery, execution) {
        return this.invoke(async () => {
            const assertExecution = () => {
                execution?.signal.throwIfAborted();
                if (execution && !execution.ownsTurn()) {
                    throw new AppError(409, 'HANDOFF_SESSION_STATE_INVALID', 'Handoff Turn ownership was lost');
                }
            };
            assertExecution();
            const identity = {
                attemptType: 'preparation',
                attemptId: execution?.turnId ?? dispatchId,
                sessionId: localSessionId,
                dispatchId,
            };
            const stage = (name, operation) => handoffStage(execution?.diagnostics ?? {}, identity, name, operation);
            const snapshot = await stage('session_history', () => this.snapshotForHostedAdmission(localSessionId, execution));
            if (!snapshot)
                return { deferred: true };
            let eligibility;
            try {
                eligibility = await stage('preflight', () => this.options.handoff.checkAdmission(localSessionId, execution ? { signal: execution.signal } : undefined));
            }
            catch {
                execution?.signal.throwIfAborted();
                throw new AppError(503, 'HANDOFF_PREFLIGHT_CHECK_FAILED', 'Unable to check Cloud handoff eligibility');
            }
            assertExecution();
            if (eligibility !== 'allowed')
                return { denied: eligibility };
            const recommendation = await this.options.handoff.recommend({
                ...snapshot,
                ...(execution ? { signal: execution.signal, attemptId: execution.turnId } : {}),
                ...(userQuery ? { userQuery } : {}),
            });
            assertExecution();
            if (!recommendation.workspaceRevisionId) {
                throw new AppError(409, 'HANDOFF_RECOMMENDATION_INVALID', 'Cloud handoff recommendation is missing its Workspace catalog revision');
            }
            const proposal = {
                dispatchId,
                localSessionId,
                historyCheckpoint: completedHandoffCheckpoint(snapshot.messages),
                catalogRevision: recommendation.workspaceRevisionId,
                files: recommendation.files.map((file) => ({
                    ...file,
                    absolutePath: resolve(snapshot.session.workspaceDir, file.relativePath),
                    selected: file.recommended,
                })),
                expiresAtMs: (this.options.nowMs ?? Date.now)() + HANDOFF_APPROVAL_TTL_MS,
            };
            let committed = false;
            return {
                dispatchId,
                commit: async () => {
                    assertExecution();
                    await stage('proposal_commit', () => this.options.handoff.createRecommendationOperation(proposal));
                    committed = true;
                },
                compensate: async () => {
                    if (!committed)
                        return;
                    await this.options.handoff.failUploadOperation(dispatchId, new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff Turn admission was compensated'));
                },
            };
        });
    }
    async completeHostedCloudHandoffAnnouncement(localSessionId, dispatchId) {
        return this.invoke(async () => {
            const operation = await this.options.handoff.getUploadOperationByDispatchId(dispatchId);
            if (operation.localSessionId !== localSessionId) {
                throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Cloud handoff announcement belongs to another Local Session');
            }
            const messages = await this.readHistory(localSessionId);
            await this.options.handoff.updateRecommendationCheckpoint(dispatchId, completedHandoffCheckpoint(messages));
        });
    }
    async failHostedCloudHandoffAnnouncement(dispatchId, reason) {
        return this.invoke(() => this.options.handoff.failUploadOperation(dispatchId, new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', reason)));
    }
    async getHostedCloudHandoffProposal(localSessionId) {
        const operation = await this.options.handoff.getCurrentUploadOperation(localSessionId);
        return operation && !terminalUploadOperation(operation)
            ? { dispatchId: operation.dispatchId }
            : undefined;
    }
    async recoverPendingUploads() {
        if (this.closed)
            return;
        const operations = await this.options.handoff.listActiveUploadOperations();
        for (const operation of operations) {
            if (this.closed)
                return;
            if (operation.state === 'recommending') {
                await this.recoverRecommendingOperation(operation);
                continue;
            }
            if (operation.state === 'archive_pending') {
                try {
                    await this.ensureFinalizeRecovery(operation);
                }
                catch {
                    // Durable archive_pending state is retried by summary polling and next startup.
                }
                continue;
            }
            if (operation.state !== 'uploading')
                continue;
            const selectedPaths = persistedUploadSelection(operation);
            if (!selectedPaths) {
                await this.options.handoff.failUploadOperation(operation.dispatchId, new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Recovering Cloud handoff has no persisted selection'));
                continue;
            }
            const background = this.ensureBackgroundUpload(operation, selectedPaths, true);
            this.detach(background.uploading);
        }
    }
    async approveLocalSessionHandoff(_context, req) {
        return this.invoke(async () => {
            const selectedPaths = req.selectedPaths;
            if (!selectedPaths) {
                throw new AppError(400, 'HANDOFF_SELECTION_INVALID', 'Local Session handoff selection is required', true);
            }
            // 显式空数组只派发会话,不上传 Workspace 文件。
            const operation = await this.options.handoff.getUploadOperationByDispatchId(req.dispatchId);
            if (operation.localSessionId !== req.id) {
                throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Cloud handoff does not belong to this Local Session');
            }
            const session = await this.options.sessions.get(req.id);
            if (!session)
                throw new AppError(404, 'SESSION_NOT_FOUND', 'Local Session was not found');
            assertHandoffSessionScope(session);
            if (operation.state === 'recommending') {
                return {
                    dispatchId: operation.dispatchId,
                    uploadState: LocalSessionHandoffUploadState.AwaitingApproval,
                };
            }
            if (operation.state === 'completed') {
                return {
                    dispatchId: operation.dispatchId,
                    uploadState: LocalSessionHandoffUploadState.Completed,
                };
            }
            if (operation.state === 'archive_pending') {
                this.detach(this.ensureFinalizeRecovery(operation));
                return {
                    dispatchId: operation.dispatchId,
                    uploadState: LocalSessionHandoffUploadState.Uploading,
                };
            }
            if (operation.state === 'expired') {
                throw new SessionHandoffError('HANDOFF_EXPIRED', `Cloud handoff is ${operation.state}`, false);
            }
            if (operation.state === 'failed' && operation.retryable !== true) {
                throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', `Cloud handoff is ${operation.state}`, false);
            }
            const background = this.ensureBackgroundUpload(operation, selectedPaths, false);
            await background.uploading;
            const current = await this.options.handoff.getUploadOperationByDispatchId(req.dispatchId);
            return {
                dispatchId: current.dispatchId,
                uploadState: uploadState(current.state),
            };
        });
    }
    async getLocalSessionHandoffEligibility(_ctx, req) {
        return this.invoke(async () => {
            const session = await this.options.sessions.get(req.id);
            if (!session) {
                throw new AppError(404, 'SESSION_NOT_FOUND', 'Local Session was not found');
            }
            if (!isPrimaryHandoffSession(session)) {
                return { allowed: false, reason: 'subagent-unsupported' };
            }
            const reason = await this.options.handoff.checkAdmission(req.id, { readOnly: true });
            return { allowed: reason === 'allowed', reason };
        });
    }
    async getSessionHandoffSummary(_context, req) {
        return this.invoke(async () => {
            const operation = await this.options.handoff.getUploadOperationByDispatchId(req.dispatchId);
            if (operation.state === 'archive_pending') {
                this.detach(this.ensureFinalizeRecovery(operation));
            }
            const files = operation.files?.map((file) => ({
                relativePath: file.relativePath,
                ...(file.absolutePath ? { absolutePath: file.absolutePath } : {}),
                reason: file.reason,
                sizeBytes: file.sizeBytes,
                sensitive: file.sensitive,
                recommended: file.recommended,
                selected: file.selected,
            }));
            return {
                summary: {
                    dispatchId: req.dispatchId,
                    uploadState: uploadState(operation.state),
                    ...(files ? { files, fileCount: files.length } : {}),
                    ...(files
                        ? { totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0) }
                        : {}),
                    ...(operation.expiresAtMs ? { expiresAtMs: operation.expiresAtMs } : {}),
                    ...(operation.cloudSessionId ? { cloudSessionId: operation.cloudSessionId } : {}),
                    ...(operation.failureCode ? { failureCode: operation.failureCode } : {}),
                    ...(operation.failureMessage ? { failureMessage: operation.failureMessage } : {}),
                    ...(operation.progress ? { progress: operation.progress } : {}),
                    ...(operation.retryable !== undefined ? { retryable: operation.retryable } : {}),
                },
            };
        });
    }
    async downloadSessionResult(_context, req) {
        return this.invoke(async () => {
            const result = await this.options.handoff.downloadResult({
                cloudSessionId: req.id,
                resultId: req.resultId,
                changes: resultChanges(req.changes),
            });
            return { downloadPath: result.downloadPath, archive: result.archive };
        });
    }
    async overwriteSessionResult(_context, req) {
        return this.invoke(async () => {
            if (!req.confirmed) {
                throw new AppError(400, 'HANDOFF_OVERWRITE_CONFIRMATION_REQUIRED', 'Result overwrite requires explicit confirmation');
            }
            const workspacePath = await this.options.handoff.overwriteResult({
                cloudSessionId: req.id,
                resultId: req.resultId,
                changes: resultChanges(req.changes),
            });
            return { workspacePath };
        });
    }
    // A `recommending` operation is only durable once the announcement marker is in
    // history; without it the pre-restart announcement never completed.
    async recoverRecommendingOperation(operation) {
        const messages = await this.readHistory(operation.localSessionId);
        if (containsCanonicalHandoffMarker(messages, operation.dispatchId)) {
            await this.options.handoff.updateRecommendationCheckpoint(operation.dispatchId, completedHandoffCheckpoint(messages));
            return;
        }
        await this.options.handoff.failUploadOperation(operation.dispatchId, new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff announcement was not durably completed before restart'));
    }
    // 派发不再封存 Local Session:上传完成后本地会话保持可用,用户可以继续在桌面端
    // 对话。持久化状态仍叫 archive_pending —— 它现在的含义是"云端身份已提交、本地
    // 收尾未完成",旧版本写下的行也要能被这里收敛,所以不改状态名。
    ensureFinalizeRecovery(operation) {
        this.requireOpen();
        const existing = this.finalizeRecoveries.get(operation.dispatchId);
        if (existing)
            return existing;
        const recovery = this.options.handoff.completeUploadOperation(operation.dispatchId);
        this.finalizeRecoveries.set(operation.dispatchId, recovery);
        this.detach(this.clearFinalizeRecovery(operation.dispatchId, recovery));
        return recovery;
    }
    async clearFinalizeRecovery(dispatchId, recovery) {
        try {
            await recovery;
        }
        catch {
            // The original recovery promise remains observable to its caller.
        }
        finally {
            if (this.finalizeRecoveries.get(dispatchId) === recovery) {
                this.finalizeRecoveries.delete(dispatchId);
            }
        }
    }
    ensureBackgroundUpload(operation, selectedPaths, recovering) {
        this.requireOpen();
        const selection = selectionIdentity(selectedPaths);
        const existing = this.backgroundUploads.get(operation.dispatchId);
        if (existing) {
            if (existing.selection !== selection) {
                throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff approval is already uploading a different selection');
            }
            return existing;
        }
        let resolveUploading;
        let rejectUploading;
        const uploading = new Promise((resolvePromise, rejectPromise) => {
            resolveUploading = resolvePromise;
            rejectUploading = rejectPromise;
        });
        const completion = this.runBackgroundUpload(operation, selectedPaths, recovering, {
            resolve: resolveUploading,
            reject: rejectUploading,
        });
        const background = { selection, uploading, completion };
        this.backgroundUploads.set(operation.dispatchId, background);
        this.detach(this.clearBackgroundUpload(operation.dispatchId, background));
        return background;
    }
    async runBackgroundUpload(operation, selectedPaths, recovering, signal) {
        // `onUploading` 只在选择完成复核、持久化状态进入 uploading 后触发。可选摘要、
        // Cloud prepare 与字节传输继续在后台执行;此前失败仍可修正选择后重试。
        let uploadingStarted = false;
        const markUploading = () => {
            uploadingStarted = true;
            signal.resolve();
        };
        try {
            await this.options.maintenance.runExclusive(operation.localSessionId, async (lane) => {
                const snapshot = await lane.run(() => recovering
                    ? this.snapshotForRecovery(operation.localSessionId)
                    : this.snapshot(operation.localSessionId));
                const result = await lane.run(() => this.options.handoff.start({
                    ...snapshot,
                    dispatchId: operation.dispatchId,
                    selectedPaths,
                    onUploading: markUploading,
                }));
                await this.options.handoff.markUploadArchivePending(operation.dispatchId, result);
                markUploading();
                await this.options.handoff.completeUploadOperation(operation.dispatchId);
            });
        }
        catch (error) {
            try {
                // 调用方传错选择(相对路径、已不在当前 revision 里的文件)只是入参问题:
                // 这类错误在 buildStartUploadPlan 阶段抛出,什么都还没发生。此前无差别
                // 落成终态 failed,会让整条 Dispatch 永久不可用——之后带正确路径重试一律
                // 409 HANDOFF_OPERATION_CONFLICT,用户只能从头重新发起派发。保持原状态,
                // 让端上改正选择后重新 approve。
                // 恢复路径(recovering)用的是已持久化且验证过的选择,继续按原样落终态,
                // 避免启动时反复重试同一份坏数据。
                if (recovering || uploadingStarted || !isRetryableSelectionError(error)) {
                    await this.options.handoff.failUploadOperation(operation.dispatchId, error);
                }
            }
            finally {
                signal.reject(error);
            }
        }
    }
    async clearBackgroundUpload(dispatchId, background) {
        try {
            await background.completion;
        }
        finally {
            if (this.backgroundUploads.get(dispatchId) === background) {
                this.backgroundUploads.delete(dispatchId);
            }
        }
    }
    detach(task) {
        const key = Symbol('session-handoff-detached-task');
        const observation = this.observeDetachedTask(key, task);
        this.detachedTasks.set(key, observation);
    }
    async observeDetachedTask(key, task) {
        try {
            await task;
        }
        catch {
            // Durable state owns retry; detached observers prevent unhandled rejections.
        }
        finally {
            this.detachedTasks.delete(key);
        }
    }
    async drainDetachedTasks() {
        while (this.detachedTasks.size > 0) {
            await Promise.all(this.detachedTasks.values());
        }
    }
    requireOpen() {
        if (!this.closed)
            return;
        throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Session handoff is closing');
    }
    async snapshotForRecovery(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw new AppError(404, 'SESSION_NOT_FOUND', 'Local Session was not found');
        return { session, messages: await this.readHistory(sessionId) };
    }
    async snapshotForHostedAdmission(sessionId, execution) {
        try {
            return await this.snapshot(sessionId, execution);
        }
        catch (error) {
            // Only transient execution occupancy may keep a handoff queued.
            if (error instanceof AppError && error.key === 'SESSION_HANDOFF_BUSY')
                return undefined;
            throw error;
        }
    }
    async snapshot(sessionId, execution) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw new AppError(404, 'SESSION_NOT_FOUND', 'Local Session was not found');
        execution?.signal.throwIfAborted();
        assertDispatchable(session, execution?.ownsTurn() === true);
        const messages = (await this.readHistory(sessionId)).filter((message) => !execution ||
            (message.turnId ?? message.turn_id ?? message.meta?.turnId) !== execution.turnId);
        execution?.signal.throwIfAborted();
        return { session, messages };
    }
    async readHistory(sessionId) {
        const result = [];
        let before;
        for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
            let page;
            try {
                page = await this.options.messages.list(sessionId, {
                    limit: HISTORY_PAGE_SIZE,
                    ...(before ? { before } : {}),
                });
            }
            catch {
                throw new AppError(503, 'HANDOFF_HISTORY_UNAVAILABLE', 'Unable to read handoff history');
            }
            result.unshift(...page.messages);
            if (!page.hasMore || !page.nextCursor) {
                const failedTurns = new Set(result
                    .filter((message) => message.preparation_error)
                    .map((message) => message.turnId ?? message.turn_id ?? message.meta?.turnId)
                    .filter((turnId) => typeof turnId === 'string'));
                return result.filter((message) => {
                    const turnId = message.turnId ?? message.turn_id ?? message.meta?.turnId;
                    return typeof turnId !== 'string' || !failedTurns.has(turnId);
                });
            }
            before = page.nextCursor;
        }
        throw new AppError(409, 'HANDOFF_HISTORY_TOO_LARGE', 'Local Session history is too large');
    }
    async invoke(operation) {
        try {
            return await operation();
        }
        catch (error) {
            throw handoffApplicationError(error);
        }
    }
}
function assertDispatchable(session, ownsAcceptedTurn = false) {
    assertHandoffSessionScope(session);
    if (session.archived)
        throw new AppError(409, 'HANDOFF_SESSION_ARCHIVED', 'Session is archived');
    if (session.runtime !== 'pi-agent')
        throw new AppError(409, 'HANDOFF_RUNTIME_UNSUPPORTED', 'Runtime does not support handoff');
    if (session.isDefaultWorkspace || !session.workspaceDir.trim())
        throw new AppError(409, 'HANDOFF_WORKSPACE_REQUIRED', 'Handoff requires a Workspace');
    if (session.status === 'started') {
        if (ownsAcceptedTurn)
            return;
        throw new AppError(409, 'SESSION_HANDOFF_BUSY', 'Local Session is busy');
    }
    // A failed or aborted previous Turn does not block a new handoff attempt.
    // Turn admission and assertExecution still protect execution ownership.
    if (session.status !== 'idle' && session.status !== 'aborted' && session.status !== 'error') {
        throw new AppError(409, 'HANDOFF_SESSION_STATE_INVALID', 'Local Session cannot be handed off');
    }
}
function isPrimaryHandoffSession(session) {
    // Reserved primary owners include legacy main. A delegated Task can use the
    // primary owner too, so checking the Agent name alone is insufficient.
    return (session.agentName === 'mavis' || session.agentName === 'main') && !isTaskSession(session);
}
function assertHandoffSessionScope(session) {
    if (!isPrimaryHandoffSession(session)) {
        throw new AppError(409, 'HANDOFF_SUBAGENT_UNSUPPORTED', 'Subagent sessions cannot be handed off to the cloud', false);
    }
}
function handoffApplicationError(error) {
    if (error instanceof AppError)
        return error;
    if (error instanceof SessionServiceError) {
        const mapping = SESSION_ERROR_STATUS[error.reason];
        return new AppError(mapping.status, error.detailCode ?? mapping.key, error.message);
    }
    if (!(error instanceof SessionHandoffError))
        return error;
    return new AppError(HANDOFF_ERROR_STATUS[error.code], error.code, error.message, error.retryable || isRetryableSelectionError(error));
}
function persistedUploadSelection(operation) {
    if (!operation.files)
        return undefined;
    const selectedPaths = [];
    for (const file of operation.files) {
        if (!file.selected)
            continue;
        if (!file.absolutePath)
            return undefined;
        selectedPaths.push(file.absolutePath);
    }
    return selectedPaths;
}
function requireNonEmptySelection(value, message) {
    if (!value || value.length === 0) {
        throw new AppError(400, 'HANDOFF_SELECTION_INVALID', message);
    }
    return value;
}
function resultChanges(value) {
    return requireNonEmptySelection(value, 'Session result changes are required').map((change) => ({
        relativePath: change.relativePath,
        kind: resultChangeKind(change.kind),
    }));
}
function containsCanonicalHandoffMarker(messages, dispatchId) {
    const marker = `<cloud-session-handoff dispatch-id="${dispatchId}" />`;
    return messages.some((message) => message.role === 'assistant' &&
        typeof message.msg_content === 'string' &&
        message.msg_content.includes(marker));
}
function uploadState(value) {
    switch (value) {
        case 'recommending':
            return LocalSessionHandoffUploadState.AwaitingApproval;
        case 'awaiting_approval':
            return LocalSessionHandoffUploadState.AwaitingApproval;
        case 'uploading':
        case 'archive_pending':
            return LocalSessionHandoffUploadState.Uploading;
        case 'completed':
            return LocalSessionHandoffUploadState.Completed;
        case 'failed':
            return LocalSessionHandoffUploadState.Failed;
        case 'expired':
            return LocalSessionHandoffUploadState.Expired;
    }
}
function terminalUploadOperation(operation) {
    return (operation.state === 'completed' || operation.state === 'failed' || operation.state === 'expired');
}
// 选择非法是调用方入参问题,选中文件被删除则是本地事实变了;两者都只会在
// buildStartUploadPlan(暂存与上传之前)抛出,因此 Dispatch 仍可用修正后的选择
// 重新 approve,不该被落成终态 failed。
const RETRYABLE_SELECTION_CODES = {
    HANDOFF_SELECTION_INVALID: true,
    HANDOFF_FILE_NOT_FOUND: true,
};
function isRetryableSelectionError(error) {
    return error instanceof SessionHandoffError && RETRYABLE_SELECTION_CODES[error.code] === true;
}
function selectionIdentity(paths) {
    return JSON.stringify([...new Set(paths)].sort((left, right) => left.localeCompare(right)));
}
function resultChangeKind(value) {
    const normalized = value.toLowerCase();
    if (normalized === 'add' || normalized === 'modify' || normalized === 'delete') {
        return normalized;
    }
    throw new AppError(400, 'SESSION_RESULT_CHANGE_INVALID', 'Result change kind is invalid');
}
//# sourceMappingURL=handoff-application.js.map