import { extensionContext } from '../core/context.js';
import { randomUUID } from 'node:crypto';
import { ModelAccessPolicyError } from '../core/policy.js';
import { apiCandidateHash, apiSourceKey, captureApiCandidates, captureApiImport, captureApiScan, ModelAccessApiScanError, } from './validation.js';
/** Owns runtime-only API candidates. Never routes generation through the source provider. */
export class ModelAccessApiScanService {
    host;
    candidates = new Map();
    readers = new Set();
    pending = new Map();
    operations = new Map();
    timeoutMs;
    candidateTtlMs;
    closed = false;
    constructor(host, options = {}) {
        this.host = host;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.candidateTtlMs = options.candidateTtlMs ?? 300_000;
        if ([this.timeoutMs, this.candidateTtlMs].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 600_000))
            throw new ModelAccessApiScanError('api_scan_invalid');
    }
    scan(input) {
        const captured = captureApiScan(input);
        return this.execute(captured.installationId, captured.signal, async (operation) => {
            const readerKey = apiSourceKey(captured);
            const admission = await this.host.serial(async () => {
                if (this.readers.has(readerKey))
                    throw new ModelAccessApiScanError('api_scan_limit');
                const admitted = this.admit(captured, operation.signal);
                this.readers.add(readerKey);
                return admitted;
            });
            const unlisten = this.listen(admission.lease, operation);
            try {
                admission.lease.assertCurrent();
                const raw = await this.readCandidates(admission);
                return await this.host.serial(async () => {
                    admission.lease.assertCurrent();
                    const values = captureApiCandidates(raw, admission.lease.enabledTargets);
                    return this.publish(admission, values);
                });
            }
            finally {
                this.readers.delete(readerKey);
                unlisten();
                admission.lease.release();
            }
        });
    }
    list() {
        if (this.closed)
            return [];
        return Object.freeze([...this.candidates.values()].flatMap((item) => {
            try {
                item.lease.assertCurrent();
                return [this.view(item)];
            }
            catch {
                item.remove();
                return [];
            }
        }));
    }
    /** writer is a host capability, deliberately separate from captured operation input. */
    importCandidate(input, writer) {
        const captured = captureApiImport(input);
        const item = this.candidates.get(captured.candidateId);
        if (!item)
            return Promise.reject(new ModelAccessApiScanError('api_candidate_stale'));
        const commit = writer.commit.bind(writer);
        return this.execute(item.source.installationId, captured.signal, async (operation) => {
            const readerKey = apiSourceKey(item.source);
            const admission = await this.host.serial(async () => {
                this.assertCandidate(item);
                if (item.importing || this.readers.has(readerKey))
                    throw new ModelAccessApiScanError('api_scan_limit');
                const admitted = this.admit({ ...item.source, targets: [item.value.target] }, AbortSignal.any([operation.signal, item.lease.signal]), item.lease.generationLease);
                this.readers.add(readerKey);
                item.importing = true;
                return admitted;
            });
            const unlisten = this.listen(admission.lease, operation);
            try {
                const raw = await this.readCandidates(admission);
                admission.lease.assertCurrent();
                const fresh = captureApiCandidates(raw, admission.lease.enabledTargets).find((value) => value.target === item.value.target && value.fingerprint === item.value.fingerprint);
                if (!fresh || apiCandidateHash(fresh) !== item.hash) {
                    unlisten();
                    item.remove();
                    throw new ModelAccessApiScanError('api_candidate_stale');
                }
                return await this.host.serial(async () => {
                    const assertCurrent = () => {
                        this.assertCandidate(item);
                        admission.lease.assertCurrent();
                    };
                    assertCurrent();
                    operation.committing = true;
                    const providerKey = await commit({
                        candidate: fresh,
                        provenance: Object.freeze({
                            ...item.source,
                            target: fresh.target,
                            digest: item.digest,
                            importedAt: Date.now(),
                        }),
                        signal: admission.lease.signal,
                        assertCurrent,
                    });
                    // A completed durable commit wins cancellation; never report that it was undone.
                    item.remove();
                    return providerKey;
                });
            }
            finally {
                item.importing = false;
                this.readers.delete(readerKey);
                unlisten();
                admission.lease.release();
            }
        });
    }
    assertCandidate(item) {
        if (this.closed || this.candidates.get(item.id) !== item)
            throw new ModelAccessApiScanError('api_candidate_stale');
        item.lease.assertCurrent();
    }
    admit(input, signal, generation) {
        if (this.closed)
            throw new ModelAccessApiScanError('api_scan_closed');
        const registration = generation?.registration ?? this.host.registry().get(input.installationId);
        const handler = registration?.extension.sources[input.sourceId]?.apiKeyScan?.[input.readerId];
        if (!registration || !handler)
            throw new ModelAccessApiScanError('api_scan_unavailable');
        const lease = this.host.policy().acquire({
            installationId: input.installationId,
            sourceId: input.sourceId,
            capability: 'apiKeyScan',
            entryId: input.readerId,
            targets: input.targets,
            signal,
        }, generation);
        const source = Object.freeze({
            installationId: input.installationId,
            sourceId: input.sourceId,
            readerId: input.readerId,
        });
        return {
            source,
            handler,
            lease,
            digest: registration.digest,
            context: extensionContext({
                directories: this.host.directories,
                profileId: lease.profileId,
                installationId: lease.installationId,
                generation: lease.generation,
                operationId: randomUUID(),
                signal: lease.signal,
                enabledTargets: lease.enabledTargets,
                policyRevision: lease.policyRevision,
            }),
        };
    }
    /**
     * API scanning is a host-level capability (Electron / TUI owners only). When it is off the
     * extension is never invoked, so no source is read; the outcome equals a scan that found nothing.
     */
    async readCandidates(admission) {
        if (this.host.apiScanEnabled !== true)
            return [];
        const retained = admission.lease.generationLease?.retain();
        try {
            return await admission.handler.scan(admission.context);
        }
        finally {
            retained?.release();
        }
    }
    publish(admission, values) {
        const sameSource = (item) => apiSourceKey(item.source) === apiSourceKey(admission.source) &&
            admission.lease.enabledTargets.includes(item.value.target);
        const replaced = [...this.candidates.values()].filter(sameSource);
        if (this.candidates.size - replaced.length + values.length > 1024)
            throw new ModelAccessApiScanError('api_scan_limit');
        const created = [];
        try {
            for (const value of values)
                created.push(this.retain(admission, value));
        }
        catch (error) {
            for (const item of created)
                item.remove();
            throw error;
        }
        for (const item of replaced)
            item.remove();
        return Object.freeze(created.map((item) => this.view(item)));
    }
    retain(admission, value) {
        const source = admission.source;
        // Candidate lifetime is independent of the completed scan caller/deadline.
        const controller = new AbortController();
        const lease = this.host.policy().acquire({
            installationId: source.installationId,
            sourceId: source.sourceId,
            capability: 'apiKeyScan',
            entryId: source.readerId,
            targets: [value.target],
            signal: controller.signal,
        }, admission.lease.generationLease);
        const id = randomUUID();
        const remove = () => {
            clearTimeout(timer);
            lease.signal.removeEventListener('abort', remove);
            this.candidates.delete(id);
            controller.abort();
            lease.release();
        };
        const timer = setTimeout(remove, this.candidateTtlMs);
        timer.unref();
        const item = {
            id,
            source,
            value,
            hash: apiCandidateHash(value),
            lease,
            digest: admission.digest,
            remove,
            importing: false,
        };
        this.candidates.set(id, item);
        lease.signal.addEventListener('abort', remove, { once: true });
        return item;
    }
    view(item) {
        return Object.freeze({
            ...item.source,
            candidateId: item.id,
            target: item.value.target,
            upstream: item.value.upstream,
            endpointOrigin: new URL(item.value.baseUrl).origin,
            api: item.value.api,
            modelCount: item.value.models.length,
            credential: 'configured',
        });
    }
    close() {
        this.closed = true;
        for (const item of [...this.candidates.values()])
            item.remove();
        for (const controller of this.operations.keys())
            controller.abort();
    }
    async invalidateInstallation(installationId) {
        for (const item of [...this.candidates.values()])
            if (item.source.installationId === installationId)
                item.remove();
        for (const [controller, owner] of this.operations)
            if (owner === installationId)
                controller.abort();
        await this.settled(installationId);
    }
    async settled(installationId) {
        await Promise.allSettled([...this.pending]
            .filter(([, owner]) => !installationId || owner === installationId)
            .map(([work]) => work));
    }
    listen(lease, operation) {
        const abort = () => operation.controller.abort();
        lease.signal.addEventListener('abort', abort, { once: true });
        if (lease.signal.aborted)
            abort();
        return () => lease.signal.removeEventListener('abort', abort);
    }
    execute(installationId, signal, run) {
        if (this.closed)
            return Promise.reject(new ModelAccessApiScanError('api_scan_closed'));
        if (this.operations.size >= 128)
            return Promise.reject(new ModelAccessApiScanError('api_scan_limit'));
        const controller = new AbortController();
        const operation = {
            controller,
            signal: AbortSignal.any([signal, controller.signal]),
            committing: false,
        };
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref();
        this.operations.set(controller, installationId);
        const work = (async () => {
            try {
                return await run(operation);
            }
            catch (error) {
                if (error instanceof ModelAccessApiScanError || error instanceof ModelAccessPolicyError)
                    throw error;
                throw new ModelAccessApiScanError('api_scan_failed');
            }
            finally {
                clearTimeout(timer);
                this.operations.delete(controller);
            }
        })();
        this.pending.set(work, installationId);
        return this.wait(work, operation);
    }
    async wait(work, operation) {
        let abort;
        const stopped = new Promise((_resolve, reject) => {
            abort = () => {
                if (!operation.committing)
                    reject(new ModelAccessPolicyError('operation_invalidated'));
            };
        });
        operation.signal.addEventListener('abort', abort, { once: true });
        if (operation.signal.aborted)
            abort();
        const tracked = (async () => {
            try {
                return await work;
            }
            finally {
                this.pending.delete(work);
            }
        })();
        try {
            return await Promise.race([tracked, stopped]);
        }
        finally {
            operation.signal.removeEventListener('abort', abort);
        }
    }
}
//# sourceMappingURL=api-scan.service.js.map