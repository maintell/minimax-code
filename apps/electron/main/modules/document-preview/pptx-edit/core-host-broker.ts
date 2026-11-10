import { AsyncLocalStorage } from "node:async_hooks";
import { PptEditOpenCoordinator, PptEditAdmissionError } from "./open-coordinator";
import { PptChartReadiness } from "./chart-readiness";
import { observeDisposableRendererExit } from "../../../lifecycle/renderer-incident-controller";
import { isEn } from "../../../config/env";
import { savedPptFileAuthority } from "../saved-file-authority";
import { validatePptProposal } from "./proposal-validator";
import { proposeUtilityPptEdits } from "../../local-runtime/utility";
import { PptEditRecoveryStore } from "./recovery-store";
import { writePptExport } from "./export-file";
import { PptEditSerialQueue } from "./serial-queue";
import { pickPptResource } from "./resource-picker";
import { app, ipcMain, BrowserWindow, clipboard, dialog, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { decodePptxEditingRequestV1, decodePptxEditingTransactionV1 } from "@mavis/shared/pptx-editing";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
import { documentPreviewSourceRegistry } from "../runtime";
import { getPageURL } from "../../../config/routes";
import { applyCorePptxPatch } from "./package-adapter";
/** Domain logic lives in pptx-core; this broker owns file and renderer authority. */
export class PptxEditCoreHostBroker {
    ownerLifecycle(owner) {
        const existing = this.owners.get(owner);
        if (existing)
            return existing;
        const state = {
            epoch: 0,
            dispose: () => undefined,
        };
        const retire = () => {
            state.epoch++;
            for (const opening of this.pendingOpens.values())
                if (opening.owner === owner)
                    this.cancelOpen(opening);
            const closing = [...this.entries.values()]
                .filter((entry) => entry.owner === owner)
                .map((entry) => {
                entry.retired = true;
                entry.readiness?.dispose();
                for (const job of entry.proposalJobs.values())
                    job.abort();
                return entry.queue.run(() => this.close(entry));
            });
            state.cleanup = Promise.allSettled([state.cleanup, ...closing]).then(() => undefined);
        };
        let disposeRendererExit = observeDisposableRendererExit(owner, retire);
        const navigate = (_event, _url, inPlace, mainFrame) => {
            if (!mainFrame || inPlace)
                return;
            retire();
            // The shared incident controller owns renderer-exit listeners. Re-arm its
            // document resource observer for the next main-frame lifetime.
            disposeRendererExit();
            disposeRendererExit = observeDisposableRendererExit(owner, retire);
        };
        const destroyed = () => {
            retire();
            state.dispose();
        };
        state.dispose = () => {
            owner.removeListener('did-start-navigation', navigate);
            disposeRendererExit();
            owner.removeListener('destroyed', destroyed);
            this.owners.delete(owner);
        };
        owner.on('did-start-navigation', navigate);
        owner.once('destroyed', destroyed);
        this.owners.set(owner, state);
        return state;
    }
    recovery() {
        return (this.recoveryStore ?? (this.recoveryStore = new PptEditRecoveryStore(path.join(app.getPath('userData'), 'pptx-edit', 'recovery'))));
    }
    scope(entry) {
        return entry.source.lineageScopeId ?? entry.source.sourceId;
    }
    withRecovery(entry, value) {
        const state = value;
        if (state?.schema !== 'mavis.pptx_editing.v1' || typeof state.dirty !== 'boolean')
            throw new Error('invalid_request');
        entry.readiness?.update(state);
        return {
            ...state,
            dirty: state.dirty || entry.recovery.restored,
            recovery: { ...entry.recovery },
        };
    }
    notifyStatus(entry) {
        if (!entry.retired && !entry.owner.isDestroyed())
            entry.owner.send('pptx-edit:status', {
                editSessionId: entry.id,
                recovery: { ...entry.recovery },
            });
    }
    scheduleRecovery(entry) {
        clearTimeout(entry.recoveryTimer);
        entry.recoveryRequestedAt = performance.now();
        entry.recoveryTimer = setTimeout(() => {
            entry.recoveryTimer = undefined;
            void entry.queue.run(() => this.autosave(entry)).catch(() => undefined);
        }, 2000);
    }
    async autosave(entry) {
        if (entry.opening || entry.recovery.available || !this.host || this.host.isDestroyed())
            return;
        const observedAt = entry.recoveryRequestedAt ?? performance.now();
        let savedRevision = 0;
        let savedBytes = 0;
        entry.recovery.saving = true;
        this.notifyStatus(entry);
        try {
            const state = (await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: { action: 'state' },
            }));
            if (!state.dirty && !entry.recovery.restored) {
                await this.recovery().discard(this.scope(entry));
                entry.recovery.failed = false;
                return;
            }
            const plan = (await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: { action: 'prepare-save' },
            }));
            const bytes = await this.measure('packageMs', () => applyCorePptxPatch(entry.baselineBytes, plan));
            savedRevision = plan.documentRevision;
            savedBytes = bytes.byteLength;
            await this.recovery().save(this.scope(entry), entry.source.contentSha256, plan.documentRevision, bytes);
            entry.recovery.failed = false;
        }
        catch (error) {
            entry.recovery.failed = true;
            // The renderer only receives a failed status; keep the safe code for diagnosis.
            console.warn('[PPTX edit recovery] autosave failed', {
                code: this.safeCode(error instanceof Error ? error.message : ''),
            });
        }
        finally {
            entry.recovery.saving = false;
            if ((savedBytes > 0 || entry.recovery.failed) && !entry.retired && !entry.owner.isDestroyed())
                entry.owner.send('pptx-edit:status', {
                    kind: 'performance',
                    editSessionId: entry.id,
                    stage: 'recovery-persist',
                    status: entry.recovery.failed ? 'failed' : 'success',
                    elapsedMs: Math.min(86400000, Math.max(0, Math.round(performance.now() - observedAt))),
                    revision: savedRevision,
                    bytes: savedBytes,
                });
            this.notifyStatus(entry);
        }
    }
    async propose(entry, input) {
        if (!entry.sessionId)
            throw new Error('unsupported_edit');
        if (entry.proposalJobs.size >= 2 || entry.proposalJobs.has(input.generationId))
            throw new Error('resource_limit_exceeded');
        const controller = new AbortController();
        entry.proposalJobs.set(input.generationId, controller);
        try {
            const epoch = entry.epoch;
            const state = await entry.queue.run(async () => {
                if (entry.recovery.available)
                    throw new Error('conflict');
                return (await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'state' },
                }));
            });
            const targets = state.objects.filter((object) => input.targetIds.includes(object.id));
            if (targets.length !== input.targetIds.length ||
                targets.some((object) => !object.editable.includes('text') && !object.editable.includes('appearance')))
                throw new Error('scope_violation');
            if (input.textRange &&
                (targets.length !== 1 ||
                    targets[0].text == null ||
                    input.textRange.end > targets[0].text.length))
                throw new Error('scope_violation');
            let reply;
            try {
                reply = await proposeUtilityPptEdits({
                    sessionId: entry.sessionId,
                    instruction: input.instruction,
                    targets: targets.map((object) => ({
                        id: object.id,
                        name: object.name,
                        text: input.textRange
                            ? object.text.slice(input.textRange.start, input.textRange.end)
                            : object.text,
                        textStyle: object.textStyle,
                        appearance: object.appearance,
                    })),
                }, controller.signal);
            }
            catch {
                throw new Error(controller.signal.aborted ? 'cancelled' : 'proposal_failed');
            }
            if (this.entries.get(entry.id) !== entry ||
                entry.owner.isDestroyed() ||
                epoch !== entry.epoch)
                throw new Error('conflict');
            if (controller.signal.aborted)
                throw new Error('cancelled');
            const proposal = validatePptProposal(state, input.targetIds, reply, input.textRange);
            entry.proposals.set(proposal.view.id, { ...proposal, epoch, createdAtMs: Date.now() });
            while (entry.proposals.size > 8)
                entry.proposals.delete(entry.proposals.keys().next().value);
            return proposal.view;
        }
        finally {
            entry.proposalJobs.delete(input.generationId);
        }
    }
    async restoreRecovery(entry) {
        const snapshot = await this.recovery().load(this.scope(entry), entry.source.contentSha256);
        if (!snapshot)
            throw new Error('source_mutated');
        await this.readOriginal(entry);
        return this.hydrateSnapshot(entry, snapshot.bytes, true);
    }
    async readOriginal(entry) {
        if (documentPreviewSourceRegistry.getSourceGeneration(entry.owner.id, entry.source.sourceId, entry.owner) !==
            entry.sourceGeneration)
            throw new Error('source_mutated');
        const actual = await documentPreviewSourceRegistry.read(entry.owner.id, entry.source.sourceId, PPTX_PREVIEW_LIMITS_V1.maxInputBytes, entry.owner);
        if (!actual.ok ||
            `sha256:${createHash('sha256').update(actual.value.bytes).digest('hex')}` !==
                entry.source.contentSha256)
            throw new Error('source_mutated');
        return Buffer.from(actual.value.bytes);
    }
    async hydrateSnapshot(entry, bytes, restored) {
        const host = await this.window();
        const name = `recovery-${randomUUID()}.pptx`;
        await writeFile(path.join(entry.folder, name), bytes, { mode: 0o600, flag: 'wx' });
        const source = await documentPreviewSourceRegistry.open(host.webContents.id, {
            readOnly: true,
            workspaceDir: entry.folder,
            filePath: name,
            fileName: entry.source.fileName,
            mimeType: entry.source.mimeType,
        }, host.webContents);
        if (!source.ok)
            throw new Error('source_not_found');
        const oldSource = entry.coreSourceId;
        entry.readiness?.dispose();
        await this.request({ operation: 'close', editSessionId: entry.id }).catch(() => undefined);
        try {
            const opened = (await this.request({
                operation: 'open',
                editSessionId: entry.id,
                sourceId: source.value.sourceId,
                preparation: entry.preparation,
            }));
            entry.epoch++;
            this.startReadiness(entry, opened.state);
            entry.proposals.clear();
            entry.coreSourceId = source.value.sourceId;
            entry.baselineBytes = bytes;
            entry.recovery = { available: false, restored, saving: false, failed: false };
            await documentPreviewSourceRegistry
                .release(host.webContents.id, oldSource, host.webContents)
                .catch(() => undefined);
            this.notifyStatus(entry);
            return this.withRecovery(entry, opened.state);
        }
        catch (error) {
            await documentPreviewSourceRegistry
                .release(host.webContents.id, source.value.sourceId, host.webContents)
                .catch(() => undefined);
            throw error;
        }
    }
    constructor() {
        this.host = null;
        this.opening = null;
        this.entries = new Map();
        this.pending = new Map();
        this.ready = null;
        this.closed = false;
        this.clipboardSnapshot = null;
        this.clipboardQueue = new PptEditSerialQueue();
        this.openCoordinator = new PptEditOpenCoordinator();
        this.nextOpenEpoch = 0;
        this.pendingOpens = new Map();
        this.owners = new Map();
        this.recoveryStore = null;
        this.performanceScope = new AsyncLocalStorage();
        ipcMain.handle('pptx-edit-host:ready', (event) => {
            if (event.sender !== this.host?.webContents || event.senderFrame !== event.sender.mainFrame)
                throw new Error('invalid_request');
            this.ready?.();
            this.ready = null;
        });
        ipcMain.on('pptx-edit-host:reply', (event, input) => {
            if (event.sender !== this.host?.webContents ||
                event.senderFrame !== event.sender.mainFrame ||
                !input ||
                typeof input !== 'object')
                return;
            const reply = input;
            const pending = reply.requestId && this.pending.get(reply.requestId);
            if (!pending)
                return;
            this.pending.delete(reply.requestId);
            clearTimeout(pending.timeout);
            if (reply.errorCode)
                pending.reject(new Error(this.safeCode(reply.errorCode)));
            else {
                try {
                    const value = reply.stateJson === undefined ? reply.value : JSON.parse(reply.stateJson);
                    if (reply.stateJson !== undefined && value?.schema !== 'mavis.pptx_editing.v1')
                        throw new Error('invalid_request');
                    pending.resolve(value, reply.documentSummary);
                }
                catch {
                    pending.reject(new Error('invalid_request'));
                }
            }
        });
    }
    safeCode(value) {
        return [
            'invalid_request',
            'source_mutated',
            'source_not_found',
            'invalid_transaction',
            'conflict',
            'scope_violation',
            'unsupported_edit',
            'capability_pending',
            'unsupported_formula',
            'media_decode_failed',
            'history_empty',
            'resource_limit_exceeded',
            'timeout',
            'cancelled',
            'invalid_patch_plan',
            'proposal_failed',
        ].includes(value)
            ? value
            : 'unsupported_edit';
    }
    async window() {
        // Admission closes before shutdown drains recovery snapshots on the live Host.
        if (this.host && !this.host.isDestroyed() && !this.opening)
            return this.host;
        if (this.closed)
            throw new Error('source_not_found');
        if (this.opening)
            return this.opening;
        this.opening = (async () => {
            const host = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.resolve(__dirname, '../../../preload.js'),
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                },
            });
            this.host = host;
            host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            host.webContents.on('will-navigate', (event) => event.preventDefault());
            let readyTimer;
            const ready = new Promise((resolve) => {
                this.ready = resolve;
            });
            const disposeRendererExit = observeDisposableRendererExit(host.webContents, () => {
                if (!host.isDestroyed())
                    host.destroy();
            });
            const hostContents = host.webContents;
            const hostId = hostContents.id;
            host.on('closed', () => {
                disposeRendererExit();
                if (this.host === host)
                    this.host = null;
                for (const request of this.pending.values()) {
                    clearTimeout(request.timeout);
                    request.reject(new Error('source_not_found'));
                }
                this.pending.clear();
                if (!this.closed)
                    for (const entry of this.entries.values()) {
                        entry.readiness?.dispose();
                        entry.recovery.available = true;
                        entry.recovery.failed = true;
                        this.notifyStatus(entry);
                    }
                void documentPreviewSourceRegistry.releaseSender(hostId, hostContents);
            });
            try {
                await host.loadURL(getPageURL('/pptx-edit-core'));
                // Cold development builds can spend longer than the readiness timeout
                // compiling this page. Only time the Host handshake after it loads.
                await Promise.race([
                    ready,
                    new Promise((_, reject) => {
                        readyTimer = setTimeout(() => reject(new Error('timeout')), 30000);
                    }),
                ]);
                return host;
            }
            catch (error) {
                this.ready = null;
                if (!host.isDestroyed())
                    host.destroy();
                throw error;
            }
            finally {
                clearTimeout(readyTimer);
            }
        })();
        try {
            return await this.opening;
        }
        finally {
            this.opening = null;
        }
    }
    async measure(field, action) {
        const observation = this.performanceScope.getStore();
        const at = performance.now();
        try {
            return await action();
        }
        finally {
            if (observation)
                observation[field] += Math.max(0, performance.now() - at);
        }
    }
    request(input, onSummary) {
        return this.measure('hostRequestMs', () => this.requestUnmeasured(input, onSummary));
    }
    async requestUnmeasured(input, onSummary) {
        const host = await this.window();
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('timeout'));
            }, 120000);
            this.pending.set(requestId, {
                resolve: (value, summary) => {
                    onSummary?.(summary);
                    resolve(value);
                },
                reject,
                timeout,
            });
            host.webContents.send('pptx-edit-host:request', {
                ...input,
                ...(input.operation === 'edit' ? { acceptJsonState: true } : {}),
                requestId,
            });
        });
    }
    async execute(owner, input) {
        const at = performance.now();
        const observation = {
            requestId: randomUUID(),
            queueMs: 0,
            operationMs: 0,
            hostRequestMs: 0,
            dialogMs: 0,
            packageMs: 0,
        };
        return this.performanceScope.run(observation, async () => {
            let result = await this.executeUnmeasured(owner, input);
            // Opt in at the Desktop transport boundary. Sending the same JSON-safe
            // state as a string avoids repeatedly cloning its large object graph
            // through IPC and contextBridge. Legacy callers keep the object reply.
            if (result.ok &&
                input?.action === 'edit' &&
                input.acceptJsonState === true &&
                result.value &&
                typeof result.value === 'object' &&
                result.value.schema === 'mavis.pptx_editing.v1') {
                try {
                    result = { ...result, value: null, stateJson: JSON.stringify(result.value) };
                }
                catch {
                    /* Keep the original reply if a future state is not JSON-safe. */
                }
            }
            observation.operationMs = Math.max(0, performance.now() - at - observation.queueMs);
            return {
                ...result,
                performance: {
                    ...observation,
                    queueMs: Math.round(observation.queueMs),
                    operationMs: Math.round(observation.operationMs),
                    hostRequestMs: Math.round(observation.hostRequestMs),
                    dialogMs: Math.round(observation.dialogMs),
                    packageMs: Math.round(observation.packageMs),
                },
            };
        });
    }
    async executeUnmeasured(owner, input) {
        try {
            if (this.closed || owner.isDestroyed())
                throw new Error('invalid_request');
            const request = decodePptxEditingRequestV1(input);
            if (request.action === 'cancel-open') {
                const pending = this.pendingOpens.get(request.openId);
                if (pending?.owner === owner && pending.sourceId === request.sourceId)
                    this.cancelOpen(pending);
                return { ok: true, value: null };
            }
            if (request.action === 'open')
                return { ok: true, value: await this.openCoordinated(owner, request) };
            const entry = this.entries.get(request.editSessionId);
            if (!entry || entry.retired || entry.owner !== owner || owner.isDestroyed())
                throw new Error('source_not_found');
            if (request.action === 'capabilities') {
                entry.readiness?.prioritize(request.objectId, request.slideIndex);
                return { ok: true, value: entry.readiness?.read() ?? null };
            }
            if (request.action === 'cancel-proposal') {
                entry.proposalJobs.get(request.generationId)?.abort();
                return { ok: true, value: null };
            }
            if (request.action === 'propose')
                return { ok: true, value: await this.propose(entry, request) };
            const queuedAt = performance.now();
            const execute = () => {
                const observation = this.performanceScope.getStore();
                if (observation)
                    observation.queueMs += Math.max(0, performance.now() - queuedAt);
                return this.executeEntry(owner, entry, request);
            };
            if (request.action === 'clipboard')
                return await this.clipboardQueue.run(() => entry.queue.run(execute));
            return await entry.queue.run(execute);
        }
        catch (error) {
            return {
                ok: false,
                error: { code: this.safeCode(error instanceof Error ? error.message : '') },
            };
        }
    }
    async executeEntry(owner, entry, input) {
        if (this.entries.get(entry.id) !== entry || entry.retired || owner.isDestroyed())
            throw new Error('source_not_found');
        if (input.action === 'read' && input.request.method === 'selection')
            entry.readiness?.prioritize(undefined, input.request.slideIndex);
        if (input.action === 'clipboard') {
            const copied = this.clipboardSnapshot;
            const available = input.operation !== 'copy' &&
                input.operation !== 'cut' &&
                copied &&
                clipboard.readHTML().includes(`data-mavis-ppt-clipboard="${copied.token}"`);
            if (input.operation === 'inspect')
                return { ok: true, value: { kind: available ? copied.kind : null } };
            if (entry.recovery.available)
                throw new Error('conflict');
            if (input.operation === 'paste') {
                if (!available || !copied || (input.kind !== undefined && input.kind !== copied.kind))
                    throw new Error('unsupported_edit');
                let documentSummary;
                const value = (await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: {
                        action: 'clipboard-paste',
                        ...(input.position === undefined ? {} : { position: input.position }),
                        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
                        snapshot: copied.value,
                        targetId: input.targetId,
                        expectedRevision: input.expectedRevision,
                    },
                }, (summary) => {
                    documentSummary = summary;
                }));
                this.scheduleRecovery(entry);
                return {
                    ok: true,
                    value: { ...value, state: this.withRecovery(entry, value.state) },
                    ...(documentSummary !== undefined ? { documentSummary } : {}),
                };
            }
            const value = await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: {
                    action: 'clipboard-export',
                    kind: input.kind,
                    targetIds: input.targetIds,
                    expectedRevision: input.expectedRevision,
                },
            });
            if (owner.isDestroyed() || this.entries.get(entry.id) !== entry)
                throw new Error('source_not_found');
            const token = `mavis-ppt-clipboard:${randomUUID()}`;
            this.clipboardSnapshot = { token, value, count: input.targetIds.length, kind: input.kind };
            const text = typeof value.plainText === 'string'
                ? value.plainText.slice(0, 8192)
                : '';
            const escaped = text
                .replace(/&/gu, '&amp;')
                .replace(/</gu, '&lt;')
                .replace(/>/gu, '&gt;')
                .replace(/"/gu, '&quot;');
            clipboard.write({
                text,
                html: `<span data-mavis-ppt-clipboard="${token}">${escaped}</span>`,
            });
            if (input.operation === 'cut') {
                const state = (await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'state' },
                }));
                if (state.revision !== input.expectedRevision)
                    throw new Error('conflict');
                const transaction = {
                    schema: 'mavis.pptx_transaction.v1',
                    commandId: randomUUID(),
                    transactionId: randomUUID(),
                    baseRevision: state.revision,
                    actor: 'human',
                    scope: input.targetIds,
                    expectedVersions: {},
                    operations: input.targetIds.map((targetId) => input.kind === 'slides'
                        ? { kind: 'page', action: 'delete', targetId }
                        : { kind: 'delete-shape', targetId }),
                };
                let documentSummary;
                const changed = await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'execute', transaction },
                }, (summary) => {
                    documentSummary = summary;
                });
                this.scheduleRecovery(entry);
                return {
                    ok: true,
                    value: { state: this.withRecovery(entry, changed), insertedIds: [], kind: input.kind },
                    ...(documentSummary !== undefined ? { documentSummary } : {}),
                };
            }
            return { ok: true, value: { kind: input.kind, count: input.targetIds.length } };
        }
        if (input.action === 'confirm-leave') {
            const window = BrowserWindow.fromWebContents(owner);
            const options = {
                type: 'question',
                buttons: isEn
                    ? ['Save changes', 'Discard changes', 'Cancel']
                    : ['保存修改', '舍弃修改', '取消'],
                defaultId: 0,
                cancelId: 2,
                noLink: true,
                message: isEn ? 'This presentation contains unsaved changes' : '文稿包含尚未保存的修改',
                detail: entry.source.fileName,
            };
            const answer = window
                ? await dialog.showMessageBox(window, options)
                : await dialog.showMessageBox(options);
            if (answer.response === 2 || answer.response < 0)
                return { ok: true, value: { choice: 'cancel' } };
            if (answer.response === 0)
                return { ok: true, value: { choice: 'save' } };
            let state;
            if (entry.recovery.restored) {
                const original = await documentPreviewSourceRegistry.read(owner.id, entry.source.sourceId, PPTX_PREVIEW_LIMITS_V1.maxInputBytes, owner);
                if (!original.ok)
                    throw new Error('source_mutated');
                state = await this.hydrateSnapshot(entry, Buffer.from(original.value.bytes), false);
            }
            else {
                const current = (await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'state' },
                }));
                state = await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'discard', expectedRevision: current.revision },
                });
            }
            clearTimeout(entry.recoveryTimer);
            await this.recovery().discard(this.scope(entry));
            entry.recovery = { available: false, restored: false, saving: false, failed: false };
            entry.epoch++;
            entry.proposals.clear();
            this.notifyStatus(entry);
            return { ok: true, value: { choice: 'discard', state: this.withRecovery(entry, state) } };
        }
        if (input.action === 'proposal') {
            const proposal = entry.proposals.get(input.proposalId);
            if (!proposal ||
                proposal.epoch !== entry.epoch ||
                Date.now() - proposal.createdAtMs > 600000)
                throw new Error('conflict');
            if (input.choice === 'reject') {
                entry.proposals.delete(input.proposalId);
                return { ok: true, value: null };
            }
            const state = await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: { action: 'execute', transaction: proposal.transaction },
            });
            entry.proposals.delete(input.proposalId);
            this.scheduleRecovery(entry);
            return { ok: true, value: this.withRecovery(entry, state) };
        }
        if (input.action === 'recovery') {
            if (input.choice === 'restore')
                return { ok: true, value: await this.restoreRecovery(entry) };
            if (entry.recovery.restored)
                throw new Error('invalid_request');
            // A crashed CoreHost has lost its sessions. Reopen the authoritative original
            // before clearing recovery, including when no autosave snapshot exists yet.
            const state = entry.recovery.available
                ? await this.hydrateSnapshot(entry, await this.readOriginal(entry), false)
                : await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'state' },
                });
            await this.recovery().discard(this.scope(entry));
            entry.recovery.available = false;
            entry.recovery.failed = false;
            this.notifyStatus(entry);
            return {
                ok: true,
                value: this.withRecovery(entry, state),
            };
        }
        if (entry.recovery.available &&
            input.action !== 'read' &&
            input.action !== 'close' &&
            !(input.action === 'edit' && input.command.action === 'state'))
            throw new Error('conflict');
        if (input.action === 'export-picture') {
            const request = {
                method: 'picture',
                objectId: input.objectId,
                expectedVersion: input.expectedVersion,
            };
            const picture = (await this.request({
                operation: 'read',
                editSessionId: entry.id,
                request,
            }));
            const assertCurrentOwner = () => {
                if (owner.isDestroyed() ||
                    entry.retired ||
                    this.entries.get(entry.id) !== entry ||
                    documentPreviewSourceRegistry.getSourceGeneration(owner.id, entry.source.sourceId, owner) !==
                        entry.sourceGeneration)
                    throw new Error('source_mutated');
            };
            assertCurrentOwner();
            const extension = {
                'image/png': 'png',
                'image/jpeg': 'jpg',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'image/bmp': 'bmp',
                'image/tiff': 'tiff',
                'image/svg+xml': 'svg',
                'image/avif': 'avif',
            }[picture.mediaType];
            if (!extension ||
                !(picture.bytes instanceof ArrayBuffer) ||
                !picture.bytes.byteLength ||
                picture.bytes.byteLength > PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes ||
                picture.objectVersion !== input.expectedVersion)
                throw new Error('unsupported_edit');
            const name = picture.name
                .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
                .replace(/\.[^.]+$/u, '')
                .slice(0, 100) || 'image';
            const options = {
                defaultPath: `${name}.${extension}`,
                filters: [{ name: 'Image', extensions: [extension] }],
            };
            const window = BrowserWindow.fromWebContents(owner);
            const selected = window
                ? await this.measure('dialogMs', () => dialog.showSaveDialog(window, options))
                : await this.measure('dialogMs', () => dialog.showSaveDialog(options));
            if (selected.canceled || !selected.filePath)
                return { ok: true, value: null };
            assertCurrentOwner();
            await this.request({ operation: 'read', editSessionId: entry.id, request });
            assertCurrentOwner();
            await writePptExport(selected.filePath, Buffer.from(picture.bytes));
            return { ok: true, value: { saved: true } };
        }
        if (input.action === 'select-resource') {
            const resource = await pickPptResource(owner, input.kind, (duration) => {
                const observation = this.performanceScope.getStore();
                if (observation)
                    observation.dialogMs += duration;
            });
            if (!resource)
                return { ok: true, value: null };
            if (input.kind !== 'image') {
                const value = await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: { action: 'register-media', ...resource, mediaKind: input.kind },
                });
                return { ok: true, value };
            }
            const value = await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: { action: 'register-picture', ...resource },
            });
            return { ok: true, value };
        }
        if (input.action === 'edit') {
            if (!input.command || !['state', 'execute', 'undo', 'redo'].includes(input.command.action))
                throw new Error('invalid_request');
            const command = input.command.action === 'execute'
                ? {
                    ...input.command,
                    transaction: {
                        ...decodePptxEditingTransactionV1(input.command.transaction),
                        actor: 'human',
                    },
                }
                : input.command;
            let documentSummary;
            const state = await this.request({ operation: 'edit', editSessionId: entry.id, command }, (summary) => {
                documentSummary = summary;
            });
            if (command.action !== 'state')
                this.scheduleRecovery(entry);
            return {
                ok: true,
                value: this.withRecovery(entry, state),
                ...(documentSummary !== undefined ? { documentSummary } : {}),
            };
        }
        if (input.action === 'read')
            return {
                ok: true,
                value: await this.request({
                    operation: 'read',
                    editSessionId: entry.id,
                    request: input.request,
                }),
            };
        if (input.action === 'save') {
            const plan = (await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: { action: 'prepare-save' },
            }));
            if (plan.documentRevision !== input.expectedRevision ||
                plan.baseSourceSha256 !==
                    `sha256:${createHash('sha256').update(entry.baselineBytes).digest('hex')}`)
                throw new Error('conflict');
            const mode = input.mode === 'save' && !documentPreviewSourceRegistry.canEditPptxSource(owner.id, entry.source.sourceId, owner)
                ? 'save-as'
                : input.mode;
            if (mode !== 'save') {
                const read = await documentPreviewSourceRegistry.read(owner.id, entry.source.sourceId, PPTX_PREVIEW_LIMITS_V1.maxInputBytes, owner);
                if (!read.ok ||
                    documentPreviewSourceRegistry.getSourceGeneration(owner.id, entry.source.sourceId, owner) !==
                        entry.sourceGeneration)
                    throw new Error('source_mutated');
                const bytes = await this.measure('packageMs', () => applyCorePptxPatch(entry.baselineBytes, plan));
                let destination;
                if (mode === 'external-open')
                    destination = path.join(entry.folder, `export-${randomUUID()}.pptx`);
                else {
                    const options = {
                        defaultPath: entry.source.fileName,
                        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
                    };
                    const window = BrowserWindow.fromWebContents(owner);
                    const selected = window
                        ? await this.measure('dialogMs', () => dialog.showSaveDialog(window, options))
                        : await this.measure('dialogMs', () => dialog.showSaveDialog(options));
                    if (selected.canceled || !selected.filePath)
                        throw new Error('cancelled');
                    destination = selected.filePath;
                }
                if (owner.isDestroyed() ||
                    this.entries.get(entry.id) !== entry ||
                    documentPreviewSourceRegistry.getSourceGeneration(owner.id, entry.source.sourceId, owner) !==
                        entry.sourceGeneration)
                    throw new Error('source_mutated');
                const file = await writePptExport(destination, bytes);
                if (mode === 'external-open') {
                    const error = await shell.openPath(file);
                    if (error)
                        throw new Error('unsupported_edit');
                }
                // An explicit Save As exports a copy and keeps editing the original, including read-only
                // sources. A Save forced into Save As (read-only source) or a Save As onto the source file
                // itself adopts the saved file so later saves and the baseline match the bytes on disk.
                if (mode !== 'save-as' ||
                    (input.mode === 'save-as' &&
                        !documentPreviewSourceRegistry.isSourceFile(owner.id, entry.source.sourceId, file, owner)))
                    return {
                        ok: true,
                        value: {
                            result: this.withRecovery(entry, await this.request({
                                operation: 'edit',
                                editSessionId: entry.id,
                                command: { action: 'state' },
                            })),
                            source: { ...entry.source, sourceGeneration: entry.sourceGeneration },
                            mode: mode === 'save-as' ? 'save-copy' : mode,
                        },
                    };
                const savedFileToken = await savedPptFileAuthority().issue(file);
                const opened = await documentPreviewSourceRegistry.open(owner.id, {
                    workspaceDir: path.dirname(file),
                    filePath: path.basename(file),
                    fileName: path.basename(file),
                    mimeType: entry.source.mimeType,
                }, owner);
                if (!opened.ok)
                    throw new Error('source_not_found');
                await this.recovery().discard(this.scope(entry));
                entry.baselineBytes = bytes;
                entry.recovery = { available: false, restored: false, saving: false, failed: false };
                clearTimeout(entry.recoveryTimer);
                entry.epoch++;
                entry.proposals.clear();
                entry.source = opened.value;
                entry.sourceGeneration = documentPreviewSourceRegistry.getSourceGeneration(owner.id, opened.value.sourceId, owner);
                const result = await this.request({
                    operation: 'edit',
                    editSessionId: entry.id,
                    command: {
                        action: 'commit-save',
                        revision: plan.documentRevision,
                        sourceSha256: opened.value.contentSha256,
                    },
                });
                return {
                    ok: true,
                    value: {
                        result,
                        source: { ...opened.value, sourceGeneration: entry.sourceGeneration },
                        target: { rootDir: path.dirname(file), path: path.basename(file), savedFileToken },
                        mode,
                    },
                };
            }
            let committedBytes;
            const saved = await documentPreviewSourceRegistry.applyPptxEdit(owner.id, {
                sourceId: entry.source.sourceId,
                contentSha256: entry.source.contentSha256,
                sourceGeneration: entry.sourceGeneration,
            }, async () => {
                committedBytes = await this.measure('packageMs', () => applyCorePptxPatch(entry.baselineBytes, plan));
                return committedBytes;
            }, owner);
            if (!saved.ok)
                return { ok: false, error: { code: saved.error.code } };
            await this.recovery().discard(this.scope(entry));
            entry.baselineBytes = committedBytes;
            entry.recovery = { available: false, restored: false, saving: false, failed: false };
            clearTimeout(entry.recoveryTimer);
            entry.source = saved.value;
            entry.sourceGeneration = saved.value.sourceGeneration;
            const result = await this.request({
                operation: 'edit',
                editSessionId: entry.id,
                command: {
                    action: 'commit-save',
                    revision: plan.documentRevision,
                    sourceSha256: saved.value.contentSha256,
                },
            });
            this.notifyStatus(entry);
            return { ok: true, value: { result: this.withRecovery(entry, result), source: saved.value } };
        }
        if (input.action === 'close') {
            await this.close(entry);
            return { ok: true, value: null };
        }
        throw new Error('invalid_request');
    }
    async describeOpenEntry(same) {
        const state = this.withRecovery(same, await this.request({
            operation: 'edit',
            editSessionId: same.id,
            command: { action: 'state' },
        }));
        if (!same.readiness)
            this.startReadiness(same, state);
        return {
            kind: 'ready',
            editSessionId: same.id,
            sourceGeneration: same.sourceGeneration,
            source: same.source,
            result: {
                state,
                runtimeHash: same.runtimeHash,
                readiness: same.readiness.read(),
                summary: await this.request({
                    operation: 'read',
                    editSessionId: same.id,
                    request: { method: 'summary' },
                }),
            },
        };
    }
    async openCoordinated(owner, input) {
        const lifecycle = this.ownerLifecycle(owner);
        const ownerEpoch = lifecycle.epoch;
        if (lifecycle.cleanup)
            await lifecycle.cleanup;
        if (this.closed || owner.isDestroyed())
            throw new Error('source_not_found');
        if (lifecycle.epoch !== ownerEpoch)
            throw new Error('cancelled');
        const source = documentPreviewSourceRegistry.getSource(owner.id, input.sourceId, owner);
        if (!source)
            throw new Error('source_not_found');
        const generation = documentPreviewSourceRegistry.getSourceGeneration(owner.id, input.sourceId, owner);
        if (generation == null ||
            (input.sourceGeneration !== undefined && input.sourceGeneration !== generation) ||
            source.contentSha256 !== input.contentSha256)
            throw new Error('source_mutated');
        if (!documentPreviewSourceRegistry.canOpenPptxEditor(owner.id, input.sourceId, owner)) {
            if (input.preparation === 'basic')
                return Promise.resolve({
                    kind: 'not-eligible',
                    reason: 'view-only-source',
                });
            throw new Error('unsupported_edit');
        }
        const key = JSON.stringify([owner.id, input.sourceId, generation, source.contentSha256]);
        const pending = this.openCoordinator.pending(key);
        if (pending)
            return pending;
        const same = [...this.entries.values()].find((entry) => entry.owner === owner && entry.source.sourceId === input.sourceId);
        if (same) {
            if (same.sourceGeneration !== generation ||
                same.source.contentSha256 !== source.contentSha256)
                throw new Error('source_mutated');
            return same.queue.run(() => this.describeOpenEntry(same));
        }
        const openId = input.openId ?? randomUUID();
        if (this.pendingOpens.has(openId))
            throw new Error('conflict');
        const opening = { key, owner, sourceId: input.sourceId, cancelled: false };
        this.pendingOpens.set(openId, opening);
        const cancelled = () => this.cancelOpen(opening);
        owner.once('destroyed', cancelled);
        return this.openCoordinator
            .run(key, source.lineageScopeId ?? source.sourceId, owner, this.entries.size, (commit) => this.open(owner, { ...input, sourceGeneration: generation }, commit, opening))
            .catch((error) => {
            if (input.preparation === 'basic' &&
                error instanceof PptEditAdmissionError &&
                !opening.cancelled &&
                !this.closed &&
                !owner.isDestroyed())
                return { kind: 'not-eligible', reason: error.reason };
            throw error;
        })
            .finally(() => {
            this.pendingOpens.delete(openId);
            owner.removeListener('destroyed', cancelled);
        });
    }
    cancelOpen(opening) {
        opening.cancelled = true;
        this.openCoordinator.cancel(opening.key);
        if (opening.entry)
            void opening.entry.queue.run(() => this.close(opening.entry)).catch(() => undefined);
    }
    startReadiness(entry, state) {
        entry.readiness?.dispose();
        entry.readiness = new PptChartReadiness(entry.id, ++this.nextOpenEpoch, async (objectId, expectedVersion) => {
            if (this.entries.get(entry.id) !== entry ||
                entry.retired ||
                this.closed ||
                entry.owner.isDestroyed())
                throw new Error('source_not_found');
            return (await this.request({
                operation: 'capability',
                editSessionId: entry.id,
                command: { action: 'chart-capability', objectId, expectedVersion },
            }));
        }, (status) => {
            if (this.entries.get(entry.id) === entry && !entry.retired && !entry.owner.isDestroyed())
                entry.owner.send('pptx-edit:status', status);
        });
        entry.readiness.update(state);
    }
    async open(owner, input, commitReservation, opening) {
        const assertActive = () => {
            if (opening.cancelled || this.closed || owner.isDestroyed())
                throw new Error('cancelled');
        };
        assertActive();
        const startedAt = performance.now();
        const id = randomUUID();
        const stage = (phase) => {
            if (process.env.NODE_ENV === 'development')
                console.debug('[PPTX edit readiness]', {
                    clock: 'main',
                    editSessionId: id,
                    phase,
                    elapsedMs: performance.now() - startedAt,
                });
        };
        stage('source_authorized');
        const generation = documentPreviewSourceRegistry.getSourceGeneration(owner.id, input.sourceId, owner);
        if (generation !== input.sourceGeneration)
            throw new Error('source_mutated');
        const source = documentPreviewSourceRegistry.getSource(owner.id, input.sourceId, owner);
        if (!source || source.contentSha256 !== input.contentSha256)
            throw new Error('source_mutated');
        const hostTask = this.window().then((host) => {
            stage('host_ready');
            return host;
        });
        void hostTask.catch(() => undefined);
        const recoveryTask = this.recovery().load(source.lineageScopeId ?? source.sourceId, source.contentSha256);
        void recoveryTask.catch(() => undefined);
        const read = await documentPreviewSourceRegistry.read(owner.id, input.sourceId, PPTX_PREVIEW_LIMITS_V1.maxInputBytes, owner);
        if (!read.ok ||
            `sha256:${createHash('sha256').update(read.value.bytes).digest('hex')}` !==
                input.contentSha256)
            throw new Error('source_mutated');
        if (generation !== documentPreviewSourceRegistry.getSourceGeneration(owner.id, input.sourceId, owner) ||
            documentPreviewSourceRegistry.getSource(owner.id, input.sourceId, owner)?.contentSha256 !== source.contentSha256)
            throw new Error('source_mutated');
        assertActive();
        const same = [...this.entries.values()].find((entry) => entry.owner === owner && entry.source.sourceId === input.sourceId);
        if (same)
            return this.describeOpenEntry(same);
        if ([...this.entries.values()].some((entry) => entry.owner !== owner &&
            entry.source.lineageScopeId &&
            entry.source.lineageScopeId === source.lineageScopeId))
            throw new PptEditAdmissionError('session-conflict');
        if (this.entries.size >= 8)
            throw new PptEditAdmissionError('session-limit');
        const base = path.join(app.getPath('userData'), 'pptx-edit');
        await mkdir(base, { recursive: true, mode: 0o700 });
        if (owner.isDestroyed() || this.closed)
            throw new Error('source_not_found');
        const folder = await mkdtemp(path.join(base, 'session-'));
        const file = path.join(folder, 'source.pptx');
        let host;
        let recoveryAvailable = false;
        let opened;
        try {
            await writeFile(file, Buffer.from(read.value.bytes), { mode: 0o600, flag: 'wx' });
            assertActive();
            stage('snapshot_ready');
            [host, recoveryAvailable] = await Promise.all([hostTask, recoveryTask.then(Boolean)]);
            if (owner.isDestroyed() || this.closed)
                throw new Error('source_not_found');
            assertActive();
            opened = await documentPreviewSourceRegistry.open(host.webContents.id, {
                readOnly: true,
                workspaceDir: folder,
                filePath: 'source.pptx',
                fileName: source.fileName,
                mimeType: source.mimeType,
            }, host.webContents);
            assertActive();
            if (!opened.ok) {
                await rm(folder, { recursive: true, force: true });
                throw new Error('source_not_found');
            }
        }
        catch (error) {
            if (opened?.ok) {
                const ownedHost = await hostTask.catch(() => null);
                if (ownedHost)
                    await documentPreviewSourceRegistry
                        .release(ownedHost.webContents.id, opened.value.sourceId, ownedHost.webContents)
                        .catch(() => undefined);
            }
            await rm(folder, { recursive: true, force: true });
            throw error;
        }
        if (!opened?.ok)
            throw new Error('source_not_found');
        const entry = {
            id,
            owner,
            folder,
            source,
            sourceGeneration: generation,
            coreSourceId: opened.value.sourceId,
            runtimeHash: null,
            preparation: input.preparation,
            opening: true,
            sessionId: input.sessionId,
            epoch: 0,
            proposalJobs: new Map(),
            proposals: new Map(),
            baselineBytes: Buffer.from(read.value.bytes),
            recovery: {
                available: recoveryAvailable,
                restored: false,
                saving: false,
                failed: false,
            },
            queue: new PptEditSerialQueue(),
            destroyListener: () => {
                void entry.queue.run(() => this.close(entry)).catch(() => undefined);
            },
        };
        this.entries.set(id, entry);
        opening.entry = entry;
        commitReservation();
        owner.once('destroyed', entry.destroyListener);
        try {
            const result = await this.request({
                operation: 'open',
                editSessionId: id,
                sourceId: opened.value.sourceId,
                preparation: input.preparation,
            });
            assertActive();
            if (this.entries.get(id) !== entry)
                throw new Error('cancelled');
            entry.opening = false;
            stage('basic_edit_ready');
            entry.runtimeHash = result.runtimeHash;
            this.startReadiness(entry, result.state);
            return {
                kind: 'ready',
                sourceGeneration: entry.sourceGeneration,
                editSessionId: id,
                source: entry.source,
                result: {
                    ...result,
                    readiness: entry.readiness?.read(),
                    state: this.withRecovery(entry, result.state),
                },
            };
        }
        catch (error) {
            await this.close(entry);
            throw error;
        }
    }
    async close(entry) {
        if (!this.entries.has(entry.id))
            return;
        entry.readiness?.dispose();
        for (const controller of entry.proposalJobs.values())
            controller.abort();
        entry.proposalJobs.clear();
        clearTimeout(entry.recoveryTimer);
        await this.autosave(entry);
        this.entries.delete(entry.id);
        entry.owner.removeListener('destroyed', entry.destroyListener);
        if (this.host && !this.host.isDestroyed()) {
            await this.request({ operation: 'close', editSessionId: entry.id }).catch(() => undefined);
            await documentPreviewSourceRegistry.release(this.host.webContents.id, entry.coreSourceId, this.host.webContents);
        }
        await rm(entry.folder, { recursive: true, force: true });
    }
    async dispose() {
        this.closed = true;
        for (const opening of this.pendingOpens.values())
            this.cancelOpen(opening);
        this.openCoordinator.dispose();
        for (const entry of this.entries.values())
            await entry.queue.run(() => this.close(entry));
        for (const owner of this.owners.values())
            owner.dispose();
        this.closed = true;
        this.host?.destroy();
        ipcMain.removeHandler('pptx-edit-host:ready');
        ipcMain.removeAllListeners('pptx-edit-host:reply');
    }
}

