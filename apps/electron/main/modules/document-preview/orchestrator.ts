import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { safePreviewDiagnosticV1, assertPreviewRequestV1, PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
import { DocumentPreviewBackendPlanner } from "./index";
import { buildArtifactCacheKey } from "./artifact-key";
import { validateArtifactPathWithinWorkDir } from "./artifact-path";
import { noopDocumentPreviewLogger, describeDocumentPreviewError } from "./logging";
const DEFAULT_MAX_CONCURRENT_PREPARES = 4;
const DEFAULT_MAX_CONCURRENT_PREPARES_PER_SENDER = 2;
const DEFAULT_BACKEND_STATUS_TIMEOUT_MS = 5000;
const DEFAULT_BACKEND_STATUS_CACHE_TTL_MS = 5000;
const DEFAULT_BACKEND_STATUS_FAILURE_COOLDOWN_MS = 2000;
const DEFAULT_BACKEND_TERMINATION_TIMEOUT_MS = 2000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
function positiveIntegerOr(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function startObservedCleanup(operation) {
    try {
        return Promise.resolve(operation()).then(() => ({ ok: true }), (reason) => ({ ok: false, reason }));
    }
    catch (reason) {
        return Promise.resolve({ ok: false, reason });
    }
}
async function settlesWithin(operation, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            operation.then(() => true, () => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function startBackendTransformJob(backend, context) {
    if (typeof backend.startTransform === 'function') {
        const job = backend.startTransform(context);
        if (!job || !(job.result instanceof Promise) || typeof job.terminateAndWait !== 'function') {
            throw new TypeError('Preview backend returned an invalid transform job');
        }
        return job;
    }
    const result = Promise.resolve().then(() => backend.transform(context));
    return {
        result,
        terminateAndWait: async () => {
            await result.then(() => undefined, () => undefined);
        },
    };
}
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
        },
    };
}
function backendFailure(code, message, backendId, retryable = false) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
            backendId,
        },
    };
}
function normalizedArch() {
    if (process.arch === 'arm64')
        return 'arm64';
    if (process.arch === 'x64')
        return 'x64';
    return null;
}
function nativePlatform() {
    if (process.platform === 'darwin')
        return 'darwin';
    if (process.platform === 'win32')
        return 'win32';
    return null;
}
function resolveRuntimeTuple(provider) {
    if (!provider)
        return { platform: nativePlatform(), arch: normalizedArch() };
    try {
        const tuple = provider();
        return {
            platform: tuple?.platform === 'darwin' || tuple?.platform === 'win32' ? tuple.platform : null,
            arch: tuple?.arch === 'x64' || tuple?.arch === 'arm64' ? tuple.arch : null,
        };
    }
    catch {
        return { platform: null, arch: null };
    }
}
function sourceMimeTypeForRequest(source) {
    return source.mimeType.trim().toLowerCase();
}
function requestKey(senderId, requestId) {
    return `${senderId}:${requestId}`;
}
function progressEvent(request, stage, backendId, progress) {
    return {
        schema: 'mavis.preview_progress.v1',
        requestId: request.requestId,
        stage,
        ...(backendId ? { backendId } : {}),
        ...(progress === undefined ? {} : { progress }),
    };
}
function capabilitySetIncludes(capabilities, required) {
    const available = new Set(capabilities);
    return required.every((capability) => available.has(capability));
}
/**
 * Fallback traces are renderer-facing telemetry, not a native-process log
 * sink.  Keep the detail-rich error in the main-process logs and expose only
 * the stable contract diagnostic across IPC.
 */
