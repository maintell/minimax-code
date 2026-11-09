import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ModelAccessPackageError } from '../errors.js';
import { comparePackageVersions } from './text.js';
import { modelAccessSnapshotPath, previewLocalModelAccessPackage, } from '../package-snapshot.adapter.js';
import { ModelAccessCatalogError, modelAccessSdkCompatible, parseModelAccessCatalog, } from './catalog.js';
import { syncModelAccessIcons } from './icons.js';
import { catalogTextDigest, MAX_STORED_CATALOG_BYTES, storedAttestationFor, } from './remote-state.js';
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** Stable lowercase code only; never a message, URL, or path. */
export function officialSyncErrorCode(error) {
    const code = error?.code;
    if (typeof code === 'string') {
        const normalized = code.toLowerCase();
        if (ERROR_CODE.test(normalized))
            return normalized;
    }
    return 'sync_failed';
}
class OfficialActivationError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'OfficialActivationError';
    }
}
/**
 * A catalog sequence only orders catalogs of one lane: after a lane switch (or clearing it) the
 * stored sequence is not sent and the new lane's catalog is taken whole, even with a lower one.
 */
function sequenceInLane(state, lane) {
    return state.lane === lane ? state.sequence : undefined;
}
/**
 * One reconcile pass. Remote content replaces the running version only for a newer version, an
 * explicit rollback, or a revocation; every failure leaves the active version running.
 */
