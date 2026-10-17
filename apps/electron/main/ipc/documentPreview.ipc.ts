import { shell, ipcMain, MessageChannelMain, BrowserWindow } from "electron";
import { realpath, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertPreviewSystemOpenClaimV1, decodePptxSelectionResolutionRequestV1, decodePptxSelectionResolutionV1 } from "@mavis/shared/document-preview";
import { decodePptxCoreSessionCapabilityV1 } from "@mavis/shared/pptx-rendering";
import { IPC_CHANNELS } from "../config/constants";
import { DocumentPreviewOrchestrator } from "../modules/document-preview/orchestrator";
export { DocumentPreviewOrchestrator };
import { documentPreviewArtifactStore, documentPreviewBackendRegistry, documentPreviewComponentManager, documentPreviewSourceRegistry, createDocumentPreviewComponentManager, createDocumentPreviewBackendRegistryWithLogger, createDocumentPreviewSanitizer, documentPreviewSanitizer } from "../modules/document-preview/runtime";
export { documentPreviewArtifactStore };
export { documentPreviewBackendRegistry };
export { documentPreviewComponentManager };
export { documentPreviewSourceRegistry };
import { PptxCoreSessionRegistry } from "../modules/document-preview/pptx-core/session-registry";
import { streamPptxCoreSource } from "../modules/document-preview/pptx-core/source-stream";
import { verifyTrustedAssetResolution } from "../modules/document-preview/asset-authority";
import { openAssetPathInApp } from "../modules/document-preview/open-asset-in-app";
import { noopDocumentPreviewLogger } from "../modules/document-preview/logging";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { issueTrustedWorkspaceCapability, isTrustedWorkspaceCapability } from "../modules/document-preview/workspace-authority";
import { sanitizePptElementMapResolution, resolvePptSelectionElementFromSidecar } from "../modules/ppt-preview/element-map";
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: { schema: 'mavis.preview_error.v1', code, message, retryable },
    };
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function parseSystemOpenClaim(value) {
    try {
        assertPreviewSystemOpenClaimV1(value);
        return value.kind === 'source'
            ? Object.freeze({
                kind: 'source',
                sourceId: value.sourceId,
                sessionId: value.sessionId,
                contentSha256: value.contentSha256,
                generation: value.generation,
                nonce: value.nonce,
            })
            : Object.freeze({
                kind: 'asset',
                assetId: value.assetId,
                sessionId: value.sessionId,
            });
    }
    catch {
        return null;
    }
}
function systemOpenClaimStillMatches(value, expected) {
    const current = parseSystemOpenClaim(value);
    if (!current || current.kind !== expected.kind)
        return false;
    return current.kind === 'source' && expected.kind === 'source'
        ? current.sourceId === expected.sourceId &&
            current.sessionId === expected.sessionId &&
            current.contentSha256 === expected.contentSha256 &&
            current.generation === expected.generation &&
            current.nonce === expected.nonce
        : current.kind === 'asset' &&
            expected.kind === 'asset' &&
            current.assetId === expected.assetId &&
            current.sessionId === expected.sessionId;
}
function validSystemOpenSender(sender) {
    return (Number.isSafeInteger(sender?.id) &&
        sender.id >= 0 &&
        (typeof sender.isDestroyed !== 'function' || !sender.isDestroyed()));
}
function captureRect(value, bounds) {
    if (!value || typeof value !== 'object')
        return null;
    const input = value;
    const rawX = finiteNumber(input.x);
    const rawY = finiteNumber(input.y);
    const rawWidth = finiteNumber(input.width);
    const rawHeight = finiteNumber(input.height);
    if (rawX === null ||
        rawY === null ||
        rawWidth === null ||
        rawHeight === null ||
        rawWidth <= 0 ||
        rawHeight <= 0 ||
        bounds.width <= 0 ||
        bounds.height <= 0) {
        return null;
    }
    const x = Math.min(Math.max(0, Math.round(rawX)), Math.max(0, bounds.width - 1));
    const y = Math.min(Math.max(0, Math.round(rawY)), Math.max(0, bounds.height - 1));
    return {
        x,
        y,
        width: Math.max(1, Math.min(Math.round(rawWidth), bounds.width - x)),
        height: Math.max(1, Math.min(Math.round(rawHeight), bounds.height - y)),
    };
}
async function resolveWorkspaceFromTrustedRoots(claimedWorkspaceDir, roots) {
    let claimed;
    try {
        claimed = await realpath(claimedWorkspaceDir);
    }
    catch {
        return null;
    }
    for (const root of roots) {
        try {
            const canonicalRoot = await realpath(root);
            if (canonicalRoot === claimed)
                return issueTrustedWorkspaceCapability(canonicalRoot);
        }
        catch {
            // A configured but absent workspace cannot grant authority.
        }
    }
    return null;
}
function bindSenderLifecycle(sender, senderStates, onDestroyed, onMainFrameNavigation) {
    const existing = senderStates.get(sender);
    if (existing)
        return existing;
    const state = { destroyed: false, generation: 0, reads: new Map() };
    senderStates.set(sender, state);
    const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
        // Reload replaces the renderer and its workers without destroying the
        // WebContents. Ready PPTX sessions have already closed their source port,
        // so neither React cleanup nor a port-close event can release them here.
        if (isMainFrame && !isInPlace) {
            state.generation += 1;
            onMainFrameNavigation();
        }
    };
    sender.on('did-start-navigation', onNavigation);
    sender.once('destroyed', () => {
        sender.removeListener('did-start-navigation', onNavigation);
        state.destroyed = true;
        for (const controller of state.reads.keys())
            controller.abort();
        state.reads.clear();
        onDestroyed();
    });
    return state;
}
export function setupDocumentPreviewIPC(options = {}) {
    const logger = options.logger ?? noopDocumentPreviewLogger;
    const sourceRegistry = options.registry ?? documentPreviewSourceRegistry;
    const pptxCoreSessions = options.pptxCoreSessionRegistry ??
        new PptxCoreSessionRegistry(sourceRegistry, {
            onDiagnostic: (diagnostic) => logger.warn({
                msg: '[DocumentPreview][pptx-core] terminal session diagnostic',
                ...diagnostic,
            }),
        });
    // When a real logger is injected but no explicit backend/component manager
    // is supplied, build logger-aware defaults so native conversion failures and
    // managed-component verification reach the main-process log. Otherwise reuse
    // the shared singletons (noop logger).
    const wireLoggerDefaults = Boolean(options.logger) && !options.backendRegistry && !options.componentManager;
    const managedComponentManager = wireLoggerDefaults
        ? createDocumentPreviewComponentManager(logger)
        : undefined;
    const backendRegistry = options.backendRegistry ??
        (managedComponentManager
            ? createDocumentPreviewBackendRegistryWithLogger(managedComponentManager, logger)
            : documentPreviewBackendRegistry);
    const artifactStore = options.artifactStore ?? documentPreviewArtifactStore;
    const componentManager = options.componentManager ?? managedComponentManager ?? documentPreviewComponentManager;
    const sanitize = options.sanitize ??
        (options.logger ? createDocumentPreviewSanitizer(logger) : documentPreviewSanitizer);
    const resolveTrustedWorkspace = options.resolveTrustedWorkspace;
    const resolveTrustedWorkspaceCapability = options.resolveTrustedWorkspaceCapability;
    const resolveTrustedAsset = options.resolveTrustedAsset;
    const openSystemPath = options.openSystemPath ?? ((target) => shell.openPath(target));
    const trustedWorkspaceRoots = options.trustedWorkspaceRoots ??
        (resolveTrustedWorkspace ? [] : [path.join(resolveLocalRuntimeDataDir(), 'workspace')]);
    const senderStates = new WeakMap();
    const sendersById = new Map();
    const senderCleanupPromises = new Set();
    const orchestratorOptions = {
        sourceRegistry,
        sanitize,
        backendRegistry,
        artifactStore,
        componentManager,
        processorVersion: options.processorVersion ?? 'office-preview-v2',
        logger,
    };
    const orchestrator = new DocumentPreviewOrchestrator(orchestratorOptions, (senderId, event) => {
        const sender = sendersById.get(senderId);
        if (!sender || sender.isDestroyed?.() || typeof sender.send !== 'function')
            return;
        try {
            sender.send(IPC_CHANNELS.DOCUMENT_PREVIEW_PROGRESS, event);
        }
        catch {
            // The renderer can disappear while a backend is unwinding.
        }
    });
    const bind = (sender) => {
        sendersById.set(sender.id, sender);
        orchestrator.bindSender(sender.id);
        return bindSenderLifecycle(sender, senderStates, () => {
            // Invalidate authority synchronously; cleanup may await a backend, but
            // no new source/component capability may be issued during that wait.
            options.onSenderDestroyed?.(sender.id);
            options.releaseTrustedAssetSender?.(sender.id);
            if (sendersById.get(sender.id) === sender)
                sendersById.delete(sender.id);
            const cleanup = Promise.all([
                pptxCoreSessions.releaseSender(sender.id, sender),
                orchestrator.releaseSender(sender.id, sender),
            ])
                .then(() => undefined)
                .catch((error) => {
                // Teardown must never reject, but a swallowed cleanup failure hid the
                // cause across every review round. Log it and still resolve undefined.
                logger.warn({
                    msg: '[DocumentPreview][ipc] sender teardown release failed',
                    senderId: sender.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return undefined;
            })
                .finally(() => senderCleanupPromises.delete(cleanup));
            senderCleanupPromises.add(cleanup);
        }, () => {
            const cleanup = pptxCoreSessions.releaseSender(sender.id, sender)
                .catch((error) => {
                logger.warn({
                    msg: '[DocumentPreview][ipc] navigation session cleanup failed',
                    senderId: sender.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            })
                .finally(() => senderCleanupPromises.delete(cleanup));
            senderCleanupPromises.add(cleanup);
        });
    };
    const resolveOpenWorkspace = async (event, input, state, isCurrent) => {
        const claimedWorkspaceDir = input &&
            typeof input === 'object' &&
            typeof input.workspaceDir === 'string'
            ? input.workspaceDir
            : null;
        const sessionId = input &&
            typeof input === 'object' &&
            typeof input.sessionId === 'string'
            ? input.sessionId
            : undefined;
        const hasAssetClaim = Boolean(input) &&
            typeof input === 'object' &&
            Object.prototype.hasOwnProperty.call(input, 'assetId');
        const assetId = hasAssetClaim && typeof input.assetId === 'string'
            ? input.assetId
            : undefined;
        if (hasAssetClaim) {
            if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
                return {
                    trustedWorkspace: null,
                    assetResolution: null,
                    sessionId,
                    assetClaimed: true,
                    invalidRequest: true,
                };
            }
            const assetResolution = assetId !== undefined && resolveTrustedAsset
                ? await Promise.resolve(resolveTrustedAsset({
                    senderId: event.sender.id,
                    assetId,
                    sessionId,
                })).catch(() => null)
                : null;
            return {
                trustedWorkspace: null,
                assetResolution,
                sessionId,
                assetClaimed: true,
                invalidRequest: false,
            };
        }
        // Do not treat an IPC-supplied filesystem path as an authority boundary.
        // The default is an exact main-owned runtime workspace root; hosts with
        // session/workspace state can inject a narrower resolver.  No matching
        // authority means the V2 route fails closed and the renderer uses the
        // established legacy preview fallback.
        const claim = claimedWorkspaceDir
            ? {
                senderId: event.sender.id,
                claimedWorkspaceDir,
                ...(typeof input.filePath === 'string'
                    ? { claimedFilePath: input.filePath }
                    : {}),
                ...(typeof sessionId === 'string' ? { sessionId } : {}),
            }
            : null;
        const resolveClaimedWorkspace = async () => claim
            ? resolveTrustedWorkspace
                ? await Promise.resolve(resolveTrustedWorkspace(claim))
                    .then(async (resolved) => {
                    if (!resolved)
                        return null;
                    // Production authorities expose a companion lookup which ties
                    // the canonical path to the sender/sequence binding. A
                    // string-only host seam is converted to an identity-bound
                    // capability before reaching the source registry.
                    if (resolveTrustedWorkspaceCapability) {
                        const companion = await Promise.resolve(resolveTrustedWorkspaceCapability(claim)).catch(() => null);
                        if (companion && isTrustedWorkspaceCapability(companion))
                            return companion;
                        // A production authority that advertises a companion but
                        // cannot return the same binding (teardown, sequence change,
                        // or root replacement) must fail closed; do not re-canonicalize
                        // the renderer-visible pathname here.
                        return null;
                    }
                    if (typeof resolved === 'object' && isTrustedWorkspaceCapability(resolved)) {
                        return resolved;
                    }
                    if (typeof resolved === 'string') {
                        const capability = await issueTrustedWorkspaceCapability(resolved);
                        // Test/host seams may use a virtual path with a mocked source
                        // registry. Keep that seam usable while real registries still
                        // require the capability for the renderer boundary.
                        return capability
                            ? { canonicalPath: capability.canonicalPath, capability }
                            : { canonicalPath: resolved };
                    }
                    return null;
                })
                    .catch(() => null)
                : claimedWorkspaceDir
                    ? await resolveWorkspaceFromTrustedRoots(claimedWorkspaceDir, trustedWorkspaceRoots)
                    : null
            : null;
        // Workspace authority has one mutable binding per sender. Keep both the
        // root lookup and companion capability lookup in the same transaction;
        // otherwise restoring another PPT tab revokes the first tab's lookup.
        // Only authorization is serialized, never source IO or Core rendering.
        const authorization = (state.workspaceAuthorizationTail ?? Promise.resolve())
            .then(() => (isCurrent() ? resolveClaimedWorkspace() : null))
            .catch(() => null);
        state.workspaceAuthorizationTail = authorization.then(() => undefined);
        const trustedWorkspace = await authorization;
        return {
            trustedWorkspace,
            assetResolution: null,
            sessionId,
            assetClaimed: false,
            invalidRequest: false,
        };
    };
    const handleOpenSource = async (event, input, legacy) => {
        const state = bind(event.sender);
        const generation = state.generation;
        const isCurrent = () => !state.destroyed && state.generation === generation && !shutdownPromise;
        if (!isCurrent())
            return failure('cancelled', 'Document preview source opening was cancelled');
        const { trustedWorkspace, assetResolution, sessionId, assetClaimed, invalidRequest } = await resolveOpenWorkspace(event, input, state, isCurrent);
        if (!isCurrent())
            return failure('cancelled', 'Document preview source opening was cancelled');
        if (invalidRequest) {
            return failure('invalid_request', 'Invalid document preview asset request');
        }
        if ((assetClaimed && !assetResolution) || (!assetClaimed && !trustedWorkspace)) {
            return failure('source_outside_workspace', 'Document preview source is not authorized');
        }
        const openMethod = legacy
            ? orchestrator.openLegacySource.bind(orchestrator)
            : orchestrator.openSource.bind(orchestrator);
        const mainOwnedInput = assetResolution
            ? {
                assetId: assetResolution.assetId,
                sessionId: sessionId,
                assetResolution,
            }
            : {
                ...input,
                // Legacy path requests receive only the main-selected workspace
                // root/capability, never renderer authority.
                workspaceDir: trustedWorkspace?.canonicalPath ?? '',
                ...(trustedWorkspace && isTrustedWorkspaceCapability(trustedWorkspace)
                    ? { workspaceCapability: trustedWorkspace }
                    : trustedWorkspace?.capability
                        ? { workspaceCapability: trustedWorkspace.capability }
                        : {}),
                ...(typeof sessionId === 'string' ? { sessionId } : {}),
            };
        const opened = await openMethod(event.sender.id, mainOwnedInput, event.sender);
        if (!isCurrent()) {
            // A new renderer may already have opened other sources on this window.
            // Release only the stale request, not the current renderer's sources.
            if (opened.ok)
                await orchestrator.releaseSource(event.sender.id, opened.value.sourceId, event.sender);
            return failure('cancelled', 'Document preview source opening was cancelled');
        }
        return opened;
    };
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_SOURCE, (event, input) => handleOpenSource(event, input, false));
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_SAVE_PPTX_NOTES, async (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed)
            return failure('cancelled', 'Notes save cancelled');
        const result = await sourceRegistry.savePptxNotes(event.sender.id, input, event.sender);
        if (!result.ok)
            logger.warn({
                msg: '[DocumentPreview][notes] save failed',
                senderId: event.sender.id,
                code: result.error.code,
            });
        return result;
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_LEGACY_SOURCE, (event, input) => handleOpenSource(event, input, true));
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_CREATE, (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed) {
            return failure('cancelled', 'PPTX core session creation was cancelled');
        }
        return pptxCoreSessions.create(event.sender.id, input, event.sender);
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_BIND, async (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed)
            return failure('cancelled', 'PPTX core session binding was cancelled');
        let capability;
        try {
            capability = decodePptxCoreSessionCapabilityV1(input);
        }
        catch {
            return failure('invalid_request', 'Invalid PPTX core session capability');
        }
        const { port1, port2 } = new MessageChannelMain();
        const bound = pptxCoreSessions.bind(event.sender.id, capability.coreSessionId, capability.nonce, port1, event.sender);
        if (!bound.ok) {
            port2.close();
            return bound;
        }
        try {
            event.sender.postMessage(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_PORT, capability, [port2]);
        }
        catch {
            port2.close();
            await bound.value.terminate();
            return failure('cancelled', 'PPTX core port delivery was cancelled');
        }
        void streamPptxCoreSource(bound.value).then((result) => {
            if (!result.ok) {
                logger.warn({
                    msg: '[DocumentPreview][pptx-core] source stream terminated',
                    senderId: event.sender.id,
                    code: result.error.code,
                });
            }
        });
        return { ok: true, value: null };
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_CANCEL, (event, input) => {
        bind(event.sender);
        let capability;
        try {
            capability = decodePptxCoreSessionCapabilityV1(input);
        }
        catch {
            return Promise.resolve(failure('invalid_request', 'Invalid PPTX core session capability'));
        }
        return pptxCoreSessions.cancel(event.sender.id, capability.coreSessionId, capability.nonce, event.sender);
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_ASSET_IN_APP, async (event, input) => {
        if (!validSystemOpenSender(event.sender) ||
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input))
            return failure('invalid_request', 'Invalid attachment open request');
        const record = input;
        if (Object.keys(record).some((key) => !['assetId', 'sessionId', 'appId'].includes(key)))
            return failure('invalid_request', 'Invalid attachment open request');
        const claim = parseSystemOpenClaim({
            kind: 'asset',
            assetId: record.assetId,
            sessionId: record.sessionId,
        });
        const appId = record.appId;
        if (!claim ||
            claim.kind !== 'asset' ||
            (appId !== undefined && (typeof appId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(appId))))
            return failure('invalid_request', 'Invalid attachment open request');
        if (!resolveTrustedAsset)
            return failure('source_not_found', 'Attachment was not found');
        const state = bind(event.sender);
        const senderIsCurrent = () => !state.destroyed && validSystemOpenSender(event.sender);
        try {
            const resolution = await resolveTrustedAsset({
                senderId: event.sender.id,
                assetId: claim.assetId,
                sessionId: claim.sessionId,
            });
            if (!senderIsCurrent())
                return failure('cancelled', 'Attachment open was cancelled');
            if (!resolution ||
                resolution.senderId !== event.sender.id ||
                resolution.assetId !== claim.assetId ||
                resolution.sessionId !== claim.sessionId ||
                !(await verifyTrustedAssetResolution(resolution, event.sender.id, logger)))
                return failure('source_not_found', 'Attachment is no longer current');
            if (!senderIsCurrent())
                return failure('cancelled', 'Attachment open was cancelled');
            const openPath = options.openAssetPath ?? openAssetPathInApp;
            if (appId === 'finder' || appId === 'file-explorer') {
                await openPath(resolution.absolutePath, appId);
                return { ok: true, value: null };
            }
            // The registered asset stays immutable. Editors receive a persistent copy
            // of the validated snapshot, separate from the expiring preview fallback.
            const lease = await sourceRegistry.acquireSystemOpenAsset(event.sender.id, resolution, event.sender);
            if (!lease)
                return failure('source_not_found', 'Attachment is no longer current');
            let copyDirectory;
            let opened = false;
            try {
                const root = options.assetEditCopyRoot ??
                    path.join(resolveLocalRuntimeDataDir(), 'document-edit-copies');
                await mkdir(root, { recursive: true, mode: 0o700 });
                copyDirectory = await mkdtemp(path.join(root, 'attachment-'));
                const target = path.join(copyDirectory, resolution.fileName);
                await copyFile(lease.path, target, constants.COPYFILE_EXCL);
                if (!senderIsCurrent())
                    return failure('cancelled', 'Attachment open was cancelled');
                if (!(await lease.validate()) ||
                    !(await verifyTrustedAssetResolution(resolution, event.sender.id, logger)))
                    return failure('source_not_found', 'Attachment is no longer current');
                if (!senderIsCurrent())
                    return failure('cancelled', 'Attachment open was cancelled');
                await openPath(target, appId);
                opened = true;
                return { ok: true, value: null };
            }
            finally {
                await lease.release();
                if (!opened && copyDirectory)
                    await rm(copyDirectory, { recursive: true, force: true });
            }
        }
        catch {
            return failure('backend_unavailable', 'The application could not open the attachment');
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_IN_SYSTEM, async (event, input) => {
        if (!validSystemOpenSender(event.sender)) {
            return failure('invalid_request', 'Invalid document preview sender');
        }
        const claim = parseSystemOpenClaim(input);
        if (!claim)
            return failure('invalid_request', 'Invalid document preview system-open claim');
        const state = bind(event.sender);
        const senderIsCurrent = () => !state.destroyed && validSystemOpenSender(event.sender);
        const invokeSystemOpen = async (target) => {
            try {
                const error = await Promise.resolve(openSystemPath(target));
                return error === ''
                    ? { ok: true, value: null }
                    : failure('backend_unavailable', 'The system could not open the document');
            }
            catch {
                return failure('backend_unavailable', 'The system could not open the document');
            }
        };
        if (claim.kind === 'source') {
            const lease = await sourceRegistry
                .acquireSystemOpenSource(event.sender.id, claim, event.sender)
                .catch(() => null);
            if (!lease)
                return failure('source_not_found', 'Document preview source was not found');
            let retained = false;
            try {
                if (!senderIsCurrent()) {
                    return failure('cancelled', 'Document preview system-open was cancelled');
                }
                if (!systemOpenClaimStillMatches(input, claim)) {
                    return failure('invalid_request', 'Document preview system-open claim changed');
                }
                if (!(await lease.validate())) {
                    return failure('source_not_found', 'Document preview source is no longer current');
                }
                if (!senderIsCurrent()) {
                    return failure('cancelled', 'Document preview system-open was cancelled');
                }
                if (!systemOpenClaimStillMatches(input, claim)) {
                    return failure('invalid_request', 'Document preview system-open claim changed');
                }
                const result = await invokeSystemOpen(lease.path);
                if (result.ok) {
                    const refreshedClaim = await lease.retain();
                    if (!refreshedClaim) {
                        return failure('source_not_found', 'Document preview source is no longer current');
                    }
                    retained = true;
                    return {
                        ok: true,
                        value: { systemOpenClaim: refreshedClaim },
                    };
                }
                return result.ok ? { ok: true, value: {} } : result;
            }
            finally {
                if (!retained)
                    await lease.release().catch((error) => {
                        logger.warn({
                            msg: '[DocumentPreview][ipc] system-open source lease release failed',
                            senderId: event.sender.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return undefined;
                    });
            }
        }
        if (!resolveTrustedAsset) {
            return failure('source_not_found', 'Document preview asset was not found');
        }
        const resolution = await Promise.resolve(resolveTrustedAsset({
            senderId: event.sender.id,
            assetId: claim.assetId,
            sessionId: claim.sessionId,
        })).catch(() => null);
        if (!senderIsCurrent()) {
            return failure('cancelled', 'Document preview system-open was cancelled');
        }
        if (!systemOpenClaimStillMatches(input, claim)) {
            return failure('invalid_request', 'Document preview system-open claim changed');
        }
        if (!resolution ||
            resolution.senderId !== event.sender.id ||
            resolution.assetId !== claim.assetId ||
            resolution.sessionId !== claim.sessionId ||
            !(await verifyTrustedAssetResolution(resolution, event.sender.id, logger))) {
            return failure('source_not_found', 'Document preview asset was not found');
        }
        const lease = await sourceRegistry
            .acquireSystemOpenAsset(event.sender.id, resolution, event.sender)
            .catch(() => null);
        if (!lease)
            return failure('source_not_found', 'Document preview asset was not found');
        let retained = false;
        try {
            if (!senderIsCurrent()) {
                return failure('cancelled', 'Document preview system-open was cancelled');
            }
            if (!systemOpenClaimStillMatches(input, claim)) {
                return failure('invalid_request', 'Document preview system-open claim changed');
            }
            if (!(await lease.validate())) {
                return failure('source_not_found', 'Document preview asset is no longer current');
            }
            if (!senderIsCurrent()) {
                return failure('cancelled', 'Document preview system-open was cancelled');
            }
            if (!systemOpenClaimStillMatches(input, claim)) {
                return failure('invalid_request', 'Document preview system-open claim changed');
            }
            const result = await invokeSystemOpen(lease.path);
            if (result.ok) {
                const refreshedClaim = await lease.retain();
                if (!refreshedClaim) {
                    return failure('source_not_found', 'Document preview asset is no longer current');
                }
                retained = true;
                return {
                    ok: true,
                    value: { systemOpenClaim: refreshedClaim },
                };
            }
            return result;
        }
        finally {
            if (!retained)
                await lease.release().catch((error) => {
                    logger.warn({
                        msg: '[DocumentPreview][ipc] system-open asset lease release failed',
                        senderId: event.sender.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return undefined;
                });
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_STAGE_SOURCE, async (event, input) => {
        const state = bind(event.sender);
        const sourceId = input &&
            typeof input === 'object' &&
            typeof input.sourceId === 'string'
            ? input.sourceId
            : '';
        const controller = new AbortController();
        state.reads.set(controller, sourceId);
        if (state.destroyed)
            controller.abort();
        try {
            const staged = await orchestrator.stageSource(event.sender.id, input, controller.signal, event.sender);
            if (!staged.ok)
                return staged;
            const systemOpenClaim = sourceRegistry.issueSystemOpenClaim(event.sender.id, sourceId, event.sender);
            return systemOpenClaim ? { ok: true, value: { ...staged.value, systemOpenClaim } } : staged;
        }
        finally {
            state.reads.delete(controller);
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_STAGE_LEGACY_SOURCE, async (event, input) => {
        const state = bind(event.sender);
        const sourceId = input &&
            typeof input === 'object' &&
            typeof input.sourceId === 'string'
            ? input.sourceId
            : '';
        const controller = new AbortController();
        state.reads.set(controller, sourceId);
        if (state.destroyed)
            controller.abort();
        try {
            const staged = await orchestrator.stageLegacySource(event.sender.id, input, controller.signal, event.sender);
            if (!staged.ok)
                return staged;
            const systemOpenClaim = sourceRegistry.issueSystemOpenClaim(event.sender.id, sourceId, event.sender);
            return systemOpenClaim ? { ok: true, value: { ...staged.value, systemOpenClaim } } : staged;
        }
        finally {
            state.reads.delete(controller);
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_READ_SOURCE, async (event, input) => {
        const state = bind(event.sender);
        const sourceId = input &&
            typeof input === 'object' &&
            typeof input.sourceId === 'string'
            ? input.sourceId
            : '';
        const controller = new AbortController();
        state.reads.set(controller, sourceId);
        if (state.destroyed)
            controller.abort();
        try {
            const read = await orchestrator.readSource(event.sender.id, input, controller.signal, event.sender);
            if (!read.ok)
                return read;
            const systemOpenClaim = sourceRegistry.issueSystemOpenClaim(event.sender.id, sourceId, event.sender);
            return systemOpenClaim ? { ok: true, value: { ...read.value, systemOpenClaim } } : read;
        }
        finally {
            state.reads.delete(controller);
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_RESOLVE_PPTX_SELECTION, async (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed) {
            return failure('cancelled', 'PPTX selection resolution was cancelled');
        }
        let request;
        try {
            request = decodePptxSelectionResolutionRequestV1(input);
        }
        catch {
            return failure('invalid_request', 'Invalid PPTX selection resolution request');
        }
        const lease = await sourceRegistry.acquireSelectionResolutionSource(event.sender.id, request.sourceId, request.contentSha256, request.sourceGeneration, event.sender);
        if (!lease)
            return failure('source_mutated', 'PPTX selection source is no longer current');
        try {
            if (state.destroyed || !(await lease.validate())) {
                return failure('source_mutated', 'PPTX selection source is no longer current');
            }
            const elementResolution = sanitizePptElementMapResolution(resolvePptSelectionElementFromSidecar({
                filePath: lease.path,
                slideNumber: request.slide.number,
                slideSize: { width: request.slide.width, height: request.slide.height },
                selection: {
                    slideRect: request.selection.slideRect,
                    text: request.selection.text,
                },
                instruction: request.instruction,
            }));
            if (state.destroyed || !(await lease.validate())) {
                return failure('source_mutated', 'PPTX selection source changed during resolution');
            }
            try {
                const value = decodePptxSelectionResolutionV1({
                    schema: 'mavis.pptx_selection_resolution.v1',
                    sourceId: request.sourceId,
                    contentSha256: request.contentSha256,
                    sourceGeneration: request.sourceGeneration,
                    slideIndex: request.slide.index,
                    ...elementResolution,
                });
                return { ok: true, value };
            }
            catch {
                return failure('internal', 'PPTX selection resolution could not be sanitized');
            }
        }
        finally {
            await lease.release().catch(() => undefined);
        }
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_PREPARE, (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed)
            return failure('cancelled', 'Document preview request was cancelled');
        return orchestrator.prepare(event.sender.id, input, event.sender);
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_CANCEL, (event, input) => {
        const state = bind(event.sender);
        if (state.destroyed)
            return { ok: true, value: null };
        return orchestrator.cancel(event.sender.id, input);
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_RELEASE, async (event, input) => {
        if (!input || typeof input !== 'object') {
            return failure('invalid_request', 'Invalid document preview release request');
        }
        const request = input;
        if (typeof request.sourceId === 'string') {
            const state = bind(event.sender);
            for (const [controller, sourceId] of state.reads) {
                if (sourceId === request.sourceId)
                    controller.abort();
            }
            await pptxCoreSessions.releaseSource(event.sender.id, request.sourceId, event.sender);
            return orchestrator.releaseSource(event.sender.id, request.sourceId, event.sender);
        }
        if (typeof request.previewId === 'string') {
            bind(event.sender);
            return orchestrator.releasePreview(event.sender.id, request.previewId);
        }
        return failure('invalid_request', 'Document preview release requires a source or preview id');
    });
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_GET_BACKEND_STATUSES, () => orchestrator.getBackendStatuses());
    ipcMain.handle(IPC_CHANNELS.DOCUMENT_PREVIEW_CAPTURE_RENDERER_REGION, async (event, value) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner || owner.isDestroyed()) {
            return failure('backend_unavailable', 'Document preview renderer is unavailable');
        }
        const bounds = owner.getContentBounds();
        const rect = captureRect(value, bounds);
        if (!rect)
            return failure('invalid_request', 'Invalid document preview capture region');
        try {
            const image = await event.sender.capturePage(rect);
            if (image.isEmpty())
                return failure('render_failed', 'Document preview capture was empty');
            return { ok: true, value: { dataUrl: image.toDataURL() } };
        }
        catch {
            return failure('render_failed', 'Document preview capture failed');
        }
    });
    let shutdownPromise;
    return Object.freeze({
        shutdown: () => {
            if (!shutdownPromise) {
                shutdownPromise = (async () => {
                    if (senderCleanupPromises.size > 0) {
                        await Promise.allSettled([...senderCleanupPromises]);
                    }
                    await pptxCoreSessions.shutdown();
                    const result = await orchestrator.shutdown();
                    if (result.ok === false) {
                        throw Object.assign(new Error(result.error.message), {
                            name: 'DocumentPreviewShutdownError',
                            code: result.error.code,
                            cause: result.error,
                        });
                    }
                })();
            }
            return shutdownPromise;
        },
    });
}