function safeTraceMessage(code, message) {
    return safePreviewDiagnosticV1(code, message);
}
function safeBackendStatusReason(availability, reason) {
    if (availability === 'available')
        return undefined;
    return safePreviewDiagnosticV1(availability === 'installable' ? 'component_unavailable' : 'backend_unavailable', reason);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
async function validateArtifactDraftResources(workDir, resources, maxArtifactBytes) {
    if (!Array.isArray(resources) || resources.length === 0)
        return { ok: false, reason: 'invalid' };
    const canonicalResources = [];
    let totalBytes = 0;
    for (const candidate of resources) {
        if (!isRecord(candidate) || typeof candidate.absolutePath !== 'string')
            return { ok: false, reason: 'invalid' };
        const validated = await validateArtifactPathWithinWorkDir(workDir, candidate.absolutePath, typeof candidate.sizeBytes === 'number' ? candidate.sizeBytes : undefined);
        if (!validated)
            return { ok: false, reason: 'invalid' };
        // A draft's declared size is part of the publication contract.  Do not
        // let the artifact store copy a file whose bytes differ from the backend's
        // metadata, even if the backend omitted a type-level field at runtime.
        if (typeof candidate.sizeBytes !== 'number' ||
            !Number.isSafeInteger(candidate.sizeBytes) ||
            candidate.sizeBytes !== validated.sizeBytes) {
            return { ok: false, reason: 'invalid' };
        }
        if (validated.sizeBytes > maxArtifactBytes - totalBytes) {
            return { ok: false, reason: 'resource_limit_exceeded' };
        }
        totalBytes += validated.sizeBytes;
        canonicalResources.push({
            canonicalPath: validated.canonicalPath,
            sizeBytes: validated.sizeBytes,
        });
    }
    return { ok: true, resources: canonicalResources, totalBytes };
}
function sourceInput(value, operation) {
    if (!isRecord(value) ||
        typeof value.sourceId !== 'string' ||
        typeof value.maxBytes !== 'number' ||
        !Number.isSafeInteger(value.maxBytes)) {
        return null;
    }
    const sourceId = value.sourceId;
    const maxBytes = value.maxBytes;
    if (operation === 'read') {
        return { sourceId, maxBytes };
    }
    return { sourceId, maxBytes };
}
/**
 * Owns the document-preview domain lifecycle in the main process.
 *
 * This class has no Electron dependency.  IPC is an adapter which supplies a
 * sender id, cancellation signals, and a progress sink; all source staging,
 * backend fallback, artifact leasing, and cleanup decisions live here.
 */
export class DocumentPreviewOrchestrator {
    constructor(options, emitProgress = () => undefined) {
        this.options = options;
        this.emitProgress = emitProgress;
        this.pending = new Map();
        this.senderEpochs = new Map();
        this.senderAlive = new Map();
        this.activePreparesBySender = new Map();
        this.quarantinedBackends = new Set();
        this.liveOperations = new Map();
        this.activePrepareCount = 0;
        this.shutdownStarted = false;
        this.log = options.logger ?? noopDocumentPreviewLogger;
    }
    senderEpoch(senderId) {
        return this.senderEpochs.get(senderId) ?? 0;
    }
    acquirePrepareAdmission(senderId) {
        const globalLimit = positiveIntegerOr(this.options.maxConcurrentPrepares, DEFAULT_MAX_CONCURRENT_PREPARES);
        const senderLimit = positiveIntegerOr(this.options.maxConcurrentPreparesPerSender, DEFAULT_MAX_CONCURRENT_PREPARES_PER_SENDER);
        const senderCount = this.activePreparesBySender.get(senderId) ?? 0;
        if (this.activePrepareCount >= globalLimit || senderCount >= senderLimit)
            return null;
        this.activePrepareCount += 1;
        this.activePreparesBySender.set(senderId, senderCount + 1);
        let released = false;
        return {
            release: () => {
                if (released)
                    return;
                released = true;
                this.activePrepareCount = Math.max(0, this.activePrepareCount - 1);
                const currentSenderCount = this.activePreparesBySender.get(senderId) ?? 0;
                if (currentSenderCount <= 1)
                    this.activePreparesBySender.delete(senderId);
                else
                    this.activePreparesBySender.set(senderId, currentSenderCount - 1);
            },
        };
    }
    createRequestTerminalOwner(key, state, resolveTerminalResult) {
        let closing;
        return {
            close: (reason, result) => {
                if (closing)
                    return closing;
                closing = (async () => {
                    const backendId = state.activeBackendId;
                    if (reason !== 'settled') {
                        state.invalidated = true;
                        state.controller.abort();
                        try {
                            this.emitProgress(state.senderId, progressEvent(state.request, 'cancelled', backendId));
                        }
                        catch {
                            // Renderer publication failure cannot retain native ownership.
                        }
                        const job = state.activeJob;
                        let terminationSucceeded = job === undefined;
                        if (job) {
                            const terminationProof = Promise.all([
                                startObservedCleanup(() => job.terminateAndWait(reason)).then((settlement) => {
                                    terminationSucceeded = settlement.ok;
                                }),
                                job.result.then(() => undefined, () => undefined),
                            ]);
                            const timeoutMs = positiveIntegerOr(this.options.backendTerminationTimeoutMs, DEFAULT_BACKEND_TERMINATION_TIMEOUT_MS);
                            const jobSettled = await settlesWithin(terminationProof, timeoutMs);
                            terminationSucceeded = jobSettled && terminationSucceeded;
                        }
                        const timeoutMs = positiveIntegerOr(this.options.backendTerminationTimeoutMs, DEFAULT_BACKEND_TERMINATION_TIMEOUT_MS);
                        const executionBounded = terminationSucceeded &&
                            (state.executionPromise
                                ? await settlesWithin(state.executionPromise, timeoutMs)
                                : true);
                        if (backendId !== undefined && !executionBounded) {
                            // Quarantine precedes capacity release: already-admitted work may
                            // remain, but this backend cannot create another runaway job.
                            this.log.error({
                                msg: '[DocumentPreview][orchestrator] backend quarantined after unproven termination; a native (soffice) process may be orphaned',
                                senderId: state.senderId,
                                requestId: state.request.requestId,
                                backendId,
                                reason,
                            });
                            this.quarantinedBackends.add(backendId);
                        }
                    }
                    if (this.pending.get(key) === state)
                        this.pending.delete(key);
                    state.admission.release();
                    if (result)
                        resolveTerminalResult(result);
                })();
                return closing;
            },
        };
    }
    /**
     * Bind a live IPC WebContents to this orchestrator.  Numeric sender ids can
     * be recycled by Electron, so rebinding is the only operation allowed to
     * start a new epoch after releaseSender().
     */
    bindSender(senderId) {
        if (this.shutdownStarted)
            return;
        if (!Number.isSafeInteger(senderId) || senderId < 0)
            return;
        if (this.senderAlive.get(senderId) === false) {
            this.senderEpochs.set(senderId, this.senderEpoch(senderId) + 1);
        }
        this.senderAlive.set(senderId, true);
    }
    activateSender(senderId) {
        if (this.shutdownStarted)
            return false;
        // A direct method call after releaseSender must not revive the sender. IPC
        // calls bindSender() when a new WebContents is first observed.
        if (this.senderAlive.get(senderId) === false)
            return false;
        this.senderAlive.set(senderId, true);
        return true;
    }
    isSenderLive(senderId) {
        // Direct orchestrator consumers have no Electron lifecycle binding. They
        // are considered live until releaseSender is called; IPC callers mark the
        // sender dead through releaseSender synchronously from `destroyed`.
        return this.senderAlive.get(senderId) !== false;
    }
    async openSource(senderId, input, ownerToken) {
        if (!this.activateSender(senderId))
            return failure('cancelled', 'Document preview source opening was cancelled');
        if (!isRecord(input))
            return failure('invalid_request', 'Invalid document preview source request');
        const openInput = input;
        return ownerToken === undefined
            ? this.options.sourceRegistry.open(senderId, openInput)
            : this.options.sourceRegistry.open(senderId, openInput, ownerToken);
    }
    async openLegacySource(senderId, input, ownerToken) {
        if (!this.activateSender(senderId))
            return failure('cancelled', 'Document preview source opening was cancelled');
        if (!isRecord(input))
            return failure('invalid_request', 'Invalid document preview source request');
        const openLegacy = this.options.sourceRegistry.openLegacy;
        if (typeof openLegacy !== 'function') {
            return failure('invalid_request', 'Legacy document preview source is unavailable');
        }
        const openInput = input;
        return ownerToken === undefined
            ? openLegacy.call(this.options.sourceRegistry, senderId, openInput)
            : openLegacy.call(this.options.sourceRegistry, senderId, openInput, ownerToken);
    }
    async readSource(senderId, input, signal = new AbortController().signal, ownerToken) {
        const request = sourceInput(input, 'read');
        if (!request)
            return failure('invalid_request', 'Invalid document preview read request');
        const read = await this.readRegisteredSource(senderId, request.sourceId, request.maxBytes, ownerToken);
        if (signal.aborted)
            return failure('cancelled', 'Document preview read was cancelled');
        if (!read.ok)
            return read;
        const sanitized = await this.options.sanitize(read.value.bytes, signal, this.sanitizerOptionsForSource(senderId, request.sourceId, ownerToken));
        if (signal.aborted)
            return failure('cancelled', 'Document preview read was cancelled');
        if (!sanitized.ok)
            return sanitized;
        const sourceGeneration = this.sourceGeneration(senderId, request.sourceId, ownerToken);
        const staged = await this.cacheSanitizedSource(senderId, request.sourceId, sanitized.value.bytes, ownerToken);
        if (signal.aborted) {
            if (staged.ok)
                await this.discardStagedCopyIfGeneration(senderId, request.sourceId, 'sanitized', sourceGeneration === null ? null : sourceGeneration + 1, ownerToken);
            return failure('cancelled', 'Document preview read was cancelled');
        }
        return staged.ok ? sanitized : staged;
    }
    async stageSource(senderId, input, signal = new AbortController().signal, ownerToken) {
        const request = sourceInput(input, 'stage');
        if (!request)
            return failure('invalid_request', 'Invalid document preview staging request');
        const read = await this.readRegisteredSource(senderId, request.sourceId, request.maxBytes, ownerToken);
        if (signal.aborted)
            return failure('cancelled', 'Document preview staging was cancelled');
        if (!read.ok)
            return read;
        const sanitized = await this.options.sanitize(read.value.bytes, signal, this.sanitizerOptionsForSource(senderId, request.sourceId, ownerToken));
        if (signal.aborted)
            return failure('cancelled', 'Document preview staging was cancelled');
        if (!sanitized.ok)
            return sanitized;
        const sourceGeneration = this.sourceGeneration(senderId, request.sourceId, ownerToken);
        const staged = await this.cacheSanitizedSource(senderId, request.sourceId, sanitized.value.bytes, ownerToken);
        if (signal.aborted) {
            if (staged.ok)
                await this.discardStagedCopyIfGeneration(senderId, request.sourceId, 'sanitized', sourceGeneration === null ? null : sourceGeneration + 1, ownerToken);
            return failure('cancelled', 'Document preview staging was cancelled');
        }
        if (!staged.ok)
            return staged;
        return {
            ok: true,
            value: {
                removedExternalRelationshipCount: sanitized.value.removedExternalRelationshipCount,
                rejectedEmbeddedResourceCount: sanitized.value.rejectedEmbeddedResourceCount,
                ...(sanitized.value.pptxPreflight ? { pptxPreflight: sanitized.value.pptxPreflight } : {}),
            },
        };
    }
    /**
     * Stage a legacy PPT/KEY source as an opaque main-process copy. Legacy
     * containers are intentionally not sent through the OOXML sanitizer; the
     * QuickLook/native compatibility adapter consumes the registry lease later.
     */
    async stageLegacySource(senderId, input, signal = new AbortController().signal, ownerToken) {
        const request = sourceInput(input, 'stage');
        if (!request)
            return failure('invalid_request', 'Invalid document preview staging request');
        const entry = this.resolveSourceForBackend(senderId, request.sourceId, ownerToken);
        if (!entry)
            return failure('source_not_found', 'Document preview source was not found');
        const extension = path.extname(entry.source.fileName).slice(1).toLowerCase();
        if (extension !== 'ppt' && extension !== 'key' && extension !== 'pptx') {
            return failure('invalid_request', 'Legacy document preview source is not allowlisted');
        }
        const read = await this.readRegisteredSource(senderId, request.sourceId, request.maxBytes, ownerToken);
        if (signal.aborted)
            return failure('cancelled', 'Document preview staging was cancelled');
        if (!read.ok)
            return read;
        const cacheLegacyCopy = this.options.sourceRegistry.cacheLegacyCopy;
        if (typeof cacheLegacyCopy !== 'function') {
            return failure('backend_unavailable', 'Legacy document preview staging is unavailable', true);
        }
        const sourceGeneration = this.sourceGeneration(senderId, request.sourceId, ownerToken);
        const staged = await (ownerToken === undefined
            ? cacheLegacyCopy.call(this.options.sourceRegistry, senderId, request.sourceId, read.value.bytes)
            : cacheLegacyCopy.call(this.options.sourceRegistry, senderId, request.sourceId, read.value.bytes, ownerToken));
        if (signal.aborted) {
            if (staged.ok)
                await this.discardStagedCopyIfGeneration(senderId, request.sourceId, 'legacy', sourceGeneration === null ? null : sourceGeneration + 1, ownerToken);
            return failure('cancelled', 'Document preview staging was cancelled');
        }
        if (!staged.ok)
            return staged;
        return {
            ok: true,
            value: {
                removedExternalRelationshipCount: 0,
                rejectedEmbeddedResourceCount: 0,
            },
        };
    }
    async releaseSource(senderId, sourceId, ownerToken) {
        return ownerToken === undefined
            ? this.options.sourceRegistry.release(senderId, sourceId)
            : this.options.sourceRegistry.release(senderId, sourceId, ownerToken);
    }
    async releasePreview(senderId, previewId) {
        return this.options.artifactStore.releaseLease({ senderId, previewId });
    }
    async prepare(senderId, input, ownerToken) {
        if (!this.activateSender(senderId))
            return failure('cancelled', 'Document preview request was cancelled', true);
        let request;
        try {
            assertPreviewRequestV1(input);
            request = input;
        }
        catch (error) {
            return failure('invalid_request', error instanceof Error ? error.message : 'Invalid document preview request');
        }
        const key = requestKey(senderId, request.requestId);
        if (this.pending.has(key))
            return failure('invalid_request', 'Preview request is already running');
        const admission = this.acquirePrepareAdmission(senderId);
        if (!admission) {
            return failure('resource_limit_exceeded', 'Document preview prepare capacity is exhausted', true);
        }
        const prepareDeadlineAtMs = Date.now() + Math.max(1, request.policy.timeoutMs);
        const remainingPrepareBudgetMs = () => Math.max(0, prepareDeadlineAtMs - Date.now());
        // Component installation is not a document-preview operation. Renderer
        // policy is retained only for v1 wire compatibility and is always cleared
        // before any backend observes the request.
        request = {
            ...request,
            policy: { ...request.policy, allowComponentDownload: false },
        };
        const controller = new AbortController();
        let resolveTerminalResult;
        const terminalResult = new Promise((resolve) => {
            resolveTerminalResult = resolve;
        });
        const state = {
            senderId,
            controller,
            request,
            invalidated: false,
            admission,
            terminal: undefined,
            terminalResult,
        };
        state.terminal = this.createRequestTerminalOwner(key, state, resolveTerminalResult);
        this.pending.set(key, state);
        try {
            this.emitProgress(senderId, progressEvent(request, 'queued', undefined, 0));
        }
        catch {
            state.invalidated = true;
            await state.terminal.close('settled');
            return failure('internal', 'Document preview progress publication failed', true);
        }
        const deadlineMs = remainingPrepareBudgetMs();
        const isActive = () => this.pending.get(key) === state && !state.invalidated && !controller.signal.aborted;
        const cancelled = () => failure('cancelled', 'Document preview was cancelled', true);
        const execution = (async () => {
            try {
                const entry = this.resolveSourceForBackend(senderId, request.sourceId, ownerToken);
                if (!entry)
                    return failure('source_not_found', 'Document preview source was not found');
                if (entry.source.sizeBytes > request.policy.maxInputBytes) {
                    return failure('source_too_large', 'Document preview source exceeds the request limit');
                }
                if (!isActive())
                    return cancelled();
                const planner = new DocumentPreviewBackendPlanner(this.options.backendRegistry);
                const candidates = planner.plan(request, {
                    sourceMimeType: sourceMimeTypeForRequest(entry.source),
                });
                if (candidates.length === 0) {
                    return failure('backend_unavailable', request.intent === 'high-fidelity'
                        ? 'No high-fidelity document preview backend is available'
                        : 'No main-process document preview backend is required for this request', true);
                }
                const staged = await this.acquireSanitizedCopy(senderId, request.sourceId, entry.source, request.policy.maxInputBytes, controller.signal, ownerToken);
                if (!staged.ok)
                    return staged;
                if (!isActive()) {
                    await staged.value.release();
                    return cancelled();
                }
                try {
                    await this.options.artifactStore.initialize();
                    const fallbackTrace = [];
                    // A single seam so every backend transition is logged with the RICH
                    // (pre-redaction) message before `safeTraceMessage` collapses it into
                    // the stable renderer-facing diagnostic on the trace itself.
                    const recordFallback = (entry) => {
                        this.log.warn({
                            msg: '[DocumentPreview][orchestrator] backend fallback transition',
                            senderId,
                            requestId: request.requestId,
                            backendId: entry.backendId,
                            outcome: entry.outcome,
                            reasonCode: entry.reasonCode,
                            elapsedMs: entry.elapsedMs,
                            detail: entry.message,
                        });
                        fallbackTrace.push({
                            ...entry,
                            message: safeTraceMessage(entry.reasonCode, entry.message),
                        });
                    };
                    let lastError = failure('backend_unavailable', 'No document preview backend completed the request', true);
                    for (const backendId of candidates) {
                        if (!isActive()) {
                            this.emitProgress(senderId, progressEvent(request, 'cancelled', backendId));
                            return cancelled();
                        }
                        if (this.quarantinedBackends.has(backendId)) {
                            const message = 'Preview backend is quarantined after unbounded execution';
                            recordFallback({
                                backendId,
                                outcome: 'unavailable',
                                reasonCode: 'backend_unavailable',
                                message,
                                elapsedMs: 0,
                            });
                            lastError = backendFailure('backend_unavailable', message, backendId, true);
                            continue;
                        }
                        const backend = planner.getBackend(backendId);
                        if (!backend) {
                            recordFallback({
                                backendId,
                                outcome: 'skipped',
                                reasonCode: 'backend_unavailable',
                                message: 'Preview backend is not registered',
                                elapsedMs: 0,
                            });
                            continue;
                        }
                        const startedAt = Date.now();
                        this.emitProgress(senderId, progressEvent(request, 'preflight', backendId));
                        let status;
                        state.activeBackendId = backendId;
                        try {
                            status = await backend.preflight({
                                senderId,
                                request,
                                source: entry.source,
                                signal: controller.signal,
                            });
                        }
                        catch (error) {
                            const message = error instanceof Error ? error.message : 'Backend preflight failed';
                            recordFallback({
                                backendId,
                                outcome: 'failed',
                                reasonCode: 'backend_unavailable',
                                message,
                                elapsedMs: Math.max(0, Date.now() - startedAt),
                            });
                            lastError = backendFailure('backend_unavailable', message, backendId, true);
                            if (state.activeBackendId === backendId)
                                state.activeBackendId = undefined;
                            continue;
                        }
                        if (state.activeBackendId === backendId)
                            state.activeBackendId = undefined;
                        if (status.backendId !== backendId) {
                            const message = 'Preview backend returned a mismatched status identity';
                            recordFallback({
                                backendId,
                                outcome: 'failed',
                                reasonCode: 'backend_unavailable',
                                message,
                                elapsedMs: Math.max(0, Date.now() - startedAt),
                            });
                            lastError = backendFailure('backend_unavailable', message, backendId, true);
                            continue;
                        }
                        if (status.availability !== 'available') {
                            const reasonCode = status.availability === 'installable'
                                ? 'component_unavailable'
                                : 'backend_unavailable';
                            const message = status.reason ?? `${backendId} is ${status.availability}`;
                            recordFallback({
                                backendId,
                                outcome: status.availability === 'installable' ? 'skipped' : 'unavailable',
                                reasonCode,
                                message,
                                elapsedMs: Math.max(0, Date.now() - startedAt),
                            });
                            lastError = backendFailure(reasonCode, message, backendId, true);
                            continue;
                        }
                        if (!capabilitySetIncludes(backend.descriptor.capabilities, request.requiredCapabilities)) {
                            const message = `Backend ${backendId} does not provide the requested capabilities`;
                            recordFallback({
                                backendId,
                                outcome: 'skipped',
                                reasonCode: 'backend_unavailable',
                                message,
                                elapsedMs: Math.max(0, Date.now() - startedAt),
                            });
                            lastError = backendFailure('backend_unavailable', message, backendId, true);
                            continue;
                        }
                        if (!isActive()) {
                            this.emitProgress(senderId, progressEvent(request, 'cancelled', backendId));
                            return cancelled();
                        }
                        const workDir = await mkdtemp(path.join(tmpdir(), 'mavis-office-preview-transform-'));
                        let preserveWorkDir = false;
                        let cacheKey;
                        let commitToken;
                        try {
                            this.emitProgress(senderId, progressEvent(request, 'transforming', backendId));
                            const sourceIntegrity = {
                                beforeTransform: () => this.verifyRegisteredSourceHash(senderId, request.sourceId, entry.source.contentSha256, ownerToken),
                                afterTransform: () => this.verifyRegisteredSourceHash(senderId, request.sourceId, entry.source.contentSha256, ownerToken),
                            };
                            let job;
                            let transformed;
                            state.activeBackendId = backendId;
                            try {
                                job = startBackendTransformJob(backend, {
                                    senderId,
                                    request,
                                    source: entry.source,
                                    sanitizedSource: staged.value.handle,
                                    signal: controller.signal,
                                    workDir,
                                    deadlineAtMs: prepareDeadlineAtMs,
                                    sourceIntegrity,
                                    markUnboundedExecution: () => {
                                        // A native backend may have returned after a bounded
                                        // proof attempt without proving that its process tree is
                                        // gone. Quarantine before the candidate loop can admit
                                        // another job, and retain the private workspace so a
                                        // surviving descendant never races recursive cleanup.
                                        this.log.error({
                                            msg: '[DocumentPreview][orchestrator] backend signalled unbounded native execution; quarantining, a native (soffice) process may be orphaned',
                                            senderId,
                                            requestId: request.requestId,
                                            backendId,
                                        });
                                        preserveWorkDir = true;
                                        this.quarantinedBackends.add(backendId);
                                    },
                                });
                                state.activeJob = job;
                                transformed = await job.result;
                            }
                            finally {
                                if (job && state.activeJob === job)
                                    state.activeJob = undefined;
                                if (state.activeBackendId === backendId)
                                    state.activeBackendId = undefined;
                            }
                            if (!transformed.ok) {
                                const error = transformed.error;
                                const outcome = error.code === 'cancelled' ? 'cancelled' : 'failed';
                                recordFallback({
                                    backendId,
                                    outcome,
                                    reasonCode: error.code,
                                    message: error.message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                lastError = {
                                    ok: false,
                                    error: { ...error, backendId: error.backendId ?? backendId },
                                };
                                // A mutated source invalidates the shared staged input; trying a
                                // lower-fidelity backend with the same generation would publish
                                // an artifact whose source identity is no longer trustworthy.
                                if (error.code === 'cancelled' || error.code === 'source_mutated')
                                    return lastError;
                                continue;
                            }
                            if (!isActive()) {
                                recordFallback({
                                    backendId,
                                    outcome: 'cancelled',
                                    reasonCode: 'cancelled',
                                    message: 'Document preview was cancelled',
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                return cancelled();
                            }
                            // Keep the source-integrity contract at the publication boundary.
                            // Backends receive the callback as a defence-in-depth check, but
                            // a successful draft must not be trusted unless the orchestrator
                            // itself verifies that the original source is still unchanged.
                            let sourceUnchanged = false;
                            try {
                                sourceUnchanged = await sourceIntegrity.afterTransform();
                            }
                            catch {
                                sourceUnchanged = false;
                            }
                            if (!sourceUnchanged) {
                                const message = 'Document preview source changed during transformation';
                                recordFallback({
                                    backendId,
                                    outcome: 'failed',
                                    reasonCode: 'source_mutated',
                                    message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                return backendFailure('source_mutated', message, backendId);
                            }
                            if (!isActive()) {
                                this.emitProgress(senderId, progressEvent(request, 'cancelled', backendId));
                                return cancelled();
                            }
                            const draft = transformed.value;
                            if (draft.backendId !== backendId ||
                                !backend.descriptor.outputKinds.includes(draft.kind) ||
                                !Array.isArray(draft.resources) ||
                                draft.resources.length === 0) {
                                const message = 'Preview backend returned an invalid artifact draft';
                                recordFallback({
                                    backendId,
                                    outcome: 'failed',
                                    reasonCode: 'transform_failed',
                                    message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                lastError = backendFailure('transform_failed', message, backendId, true);
                                continue;
                            }
                            const validatedResources = await validateArtifactDraftResources(workDir, draft.resources, request.policy.maxArtifactBytes);
                            if (!validatedResources.ok) {
                                const reasonCode = validatedResources.reason === 'resource_limit_exceeded'
                                    ? 'resource_limit_exceeded'
                                    : 'artifact_invalid';
                                const message = reasonCode === 'resource_limit_exceeded'
                                    ? 'Preview artifact exceeds the request publication limit'
                                    : 'Preview backend returned an artifact outside its transform workspace';
                                recordFallback({
                                    backendId,
                                    outcome: 'failed',
                                    reasonCode,
                                    message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                lastError = backendFailure(reasonCode, message, backendId, reasonCode !== 'resource_limit_exceeded');
                                continue;
                            }
                            cacheKey = buildArtifactCacheKey({
                                contentSha256: entry.source.contentSha256,
                                backendId: draft.backendId,
                                backendVersion: draft.backendVersion,
                                processorVersion: this.options.processorVersion,
                            });
                            const committed = await this.options.artifactStore.commitCacheEntry({
                                cacheKey,
                                backendId: draft.backendId,
                                backendVersion: draft.backendVersion,
                                processorVersion: this.options.processorVersion,
                                kind: draft.kind,
                                ...(draft.pageCount === undefined ? {} : { pageCount: draft.pageCount }),
                                ...(draft.slideCount === undefined ? {} : { slideCount: draft.slideCount }),
                                warnings: draft.warnings,
                                resources: draft.resources.map((resource, index) => ({
                                    resourceId: resource.resourceId,
                                    name: resource.name,
                                    mediaType: resource.mediaType,
                                    sourcePath: validatedResources.resources[index].canonicalPath,
                                    sizeBytes: validatedResources.resources[index].sizeBytes,
                                })),
                                maxCommitBytes: request.policy.maxArtifactBytes,
                                signal: controller.signal,
                                isActive,
                            });
                            if (committed.ok)
                                commitToken = committed.value.commitToken;
                            const discardCommit = async () => {
                                if (!commitToken || !cacheKey)
                                    return;
                                const discard = this.options.artifactStore.discardUnleasedCommit;
                                if (typeof discard !== 'function')
                                    return;
                                await discard.call(this.options.artifactStore, {
                                    cacheKey: committed.ok ? committed.value.cacheKey : cacheKey,
                                    commitToken,
                                });
                                commitToken = undefined;
                            };
                            if (!isActive()) {
                                await discardCommit();
                                recordFallback({
                                    backendId,
                                    outcome: 'cancelled',
                                    reasonCode: 'cancelled',
                                    message: 'Document preview was cancelled',
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                return cancelled();
                            }
                            if (!committed.ok) {
                                recordFallback({
                                    backendId,
                                    outcome: 'failed',
                                    reasonCode: committed.error.code,
                                    message: committed.error.message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                lastError = { ok: false, error: { ...committed.error, backendId } };
                                continue;
                            }
                            const leased = await this.options.artifactStore.acquireLease({
                                senderId,
                                sourceId: request.sourceId,
                                cacheKey: committed.value.cacheKey,
                                fallbackTrace,
                                maxArtifactBytes: request.policy.maxArtifactBytes,
                                signal: controller.signal,
                                isActive,
                            });
                            if (!isActive()) {
                                if (leased.ok) {
                                    await this.options.artifactStore.releaseLease({
                                        senderId,
                                        previewId: leased.value.previewId,
                                    });
                                }
                                await discardCommit();
                                return cancelled();
                            }
                            if (!leased.ok) {
                                await discardCommit();
                                recordFallback({
                                    backendId,
                                    outcome: 'failed',
                                    reasonCode: leased.error.code,
                                    message: leased.error.message,
                                    elapsedMs: Math.max(0, Date.now() - startedAt),
                                });
                                lastError = { ok: false, error: { ...leased.error, backendId } };
                                continue;
                            }
                            this.emitProgress(senderId, progressEvent(request, 'ready', backendId, 1));
                            return leased;
                        }
                        catch (error) {
                            if (typeof commitToken === 'string' && cacheKey) {
                                const discard = this.options.artifactStore.discardUnleasedCommit;
                                if (typeof discard === 'function') {
                                    await discard.call(this.options.artifactStore, {
                                        cacheKey,
                                        commitToken,
                                    });
                                }
                                commitToken = undefined;
                            }
                            const message = error instanceof Error ? error.message : 'Preview transform failed';
                            recordFallback({
                                backendId,
                                outcome: !isActive() ? 'cancelled' : 'failed',
                                reasonCode: !isActive() ? 'cancelled' : 'transform_failed',
                                message,
                                elapsedMs: Math.max(0, Date.now() - startedAt),
                            });
                            lastError = backendFailure(!isActive() ? 'cancelled' : 'transform_failed', message, backendId, true);
                            if (!isActive())
                                return lastError;
                        }
                        finally {
                            if (!preserveWorkDir) {
                                await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
                            }
                        }
                    }
                    return lastError;
                }
                finally {
                    await staged.value.release();
                }
            }
            catch (error) {
                // The rich infrastructure failure (stack included) stays in the
                // main-process log; the renderer only receives the stable redacted
                // `internal` diagnostic returned below.
                this.log.error({
                    msg: '[DocumentPreview][orchestrator] prepare infrastructure failure',
                    senderId,
                    requestId: request.requestId,
                    ...describeDocumentPreviewError(error),
                });
                return failure('internal', 'Document preview infrastructure failed', true);
            }
            finally {
                // Request membership and admission belong to the terminal owner. This
                // finally only marks completion of execution-owned cleanup above.
            }
        })();
        state.executionPromise = execution;
        const operation = execution.finally(() => state.terminal.close('settled'));
        state.promise = operation;
        this.liveOperations.set(operation, senderId);
        void operation.then(() => this.liveOperations.delete(operation), () => this.liveOperations.delete(operation));
        // A backend is untrusted code from the orchestrator's perspective. The
        // terminal owner bounds termination proof and quarantines an execution
        // that cannot settle before it releases request capacity.
        void operation.catch(() => undefined);
        const deadlineTimer = setTimeout(() => {
            void state.terminal.close('timeout', failure('timeout', 'Document preview timed out', true));
        }, deadlineMs);
        return Promise.race([operation, state.terminalResult]).finally(() => {
            clearTimeout(deadlineTimer);
        });
    }
    async cancel(senderId, input) {
        if (!isRecord(input) || typeof input.requestId !== 'string') {
            return failure('invalid_request', 'Invalid document preview cancellation request');
        }
        const state = this.pending.get(requestKey(senderId, input.requestId));
        if (state) {
            void state.terminal.close('cancelled', failure('cancelled', 'Document preview was cancelled', true));
        }
        return { ok: true, value: null };
    }
    getBackendStatuses() {
        if (this.shutdownStarted) {
            return Promise.resolve(failure('cancelled', 'Document preview backend status probe was cancelled', true));
        }
        const now = Date.now();
        if (this.backendStatusCache && this.backendStatusCache.expiresAtMs > now) {
            return Promise.resolve(this.backendStatusCache.result);
        }
        this.backendStatusCache = undefined;
        if (this.backendStatusFlight)
            return this.backendStatusFlight.promise;
        const controller = new AbortController();
        let resolveInterruption;
        const interruption = new Promise((resolve) => {
            resolveInterruption = resolve;
        });
        let interrupted = false;
        let deadlineTimer;
        const clearDeadline = () => {
            if (!deadlineTimer)
                return;
            clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
        };
        const interrupt = (result) => {
            if (interrupted)
                return;
            interrupted = true;
            controller.abort();
            clearDeadline();
            resolveInterruption(result);
        };
        deadlineTimer = setTimeout(() => interrupt(failure('timeout', 'Document preview backend status probe timed out', true)), positiveIntegerOr(this.options.backendStatusTimeoutMs, DEFAULT_BACKEND_STATUS_TIMEOUT_MS));
        const probe = this.probeBackendStatuses(controller.signal);
        void probe.catch(() => undefined);
        let flight;
        const promise = Promise.race([probe, interruption])
            .then((result) => {
            if (this.backendStatusFlight === flight && !this.shutdownStarted) {
                const ttlMs = result.ok
                    ? positiveIntegerOr(this.options.backendStatusCacheTtlMs, DEFAULT_BACKEND_STATUS_CACHE_TTL_MS)
                    : positiveIntegerOr(this.options.backendStatusFailureCooldownMs, DEFAULT_BACKEND_STATUS_FAILURE_COOLDOWN_MS);
                this.backendStatusCache = {
                    result,
                    expiresAtMs: Date.now() + ttlMs,
                };
            }
            return result;
        })
            .finally(() => {
            clearDeadline();
            if (this.backendStatusFlight === flight)
                this.backendStatusFlight = undefined;
        });
        flight = {
            promise,
            cancel: () => interrupt(failure('cancelled', 'Document preview backend status probe was cancelled', true)),
        };
        this.backendStatusFlight = flight;
        return promise;
    }
    async probeBackendStatuses(signal) {
        const { platform, arch } = resolveRuntimeTuple(this.options.runtimeTuple);
        const syntheticSource = {
            schema: 'mavis.preview_source.v1',
            sourceId: 'status-source',
            fileName: 'status.pptx',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            sizeBytes: 1,
            modifiedAtMs: 0,
            contentSha256: `sha256:${'0'.repeat(64)}`,
        };
        const request = {
            schema: 'mavis.preview_request.v1',
            requestId: 'status-request',
            sourceId: syntheticSource.sourceId,
            intent: 'high-fidelity',
            requiredCapabilities: [],
            preferredArtifactKinds: ['pdf.v1'],
            policy: {
                allowComponentDownload: false,
                timeoutMs: PPTX_PREVIEW_LIMITS_V1.nativeConversionTimeoutMs,
                maxInputBytes: PPTX_PREVIEW_LIMITS_V1.maxInputBytes,
                maxArtifactBytes: PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes,
            },
        };
        try {
            const statuses = await Promise.all(this.options.backendRegistry.list().map(async (backend) => {
                try {
                    const status = await backend.preflight({
                        senderId: 0,
                        request,
                        source: syntheticSource,
                        signal,
                    });
                    const reason = safeBackendStatusReason(status.availability, status.reason);
                    return {
                        ...status,
                        ...(reason ? { reason } : {}),
                    };
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : 'Backend status probe failed';
                    return {
                        backendId: backend.descriptor.id,
                        availability: 'unavailable',
                        reason: safeBackendStatusReason('unavailable', reason),
                        platform: platform ?? process.platform,
                        arch: arch ?? process.arch,
                    };
                }
            }));
            return { ok: true, value: statuses };
        }
        catch {
            return failure('backend_unavailable', 'Document preview backend status probe failed', true);
        }
    }
    async releaseSender(senderId, ownerToken) {
        this.senderAlive.set(senderId, false);
        this.senderEpochs.set(senderId, this.senderEpoch(senderId) + 1);
        // Revoke sender-owned stores before waiting for workers to unwind. Electron
        // may recycle a numeric WebContents id during that wait; deferring a bulk
        // release until afterwards would let the old teardown sweep sources or
        // leases already created by the rebound sender. Both stores synchronously
        // retire/remove their current ownership records before their cleanup
        // promises yield, while invalidated workers are forbidden from publishing
        // new records.
        const storeCleanup = Promise.all([
            startObservedCleanup(() => ownerToken === undefined
                ? this.options.sourceRegistry.releaseSender(senderId)
                : this.options.sourceRegistry.releaseSender(senderId, ownerToken)),
            startObservedCleanup(() => this.options.artifactStore.releaseSender(senderId)),
        ]);
        const terminalClosures = [...this.pending.values()]
            .filter((state) => state.senderId === senderId)
            .map((state) => state.terminal.close('sender_teardown', failure('cancelled', 'Document preview was cancelled', true)));
        const live = [...this.liveOperations]
            .filter(([, operationSenderId]) => operationSenderId === senderId)
            .map(([operation]) => operation);
        if (terminalClosures.length > 0 || live.length > 0) {
            await settlesWithin(Promise.allSettled([...terminalClosures, ...live]), DEFAULT_SHUTDOWN_TIMEOUT_MS);
        }
        const cleanupResults = await storeCleanup;
        const failedCleanup = cleanupResults.find((result) => !result.ok);
        if (failedCleanup) {
            this.log.error({
                msg: '[DocumentPreview][orchestrator] releaseSender store cleanup failed',
                senderId,
                ...describeDocumentPreviewError(failedCleanup.reason),
            });
            throw failedCleanup.reason;
        }
    }
    async shutdown() {
        this.shutdownStarted = true;
        const shutdownTimeoutMs = positiveIntegerOr(this.options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
        const statusFlight = this.backendStatusFlight;
        statusFlight?.cancel();
        this.backendStatusCache = undefined;
        if (statusFlight)
            await statusFlight.promise;
        for (const senderId of this.senderAlive.keys()) {
            this.senderAlive.set(senderId, false);
            this.senderEpochs.set(senderId, this.senderEpoch(senderId) + 1);
        }
        const terminalClosures = [...this.pending.values()].map((state) => state.terminal.close('shutdown', failure('cancelled', 'Document preview was cancelled', true)));
        const live = [...this.liveOperations.keys()];
        let operationsStopped = true;
        if (terminalClosures.length > 0 || live.length > 0) {
            operationsStopped = await settlesWithin(Promise.allSettled([...terminalClosures, ...live]), shutdownTimeoutMs);
        }
        // Admission/publication is already closed above. Start every owner cleanup
        // before awaiting any sibling so one rejection or a live-operation timeout
        // can never skip another owner's best-effort teardown.
        let cleanupResults;
        const cleanup = Promise.allSettled([
            Promise.resolve().then(() => this.options.sourceRegistry.releaseAll()),
            Promise.resolve().then(() => this.options.componentManager.shutdown()),
            Promise.resolve().then(() => this.options.artifactStore.shutdown()),
        ]).then((results) => {
            cleanupResults = results;
        });
        const cleanupStopped = await settlesWithin(cleanup, shutdownTimeoutMs);
        if (!cleanupStopped) {
            return failure('timeout', 'Document preview owners did not stop before shutdown', true);
        }
        const [sourceCleanup, componentCleanup, artifactCleanup] = cleanupResults;
        for (const [owner, result] of [
            ['source registry', sourceCleanup],
            ['component manager', componentCleanup],
            ['artifact store', artifactCleanup],
        ]) {
            if (result.status !== 'rejected')
                continue;
            this.log.error({
                msg: '[DocumentPreview][orchestrator] shutdown failed',
                owner,
                ...describeDocumentPreviewError(result.reason),
            });
        }
        if (!operationsStopped) {
            return failure('timeout', 'Document preview requests did not stop before shutdown', true);
        }
        if (sourceCleanup.status === 'fulfilled' &&
            sourceCleanup.value &&
            typeof sourceCleanup.value === 'object' &&
            'ok' in sourceCleanup.value &&
            sourceCleanup.value.ok === false) {
            return sourceCleanup.value;
        }
        if (componentCleanup.status === 'rejected' || artifactCleanup.status === 'rejected') {
            return failure('internal', 'Document preview shutdown failed', true);
        }
        if (sourceCleanup.status === 'rejected') {
            return failure('internal', 'Document preview shutdown failed', true);
        }
        return { ok: true, value: null };
    }
    sanitizerOptionsForSource(senderId, sourceId, ownerToken) {
        const entry = this.resolveSourceForBackend(senderId, sourceId, ownerToken);
        return { pptxPreflight: entry?.source.fileName.toLowerCase().endsWith('.pptx') === true };
    }
    resolveSourceForBackend(senderId, sourceId, ownerToken) {
        return ownerToken === undefined
            ? this.options.sourceRegistry.resolveForBackend(senderId, sourceId)
            : this.options.sourceRegistry.resolveForBackend(senderId, sourceId, ownerToken);
    }
    readRegisteredSource(senderId, sourceId, maxBytes, ownerToken) {
        return ownerToken === undefined
            ? this.options.sourceRegistry.read(senderId, sourceId, maxBytes)
            : this.options.sourceRegistry.read(senderId, sourceId, maxBytes, ownerToken);
    }
    cacheSanitizedSource(senderId, sourceId, bytes, ownerToken) {
        return ownerToken === undefined
            ? this.options.sourceRegistry.cacheSanitizedCopy(senderId, sourceId, bytes)
            : this.options.sourceRegistry.cacheSanitizedCopy(senderId, sourceId, bytes, ownerToken);
    }
    verifyRegisteredSourceHash(senderId, sourceId, expectedSha256, ownerToken) {
        return ownerToken === undefined
            ? this.options.sourceRegistry.verifySourceHash(senderId, sourceId, expectedSha256)
            : this.options.sourceRegistry.verifySourceHash(senderId, sourceId, expectedSha256, ownerToken);
    }
    sourceGeneration(senderId, sourceId, ownerToken) {
        const getGeneration = this.options.sourceRegistry.getSourceGeneration;
        return typeof getGeneration === 'function'
            ? ownerToken === undefined
                ? getGeneration.call(this.options.sourceRegistry, senderId, sourceId)
                : getGeneration.call(this.options.sourceRegistry, senderId, sourceId, ownerToken)
            : null;
    }
    async discardStagedCopyIfGeneration(senderId, sourceId, kind, generation, ownerToken) {
        if (generation === null)
            return;
        const discard = this.options.sourceRegistry.deleteStagedCopyIfGeneration;
        if (typeof discard !== 'function')
            return;
        if (ownerToken === undefined) {
            await discard.call(this.options.sourceRegistry, senderId, sourceId, kind, generation);
        }
        else {
            await discard.call(this.options.sourceRegistry, senderId, sourceId, kind, generation, ownerToken);
        }
    }
    async acquireSanitizedCopy(senderId, sourceId, source, maxBytes, signal, ownerToken) {
        const existing = ownerToken === undefined
            ? this.options.sourceRegistry.acquireSanitizedCopy(senderId, sourceId)
            : this.options.sourceRegistry.acquireSanitizedCopy(senderId, sourceId, ownerToken);
        if (existing)
            return { ok: true, value: existing };
        const sourceGeneration = this.sourceGeneration(senderId, sourceId, ownerToken);
        const read = await this.readRegisteredSource(senderId, sourceId, maxBytes, ownerToken);
        if (!read.ok)
            return read;
        if (signal.aborted)
            return failure('cancelled', 'Document preview was cancelled', true);
        const sanitized = await this.options.sanitize(read.value.bytes, signal, {
            pptxPreflight: source.fileName.toLowerCase().endsWith('.pptx'),
        });
        if (!sanitized.ok)
            return sanitized;
        if (signal.aborted)
            return failure('cancelled', 'Document preview was cancelled', true);
        const cached = await this.cacheSanitizedSource(senderId, sourceId, sanitized.value.bytes, ownerToken);
        if (!cached.ok)
            return cached;
        const discardStagedCopy = async () => {
            await this.discardStagedCopyIfGeneration(senderId, sourceId, 'sanitized', sourceGeneration === null ? null : sourceGeneration + 1, ownerToken);
        };
        if (signal.aborted) {
            await discardStagedCopy();
            return failure('cancelled', 'Document preview was cancelled', true);
        }
        const lease = ownerToken === undefined
            ? this.options.sourceRegistry.acquireSanitizedCopy(senderId, sourceId)
            : this.options.sourceRegistry.acquireSanitizedCopy(senderId, sourceId, ownerToken);
        if (!lease) {
            if (signal.aborted)
                await discardStagedCopy();
            return failure('source_not_found', 'Sanitized preview source is no longer available', true);
        }
        if (signal.aborted) {
            await lease.release();
            await discardStagedCopy();
            return failure('cancelled', 'Document preview was cancelled', true);
        }
        return { ok: true, value: lease };
    }
}

