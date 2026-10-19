import { isAbsolute, relative, resolve, sep } from 'node:path';
import { approvedWorkspaceRevision, buildHandoffArtifacts, latestUserContent, redactedHandoffMessages, } from './admission/artifacts.js';
import { summaryInputMessages } from './admission/history-digest.js';
import { handoffCloudModel } from './admission/model-selection.js';
import { compareHandoffPaths } from './admission/recommendation.js';
import { summarizeHandoffHistory } from './admission/summarize.js';
import { SessionHandoffError } from './errors.js';
import { handoffConfirmationStages } from './admission/observability.js';
export async function resumeStartUpload({ input, record, ports, attemptId, options, nowMs, }) {
    const identity = {
        attemptType: 'confirmation',
        attemptId,
        sessionId: input.session.sessionId,
        dispatchId: input.dispatchId,
    };
    const stage = handoffConfirmationStages(options, identity);
    let commitSucceeded = false;
    try {
        await stage('workspace_upload', () => ports.transfer.run({
            direction: 'upload',
            localPath: record.stagingDir,
            ticket: record.workspaceTransfer,
            snapshot: record.snapshot,
            onProgress: (progress) => persistUploadProgress({
                state: ports.state,
                dispatchId: input.dispatchId,
                progress,
                nowMs: nowMs(),
            }),
        }));
        await persistMaterializingProgress({
            state: ports.state,
            dispatchId: input.dispatchId,
            snapshot: record.snapshot,
            nowMs: nowMs(),
        });
        await stage('materializing', () => awaitTransferReceiver({
            cloud: ports.cloud,
            dispatchId: record.dispatchId,
            sourceDeviceToken: record.sourceDeviceToken,
            ticket: record.workspaceTransfer,
            nowMs,
            ...(options.transferReadyTimeoutMs === undefined
                ? {}
                : { timeoutMs: options.transferReadyTimeoutMs }),
        }));
        const committed = await stage('cloud_commit', () => ports.cloud.commit(record.dispatchId, record.sourceDeviceToken));
        commitSucceeded = true;
        await completeLocalTransfer({
            state: ports.state,
            workspace: options.workspace,
            transfer: ports.transfer,
            record,
            cloudSessionId: committed.cloudSessionId,
            nowMs: nowMs(),
        });
        return {
            operationId: record.operationId,
            dispatchId: record.dispatchId,
            cloudSessionId: committed.cloudSessionId,
        };
    }
    catch (error) {
        if (commitSucceeded || retryableHandoffFailure(error))
            throw error;
        await terminateLocalTransfer({
            state: ports.state,
            workspace: options.workspace,
            transfer: ports.transfer,
            cloud: ports.cloud,
            record,
            nowMs: nowMs(),
            abortRemote: true,
        });
        throw error;
    }
}
const TRANSFER_READY_POLL_MS = 300;
const DEFAULT_TRANSFER_READY_TIMEOUT_MS = 10 * 60_000;
// Cloud role, not the local storage owner (upgraded installs may still use main).
const CLOUD_HANDOFF_AGENT_NAME = 'mavis';
function freezePrepareReplay(input) {
    return {
        sourceDeviceId: input.sourceDeviceId,
        selectedPaths: [...input.selectedPaths],
        ...input.request,
        artifactBodies: [...input.bodies].map(([kind, body]) => ({
            kind,
            base64: Buffer.from(body).toString('base64'),
        })),
    };
}
export async function resolvePrepareReplay(input) {
    if (input.operation.prepareReplay) {
        if (!prepareReplayMatchesPlan(input.operation.prepareReplay, input.plan)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Approved Workspace selection changed after Prepare began');
        }
        return input.operation.prepareReplay;
    }
    const redacted = summaryInputMessages(redactedHandoffMessages(input.start, input.plan.selectedFiles), latestUserContent(input.start.messages));
    const summary = await summarizeHandoffHistory({
        ...(input.summary ? { port: input.summary } : {}),
        ...(input.summaryTimeoutMs === undefined ? {} : { timeoutMs: input.summaryTimeoutMs }),
        session: input.start.session,
        redactedMessages: redacted,
    });
    const artifacts = buildHandoffArtifacts(input.start, input.plan.revisionId, input.plan.selectedFiles, summary);
    const replay = freezePrepareReplay({
        sourceDeviceId: await input.sourceDeviceId(),
        selectedPaths: input.plan.selectedPaths,
        request: {
            checkpoint: artifacts.checkpoint,
            sessionSpec: {
                agentName: CLOUD_HANDOFF_AGENT_NAME,
                ...(input.start.session.title ? { title: input.start.session.title } : {}),
                model: handoffCloudModel(input.start.session),
            },
            artifacts: artifacts.descriptors,
            workspace: artifacts.workspace,
        },
        bodies: artifacts.bodies,
    });
    await input.state.putUploadOperation({
        ...input.operation,
        prepareReplay: replay,
        updatedAtMs: input.nowMs,
    });
    return replay;
}
export function replayedPrepareInput(replay, input) {
    return {
        ...input,
        sourceDeviceId: replay.sourceDeviceId,
        checkpoint: replay.checkpoint,
        sessionSpec: replay.sessionSpec,
        artifacts: replay.artifacts,
        workspace: replay.workspace,
    };
}
export function replayedArtifactBodies(replay) {
    return new Map(replay.artifactBodies.map(({ kind, base64 }) => [kind, Buffer.from(base64, 'base64')]));
}
function prepareReplayMatchesPlan(replay, plan) {
    return (replay.workspace.revisionId === plan.revisionId &&
        replay.selectedPaths.length === plan.selectedPaths.length &&
        replay.selectedPaths.every((path, index) => path === plan.selectedPaths[index]));
}
export function resumableHandoffRecord(record) {
    return (record.state === 'transferring' &&
        record.workspaceTransfer !== undefined &&
        record.stagingDir !== undefined &&
        record.snapshot !== undefined);
}
export function matchesResumeIdentity(record, input) {
    return (record.workspaceTransfer.expiresAt > input.nowMs &&
        resolve(record.workspaceDir) === resolve(input.workspaceDir) &&
        ticketMatchesSource(record.workspaceTransfer, record.workspaceRevisionId) &&
        selectedPathsMatch(input.workspaceDir, input.selectedPaths, record.snapshot.files));
}
export async function stagedSnapshotMatches(record, operation, inspectExplicit) {
    try {
        const stagedFiles = await inspectExplicit(record.stagingDir, record.snapshot.files.map((file) => file.relativePath));
        return (sameSnapshotFiles(stagedFiles, record.snapshot.files) &&
            approvedWorkspaceRevision(operation, stagedFiles) === record.workspaceRevisionId);
    }
    catch {
        return false;
    }
}
export function requireSourceBoundTransfer(ticket, workspaceRevisionId) {
    if (!ticket) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Workspace handoff returned no transfer ticket', false, { reason: 'missing_transfer_ticket' });
    }
    if (!ticketMatchesSource(ticket, workspaceRevisionId)) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Workspace transfer ticket does not match the approved Workspace revision', false, { reason: 'invalid_response' });
    }
    return ticket;
}
export function reconcileProposalFiles(workspaceDir, proposedFiles, scannedFiles, selectedPaths) {
    const selectedSet = new Set(selectedPaths);
    const scanByPath = new Map(scannedFiles.map((file) => [file.relativePath, file]));
    const result = [...proposedFiles];
    const proposedByPath = new Map(result.map((file) => [file.relativePath, file]));
    for (const relativePath of selectedPaths) {
        const proposed = proposedByPath.get(relativePath);
        const current = requireApprovedWorkspaceFile(proposed, scanByPath.get(relativePath));
        if (!proposed) {
            const added = {
                relativePath,
                absolutePath: resolve(workspaceDir, relativePath),
                reason: 'Added by user',
                sizeBytes: current.sizeBytes,
                sha256: current.sha256,
                sensitive: current.sensitive === true,
                recommended: false,
                selected: true,
            };
            result.push(added);
            proposedByPath.set(relativePath, added);
        }
    }
    return result
        .map((file) => ({ ...file, selected: selectedSet.has(file.relativePath) }))
        .sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath));
}
function requireApprovedWorkspaceFile(proposed, current) {
    if (!current) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Selected Workspace file is unavailable');
    }
    if (proposed &&
        (current.sha256 !== proposed.sha256 || current.sizeBytes !== proposed.sizeBytes)) {
        throw new SessionHandoffError('WORKSPACE_REVISION_STALE', 'A selected Workspace file changed after approval');
    }
    return current;
}
function terminalHandoffRecord(record, input) {
    const terminal = {
        localSessionId: record.localSessionId,
        operationId: record.operationId,
        clientRequestId: record.clientRequestId,
        dispatchId: record.dispatchId,
        sourceDeviceId: record.sourceDeviceId,
        sourceDeviceToken: record.sourceDeviceToken,
        workspaceDir: record.workspaceDir,
        workspaceRevisionId: record.workspaceRevisionId,
        state: input.state,
        createdAtMs: record.createdAtMs,
        updatedAtMs: input.updatedAtMs,
    };
    return input.cloudSessionId ? { ...terminal, cloudSessionId: input.cloudSessionId } : terminal;
}
export function retryableHandoffFailure(error) {
    if (error instanceof SessionHandoffError)
        return error.retryable;
    return hasRetryableResourceCode(error);
}
export function retryableFailedUpload(operation) {
    return operation.state === 'failed' && operation.retryable === true;
}
export function restartRetryableUpload(operation, updatedAtMs) {
    const uploading = { ...operation, state: 'uploading', updatedAtMs };
    delete uploading.failureCode;
    delete uploading.failureMessage;
    delete uploading.retryable;
    delete uploading.progress;
    return uploading;
}
export function failedUploadOperation(operation, error, updatedAtMs) {
    return {
        ...operation,
        state: 'failed',
        failureCode: error instanceof SessionHandoffError ? error.code : 'HANDOFF_UPLOAD_FAILED',
        failureMessage: error instanceof Error ? error.message : 'Local Session handoff failed',
        retryable: retryableHandoffFailure(error),
        updatedAtMs,
    };
}
export async function handleInitialTransferFailure(input) {
    if (input.commitSucceeded)
        return;
    if (retryableHandoffFailure(input.error) && input.record?.state === 'transferring')
        return;
    if (input.stagingDir && !input.record?.stagingDir) {
        await cleanupStagingBestEffort(input.workspace, input.stagingDir);
    }
    if (!input.record)
        return;
    await terminateLocalTransfer({
        ...input,
        record: input.record,
        abortRemote: true,
    });
}
export async function awaitTransferReceiver(input) {
    const timeoutAt = input.nowMs() + (input.timeoutMs ?? DEFAULT_TRANSFER_READY_TIMEOUT_MS);
    const deadline = Math.min(timeoutAt, input.ticket.expiresAt);
    for (;;) {
        const now = input.nowMs();
        if (now >= deadline)
            throw transferReadinessTimeout(now, input.ticket.expiresAt);
        const dispatch = await input.cloud.get(input.dispatchId, input.sourceDeviceToken);
        if (dispatch.readyToCommit)
            return;
        if (dispatch.state !== 'prepared') {
            throw new SessionHandoffError(dispatch.state === 'expired' ? 'HANDOFF_EXPIRED' : 'HANDOFF_UNAVAILABLE', `Cloud receiver entered terminal state ${dispatch.state} before commit`);
        }
        await delay(TRANSFER_READY_POLL_MS);
    }
}
export async function persistUploadProgress(input) {
    const operation = await input.state.getUploadOperationByDispatchId(input.dispatchId);
    if (!operation || operation.state !== 'uploading')
        return;
    await input.state.putUploadOperation({
        ...operation,
        progress: { phase: 'uploading', ...input.progress },
        updatedAtMs: input.nowMs,
    });
}
export async function persistMaterializingProgress(input) {
    const operation = await input.state.getUploadOperationByDispatchId(input.dispatchId);
    if (!operation || operation.state !== 'uploading')
        return;
    const totalBytes = operation.progress?.totalBytes ??
        input.snapshot.files.reduce((total, file) => total + file.sizeBytes, 0);
    await input.state.putUploadOperation({
        ...operation,
        progress: { phase: 'materializing', uploadedBytes: totalBytes, totalBytes },
        updatedAtMs: input.nowMs,
    });
}
export async function completeLocalTransfer(input) {
    try {
        await input.state.put(terminalHandoffRecord(input.record, {
            state: 'committed',
            cloudSessionId: input.cloudSessionId,
            updatedAtMs: input.nowMs,
        }));
    }
    catch {
        throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Cloud Session committed but local handoff state could not be finalized', true);
    }
    if (input.record.workspaceTransfer) {
        await cleanupTransferBestEffort(input.transfer, input.record.workspaceTransfer);
    }
    if (input.record.stagingDir) {
        await cleanupStagingBestEffort(input.workspace, input.record.stagingDir);
    }
}
export async function terminateLocalTransfer(input) {
    if (input.abortRemote && input.cloud) {
        await abortBestEffort(input.cloud, input.record.dispatchId, input.record.sourceDeviceToken, input.abortReason);
    }
    const persisted = await persistTerminalFailure(input.state, input.record, input.nowMs);
    if (!persisted)
        return;
    if (input.transfer && input.record.workspaceTransfer)
        await cleanupTransferBestEffort(input.transfer, input.record.workspaceTransfer);
    if (input.record.stagingDir)
        await cleanupStagingBestEffort(input.workspace, input.record.stagingDir);
}
async function persistTerminalFailure(state, record, updatedAtMs) {
    try {
        await state.put(terminalHandoffRecord(record, { state: 'failed', updatedAtMs }));
        return true;
    }
    catch {
        // The persisted resumable record is reconciled again on the next startup or request.
        return false;
    }
}
export async function cleanupTransferOrphans(input) {
    const records = (await input.state?.listResumableTransfers?.()) ?? [];
    const retained = records.filter((record) => resumableHandoffRecord(record) &&
        record.workspaceTransfer.expiresAt > input.nowMs &&
        ticketMatchesSource(record.workspaceTransfer, record.workspaceRevisionId));
    const retainedIds = new Set(retained.map((record) => record.dispatchId));
    for (const record of records) {
        if (retainedIds.has(record.dispatchId) || !input.state)
            continue;
        await terminateLocalTransfer({ ...input, state: input.state, record, abortRemote: true });
    }
    await input.workspace.cleanupOrphans?.(retained.map((record) => record.stagingDir));
    await input.transfer?.cleanupOrphans?.(retained.map((record) => record.workspaceTransfer.transferId));
}
async function cleanupStagingBestEffort(workspace, stagingDir) {
    try {
        await workspace.cleanupStaging?.(stagingDir);
    }
    catch {
        // Terminal state is authoritative; startup orphan cleanup retries local removal.
    }
}
async function cleanupTransferBestEffort(transfer, ticket) {
    try {
        await transfer.cleanup?.(ticket);
    }
    catch {
        // Terminal state is authoritative; startup orphan cleanup retries local removal.
    }
}
async function abortBestEffort(cloud, dispatchId, sourceDeviceToken, reason = 'Local Session handoff failed before commit') {
    try {
        await cloud.abort(dispatchId, sourceDeviceToken, reason);
    }
    catch {
        // Server-side expiry remains authoritative when cleanup cannot reach the control API.
    }
}
function transferReadinessTimeout(nowMs, expiresAt) {
    const ticketExpired = nowMs >= expiresAt;
    return new SessionHandoffError(ticketExpired ? 'HANDOFF_EXPIRED' : 'HANDOFF_UNAVAILABLE', ticketExpired
        ? 'Workspace transfer expired before the Cloud receiver completed'
        : 'Cloud receiver did not complete before the transfer readiness timeout', !ticketExpired);
}
function delay(ms) {
    return new Promise((settle) => {
        setTimeout(settle, ms);
    });
}
function ticketMatchesSource(ticket, workspaceRevisionId) {
    return ticket.sourceRevisionId === workspaceRevisionId;
}
function hasRetryableResourceCode(error) {
    if (typeof error !== 'object' || error === null || !('code' in error))
        return false;
    return ['ENOSPC', 'EBUSY', 'EMFILE'].includes(String(error.code));
}
function selectedPathsMatch(workspaceDir, selectedPaths, files) {
    const workspaceRoot = resolve(workspaceDir);
    const normalized = selectedPaths
        .map((path) => {
        const candidate = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
        const value = relative(workspaceRoot, candidate).split(sep).join('/');
        return value && value !== '..' && !value.startsWith('../') ? value : undefined;
    })
        .filter((path) => path !== undefined)
        .sort(compareHandoffPaths);
    const expected = files.map((file) => file.relativePath).sort(compareHandoffPaths);
    return normalized.length === selectedPaths.length && arraysEqual(normalized, expected);
}
function sameSnapshotFiles(actual, expected) {
    const orderedActual = [...actual].sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath));
    const orderedExpected = [...expected].sort((left, right) => compareHandoffPaths(left.relativePath, right.relativePath));
    return (orderedActual.length === orderedExpected.length &&
        orderedActual.every((file, index) => {
            const other = orderedExpected[index];
            return (other !== undefined &&
                file.relativePath === other.relativePath &&
                file.sizeBytes === other.sizeBytes &&
                file.sha256 === other.sha256 &&
                file.sensitive === other.sensitive);
        }));
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
//# sourceMappingURL=upload-resume.js.map