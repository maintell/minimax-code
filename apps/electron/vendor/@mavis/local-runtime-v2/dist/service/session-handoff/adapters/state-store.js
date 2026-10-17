import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyedOperationLane } from '@mavis/shared';
const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const VALID_STATES = new Set([
    'prepared',
    'transferring',
    'committed',
    'failed',
]);
export class FileHandoffStateStore {
    makeDeviceId;
    root;
    recordsDir;
    resultsDir;
    operationsDir;
    recordCurrentDir;
    operationCurrentDir;
    operationLanes = new KeyedOperationLane();
    constructor(dataDir, makeDeviceId = randomUUID) {
        this.makeDeviceId = makeDeviceId;
        this.root = join(dataDir, 'v2', 'session-handoff');
        this.recordsDir = join(this.root, 'records');
        this.resultsDir = join(this.root, 'results');
        this.operationsDir = join(this.root, 'operations');
        this.recordCurrentDir = join(this.root, 'current', 'records');
        this.operationCurrentDir = join(this.root, 'current', 'operations');
    }
    async getDeviceId() {
        const path = join(this.root, 'device-id');
        const existing = await this.readOptionalText(path);
        if (validIdentifier(existing))
            return existing;
        await this.ensureDirectories();
        const candidate = this.makeDeviceId().trim();
        if (!validIdentifier(candidate))
            throw new Error('session_handoff_device_id_invalid');
        try {
            await writeFile(path, candidate, { encoding: 'utf8', flag: 'wx', mode: STATE_FILE_MODE });
        }
        catch (error) {
            if (!isErrorCode(error, 'EEXIST'))
                throw error;
        }
        await chmod(path, STATE_FILE_MODE);
        const persisted = await readFile(path, 'utf8');
        if (!validIdentifier(persisted.trim()))
            throw new Error('session_handoff_device_id_corrupt');
        return persisted.trim();
    }
    async put(record) {
        assertRecord(record);
        await this.ensureDirectories();
        await this.writeJSON(this.recordPath(record.dispatchId), record);
        await this.writeCurrentDispatch(this.recordCurrentDir, record.localSessionId, record.dispatchId);
    }
    async getByLocalSession(localSessionId) {
        const dispatchId = await this.readCurrentDispatch(this.recordCurrentDir, localSessionId);
        return dispatchId ? this.getByDispatchId(dispatchId) : undefined;
    }
    async getByDispatchId(dispatchId) {
        if (!validIdentifier(dispatchId))
            return undefined;
        return this.readRecord(this.recordPath(dispatchId));
    }
    async getByCloudSession(cloudSessionId) {
        if (!validIdentifier(cloudSessionId))
            return undefined;
        let names;
        try {
            names = await readdir(this.recordsDir);
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                return undefined;
            throw error;
        }
        for (const name of names) {
            if (!name.endsWith('.json'))
                continue;
            const record = await this.readRecord(join(this.recordsDir, name));
            if (record?.cloudSessionId === cloudSessionId)
                return record;
        }
        return undefined;
    }
    async listResumableTransfers() {
        let names;
        try {
            names = await readdir(this.recordsDir);
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                return [];
            throw error;
        }
        const records = [];
        for (const name of names.sort()) {
            if (!name.endsWith('.json'))
                continue;
            const record = await this.readRecord(join(this.recordsDir, name));
            if (record?.state === 'transferring')
                records.push(record);
        }
        return records;
    }
    async putUploadOperation(record) {
        assertUploadOperation(record);
        await this.operationLanes.run(record.localSessionId, async () => {
            await this.ensureDirectories();
            await this.writeJSON(this.operationPath(record.dispatchId), record);
            if (terminalUploadState(record.state)) {
                const current = await this.readCurrentDispatch(this.operationCurrentDir, record.localSessionId);
                if (current === record.dispatchId) {
                    await removeOptional(this.currentPath(this.operationCurrentDir, record.localSessionId));
                }
                return;
            }
            await this.writeCurrentDispatch(this.operationCurrentDir, record.localSessionId, record.dispatchId);
        });
    }
    async getCurrentUploadOperation(localSessionId) {
        const dispatchId = await this.readCurrentDispatch(this.operationCurrentDir, localSessionId);
        return dispatchId ? this.getUploadOperationByDispatchId(dispatchId) : undefined;
    }
    async getUploadOperationByDispatchId(dispatchId) {
        if (!validIdentifier(dispatchId))
            return undefined;
        return this.readUploadOperation(this.operationPath(dispatchId));
    }
    async listActiveUploadOperations() {
        let names;
        try {
            names = await readdir(this.operationsDir);
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                return [];
            throw error;
        }
        const operations = [];
        for (const name of names.sort()) {
            if (!name.endsWith('.json'))
                continue;
            const operation = await this.readUploadOperation(join(this.operationsDir, name));
            if (operation && !terminalUploadState(operation.state))
                operations.push(operation);
        }
        return operations;
    }
    async listActiveResultMaterializations() {
        let names;
        try {
            names = await readdir(this.resultsDir);
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                return [];
            throw error;
        }
        const materializations = [];
        for (const name of names.sort()) {
            if (!name.endsWith('.json'))
                continue;
            const materialization = await this.readResultMaterialization(join(this.resultsDir, name));
            if (materialization?.state === 'materializing')
                materializations.push(materialization);
        }
        return materializations;
    }
    async getResultMaterialization(cloudSessionId, resultId, selection) {
        if (!validIdentifier(cloudSessionId) || !validIdentifier(resultId))
            return undefined;
        if (!validResultSelection(selection))
            return undefined;
        return this.readResultMaterialization(this.resultPath(cloudSessionId, resultId, selection));
    }
    async putResultMaterialization(record) {
        assertResultMaterialization(record);
        await this.ensureDirectories();
        const target = this.resultPath(record.cloudSessionId, record.resultId, record.selection);
        const existing = await this.readResultMaterialization(target);
        if (existing?.selection !== undefined && existing.selection !== record.selection) {
            throw new Error('session_handoff_result_selection_conflict');
        }
        if (existing?.state === 'published' &&
            (record.state !== 'published' || existing.workspacePath !== record.workspacePath)) {
            throw new Error('session_handoff_result_publication_conflict');
        }
        await this.writeJSON(target, record);
    }
    async ensureDirectories() {
        await mkdir(this.recordsDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
        await mkdir(this.resultsDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
        await mkdir(this.operationsDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
        await mkdir(this.recordCurrentDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
        await mkdir(this.operationCurrentDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
        await chmod(this.root, STATE_DIRECTORY_MODE);
        await chmod(this.recordsDir, STATE_DIRECTORY_MODE);
        await chmod(this.resultsDir, STATE_DIRECTORY_MODE);
        await chmod(this.operationsDir, STATE_DIRECTORY_MODE);
        await chmod(this.recordCurrentDir, STATE_DIRECTORY_MODE);
        await chmod(this.operationCurrentDir, STATE_DIRECTORY_MODE);
    }
    recordPath(dispatchId) {
        if (!validIdentifier(dispatchId))
            throw new Error('session_handoff_dispatch_id_invalid');
        const digest = createHash('sha256').update(dispatchId).digest('hex');
        return join(this.recordsDir, `${digest}.json`);
    }
    resultPath(cloudSessionId, resultId, selection) {
        if (!validIdentifier(cloudSessionId) || !validIdentifier(resultId)) {
            throw new Error('session_handoff_result_id_invalid');
        }
        const digest = createHash('sha256')
            .update(cloudSessionId)
            .update('\0')
            .update(resultId)
            .update('\0')
            .update(selection)
            .digest('hex');
        return join(this.resultsDir, `${digest}.json`);
    }
    operationPath(dispatchId) {
        if (!validIdentifier(dispatchId)) {
            throw new Error('session_handoff_operation_id_invalid');
        }
        const digest = createHash('sha256').update(dispatchId).digest('hex');
        return join(this.operationsDir, `${digest}.json`);
    }
    currentPath(directory, localSessionId) {
        if (!validIdentifier(localSessionId)) {
            throw new Error('session_handoff_local_id_invalid');
        }
        const digest = createHash('sha256').update(localSessionId).digest('hex');
        return join(directory, `${digest}.json`);
    }
    async writeCurrentDispatch(directory, localSessionId, dispatchId) {
        await this.writeJSON(this.currentPath(directory, localSessionId), { dispatchId });
    }
    async readCurrentDispatch(directory, localSessionId) {
        if (!validIdentifier(localSessionId))
            return undefined;
        const raw = await this.readOptionalText(this.currentPath(directory, localSessionId));
        if (raw === undefined)
            return undefined;
        try {
            const value = JSON.parse(raw);
            if (validIdentifier(value.dispatchId))
                return value.dispatchId;
        }
        catch {
            // Fall through to one stable corruption error.
        }
        throw new Error('session_handoff_current_record_corrupt');
    }
    async readRecord(path) {
        const raw = await this.readOptionalText(path);
        if (raw === undefined)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('session_handoff_record_corrupt');
        }
        assertRecord(parsed);
        return parsed;
    }
    async readUploadOperation(path) {
        const raw = await this.readOptionalText(path);
        if (raw === undefined)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('session_handoff_operation_record_corrupt');
        }
        assertUploadOperation(parsed);
        return parsed;
    }
    async readResultMaterialization(path) {
        const raw = await this.readOptionalText(path);
        if (raw === undefined)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('session_handoff_result_record_corrupt');
        }
        assertResultMaterialization(parsed);
        return parsed;
    }
    async writeJSON(path, value) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(value), {
                encoding: 'utf8',
                mode: STATE_FILE_MODE,
            });
            await rename(temporary, path);
            await chmod(path, STATE_FILE_MODE);
        }
        catch (error) {
            await removeTemporary(temporary);
            throw error;
        }
    }
    async readOptionalText(path) {
        try {
            return await readFile(path, 'utf8');
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                return undefined;
            throw error;
        }
    }
}
function assertRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('session_handoff_record_invalid');
    }
    const candidate = value;
    const required = [
        candidate.localSessionId,
        candidate.operationId,
        candidate.clientRequestId,
        candidate.dispatchId,
        candidate.sourceDeviceId,
        candidate.sourceDeviceToken,
        candidate.workspaceDir,
        candidate.workspaceRevisionId,
    ];
    if (required.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
        !validOptionalCloudId(candidate.cloudSessionId) ||
        !validState(candidate.state) ||
        !validResumeState(candidate) ||
        !finiteTimestamp(candidate.createdAtMs) ||
        !finiteTimestamp(candidate.updatedAtMs)) {
        throw new Error('session_handoff_record_invalid');
    }
}
function validResumeState(candidate) {
    const resumeFields = [candidate.workspaceTransfer, candidate.stagingDir, candidate.snapshot];
    if (candidate.state !== 'transferring')
        return resumeFields.every((value) => value === undefined);
    return (validTransferTicket(candidate.workspaceTransfer) &&
        validIdentifier(candidate.stagingDir) &&
        validTransferSnapshot(candidate.snapshot));
}
function validTransferTicket(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    return validTransferTicketFields(value) && validTransferTicketSourceBinding(value);
}
function validTransferTicketFields(value) {
    return ([value.transferId, value.endpointUrl, value.accessToken].every(validIdentifier) &&
        finiteTimestamp(value.expiresAt));
}
function validTransferTicketSourceBinding(value) {
    return validIdentifier(value.sourceRevisionId);
}
function validTransferSnapshot(value) {
    return (typeof value === 'object' &&
        value !== null &&
        /^[0-9a-f]{64}$/u.test(value.manifestHash) &&
        Array.isArray(value.files) &&
        value.files.every((file) => validIdentifier(file.relativePath) &&
            Number.isSafeInteger(file.sizeBytes) &&
            file.sizeBytes >= 0 &&
            /^[0-9a-f]{64}$/u.test(file.sha256) &&
            (file.sensitive === undefined || typeof file.sensitive === 'boolean')));
}
function assertUploadOperation(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('session_handoff_operation_record_invalid');
    }
    const candidate = value;
    const valid = [
        validIdentifier(candidate.dispatchId),
        validIdentifier(candidate.localSessionId),
        validUploadState(candidate.state),
        validOptionalHistoryCheckpoint(candidate.historyCheckpoint),
        validOptionalText(candidate.catalogRevision),
        validOptionalCloudId(candidate.cloudSessionId),
        validOptionalCloudId(candidate.cloudDispatchId),
        validOptionalProposalFiles(candidate.files),
        validOptionalTimestamp(candidate.expiresAtMs),
        validOptionalText(candidate.failureCode),
        validOptionalText(candidate.failureMessage),
        candidate.retryable === undefined || typeof candidate.retryable === 'boolean',
        validOptionalPrepareReplay(candidate.prepareReplay),
        validOptionalUploadProgress(candidate.progress),
        finiteTimestamp(candidate.createdAtMs),
        finiteTimestamp(candidate.updatedAtMs),
    ];
    if (!valid.every(Boolean))
        throw new Error('session_handoff_operation_record_invalid');
}
function validOptionalPrepareReplay(value) {
    if (value === undefined)
        return true;
    return validPrepareReplayHeader(value) && validPrepareReplayArtifacts(value);
}
function validPrepareReplayHeader(value) {
    return (validIdentifier(value.sourceDeviceId) &&
        Array.isArray(value.selectedPaths) &&
        value.selectedPaths.every(validIdentifier) &&
        validOptionalHistoryCheckpoint(value.checkpoint) &&
        validPrepareSessionSpec(value.sessionSpec) &&
        validPrepareWorkspace(value.workspace));
}
function validPrepareReplayArtifacts(value) {
    if (!Array.isArray(value.artifacts) || !Array.isArray(value.artifactBodies))
        return false;
    const descriptors = new Map(value.artifacts.map((artifact) => [artifact.kind, artifact]));
    if (descriptors.size !== 3 || value.artifactBodies.length !== 3)
        return false;
    const bodyKinds = new Set();
    return (value.artifacts.every(validPrepareArtifactDescriptor) &&
        value.artifactBodies.every((body) => {
            if (bodyKinds.has(body.kind))
                return false;
            bodyKinds.add(body.kind);
            return validPrepareArtifactBody(body, descriptors);
        }));
}
function validPrepareArtifactDescriptor(artifact) {
    return (validArtifactKind(artifact.kind) &&
        /^[0-9a-f]{64}$/u.test(artifact.sha256) &&
        Number.isSafeInteger(artifact.sizeBytes) &&
        artifact.sizeBytes >= 0);
}
function validPrepareArtifactBody(body, descriptors) {
    if (!validArtifactKind(body.kind) || !canonicalBase64(body.base64))
        return false;
    const bytes = Buffer.from(body.base64, 'base64');
    const descriptor = descriptors.get(body.kind);
    return (descriptor !== undefined &&
        descriptor.sizeBytes === bytes.byteLength &&
        descriptor.sha256 === createHash('sha256').update(bytes).digest('hex'));
}
function validPrepareSessionSpec(value) {
    if (!value || !validIdentifier(value.agentName) || !validOptionalText(value.title))
        return false;
    if (value.model === undefined)
        return true;
    return (validIdentifier(value.model.providerId) &&
        validIdentifier(value.model.modelId) &&
        validOptionalText(value.model.variant));
}
function validPrepareWorkspace(value) {
    return (!!value &&
        validIdentifier(value.revisionId) &&
        /^[0-9a-f]{64}$/u.test(value.manifest.manifestHash) &&
        Number.isSafeInteger(value.manifest.fileCount) &&
        value.manifest.fileCount >= 0 &&
        Number.isSafeInteger(value.manifest.totalBytes) &&
        value.manifest.totalBytes >= 0);
}
function validArtifactKind(value) {
    return value === 'imported_history' || value === 'handoff_context' || value === 'file_manifest';
}
function canonicalBase64(value) {
    if (typeof value !== 'string' || value.length === 0)
        return false;
    try {
        return Buffer.from(value, 'base64').toString('base64') === value;
    }
    catch {
        return false;
    }
}
function validOptionalUploadProgress(value) {
    return (value === undefined ||
        ((value.phase === 'uploading' || value.phase === 'materializing') &&
            Number.isSafeInteger(value.uploadedBytes) &&
            value.uploadedBytes >= 0 &&
            Number.isSafeInteger(value.totalBytes) &&
            value.totalBytes >= value.uploadedBytes));
}
function validUploadState(value) {
    return (value === 'archive_pending' ||
        value === 'recommending' ||
        value === 'awaiting_approval' ||
        value === 'uploading' ||
        value === 'completed' ||
        value === 'failed' ||
        value === 'expired');
}
function terminalUploadState(state) {
    return state === 'completed' || state === 'failed' || state === 'expired';
}
function validOptionalHistoryCheckpoint(value) {
    return (value === undefined ||
        (Number.isSafeInteger(value.turnCount) &&
            value.turnCount > 0 &&
            validIdentifier(value.lastMessageId)));
}
function validOptionalProposalFiles(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.every((file) => validIdentifier(file.relativePath) &&
                (file.absolutePath === undefined || validIdentifier(file.absolutePath)) &&
                validIdentifier(file.reason) &&
                Number.isSafeInteger(file.sizeBytes) &&
                file.sizeBytes >= 0 &&
                /^[0-9a-f]{64}$/u.test(file.sha256) &&
                typeof file.sensitive === 'boolean' &&
                typeof file.recommended === 'boolean' &&
                typeof file.selected === 'boolean')));
}
function validOptionalText(value) {
    return value === undefined || (typeof value === 'string' && value.length > 0);
}
function validOptionalTimestamp(value) {
    return value === undefined || finiteTimestamp(value);
}
function assertResultMaterialization(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('session_handoff_result_record_invalid');
    }
    const candidate = value;
    if (!validResultMaterialization(candidate)) {
        throw new Error('session_handoff_result_record_invalid');
    }
}
function validResultMaterialization(candidate) {
    return (validIdentifier(candidate.cloudSessionId) &&
        validIdentifier(candidate.resultId) &&
        validResultSelection(candidate.selection) &&
        validResultState(candidate.state) &&
        validResultWorkspaceState(candidate) &&
        finiteTimestamp(candidate.createdAtMs) &&
        finiteTimestamp(candidate.updatedAtMs));
}
function validResultSelection(value) {
    return typeof value === 'string' && value.length > 0;
}
function validResultState(value) {
    return value === 'selected' || value === 'materializing' || value === 'published';
}
function validResultWorkspaceState(candidate) {
    if (candidate.state === 'selected')
        return candidate.workspaceTransfer === undefined;
    if (candidate.state === 'published') {
        return candidate.workspaceTransfer === undefined && validPersistedPath(candidate.workspacePath);
    }
    if (candidate.state !== 'materializing')
        return false;
    return [
        validPersistedPath(candidate.workspacePath),
        validPersistedPath(candidate.workingPath),
        validPersistedPath(candidate.transferPath),
        validIdentifier(candidate.operationId),
        candidate.kind === 'worktree' || candidate.kind === 'snapshot',
        validOptionalIdentifier(candidate.ownershipToken),
        validOptionalIdentifier(candidate.fingerprint),
        candidate.workspaceTransfer === undefined || validTransferTicket(candidate.workspaceTransfer),
    ].every(Boolean);
}
function validPersistedPath(value) {
    return typeof value === 'string' && value.length > 0;
}
function validIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function validOptionalCloudId(value) {
    return value === undefined || validIdentifier(value);
}
function validOptionalIdentifier(value) {
    return value === undefined || validIdentifier(value);
}
function validState(value) {
    return typeof value === 'string' && VALID_STATES.has(value);
}
function finiteTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isErrorCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
async function removeOptional(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (!isErrorCode(error, 'ENOENT'))
            throw error;
    }
}
async function removeTemporary(path) {
    try {
        await unlink(path);
    }
    catch {
        // Best-effort cleanup must not replace the authoritative write failure.
    }
}
//# sourceMappingURL=state-store.js.map