export class OfficialModelAccessSync {
    host;
    client;
    archive;
    options;
    mappings = new Map();
    constructor(host, client, archive, options = {}) {
        this.host = host;
        this.client = client;
        this.archive = archive;
        this.options = options;
    }
    async run(signal) {
        const before = this.host.remoteDelivery();
        const lane = this.options.lane?.();
        const response = await this.client.desktopState(sequenceInLane(before, lane), signal);
        const pollIntervalSeconds = response.pollIntervalSeconds;
        if (await this.applyServiceSwitch(response.deliveryEnabled, before))
            return { pollIntervalSeconds, deliveryDisabled: true };
        if (response.catalog)
            await this.applyCatalog(response.catalog, before, lane);
        const state = this.host.remoteDelivery();
        if (!state.catalogJson || state.sequence === undefined)
            return { pollIntervalSeconds, errorCode: 'catalog_missing' };
        const catalog = parseModelAccessCatalog(state.catalogJson, { sequence: state.sequence });
        this.loadMappings(state);
        const errors = await this.reconcileWithMigrations(catalog, signal);
        await this.collect(errors, () => this.enforceRevocations());
        await this.saveMappings();
        // Icons are presentation only: a failed icon is reported but never fails package delivery.
        await this.collect(errors, async () => {
            const icons = await syncModelAccessIcons({
                root: this.host.root,
                catalog,
                download: (url, target, iconSignal) => this.client.downloadToFile(url, target, iconSignal),
                signal,
            });
            if (icons.errorCode)
                errors.push(icons.errorCode);
        });
        return { pollIntervalSeconds, ...(errors[0] ? { errorCode: errors[0] } : {}) };
    }
    /** Records the master switch; true while it is off (nothing is downloaded or changed). */
    async applyServiceSwitch(deliveryEnabled, before) {
        if (!deliveryEnabled) {
            // Master switch off: keep snapshots, credentials and settings; download nothing.
            if (!before.serviceDisabled)
                await this.host.updateRemoteDelivery((current) => ({ ...current, serviceDisabled: true }));
            return true;
        }
        if (before.serviceDisabled)
            // Restored from local snapshots by the package service; no re-download.
            await this.host.updateRemoteDelivery(({ serviceDisabled: _off, ...current }) => current);
        return false;
    }
    /**
     * A split package's new version may only drop providers once their bindings moved: after a
     * migration, packages that failed (credential_schema_mismatch) get one more pass.
     */
    async reconcileWithMigrations(catalog, signal) {
        let errors = await this.reconcileAll(catalog, signal);
        try {
            if ((await this.applyMigrations(catalog)) && errors.length)
                errors = await this.reconcileAll(catalog, signal);
        }
        catch (error) {
            errors.push(officialSyncErrorCode(error));
        }
        return errors;
    }
    /** Runs one best-effort step, adding its failure code to `errors`. */
    async collect(errors, step) {
        try {
            await step();
        }
        catch (error) {
            errors.push(officialSyncErrorCode(error));
        }
    }
    async reconcileAll(catalog, signal) {
        const errors = [];
        for (const entry of catalog.packages) {
            if (signal.aborted)
                throw new OfficialActivationError('sync_aborted');
            try {
                await this.reconcilePackage(entry, signal);
            }
            catch (error) {
                errors.push(officialSyncErrorCode(error));
            }
        }
        return errors;
    }
    /** Offline startup step: never run a version revoked by a catalog applied earlier. */
    async enforceLocal() {
        this.loadMappings(this.host.remoteDelivery());
        await this.enforceRevocations();
        await this.saveMappings();
    }
    async applyCatalog(envelope, before, lane) {
        const appliedSequence = sequenceInLane(before, lane);
        if (Buffer.byteLength(envelope.catalogJson) > MAX_STORED_CATALOG_BYTES)
            throw new ModelAccessCatalogError('catalog_invalid');
        const catalog = parseModelAccessCatalog(envelope.catalogJson, {
            sequence: envelope.sequence,
            ...(appliedSequence !== undefined ? { appliedSequence } : {}),
        });
        // A profile never switches between test and prod catalogs.
        if (before.environment && before.environment !== catalog.environment)
            throw new ModelAccessCatalogError('catalog_invalid');
        for (const pkg of envelope.packages) {
            const entry = catalog.packages.find((item) => item.name === pkg.name && item.version === pkg.version);
            if (!entry)
                throw new ModelAccessCatalogError('attestation_invalid');
        }
        await this.host.updateRemoteDelivery(({ lane: _previous, ...current }) => ({
            ...current,
            ...(lane ? { lane } : {}),
            environment: catalog.environment,
            sequence: catalog.sequence,
            catalogJson: envelope.catalogJson,
            catalogDigest: catalogTextDigest(envelope.catalogJson),
            attestations: envelope.packages.map(({ name, version, attestationJson }) => ({
                name,
                version,
                attestationJson,
            })),
            revokedDigests: [...new Set([...current.revokedDigests, ...catalog.revokedDigests])],
        }));
    }
    isRevoked(contentDigest) {
        return !!contentDigest && this.host.remoteDelivery().revokedDigests.includes(contentDigest);
    }
    async reconcilePackage(entry, signal) {
        if (this.isRevoked(entry.contentDigest))
            return;
        const state = this.host.remoteDelivery();
        // No compatible attestation: this client cannot install it; keep what is installed.
        const attestation = this.installableAttestation(state, entry);
        if (!attestation)
            return;
        const item = this.host.installations().find((candidate) => candidate.name === entry.name);
        const stoppedByRevocation = !!item && (state.revocationDisabled ?? []).includes(item.name);
        const local = await this.localFor(entry.contentDigest, item);
        if (!stoppedByRevocation && (await this.keepsRunning(entry, item, local)))
            return this.resume(item);
        await this.installVersion({ entry, attestation, item, local }, signal);
        if (stoppedByRevocation)
            await this.clearStopped(entry.name);
    }
    installableAttestation(state, entry) {
        const attestation = storedAttestationFor(state, entry);
        if (!attestation || !attestation.platforms.includes(this.host.platform))
            return undefined;
        return modelAccessSdkCompatible(attestation.sdkRange, this.host.sdkVersion)
            ? attestation
            : undefined;
    }
    /** The running version stays: it is this content, the same version, or newer (no rollback). */
    async keepsRunning(entry, item, local) {
        const running = item?.activeDigest;
        if (!item || !running)
            return false;
        if (local && local === running)
            return true;
        const current = await this.host.snapshotManifest(item.installationId, running);
        if (!current)
            return false;
        const order = comparePackageVersions(entry.version, current.version);
        return order === 0 || (order < 0 && !entry.rollbackReason);
    }
    /**
     * Official packages always follow remote delivery: a package stopped by an older Desktop
     * (which still allowed a user stop) is resumed. Only revocation stops one.
     */
    async resume(item) {
        if (item && !item.enabled && item.activeDigest)
            await this.expectActive(await this.ensureEnabled(item), item.activeDigest);
    }
    /** Activates `entry`: a trusted local snapshot by rollback, otherwise a verified download. */
    async installVersion(target, signal) {
        const { entry, attestation, item, local } = target;
        if (item && local && item.trustedDigests.includes(local)) {
            await this.expectActive(await this.ensureEnabled(await this.host.rollback(item.installationId, local)), local);
            return;
        }
        const digest = local ?? (await this.download(entry, attestation, signal));
        const installed = await this.host.install(await this.physical(modelAccessSnapshotPath(this.host.root, digest)), digest);
        await this.expectActive(await this.ensureEnabled(installed), digest);
    }
    async ensureEnabled(item) {
        return item.enabled ? item : this.host.enable(item.installationId);
    }
    /** A failed hot swap keeps the previous version and records its code on the installation. */
    async expectActive(item, digest) {
        if (item.activeDigest !== digest)
            throw new OfficialActivationError(item.errorCode ?? 'activation_failed');
    }
    /** Private staging download; both digests and the manifest are checked before a snapshot. */
    async download(entry, attestation, signal) {
        const authorization = await this.client.authorizeDownload({ name: entry.name, version: entry.version, contentDigest: entry.contentDigest }, signal);
        if (authorization.archiveSha256 !== entry.archiveSha256 ||
            authorization.packageSizeBytes !== attestation.packageSizeBytes)
            throw new ModelAccessCatalogError('attestation_invalid');
        await mkdir(path.join(this.host.root, 'staging'), { recursive: true, mode: 0o700 });
        // Package readers require a physical path (realpath === resolve); an ancestor symlink such
        // as macOS /var -> /private/var would otherwise fail every downloaded package.
        const stagingRoot = await realpath(path.join(this.host.root, 'staging'));
        const staging = path.join(stagingRoot, `remote-${randomUUID()}`);
        await mkdir(staging, { mode: 0o700 });
        try {
            const archivePath = path.join(staging, 'package.zip');
            await this.client.downloadToFile(authorization.downloadUrl, archivePath, signal);
            const materialized = await this.archive.materialize({
                archivePath,
                cacheRoot: path.join(staging, 'content'),
                expectedArchiveSha256: entry.archiveSha256,
                expectedContentDigest: entry.contentDigest,
                signal,
            });
            const preview = await previewLocalModelAccessPackage(materialized.packageRoot);
            if (preview.manifest.name !== entry.name ||
                preview.manifest.version !== entry.version ||
                !preview.manifest.platforms.includes(this.host.platform) ||
                !modelAccessSdkCompatible(preview.manifest.engines.mcodeSdk, this.host.sdkVersion))
                throw new ModelAccessPackageError('invalid_package');
            this.mappings.set(preview.digest, {
                contentDigest: entry.contentDigest,
                localDigest: preview.digest,
                origin: 'remote',
            });
            // Persist the mapping before activation so the trust label and revocation see it.
            await this.saveMappings();
            const installed = await this.host.install(materialized.packageRoot, preview.digest);
            await this.expectActive(await this.ensureEnabled(installed), preview.digest);
            return preview.digest;
        }
        finally {
            await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }
    /** Local snapshot with the same sha256-tree-v1 content; avoids a download when present. */
    async localFor(contentDigest, item) {
        for (const digest of item?.trustedDigests ?? [])
            await this.contentOf(digest);
        for (const mapping of this.mappings.values()) {
            if (mapping.contentDigest !== contentDigest)
                continue;
            try {
                const preview = await previewLocalModelAccessPackage(await this.physical(modelAccessSnapshotPath(this.host.root, mapping.localDigest)));
                if (preview.digest === mapping.localDigest)
                    return mapping.localDigest;
            }
            catch {
                /* Snapshot gone or changed: download again. */
            }
        }
        return undefined;
    }
    /**
     * The two digest schemes hash the same bytes differently: `sha256:` (local snapshot identity)
     * and `sha256-tree-v1:` (server/Plugin identity). The tree digest is computed once per local
     * snapshot and persisted.
     */
    async contentOf(localDigest, directory) {
        const known = this.mappings.get(localDigest);
        if (known)
            return known.contentDigest;
        try {
            const contentDigest = await this.archive.contentDigest(directory ?? modelAccessSnapshotPath(this.host.root, localDigest));
            this.mappings.set(localDigest, { contentDigest, localDigest, origin: 'local' });
            return contentDigest;
        }
        catch {
            // Outside the portable package contract (development imports): never a remote version.
            return undefined;
        }
    }
    /** Resolve ancestor symlinks; package readers reject non-physical paths. */
    async physical(target) {
        return path.join(await realpath(path.dirname(target)), path.basename(target));
    }
    loadMappings(state) {
        this.mappings = new Map(state.digests.map((item) => [item.localDigest, item]));
    }
    async saveMappings() {
        const learned = [...this.mappings.values()];
        const current = this.host.remoteDelivery().digests;
        const unchanged = learned.length === current.length &&
            learned.every((item) => current.some((old) => old.localDigest === item.localDigest &&
                old.contentDigest === item.contentDigest &&
                old.origin === item.origin));
        if (unchanged)
            return;
        await this.host.updateRemoteDelivery((state) => {
            const merged = new Map(state.digests.map((item) => [item.localDigest, item]));
            for (const item of learned) {
                const old = merged.get(item.localDigest);
                // A downloaded origin is sticky: it decides the "official" label.
                merged.set(item.localDigest, old?.origin === 'remote' ? { ...item, origin: 'remote' } : item);
            }
            return { ...state, digests: [...merged.values()].slice(-512) };
        });
    }
    /**
     * Catalog v2 split: once the new packages run, bindings move to them. Any delivered official
     * package the catalog no longer lists (a migration source or not) is stopped when nothing is
     * bound to it any more; it is not deleted. A binding the new package cannot take keeps the old
     * package running. Listing the old package again resumes it.
     */
    async applyMigrations(catalog) {
        const migrations = catalog.credentialMigrations ?? [];
        const migrate = this.host.migrateCredentials;
        let moved = false;
        const sources = new Set();
        for (const migration of migrations) {
            if (!migrate)
                break;
            const target = this.host.installations().find((item) => item.name === migration.to);
            if (!target?.enabled || !target.activeDigest)
                continue;
            const result = await migrate({
                from: migration.from,
                to: migration.to,
                providerIds: migration.providers,
            });
            moved ||= result.moved.length > 0;
            sources.add(migration.from);
        }
        await this.stopDelisted(catalog, sources);
        return moved;
    }
    /**
     * Every delivered official package the catalog no longer lists stops once nothing is bound to
     * it, whether or not a migration names it: a package the client once bundled (or an older
     * catalog delivered) must not keep running beside its successors. User packages never stop here.
     */
    async stopDelisted(catalog, sources) {
        const listed = new Set(catalog.packages.map((item) => item.name));
        for (const item of this.host.installations())
            if (item.trustSource === 'bundled')
                sources.add(item.name);
        for (const name of sources)
            if (!listed.has(name))
                await this.stopIfUnbound(name);
    }
    /** A source package the catalog dropped stops once nothing is bound to it any more. */
    async stopIfUnbound(name) {
        const item = this.host.installations().find((entry) => entry.name === name);
        if (!item?.enabled || this.host.boundInstallation?.(item.installationId) !== false)
            return;
        await this.host.disable(item.installationId);
    }
    async clearStopped(name) {
        await this.host.updateRemoteDelivery((current) => ({
            ...current,
            revocationDisabled: (current.revocationDisabled ?? []).filter((item) => item !== name),
        }));
    }
    /**
     * A revoked running version moves to the newest clean local snapshot; with none, it stops.
     * The bundled package is never a fallback: remote delivery owns installation.
     */
    async enforceRevocations() {
        for (const item of this.host.installations()) {
            const digest = item.activeDigest ?? item.pendingDigest;
            if (!item.enabled || !digest || !this.isRevoked(await this.contentOf(digest)))
                continue;
            if (await this.replaceRevoked(item, digest))
                continue;
            // Nothing clean to run: stop the package; credentials and its data directory stay.
            await this.host.disable(item.installationId);
            await this.host.updateRemoteDelivery((current) => ({
                ...current,
                revocationDisabled: [...new Set([...(current.revocationDisabled ?? []), item.name])],
            }));
        }
    }
    async replaceRevoked(item, digest) {
        for (const candidate of await this.cleanCandidates(item, digest)) {
            try {
                const result = await this.host.rollback(item.installationId, candidate);
                if (result.installationId === item.installationId && result.activeDigest === candidate)
                    return true;
            }
            catch {
                /* Try the next clean version. */
            }
        }
        return false;
    }
    /** Trusted, unrevoked local snapshots other than `digest`, newest version first. */
    async cleanCandidates(item, digest) {
        const candidates = [];
        for (const candidate of item.trustedDigests) {
            if (candidate === digest || this.isRevoked(await this.contentOf(candidate)))
                continue;
            const manifest = await this.host.snapshotManifest(item.installationId, candidate);
            if (manifest)
                candidates.push({ digest: candidate, version: manifest.version });
        }
        candidates.sort((a, b) => comparePackageVersions(b.version, a.version));
        return [...new Set(candidates.map((candidate) => candidate.digest))];
    }
}
//# sourceMappingURL=sync.js.map