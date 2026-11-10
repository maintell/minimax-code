import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { readFile, rm, stat } from 'node:fs/promises';
import { decodePptPreviewRequest, PptPreviewError, PPT_PREVIEW_LIMITS, } from '@mavis/shared/ppt-preview';
import { PreviewRepository } from '../preview.repository.js';
import { capturePptx, readPptxSource, writePptxSnapshot } from './snapshot-capture.js';
function canonical(input) {
    if (Array.isArray(input))
        return input.map(canonical);
    if (input && typeof input === 'object')
        return Object.fromEntries(Object.entries(input)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)]));
    return input;
}
function fingerprint(input) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(input)))
        .digest('hex');
}
/** Cheap change detector for observed sources; any rewrite changes mtime/ctime, size or inode. */
function sourceIdentity(stats) {
    return [stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino, stats.dev].join(':');
}
function generation(owner = 'explicit') {
    return {
        generationId: randomUUID(),
        owner,
        state: 'generating',
        acceptedRevision: 0,
        snapshots: [],
    };
}
export class PptPreviewService {
    options;
    repo;
    nowMs;
    tails = new Map();
    jobs = new Map();
    closed = false;
    preparationTail = Promise.resolve();
    observeAfter = new Map();
    /** Last examined file identity per session source; unchanged files are not re-read or copied. */
    observedSources = new Map();
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.repo = new PreviewRepository(options.db, this.nowMs);
    }
    async execute(sessionId, value, origin) {
        const request = decodePptPreviewRequest(value);
        if (this.closed)
            throw new PptPreviewError('GENERATION_CLOSED', 'PPT preview host is closed');
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw new PptPreviewError('SESSION_NOT_FOUND', 'Current session does not exist');
        if (request.action === 'capabilities')
            return {
                available: Boolean(this.options.renderHost),
                protocol: 'minimax.ppt-preview.v1',
                features: ['complete-pptx-snapshots', 'readonly-preview', 'persistent-events'],
                limits: PPT_PREVIEW_LIMITS,
            };
        return this.serial(sessionId, async () => {
            if (request.action === 'list')
                await this.observe(sessionId, session.workspaceDir);
            return this.apply(sessionId, session.workspaceDir, request, origin);
        });
    }
    async executeNative(sessionId, value, origin) {
        const result = await this.execute(sessionId, value, origin);
        const request = decodePptPreviewRequest(value);
        if (request.action !== 'capabilities' ||
            !this.options.renderHost ||
            !this.options.taskConnection)
            return result;
        return {
            ...result,
            ...(await this.options.taskConnection.issue(sessionId, origin)),
        };
    }
    async ready() {
        if (!this.options.renderHost)
            return;
        for (const a of this.repo.all()) {
            for (const s of a.generation.snapshots)
                if (a.generation.state !== 'cancelled' &&
                    ['accepted', 'importing', 'preparing'].includes(s.renderState))
                    this.prepare(a.sessionId, a.artifactId, s);
            for (const s of [...a.generations.flatMap((g) => g.snapshots), ...a.generation.snapshots])
                if (s.renderState === 'ready')
                    this.prepare(a.sessionId, a.artifactId, s);
            if (a.generation.state === 'validating')
                await this.serial(a.sessionId, () => this.finishIfReady(a));
        }
    }
    async close() {
        this.closed = true;
        await this.options.taskConnection?.close();
        for (const j of this.jobs.values())
            j.controller.abort();
        await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
        await Promise.allSettled([...this.tails.values()]);
    }
    async cancelSession(sessionId) {
        if (this.closed || !this.options.renderHost)
            return;
        await this.serial(sessionId, () => {
            for (const artifact of this.repo.list(sessionId)) {
                if (!['generating', 'validating'].includes(artifact.generation.state))
                    continue;
                this.cancel(artifact);
                this.repo.commit(artifact, 'task-cancelled');
            }
        });
    }
    serial(key, run) {
        const previous = this.tails.get(key);
        const runNext = async () => {
            try {
                await previous;
            }
            catch {
                /* An earlier request failure does not poison the session lane. */
            }
            try {
                return await run();
            }
            finally {
                if (this.tails.get(key) === next)
                    this.tails.delete(key);
            }
        };
        const next = runNext();
        this.tails.set(key, next);
        return next;
    }
    async observe(sessionId, workspace) {
        if (!this.options.renderHost || !this.options.assets)
            return;
        if ((this.observeAfter.get(sessionId) ?? 0) > this.nowMs())
            return;
        this.observeAfter.set(sessionId, this.nowMs() + 5000);
        const sources = (await this.options.assets.list(sessionId))
            .filter((asset) => asset.sourceTag === 'deliver-assets' && /\.pptx$/iu.test(asset.path))
            .slice(0, 20);
        for (const source of sources)
            await this.observeSource(sessionId, workspace, source);
    }
    observedTarget(sessionId, assetKey, file) {
        const existing = this.repo.list(sessionId);
        if (existing.some((artifact) => artifact.generation.owner === 'explicit' &&
            [...artifact.generations, artifact.generation].some((g) => g.sourcePaths?.includes(file))))
            return false;
        const artifact = existing.find((item) => item.artifactKey === `observed:${assetKey}`);
        if (!artifact)
            return undefined;
        if (artifact.generation.owner !== 'observed' || artifact.generation.state !== 'generating')
            return false;
        if (artifact.generation.snapshots.length >= PPT_PREVIEW_LIMITS.maxVersions ||
            this.queued(artifact) >= PPT_PREVIEW_LIMITS.maxQueuedVersions)
            return false;
        return artifact;
    }
    async observeSource(sessionId, workspace, source) {
        const file = resolve(workspace, source.path);
        let artifact = this.observedTarget(sessionId, source.assetKey, file);
        if (artifact === false)
            return;
        const cacheKey = `${sessionId}\0${file}`;
        let identity;
        try {
            identity = sourceIdentity(await stat(file));
        }
        catch {
            return; /* Missing sources are retried on the next observation window. */
        }
        if (this.observedSources.get(cacheKey) === identity)
            return;
        let capture;
        try {
            const read = await readPptxSource(workspace, source.path);
            if (artifact?.generation.snapshots.at(-1)?.contentHash === read.contentHash) {
                this.observedSources.set(cacheKey, identity);
                return;
            }
            capture = await writePptxSnapshot(read, this.snapshotFolder(sessionId));
            artifact ??= this.createArtifact(sessionId, {
                schema: 'minimax.ppt-preview.start.v1',
                action: 'start',
                artifactKey: `observed:${source.assetKey}`,
                title: source.name ?? source.path,
            });
            artifact.generation.owner = 'observed';
            const snapshot = this.snapshot(artifact, capture, Array.from({ length: capture.slideCount }, (_, index) => ({
                pageId: `observed-${capture.snapshotId}-slide-${index + 1}`,
                sourceSlide: index + 1,
                contentState: 'ready',
            })));
            artifact.generation.sourcePaths = [file];
            artifact.generation.snapshots.push(snapshot);
            this.repo.commit(artifact, 'observed-source');
            capture = undefined;
            this.observedSources.set(cacheKey, identity);
            this.prepare(sessionId, artifact.artifactId, snapshot);
        }
        catch (error) {
            /* Invalid or unauthorized content stays rejected until the file changes; IO errors retry. */
            if (error instanceof PptPreviewError)
                this.observedSources.set(cacheKey, identity);
            if (capture)
                await rm(capture.sourcePath, {
                    force: true,
                }); /* Indexed output evidence still requires capture validation. */
        }
    }
    snapshotFolder(sessionId) {
        return join(this.options.dataDir, 'v2', 'ppt-preview', fingerprint(sessionId));
    }
    snapshot(artifact, captured, pages) {
        return {
            ...captured,
            versionId: captured.snapshotId,
            generationId: artifact.generation.generationId,
            acceptedRevision: ++artifact.generation.acceptedRevision,
            pages,
            renderState: 'accepted',
            createdAtMs: this.nowMs(),
        };
    }
    artifact(sessionId, id) {
        const a = this.repo.list(sessionId).find((item) => item.artifactId === id);
        if (!a)
            throw new PptPreviewError('ARTIFACT_NOT_FOUND', 'PPT document does not belong to this session');
        return a;
    }
    current(a, r) {
        if (r.generationId !== a.generation.generationId)
            throw new PptPreviewError('REVISION_CONFLICT', 'Generation is no longer current');
        const acceptsRequest = a.generation.state === 'generating' ||
            (r.action === 'cancel' && a.generation.state === 'validating');
        if (!acceptsRequest)
            throw new PptPreviewError('GENERATION_CLOSED', 'Generation no longer accepts publications');
    }
    readRequest(sessionId, request) {
        if (request.action === 'list')
            return { artifacts: this.repo.list(sessionId) };
        if (request.action === 'events')
            return { events: this.repo.events(sessionId, request.eventCursor ?? 0) };
        if (request.queryRequestId)
            return { result: this.repo.receipt(sessionId, request.queryRequestId) ?? null };
        const artifact = this.artifact(sessionId, request.artifactId);
        if (request.snapshotId)
            return {
                artifact,
                snapshot: [
                    ...artifact.generation.snapshots,
                    ...artifact.generations.flatMap((g) => g.snapshots),
                ].find((item) => item.snapshotId === request.snapshotId) ?? null,
            };
        return { artifact };
    }
    async apply(sessionId, workspace, request, origin) {
        if (['list', 'events', 'status'].includes(request.action))
            return this.readRequest(sessionId, request);
        if (!this.options.renderHost)
            throw new PptPreviewError('PREVIEW_UNAVAILABLE', 'This host does not support background PPT preview');
        let captured;
        if (request.action === 'publish' || (request.action === 'complete' && request.pptx))
            captured = await capturePptx(workspace, request.pptx, this.snapshotFolder(sessionId));
        const fp = fingerprint({ request, contentHash: captured?.contentHash });
        try {
            const old = this.repo.receipt(sessionId, request.requestId, fp);
            if (old !== undefined)
                return old;
            const artifact = this.applyMutation(sessionId, workspace, request, { captured, origin });
            const result = this.receipt(artifact, request.action);
            this.repo.commit(artifact, request.action, {
                requestId: request.requestId,
                fingerprint: fp,
                result,
            });
            if (request.action === 'publish')
                captured = undefined;
            this.schedule(artifact, request.action);
            if (request.action === 'complete')
                await this.finishIfReady(artifact);
            return result;
        }
        finally {
            if (captured)
                await rm(captured.sourcePath, { force: true });
        }
    }
    applyMutation(sessionId, workspace, request, context) {
        if (request.action !== 'start')
            return this.mutate(sessionId, workspace, request, context.captured);
        const artifact = this.startGeneration(sessionId, request);
        artifact.generation.origin = context.origin;
        return artifact;
    }
    receipt(artifact, action) {
        const latest = artifact.generation.snapshots.at(-1);
        const publication = action === 'publish' && latest
            ? {
                snapshotId: latest.snapshotId,
                jobId: latest.snapshotId,
                requestState: 'accepted',
                renderState: latest.renderState,
            }
            : {};
        return {
            ok: true,
            artifactId: artifact.artifactId,
            generationId: artifact.generation.generationId,
            acceptedRevision: artifact.generation.acceptedRevision,
            ...publication,
            generationState: artifact.generation.state,
        };
    }
    schedule(artifact, action) {
        const latest = artifact.generation.snapshots.at(-1);
        if (action === 'publish' && latest)
            this.prepare(artifact.sessionId, artifact.artifactId, latest);
    }
    mutate(sessionId, workspace, request, captured) {
        const artifact = this.artifact(sessionId, request.artifactId);
        this.current(artifact, request);
        switch (request.action) {
            case 'publish':
                this.publish(artifact, workspace, request, captured);
                break;
            case 'progress':
                artifact.generation.phase = request.phase;
                artifact.generation.message = request.message;
                artifact.generation.expectedPages =
                    request.expectedPages ?? artifact.generation.expectedPages;
                break;
            case 'cancel':
                this.cancel(artifact);
                break;
            case 'complete':
                if (captured) {
                    if (captured.contentHash !== artifact.generation.snapshots.at(-1)?.contentHash)
                        throw new PptPreviewError('REVISION_CONFLICT', 'Final file differs from the latest snapshot');
                }
                this.complete(artifact, request);
                if (captured)
                    artifact.generation.finalFile = {
                        path: relative(workspace, resolve(workspace, request.pptx)).replace(/\\/g, '/'),
                        contentHash: captured.contentHash,
                    };
                break;
            default:
                throw new PptPreviewError('INVALID_REQUEST', 'Unsupported publication action');
        }
        return artifact;
    }
    createArtifact(sessionId, request) {
        return {
            artifactId: randomUUID(),
            sessionId,
            artifactKey: request.artifactKey,
            title: request.title ?? request.artifactKey,
            aspectRatio: request.aspectRatio ?? 16 / 9,
            generation: generation(),
            generations: [],
            createdAtMs: this.nowMs(),
            updatedAtMs: this.nowMs(),
            eventCursor: 0,
        };
    }
    startGeneration(sessionId, request) {
        let artifact;
        if (request.artifactKey) {
            if (this.repo.list(sessionId).some((item) => item.artifactKey === request.artifactKey))
                throw new PptPreviewError('ARTIFACT_ALREADY_TRACKED', 'Document key already belongs to a tracked document');
            artifact = this.createArtifact(sessionId, request);
        }
        else {
            artifact = this.artifact(sessionId, request.artifactId ?? request.adoptArtifactId);
            this.checkRevisionBase(artifact, request);
            const previous = artifact.generation;
            if (request.adoptArtifactId)
                previous.state = 'cancelled';
            artifact.generations.push(previous);
            artifact.generation = generation();
            artifact.generation.previousGenerationId = previous.generationId;
        }
        artifact.generation.expectedPages = request.expectedPages;
        return artifact;
    }
    checkRevisionBase(artifact, request) {
        if (request.adoptArtifactId)
            this.checkAdoption(artifact, request);
        else if (artifact.generation.generationId !== request.previousGenerationId ||
            !['completed', 'failed', 'cancelled'].includes(artifact.generation.state))
            throw new PptPreviewError('REVISION_CONFLICT', 'Revision requires the current terminal generation');
        if (request.fromSnapshotId &&
            ![...artifact.generation.snapshots, ...artifact.generations.flatMap((g) => g.snapshots)].some((item) => item.snapshotId === request.fromSnapshotId && item.renderState === 'ready'))
            throw new PptPreviewError('SNAPSHOT_NOT_FOUND', 'Revision base must be a ready snapshot of this artifact');
    }
    checkAdoption(artifact, request) {
        if (artifact.generation.owner !== 'observed' ||
            artifact.generation.generationId !== request.expectedGenerationId ||
            artifact.generation.acceptedRevision !== request.expectedRevision)
            throw new PptPreviewError('REVISION_CONFLICT', 'Observed owner changed before adoption');
    }
    queued(artifact) {
        return artifact.generation.snapshots.filter((item) => ['accepted', 'importing', 'preparing'].includes(item.renderState)).length;
    }
    publish(artifact, workspace, request, captured) {
        if (artifact.generation.acceptedRevision !== request.baseRevision)
            throw new PptPreviewError('REVISION_CONFLICT', 'baseRevision does not match current publication');
        if (artifact.generation.snapshots.length >= PPT_PREVIEW_LIMITS.maxVersions)
            throw new PptPreviewError('LIMIT_EXCEEDED', 'Snapshot limit reached');
        if (this.queued(artifact) >= PPT_PREVIEW_LIMITS.maxQueuedVersions)
            throw new PptPreviewError('BACKPRESSURE', 'Background preview queue is full');
        if (request.pages.length !== captured.slideCount ||
            request.pages.some((page) => page.sourceSlide > captured.slideCount))
            throw new PptPreviewError('PAGE_MAP_INVALID', 'Manifest must map every PPTX page');
        artifact.generation.snapshots.push(this.snapshot(artifact, captured, request.pages));
        artifact.generation.sourcePaths = [
            ...new Set([...(artifact.generation.sourcePaths ?? []), resolve(workspace, request.pptx)]),
        ];
    }
    cancel(artifact) {
        artifact.generation.state = 'cancelled';
        for (const item of artifact.generation.snapshots) {
            if (['accepted', 'importing', 'preparing'].includes(item.renderState))
                item.renderState = 'superseded';
            this.jobs.get(item.snapshotId)?.controller.abort();
        }
    }
    complete(artifact, request) {
        const latest = artifact.generation.snapshots.at(-1);
        if (!latest ||
            latest.snapshotId !== request.snapshotId ||
            artifact.generation.acceptedRevision !== request.expectedRevision)
            throw new PptPreviewError('REVISION_CONFLICT', 'complete must reference the latest snapshot and revision');
        this.checkFinalPages(artifact, latest);
        artifact.generation.finalSnapshotId = latest.snapshotId;
        artifact.generation.state = 'validating';
    }
    checkFinalPages(artifact, snapshot) {
        if (snapshot.renderState === 'error')
            throw new PptPreviewError('RENDER_FAILED', 'Final snapshot preparation failed');
        if (snapshot.pages.some((page) => page.contentState !== 'ready'))
            throw new PptPreviewError('FINAL_INCOMPLETE', 'Final snapshot pages must be ready');
        if (artifact.generation.expectedPages !== undefined &&
            snapshot.pages.length !== artifact.generation.expectedPages)
            throw new PptPreviewError('FINAL_INCOMPLETE', 'Final snapshot must contain the expected pages');
    }
    prepare(sessionId, artifactId, snapshot) {
        if (!this.options.renderHost || this.closed || this.jobs.has(snapshot.snapshotId))
            return;
        const controller = new AbortController();
        const previous = this.preparationTail;
        const done = (async () => {
            try {
                await previous;
            }
            catch {
                /* Worker failure does not poison the preparation lane. */
            }
            try {
                await this.runPreparation(sessionId, artifactId, snapshot, controller);
            }
            finally {
                this.jobs.delete(snapshot.snapshotId);
            }
        })();
        this.preparationTail = this.observeJob(done);
        this.jobs.set(snapshot.snapshotId, { controller, done });
    }
    async observeJob(done) {
        try {
            await done;
        }
        catch {
            /* Preparation is recorded by its own state machine. */
        }
    }
    findSnapshot(artifact, snapshotId) {
        return [
            ...artifact.generation.snapshots,
            ...artifact.generations.flatMap((g) => g.snapshots),
        ].find((item) => item.snapshotId === snapshotId);
    }
    async runPreparation(sessionId, artifactId, snapshot, controller) {
        if (controller.signal.aborted || this.closed)
            return;
        try {
            await this.serial(sessionId, () => {
                if (!controller.signal.aborted && !this.closed)
                    this.markPreparing(sessionId, artifactId, snapshot.snapshotId);
            });
            if (controller.signal.aborted || this.closed)
                return;
            const result = await this.options.renderHost.prepare({ sessionId, artifactId, snapshot }, controller.signal);
            if (snapshot.pages.some((page) => page.sourceSlide > result.slideCount))
                throw new PptPreviewError('PAGE_MAP_INVALID', 'Imported pages do not match manifest');
            await this.serial(sessionId, async () => {
                if (controller.signal.aborted)
                    return;
                const artifact = this.artifact(sessionId, artifactId);
                const prepared = this.findSnapshot(artifact, snapshot.snapshotId);
                if (!prepared)
                    return;
                prepared.renderState = 'ready';
                this.repo.commit(artifact, 'ready');
                await this.finishIfReady(artifact);
            });
        }
        catch (error) {
            if (controller.signal.aborted || this.closed)
                return;
            await this.serial(sessionId, () => this.markFailed(sessionId, artifactId, snapshot.snapshotId, error));
        }
    }
    markPreparing(sessionId, artifactId, snapshotId) {
        const artifact = this.artifact(sessionId, artifactId);
        const snapshot = this.findSnapshot(artifact, snapshotId);
        if (!snapshot)
            return;
        snapshot.renderState = 'preparing';
        this.repo.commit(artifact, 'preparing');
    }
    markFailed(sessionId, artifactId, snapshotId, error) {
        const artifact = this.artifact(sessionId, artifactId);
        const snapshot = this.findSnapshot(artifact, snapshotId);
        if (!snapshot)
            return;
        snapshot.renderState = 'error';
        snapshot.error = {
            code: error instanceof PptPreviewError ? error.code : 'RENDER_FAILED',
            message: error instanceof Error && /^PPT_[A-Z_]+:[A-Za-z0-9_,.-]{1,1024}$/u.test(error.message)
                ? error.message
                : 'Background PPT preview preparation failed',
        };
        if (artifact.generation.state === 'validating' &&
            artifact.generation.finalSnapshotId === snapshotId)
            artifact.generation.state = 'failed';
        this.repo.commit(artifact, 'error');
    }
    async finishIfReady(a) {
        if (a.generation.state !== 'validating')
            return;
        const s = a.generation.snapshots.find((item) => item.snapshotId === a.generation.finalSnapshotId);
        if (!s || s.renderState !== 'ready')
            return;
        const bytes = await readFile(s.sourcePath);
        if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== s.contentHash) {
            a.generation.state = 'failed';
            this.repo.commit(a, 'final-source-mutated');
            return;
        }
        a.generation.state = 'completed';
        this.repo.commit(a, 'completed');
    }
}
//# sourceMappingURL=publication.service.js.map