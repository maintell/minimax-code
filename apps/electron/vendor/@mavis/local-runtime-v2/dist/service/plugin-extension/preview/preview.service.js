import { KeyedOperationQueue } from '../../../infra/util/keyed-operation-queue.js';
import { createExtensionDiagnostic, } from '../sdk/diagnostics.js';
/**
 * `preview` ①–④ (two.md §10.2): snapshot and static scan without running code, then activation of
 * exactly the candidate that was bound. The user's approval is the `extension` tool's `preview`
 * permission, checked before the tool runs: once this service is called the preview is allowed,
 * and later changes, including new bundled MCP servers, reload like an installed plugin's.
 */
export class ExtensionPreviewService {
    deps;
    /** Previews between `validate` and their record; their candidate is held by nothing yet. */
    inFlight = 0;
    /**
     * Bumped when a session is deleted: an operation that started under an older epoch is
     * cancelled at its next async boundary, so it cannot re-create the session's preview.
     */
    sessionEpochs = new Map();
    /**
     * One lane per (session, plugin): its preview, reload, restore, withdraw cleanup and installed
     * yield run whole, one after another, in the order they arrived.
     */
    lanes = new KeyedOperationQueue();
    constructor(deps) {
        this.deps = deps;
    }
    async preview(request) {
        const { sessionId, pluginId } = request;
        // Taken before the lane: a session deleted while this waits cancels it on admission.
        const epoch = this.epochOf(sessionId);
        return this.holding(() => this.inLane(sessionId, pluginId, () => this.previewNow(request, epoch)));
    }
    async previewNow(request, epoch) {
        const { sessionId, pluginId } = request;
        if (this.epochOf(sessionId) !== epoch)
            return sessionDeleted();
        if (request.sourcePath) {
            await this.deps.devDirectories.pointTo(sessionId, pluginId, request.sourcePath);
        }
        const reserved = await this.checkName(pluginId);
        if (reserved)
            return reserved;
        const sourceDir = (await this.deps.devDirectories.source(sessionId, pluginId)) ??
            this.deps.devDirectories.directory(sessionId, pluginId);
        const validation = await this.deps.validate({ pluginId, sourceDir });
        if (this.epochOf(sessionId) !== epoch)
            return sessionDeleted();
        if (!validation.artifact) {
            return { status: 'invalid', errors: validation.errors, warnings: validation.warnings };
        }
        this.deps.bindings.bind(sessionId, pluginId, validation.artifact.digest);
        const { artifact, warnings } = validation;
        return this.activate(sessionId, { sourceDir, artifact, warnings }, epoch);
    }
    /** Turn end: every preview of the session whose source changed validates and activates again. */
    async reloadSession(sessionId) {
        const epoch = this.epochOf(sessionId);
        const results = [];
        for (const { pluginId } of this.deps.activations.previewsOf(sessionId)) {
            if (this.epochOf(sessionId) !== epoch)
                break;
            const result = await this.holding(() => this.inLane(sessionId, pluginId, () => this.reloadOne(sessionId, pluginId, epoch)));
            if (result)
                results.push(result);
        }
        return results;
    }
    /** Runtime start / resume: a session's preview record, not yet installed, re-enters. */
    async restore(sessionId, pluginId) {
        const epoch = this.epochOf(sessionId);
        await this.holding(() => this.inLane(sessionId, pluginId, () => this.restoreNow(sessionId, pluginId, epoch)));
    }
    async restoreNow(sessionId, pluginId, epoch) {
        if (this.epochOf(sessionId) !== epoch)
            return;
        const sourceDir = await this.deps.devDirectories.source(sessionId, pluginId);
        if (!this.previewing(sessionId, pluginId) || !sourceDir)
            return;
        const validation = await this.deps.validate({ pluginId, sourceDir });
        if (!validation.artifact || this.epochOf(sessionId) !== epoch)
            return;
        if (!this.previewing(sessionId, pluginId))
            return;
        this.deps.bindings.bind(sessionId, pluginId, validation.artifact.digest);
        const { artifact, warnings } = validation;
        await this.activate(sessionId, { sourceDir, artifact, warnings }, epoch);
    }
    /**
     * The `extension withdraw` action: the session stops previewing the plugin now. Its overlay
     * (bundled MCP servers) and module leave the session and its entries disappear; dev files and
     * store overlay stay, so a later `preview` activates it again.
     * Returns false when the session had no live preview of it when called.
     */
    async withdraw(sessionId, pluginId) {
        const active = this.deps.activations.preview(sessionId, pluginId) !== undefined;
        // Without its record the preview is not restored on resume, and the operation running in the
        // lane is refused at its next check instead of publishing.
        this.deps.bindings.unbind(sessionId, pluginId);
        await this.inLane(sessionId, pluginId, async () => {
            // An operation queued before the withdrawal may have bound again meanwhile.
            this.deps.bindings.unbind(sessionId, pluginId);
            await this.yieldNow(sessionId, pluginId);
        });
        return active;
    }
    /**
     * The installed tier reconciled it: the preview record is consumed and the preview leaves the
     * session overlay. With `expectedDigest` (the binding the reconcile decided on) it yields only
     * if the session is still bound to it once its turn in the lane comes: a preview or reload ahead
     * of it that bound another version stays live. The record goes in the same lane step, so a later
     * uninstall, disable or upgrade (the installed digest no longer matching) leaves nothing for the
     * next runtime start to restore.
     */
    async yieldToInstalled(sessionId, pluginId, expectedDigest) {
        await this.inLane(sessionId, pluginId, async () => {
            if (expectedDigest !== undefined &&
                this.deps.bindings.find(sessionId, pluginId)?.boundDigest !== expectedDigest) {
                return;
            }
            this.deps.bindings.unbind(sessionId, pluginId);
            await this.yieldNow(sessionId, pluginId);
        });
    }
    /** Not re-entrant into the lane: callers already hold it. */
    async yieldNow(sessionId, pluginId) {
        if (this.deps.activations.removePreview(sessionId, pluginId)) {
            this.deps.emit({ type: 'entries-changed', pluginId, sessionId });
            try {
                await this.deps.overlay.remove(sessionId, pluginId);
            }
            catch {
                // The overlay goes with the session at the latest; withdrawing never fails on it.
            }
        }
    }
    /** Candidate snapshots the session's preview records hold. */
    candidateRootsOf(sessionId) {
        return this.deps.activations.previewsOf(sessionId).map((activation) => activation.root);
    }
    /**
     * Of `roots`, the candidates nothing holds any more: no preview record, and no preview in
     * flight that may still bind the same content-addressed snapshot.
     */
    unheldCandidateRoots(roots) {
        if (this.inFlight > 0)
            return [];
        const held = new Set(this.deps.activations.allPreviews().map((activation) => activation.root));
        return [...new Set(roots)].filter((root) => !held.has(root));
    }
    async deleteSession(sessionId) {
        // In-flight previews of the session stop at their next async boundary.
        this.sessionEpochs.set(sessionId, this.epochOf(sessionId) + 1);
        this.deps.activations.removeSession(sessionId);
        try {
            await this.deps.overlay.deleteSession(sessionId);
        }
        catch {
            // Session cleanup continues with the extension's own records.
        }
    }
    async reloadOne(sessionId, pluginId, epoch) {
        if (this.epochOf(sessionId) !== epoch)
            return undefined;
        // Read in the lane: an operation ahead of this one may have replaced or withdrawn it.
        const current = this.deps.activations.preview(sessionId, pluginId);
        if (!current)
            return undefined;
        const sourceDir = await this.deps.devDirectories.source(sessionId, pluginId);
        if (!this.previewing(sessionId, pluginId) || !sourceDir)
            return undefined;
        if (!(await this.changed(sourceDir, current)))
            return undefined;
        const kept = { status: 'kept', pluginId, artifactDigest: current.artifactDigest };
        const validation = await this.deps.validate({ pluginId, sourceDir });
        if (this.epochOf(sessionId) !== epoch)
            return undefined;
        if (!validation.artifact) {
            return { ...kept, diagnostics: validation.errors };
        }
        if (!this.previewing(sessionId, pluginId))
            return undefined;
        this.deps.bindings.bind(sessionId, pluginId, validation.artifact.digest);
        const { artifact, warnings } = validation;
        const outcome = await this.activate(sessionId, { sourceDir, artifact, warnings }, epoch);
        if (outcome.status !== 'activated') {
            return { ...kept, diagnostics: refusalDiagnostics(outcome) };
        }
        return { status: 'reloaded', pluginId };
    }
    /**
     * Same bytes built the same way: nothing to reload (also right after a successful `preview`).
     * An unreadable source is not reloaded either.
     */
    async changed(sourceDir, current) {
        try {
            const [digest, fingerprint] = await Promise.all([
                this.deps.sourceDigest(sourceDir),
                this.deps.compilerFingerprint(),
            ]);
            return digest !== current.artifactDigest || fingerprint !== current.compilerFingerprint;
        }
        catch {
            return false;
        }
    }
    /**
     * ④: only the candidate the session's record binds may activate, and only if its bytes still
     * match the validated snapshot (`EXTENSION_CANDIDATE_DRIFTED`). It runs inside the plugin's
     * lane, so a newer preview or reload waits for it and replaces it afterwards. A `withdraw`
     * unbinds at once and cancels it: the binding is checked again before the overlay is entered
     * and in the same tick as the commit, and a cancelled operation releases only the overlay it
     * entered itself, announces nothing and returns refused. Its module loads and `register` runs
     * before the record is replaced (R10); if that throws, the live revision stays bound and
     * running and nothing is announced. A session deleted since `epoch` cancels it after every
     * async step, releasing an overlay it already entered.
     */
    async activate(sessionId, validated, epoch) {
        const { sourceDir, artifact, warnings } = validated;
        const bound = this.deps.bindings.find(sessionId, artifact.pluginId)?.boundDigest;
        let onDisk;
        try {
            onDisk = await this.deps.snapshotDigest(artifact.candidateRoot);
        }
        catch {
            onDisk = undefined;
        }
        if (this.epochOf(sessionId) !== epoch)
            return sessionDeleted();
        const stillBound = this.deps.bindings.find(sessionId, artifact.pluginId)?.boundDigest;
        if (bound !== artifact.digest || stillBound !== artifact.digest || onDisk !== artifact.digest) {
            return refused('EXTENSION_CANDIDATE_DRIFTED', 'the candidate is not the one bound');
        }
        const activation = {
            pluginId: artifact.pluginId,
            tier: 'preview',
            source: 'LOCAL_PREVIEW',
            sessionId,
            artifactDigest: artifact.digest,
            root: artifact.candidateRoot,
            entry: artifact.entry,
            files: artifact.files,
            scan: artifact.scan,
            compiled: artifact.compiled,
            compilerFingerprint: artifact.compilerFingerprint,
            sdkVersion: artifact.sdkVersion,
            activatedAt: this.deps.nowMs(),
        };
        const failure = await this.deps.prepare(activation);
        if (this.epochOf(sessionId) !== epoch)
            return sessionDeleted();
        if (failure) {
            this.restoreLiveBinding(sessionId, artifact);
            return { status: 'invalid', errors: [failure], warnings };
        }
        if (this.deps.bindings.find(sessionId, artifact.pluginId)?.boundDigest !== artifact.digest) {
            return refused('EXTENSION_CANDIDATE_DRIFTED', 'the candidate is not the one bound');
        }
        // Skills and MCP servers enter first, so the first render can already reach them.
        const findings = await this.enterOverlay(activation, artifact);
        const outcome = await this.commit(sessionId, activation, { findings, warnings, epoch });
        if (outcome.status === 'activated')
            await this.refreshEditorTypes(activation, sourceDir);
        return outcome;
    }
    restoreLiveBinding(sessionId, artifact) {
        if (this.deps.bindings.find(sessionId, artifact.pluginId)?.boundDigest !== artifact.digest)
            return;
        const live = this.deps.activations.preview(sessionId, artifact.pluginId);
        if (live)
            this.deps.bindings.bind(sessionId, artifact.pluginId, live.artifactDigest);
    }
    /** Dev-directory previews only: an installed package is never written to. */
    async refreshEditorTypes(activation, sourceDir) {
        if (!this.deps.refreshEditorTypes)
            return;
        let failure;
        try {
            await this.deps.refreshEditorTypes(sourceDir);
        }
        catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        this.deps.onEditorTypes?.(activation, failure);
    }
    /**
     * The cancellation check and the commit share one tick. A withdrawn operation removes only its
     * own plugin's overlay: the lane keeps every later operation of the plugin behind it.
     */
    async commit(sessionId, activation, entered) {
        if (this.epochOf(sessionId) !== entered.epoch) {
            await this.releaseOverlay(sessionId);
            return sessionDeleted();
        }
        if (this.deps.bindings.find(sessionId, activation.pluginId)?.boundDigest !==
            activation.artifactDigest) {
            try {
                await this.deps.overlay.remove(sessionId, activation.pluginId);
            }
            catch {
                // A stale preview never fails on overlay cleanup.
            }
            return refused('EXTENSION_CANDIDATE_DRIFTED', 'the candidate is not the one bound');
        }
        if (entered.findings.length > 0)
            this.deps.onOverlayFindings?.(activation, entered.findings);
        // The replaced activation leaves the host when the session re-syncs on this event.
        this.deps.activations.putPreview(activation);
        this.deps.emit({ type: 'entries-changed', pluginId: activation.pluginId, sessionId });
        return { status: 'activated', activation, warnings: entered.warnings };
    }
    /**
     * The overlay enters the package `validate` read, so it starts exactly the servers this
     * candidate declares, the same way the plugin system starts an installed plugin's. A failed overlay does not undo the activation; its findings are kept for `inspect`.
     */
    async enterOverlay(activation, artifact) {
        const { sessionId } = activation;
        if (!sessionId)
            return [];
        try {
            const findings = await this.deps.overlay.put({
                sessionId,
                pluginName: activation.pluginId,
                candidate: artifact.package,
                contentDigest: artifact.digest,
            });
            return findings.map((finding) => finding.capabilityName ? `${finding.code} (${finding.capabilityName})` : finding.code);
        }
        catch (error) {
            return [`PLUGIN_OVERLAY_FAILED: ${error instanceof Error ? error.message : 'unknown'}`];
        }
    }
    /** Drops the MCP generation a preview of a since-deleted session opened. */
    async releaseOverlay(sessionId) {
        try {
            await this.deps.overlay.deleteSession(sessionId);
        }
        catch {
            // The session's overlay is gone with the session at the latest.
        }
    }
    async inLane(sessionId, pluginId, run) {
        const key = JSON.stringify([sessionId, pluginId]);
        return this.lanes.run(key, run);
    }
    async holding(run) {
        this.inFlight += 1;
        try {
            return await run();
        }
        finally {
            this.inFlight -= 1;
        }
    }
    async checkName(pluginId) {
        try {
            await this.deps.names.assertPreviewNameAvailable(pluginId);
            return undefined;
        }
        catch (error) {
            if (error?.code === 'EXTENSION_NAME_RESERVED') {
                return refused('EXTENSION_NAME_RESERVED', pluginId);
            }
            throw error;
        }
    }
    /** The session still previews the plugin (not withdrawn). */
    previewing(sessionId, pluginId) {
        return this.deps.bindings.find(sessionId, pluginId) !== undefined;
    }
    epochOf(sessionId) {
        return this.sessionEpochs.get(sessionId) ?? 0;
    }
}
function refused(code, detail) {
    return { status: 'refused', diagnostic: createExtensionDiagnostic(code, { detail }) };
}
function sessionDeleted() {
    return refused('EXTENSION_CANDIDATE_DRIFTED', 'the session was deleted during the preview');
}
function refusalDiagnostics(outcome) {
    if (outcome.status === 'refused')
        return [outcome.diagnostic];
    return outcome.status === 'invalid' ? outcome.errors : [];
}
//# sourceMappingURL=preview.service.js.map