import { createHash, randomUUID } from 'node:crypto';
import { approvedWorkspaceRevision, assertHistoryCheckpoint, completedHandoffCheckpoint, normalizeSelectedPaths, uploadArtifacts, } from './admission/artifacts.js';
import { SessionHandoffError } from './errors.js';
import { isSensitiveHandoffPath, compareHandoffPaths, handoffFileCandidates, handoffModelCandidateBudget, recentHandoffContext, referencedHandoffPaths, } from './admission/recommendation.js';
import { checkHandoffAdmission, terminalOperation } from './admission/check-admission.js';
import { handoffConfirmationStages, handoffStage, observeHandoff, } from './admission/observability.js';
import { discardResultWorkspace, discardPublishedResultBestEffort, publishedResultMaterialization, normalizeResultChanges, preparedResultWorkspaceFromState, requirePublishedWorkspacePath, resetResultMaterialization, resultMaterializationInProgress, resolveResultTransferTicket, retryableResultApplyFailure, retryableResultPublicationFailure, } from './result-resume.js';
import { awaitTransferReceiver, cleanupTransferOrphans, completeLocalTransfer, failedUploadOperation, handleInitialTransferFailure, matchesResumeIdentity, persistMaterializingProgress, persistUploadProgress, resolvePrepareReplay, replayedArtifactBodies, replayedPrepareInput, reconcileProposalFiles, requireSourceBoundTransfer, restartRetryableUpload, resumableHandoffRecord, resumeStartUpload, retryableFailedUpload, retryableHandoffFailure, stagedSnapshotMatches, terminateLocalTransfer, } from './upload-resume.js';
const DEFAULT_RECOMMENDATION_TIMEOUT_MS = 20_000;
export class LocalSessionHandoffService {
    options;
    makeId;
    nowMs;
    starts = new Map();
    materializations = new Map();
    constructor(options) {
        this.options = options;
        this.makeId = options.makeId ?? randomUUID;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async checkAdmission(localSessionId, queryOptions) {
        return checkHandoffAdmission(this.options, this.requireStatePort(), localSessionId, {
            nowMs: this.nowMs,
            readOnly: queryOptions?.readOnly,
            signal: queryOptions?.signal,
        });
    }
    async recommend(input) {
        input.signal?.throwIfAborted();
        const identity = {
            attemptType: 'preparation',
            attemptId: input.attemptId ?? input.session.sessionId,
            sessionId: input.session.sessionId,
        };
        const scan = await handoffStage(this.options, identity, 'workspace_scan', () => this.scanWorkspace(input));
        input.signal?.throwIfAborted();
        const base = {
            workspaceDir: input.session.workspaceDir,
            files: scan.files,
            messages: input.messages,
        };
        const modelSelection = await handoffStage(this.options, identity, 'recommendation', () => this.selectRecommendedFiles(input, handoffFileCandidates(base)));
        input.signal?.throwIfAborted();
        if (modelSelection.status === 'unavailable')
            observeHandoff(this.options, {
                ...identity,
                event: 'stage_finished',
                stage: 'recommendation_fallback',
                outcome: 'degraded',
            });
        return {
            workspaceRevisionId: scan.revisionId,
            files: handoffFileCandidates({ ...base, modelSelection }),
        };
    }
    /**
     * Asks the recommendation model which catalog files this handoff should default to. Every
     * failure mode — no port, no query, rejection, unusable answer, timeout — returns
     * `unavailable`, which leaves the default selection on its tool-evidence floor.
     */
    async selectRecommendedFiles(input, catalog) {
        const port = this.options.recommendation;
        const userQuery = input.userQuery?.trim() ?? '';
        if (!port || !userQuery || catalog.length === 0)
            return { status: 'unavailable' };
        const recentContext = recentHandoffContext(input.messages);
        const controller = new AbortController();
        let expire = () => undefined;
        const expiry = new Promise((settle) => {
            expire = () => settle(undefined);
        });
        const cancel = () => {
            controller.abort(input.signal?.reason);
            expire();
        };
        input.signal?.addEventListener('abort', cancel, { once: true });
        if (input.signal?.aborted)
            cancel();
        const timer = setTimeout(() => {
            controller.abort();
            expire();
        }, this.options.recommendationTimeoutMs ?? DEFAULT_RECOMMENDATION_TIMEOUT_MS);
        try {
            const selected = await Promise.race([
                this.requestRecommendation(port, {
                    session: input.session,
                    userQuery,
                    recentContext,
                    candidates: handoffModelCandidateBudget(catalog, {
                        queryText: [userQuery, ...recentContext].join('\n'),
                    }),
                    signal: controller.signal,
                }),
                expiry,
            ]);
            return selected ?? { status: 'unavailable' };
        }
        finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', cancel);
        }
    }
    async requestRecommendation(port, request) {
        try {
            const files = await port.selectFiles(request);
            if (!Array.isArray(files))
                return undefined;
            const selection = files.filter(isHandoffModelFileSelection);
            // An answer that survives no validation is malformed output, not "nothing to add".
            if (files.length > 0 && selection.length === 0)
                return undefined;
            return { status: 'selected', files: selection };
        }
        catch {
            return undefined;
        }
    }
    async createRecommendationOperation(input) {
        const state = this.requireStatePort();
        const existing = await state.getCurrentUploadOperation(input.localSessionId);
        if (existing && !terminalOperation(existing)) {
            if (existing.dispatchId === input.dispatchId)
                return existing;
            if (existing.state === 'awaiting_approval' && (existing.expiresAtMs ?? 0) <= this.nowMs()) {
                await state.putUploadOperation({
                    ...existing,
                    state: 'expired',
                    updatedAtMs: this.nowMs(),
                });
            }
            else {
                throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Local Session already has an active Cloud handoff');
            }
        }
        const now = this.nowMs();
        const operation = {
            dispatchId: input.dispatchId,
            localSessionId: input.localSessionId,
            state: 'recommending',
            historyCheckpoint: { ...input.historyCheckpoint },
            catalogRevision: input.catalogRevision,
            files: input.files.map((file) => ({ ...file })),
            expiresAtMs: input.expiresAtMs,
            createdAtMs: now,
            updatedAtMs: now,
        };
        await state.putUploadOperation(operation);
        return operation;
    }
    async updateRecommendationCheckpoint(dispatchId, checkpoint) {
        const state = this.requireStatePort();
        const operation = await this.requireUploadOperation(state, dispatchId);
        if (operation.state === 'awaiting_approval' &&
            operation.historyCheckpoint?.turnCount === checkpoint.turnCount &&
            operation.historyCheckpoint.lastMessageId === checkpoint.lastMessageId) {
            return;
        }
        if (operation.state !== 'recommending') {
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff recommendation is no longer being finalized');
        }
        await state.putUploadOperation({
            ...operation,
            state: 'awaiting_approval',
            historyCheckpoint: { ...checkpoint },
            updatedAtMs: this.nowMs(),
        });
    }
    async beginUploadOperation(dispatchId) {
        const state = this.requireStatePort();
        const operation = await this.requireUploadOperation(state, dispatchId);
        if (operation.state === 'uploading' ||
            operation.state === 'archive_pending' ||
            operation.state === 'completed') {
            return operation;
        }
        if (operation.state === 'expired' || (operation.expiresAtMs ?? 0) <= this.nowMs()) {
            const expired = {
                ...operation,
                state: 'expired',
                retryable: false,
                updatedAtMs: this.nowMs(),
            };
            await state.putUploadOperation(expired);
            throw new SessionHandoffError('HANDOFF_EXPIRED', 'Cloud handoff approval has expired');
        }
        if (operation.state !== 'awaiting_approval' && !retryableFailedUpload(operation)) {
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff is not awaiting approval');
        }
        const uploading = restartRetryableUpload(operation, this.nowMs());
        await state.putUploadOperation(uploading);
        return uploading;
    }
    async markUploadArchivePending(dispatchId, result) {
        const state = this.requireStatePort();
        const operation = await this.requireUploadOperation(state, dispatchId);
        if (result.operationId !== dispatchId) {
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff returned a different operation ID');
        }
        if (operation.state === 'archive_pending' || operation.state === 'completed') {
            if (operation.cloudSessionId === result.cloudSessionId &&
                operation.cloudDispatchId === result.dispatchId) {
                return;
            }
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Committed Cloud handoff identity changed');
        }
        if (operation.state !== 'uploading') {
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff is not uploading');
        }
        await state.putUploadOperation({
            ...operation,
            state: 'archive_pending',
            cloudSessionId: result.cloudSessionId,
            cloudDispatchId: result.dispatchId,
            updatedAtMs: this.nowMs(),
        });
    }
    async completeUploadOperation(dispatchId) {
        const state = this.requireStatePort();
        const operation = await this.requireUploadOperation(state, dispatchId);
        if (operation.state === 'completed')
            return;
        if (operation.state !== 'archive_pending') {
            throw new SessionHandoffError('HANDOFF_OPERATION_CONFLICT', 'Cloud handoff is not awaiting Local Session archival');
        }
        await state.putUploadOperation({
            ...operation,
            state: 'completed',
            updatedAtMs: this.nowMs(),
        });
    }
    async failUploadOperation(dispatchId, error) {
        const state = this.requireStatePort();
        const operation = await this.requireUploadOperation(state, dispatchId);
        if (operation.state === 'archive_pending' ||
            operation.state === 'completed' ||
            operation.state === 'expired') {
            return;
        }
        const failed = failedUploadOperation(operation, error, this.nowMs());
        await state.putUploadOperation(failed);
        this.options.logger?.info({
            localSessionId: operation.localSessionId,
            dispatchId,
            failureCode: failed.failureCode,
            retryable: failed.retryable,
            progress: operation.progress,
        }, '[handoff-upload-failed]');
    }
    async getCurrentUploadOperation(localSessionId) {
        return this.requireStatePort().getCurrentUploadOperation(localSessionId);
    }
    async getUploadOperationByDispatchId(dispatchId) {
        return this.requireUploadOperation(this.requireStatePort(), dispatchId);
    }
    listActiveUploadOperations() {
        return this.requireStatePort().listActiveUploadOperations();
    }
    async scanWorkspace(input) {
        await this.cleanupTransferOrphans();
        completedHandoffCheckpoint(input.messages);
        let base;
        try {
            base = await this.options.workspace.scan(input.session.workspaceDir);
        }
        catch (error) {
            if (error instanceof SessionHandoffError)
                throw error;
            if (error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'WORKSPACE_SCAN_TOO_LARGE') {
                throw new SessionHandoffError('HANDOFF_SCAN_TOO_LARGE', 'Workspace scan exceeds the handoff candidate limit');
            }
            throw new SessionHandoffError('HANDOFF_SCAN_FAILED', 'Unable to scan the handoff Workspace');
        }
        const sensitivePaths = referencedHandoffPaths(input.session.workspaceDir, input.messages).filter(isSensitiveHandoffPath);
        const sensitive = sensitivePaths.length > 0
            ? await this.options.workspace.inspectSensitive?.(input.session.workspaceDir, sensitivePaths)
            : undefined;
        return mergeWorkspaceScan(base, sensitive ?? []);
    }
    async start(input) {
        const running = this.starts.get(input.dispatchId);
        if (running)
            return running;
        const identity = {
            attemptType: 'confirmation',
            attemptId: randomUUID(),
            sessionId: input.session.sessionId,
            dispatchId: input.dispatchId,
        };
        const started = this.nowMs();
        observeHandoff(this.options, {
            ...identity,
            event: 'attempt_started',
            stage: 'confirmation',
            outcome: 'started',
        });
        const operation = this.startOnce(input, identity.attemptId);
        this.starts.set(input.dispatchId, operation);
        try {
            const result = await operation;
            observeHandoff(this.options, {
                ...identity,
                event: 'attempt_finished',
                stage: 'confirmation',
                outcome: 'success',
                durationMs: this.nowMs() - started,
            });
            return result;
        }
        catch (error) {
            observeHandoff(this.options, {
                ...identity,
                event: 'attempt_finished',
                stage: 'confirmation',
                outcome: 'failed',
                durationMs: this.nowMs() - started,
                ...(error instanceof SessionHandoffError
                    ? { code: error.code, retryable: error.retryable }
                    : {}),
            });
            throw error;
        }
        finally {
            if (this.starts.get(input.dispatchId) === operation) {
                this.starts.delete(input.dispatchId);
            }
        }
    }
    async startOnce(input, attemptId) {
        const ports = this.requireStartPorts();
        const operation = await this.requireUploadOperation(ports.state, input.dispatchId);
        await this.cleanupTransferOrphans();
        const recovery = await this.recoverExisting({
            operationId: input.dispatchId,
            localSessionId: input.session.sessionId,
            workspaceDir: input.session.workspaceDir,
            selectedPaths: input.selectedPaths,
            messages: input.messages,
            operation,
        }, ports);
        if (recovery.result)
            return recovery.result;
        if (recovery.resume) {
            await this.beginUploadOperation(input.dispatchId);
            await input.onUploading?.();
            return resumeStartUpload({
                input,
                record: recovery.resume,
                ports,
                attemptId,
                options: this.options,
                nowMs: this.nowMs,
            });
        }
        assertHistoryCheckpoint(operation, input.messages);
        const plan = await handoffStage(this.options, {
            attemptType: 'confirmation',
            attemptId,
            sessionId: input.session.sessionId,
            dispatchId: input.dispatchId,
        }, 'selection_validation', () => this.buildStartUploadPlan(input, operation, ports));
        await input.onUploading?.();
        return this.executeStartUpload(input, { clientRequestId: recovery.clientRequestId, attemptId }, plan, ports);
    }
    async buildStartUploadPlan(input, operation, ports) {
        const selectedRelativePaths = await ports.resolveApprovedPaths(input.session.workspaceDir, input.selectedPaths);
        // Recommendation already persisted the complete catalog and its hashes. Approval only
        // revalidates the selected files; rescanning every unselected file makes latency scale
        // with the whole Workspace and previously included nested worktrees.
        const currentFiles = await ports.inspectExplicit(input.session.workspaceDir, selectedRelativePaths);
        const selectedPaths = normalizeSelectedPaths(selectedRelativePaths, currentFiles);
        const selectedSet = new Set(selectedPaths);
        const uploadFiles = reconcileProposalFiles(input.session.workspaceDir, operation.files ?? [], currentFiles, selectedPaths);
        const revisionId = approvedWorkspaceRevision(operation, currentFiles);
        await ports.state.putUploadOperation({
            ...operation,
            files: uploadFiles,
            catalogRevision: revisionId,
            updatedAtMs: this.nowMs(),
        });
        await this.beginUploadOperation(input.dispatchId);
        return {
            revisionId,
            selectedPaths,
            selectedFiles: currentFiles.filter((file) => selectedSet.has(file.relativePath)),
        };
    }
    async executeStartUpload(input, { clientRequestId, attemptId }, plan, ports) {
        const identity = {
            attemptType: 'confirmation',
            attemptId,
            sessionId: input.session.sessionId,
            dispatchId: input.dispatchId,
        };
        const stage = handoffConfirmationStages(this.options, identity);
        let prepared;
        let record;
        let recordPersisted = false;
        let cloudSessionId;
        let commitSucceeded = false;
        let staged;
        try {
            const operation = await this.requireUploadOperation(ports.state, input.dispatchId);
            const replay = await stage('history_summary', () => resolvePrepareReplay({
                operation,
                start: input,
                plan,
                state: ports.state,
                sourceDeviceId: () => ports.identity.getDeviceId(),
                ...(this.options.summary ? { summary: this.options.summary } : {}),
                ...(this.options.summaryTimeoutMs === undefined
                    ? {}
                    : { summaryTimeoutMs: this.options.summaryTimeoutMs }),
                nowMs: this.nowMs(),
            }));
            prepared = await stage('cloud_prepare', () => ports.cloud.prepare(replayedPrepareInput(replay, {
                clientRequestId,
                handoffOperationId: input.dispatchId,
                localSessionId: input.session.sessionId,
            })));
            const now = this.nowMs();
            record = {
                localSessionId: input.session.sessionId,
                operationId: input.dispatchId,
                clientRequestId,
                dispatchId: prepared.dispatchId,
                sourceDeviceId: replay.sourceDeviceId,
                sourceDeviceToken: prepared.sourceDeviceToken,
                workspaceDir: input.session.workspaceDir,
                workspaceRevisionId: plan.revisionId,
                state: 'prepared',
                createdAtMs: now,
                updatedAtMs: now,
            };
            await ports.state.put(record);
            recordPersisted = true;
            staged = await stage('staging', () => ports.stage({
                workspaceDir: input.session.workspaceDir,
                revisionId: plan.revisionId,
                selectedPaths: plan.selectedPaths,
                operationId: input.dispatchId,
                files: plan.selectedFiles,
            }));
            const artifactUploads = prepared.artifactUploads;
            await stage('artifact_upload', () => uploadArtifacts(ports.cloud, artifactUploads, replayedArtifactBodies(replay)));
            const transferTicket = prepared.workspaceTransfer;
            const workspaceTransfer = await stage('cloud_prepare_validation', async () => requireSourceBoundTransfer(transferTicket, plan.revisionId));
            const snapshot = {
                manifestHash: replay.workspace.manifest.manifestHash,
                files: staged.files,
            };
            record = {
                ...record,
                state: 'transferring',
                workspaceTransfer,
                stagingDir: staged.stagingDir,
                snapshot,
                updatedAtMs: this.nowMs(),
            };
            await ports.state.put(record);
            const stagingDir = staged.stagingDir;
            await stage('workspace_upload', () => ports.transfer.run({
                direction: 'upload',
                localPath: stagingDir,
                ticket: workspaceTransfer,
                snapshot,
                onProgress: (progress) => persistUploadProgress({
                    state: ports.state,
                    dispatchId: input.dispatchId,
                    progress,
                    nowMs: this.nowMs(),
                }),
            }));
            await persistMaterializingProgress({
                state: ports.state,
                dispatchId: input.dispatchId,
                snapshot,
                nowMs: this.nowMs(),
            });
            const preparedDispatch = prepared;
            await stage('materializing', () => awaitTransferReceiver({
                cloud: ports.cloud,
                dispatchId: preparedDispatch.dispatchId,
                sourceDeviceToken: preparedDispatch.sourceDeviceToken,
                ticket: workspaceTransfer,
                nowMs: this.nowMs,
                ...(this.options.transferReadyTimeoutMs === undefined
                    ? {}
                    : { timeoutMs: this.options.transferReadyTimeoutMs }),
            }));
            const committed = await stage('cloud_commit', () => ports.cloud.commit(preparedDispatch.dispatchId, preparedDispatch.sourceDeviceToken));
            commitSucceeded = true;
            cloudSessionId = committed.cloudSessionId;
            await completeLocalTransfer({
                state: ports.state,
                workspace: this.options.workspace,
                transfer: ports.transfer,
                record,
                cloudSessionId,
                nowMs: this.nowMs(),
            });
            return {
                operationId: input.dispatchId,
                dispatchId: prepared.dispatchId,
                cloudSessionId,
            };
        }
        catch (error) {
            await handleInitialTransferFailure({
                state: ports.state,
                workspace: this.options.workspace,
                transfer: ports.transfer,
                cloud: ports.cloud,
                ...(recordPersisted && record ? { record } : {}),
                ...(staged ? { stagingDir: staged.stagingDir } : {}),
                error,
                nowMs: this.nowMs(),
                commitSucceeded,
            });
            throw error;
        }
    }
    async recoverExisting(input, ports) {
        const current = await ports.state.getByLocalSession(input.localSessionId);
        if (!current || current.operationId !== input.operationId) {
            return { clientRequestId: input.operationId };
        }
        const remote = await ports.cloud.get(current.dispatchId, current.sourceDeviceToken);
        if (remote.state === 'committed') {
            if (!remote.cloudSessionId) {
                throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Committed handoff is missing its Cloud Session identity');
            }
            await completeLocalTransfer({
                state: ports.state,
                workspace: this.options.workspace,
                transfer: ports.transfer,
                record: current,
                cloudSessionId: remote.cloudSessionId,
                nowMs: this.nowMs(),
            });
            return {
                clientRequestId: current.clientRequestId,
                result: {
                    operationId: current.operationId,
                    dispatchId: current.dispatchId,
                    cloudSessionId: remote.cloudSessionId,
                },
            };
        }
        if (remote.state === 'prepared' &&
            resumableHandoffRecord(current) &&
            matchesResumeIdentity(current, {
                workspaceDir: input.workspaceDir,
                selectedPaths: input.selectedPaths,
                nowMs: this.nowMs(),
            })) {
            try {
                assertHistoryCheckpoint(input.operation, input.messages);
            }
            catch (error) {
                await terminateLocalTransfer({
                    state: ports.state,
                    workspace: this.options.workspace,
                    transfer: ports.transfer,
                    cloud: ports.cloud,
                    record: current,
                    nowMs: this.nowMs(),
                    abortRemote: true,
                });
                throw error;
            }
            if (await stagedSnapshotMatches(current, input.operation, ports.inspectExplicit)) {
                return { clientRequestId: current.clientRequestId, resume: current };
            }
        }
        await terminateLocalTransfer({
            state: ports.state,
            workspace: this.options.workspace,
            transfer: ports.transfer,
            cloud: ports.cloud,
            record: current,
            nowMs: this.nowMs(),
            abortRemote: remote.state === 'prepared',
        });
        return { clientRequestId: this.makeId() };
    }
    async cleanupTransferOrphans() {
        await cleanupTransferOrphans({
            workspace: this.options.workspace,
            ...(this.options.state ? { state: this.options.state } : {}),
            ...(this.options.transfer ? { transfer: this.options.transfer } : {}),
            ...(this.options.cloud ? { cloud: this.options.cloud } : {}),
            nowMs: this.nowMs(),
        });
    }
    async materializeResult(input) {
        const changes = await this.canonicalResultChanges(input);
        return this.materializeCanonicalResult(input, changes);
    }
    async materializeCanonicalResult(input, changes) {
        const selection = JSON.stringify(changes);
        const key = `${input.cloudSessionId}\0${input.resultId}\0${selection}`;
        const running = this.materializations.get(key);
        if (running)
            return running;
        const promise = this.materializeResultOnce(input, changes, selection);
        this.materializations.set(key, promise);
        try {
            return await promise;
        }
        finally {
            if (this.materializations.get(key) === promise) {
                this.materializations.delete(key);
            }
        }
    }
    async materializeResultOnce(input, changes, selection) {
        const ports = this.requireResultPorts();
        const record = requireCommittedHandoffRecord(await ports.state.getByCloudSession(input.cloudSessionId));
        const resolved = await this.resolveResultMaterialization(input, selection, ports.state);
        if (typeof resolved === 'string')
            return resolved;
        const prepared = await this.prepareResultMaterialization(record, input.resultId, resolved, ports);
        if (prepared.published) {
            return this.publishPreparedResult(resolved, prepared, ports);
        }
        const materialization = resultMaterializationInProgress(resolved, prepared, this.nowMs());
        await ports.state.putResultMaterialization(materialization);
        return this.transferResultMaterialization({
            input,
            changes,
            record,
            materialization,
            prepared,
            ports,
        });
    }
    async resolveResultMaterialization(input, selection, state) {
        const existing = await state.getResultMaterialization(input.cloudSessionId, input.resultId, selection);
        if (existing && existing.selection !== selection) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result Workspace materialization selection is already fixed');
        }
        if (existing?.state === 'published')
            return requirePublishedWorkspacePath(existing);
        if (existing)
            return existing;
        const now = this.nowMs();
        const selected = {
            cloudSessionId: input.cloudSessionId,
            resultId: input.resultId,
            selection,
            state: 'selected',
            createdAtMs: now,
            updatedAtMs: now,
        };
        await state.putResultMaterialization(selected);
        return selected;
    }
    async prepareResultMaterialization(record, resultId, materialization, ports) {
        if (materialization.state !== 'materializing') {
            return ports.resultWorkspace.prepare(record, resultId, this.makeId(), materialization.selection);
        }
        try {
            return await ports.resultWorkspace.resume(preparedResultWorkspaceFromState(materialization));
        }
        catch (error) {
            await ports.state.putResultMaterialization(resetResultMaterialization(materialization, this.nowMs()));
            throw error;
        }
    }
    async publishPreparedResult(materialization, prepared, ports) {
        await ports.state.putResultMaterialization(publishedResultMaterialization(materialization, prepared.workspacePath, this.nowMs()));
        await discardPublishedResultBestEffort(ports.resultWorkspace, prepared);
        return prepared.workspacePath;
    }
    async transferResultMaterialization(input) {
        let materialization = input.materialization;
        let downloaded = false;
        let applied = false;
        try {
            const ticket = await resolveResultTransferTicket({
                materialization,
                cloud: input.ports.cloud,
                delivery: input.input,
                changes: input.changes,
                source: input.record,
                nowMs: this.nowMs(),
            });
            if (!materialization.workspaceTransfer) {
                materialization = {
                    ...materialization,
                    workspaceTransfer: ticket,
                    updatedAtMs: this.nowMs(),
                };
                await input.ports.state.putResultMaterialization(materialization);
            }
            await input.ports.transfer.run({
                direction: 'download',
                localPath: input.prepared.transferPath,
                ticket,
            });
            downloaded = true;
            await input.ports.resultWorkspace.applyDownloaded({
                ...input.prepared,
                changes: input.changes,
            });
            applied = true;
            await input.ports.state.putResultMaterialization(publishedResultMaterialization(materialization, input.prepared.workspacePath, this.nowMs()));
            await discardPublishedResultBestEffort(input.ports.resultWorkspace, input.prepared);
            return input.prepared.workspacePath;
        }
        catch (error) {
            if (applied) {
                throw retryableResultPublicationFailure(error);
            }
            if (materialization.workspaceTransfer &&
                (retryableHandoffFailure(error) || (downloaded && retryableResultApplyFailure(error)))) {
                throw downloaded ? retryableResultPublicationFailure(error) : error;
            }
            await discardResultWorkspace(input.ports.resultWorkspace, input.prepared, error);
            await input.ports.state.putResultMaterialization(resetResultMaterialization(materialization, this.nowMs()));
            throw error;
        }
    }
    async downloadResult(input) {
        const changes = await this.canonicalResultChanges(input);
        if (!changes.some((change) => change.kind !== 'delete')) {
            throw new SessionHandoffError('RESULT_DOWNLOAD_EMPTY', 'Result has no downloadable files');
        }
        const sourceWorkspacePath = await this.materializeCanonicalResult(input, changes);
        return this.requireResultDelivery().download({
            sourceWorkspacePath,
            cloudSessionId: input.cloudSessionId,
            resultId: input.resultId,
            changes,
        });
    }
    async overwriteResult(input) {
        const state = this.requireStatePort();
        const record = await state.getByCloudSession(input.cloudSessionId);
        if (!record || record.state !== 'committed') {
            throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Committed Local Session handoff was not found');
        }
        const changes = await this.canonicalResultChanges(input);
        const sourceWorkspacePath = await this.materializeCanonicalResult(input, changes);
        return this.requireResultDelivery().overwrite({
            sourceWorkspacePath,
            targetWorkspacePath: record.workspaceDir,
            operationId: this.makeId(),
            changes,
        });
    }
    async canonicalResultChanges(input) {
        const selected = normalizeResultChanges(input.changes);
        const authoritative = normalizeResultChanges(await this.requireResultPorts().cloud.listResultChanges({
            cloudSessionId: input.cloudSessionId,
            resultId: input.resultId,
        }));
        const byPath = new Map(authoritative.map((change) => [change.relativePath, change]));
        return selected.map((selection) => {
            const change = byPath.get(selection.relativePath);
            if (!change) {
                throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result selection contains a path outside the authoritative change set');
            }
            return change;
        });
    }
    requireStatePort() {
        if (!this.options.state) {
            throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Session handoff state is unavailable');
        }
        return this.options.state;
    }
    async requireUploadOperation(state, dispatchId) {
        const operation = await state.getUploadOperationByDispatchId(dispatchId);
        if (!operation) {
            throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Handoff upload operation not found');
        }
        return operation;
    }
    requireResultDelivery() {
        if (!this.options.resultDelivery) {
            throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Result delivery is unavailable');
        }
        return this.options.resultDelivery;
    }
    requireStartPorts() {
        const { cloud, transfer, state, identity } = this.options;
        const { stage, resolveApprovedPaths, inspectExplicit } = this.options.workspace;
        if (!cloud ||
            !transfer ||
            !state ||
            !identity ||
            !stage ||
            !resolveApprovedPaths ||
            !inspectExplicit) {
            throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Session handoff is unavailable');
        }
        return { cloud, transfer, state, identity, stage, resolveApprovedPaths, inspectExplicit };
    }
    requireResultPorts() {
        const { cloud, transfer, state, resultWorkspace } = this.options;
        if (!cloud || !transfer || !state || !resultWorkspace) {
            throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Result Workspace materialization is unavailable');
        }
        return { cloud, transfer, state, resultWorkspace };
    }
}
/** Guards the model boundary: only well-formed entries reach path validation. */
function isHandoffModelFileSelection(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const entry = value;
    return (typeof entry.relativePath === 'string' &&
        (entry.reason === undefined || typeof entry.reason === 'string'));
}
function requireCommittedHandoffRecord(record) {
    if (!record || record.state !== 'committed') {
        throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Committed Local Session handoff was not found');
    }
    return record;
}
function mergeWorkspaceScan(base, sensitive) {
    if (sensitive.length === 0)
        return base;
    const files = new Map(base.files.map((file) => [file.relativePath, file]));
    for (const file of sensitive)
        files.set(file.relativePath, { ...file, sensitive: true });
    const sensitiveRevision = [...sensitive]
        .sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath))
        .map((file) => [file.relativePath, file.sizeBytes, file.sha256]);
    return {
        revisionId: `sha256:${sha256(JSON.stringify([base.revisionId, sensitiveRevision]))}`,
        files: [...files.values()],
    };
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
//# sourceMappingURL=session-handoff.service.js.map