import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { ModelAccessPackageError } from '../errors.js';
import { modelAccessSnapshotPath, previewLocalModelAccessPackage, } from '../package-snapshot.adapter.js';
import { materializePackageSource, parsePackageSource, } from './sources.js';
const MAX_DEV_SESSIONS = 8;
const MAX_DEV_REQUESTS = 8;
/**
 * The kept user digest to remember when a package is (re)registered under `trustSource`: a dev
 * session taking over a kept user package remembers its digest; leaving dev forgets it.
 */
export function keptDigestOf(previous, trustSource) {
    if (trustSource !== 'dev-session')
        return undefined;
    if (previous.trustSource === 'user-import')
        return previous.activeDigest ?? previous.pendingDigest;
    return previous.keptDigest;
}
/**
 * Registering the content an installation already runs is a no-op, except a dev session taking
 * over a kept user package: the same digest then moves to the dev host group.
 */
export function unchangedRegistration(previous, digest, trustSource) {
    if (previous.activeDigest !== digest || previous.pendingDigest)
        return false;
    return !(trustSource === 'dev-session' && previous.trustSource === 'user-import');
}
/** The installation after a retag (see UserPackageHost.retag). */
export function retaggedInstallation(item, trustSource, digest) {
    return {
        ...item,
        trustSource,
        ...(digest ? { pendingDigest: digest, errorCode: undefined } : {}),
        keptDigest: trustSource === 'dev-session' ? item.keptDigest : undefined,
    };
}
/**
 * User-managed packages: folder/zip installs (consent bound to an exact digest) and dev sessions
 * for packages under development (consent bound to one real path for one session; each reload
 * re-snapshots that path into the dev host group). Sessions are memory-only: an app restart ends
 * them and their packages are removed at the next startup. A dev session for the name of a kept
 * user package runs in that installation's place (same bindings and providers); stopping it, or
 * the next startup, returns the kept version, and keeping it updates the installation in place.
 */
export class ModelAccessUserPackages {
    host;
    sessions = new Map();
    requests = new Map();
    waiters = new Map();
    listeners = new Set();
    constructor(host) {
        this.host = host;
    }
    async preview(source) {
        this.host.assertReady();
        return this.withSource(parsePackageSource(source), (root) => previewLocalModelAccessPackage(root));
    }
    async install(request) {
        this.host.assertReady();
        this.assertAllowed();
        const source = parsePackageSource(request.source);
        if (request.trustNativeCode !== true)
            throw new ModelAccessPackageError('trust_required');
        if (typeof request.expectedDigest !== 'string')
            throw new ModelAccessPackageError('package_changed');
        const installed = await this.withSource(source, (root) => this.host.register(root, request.expectedDigest, 'user-import'));
        return installed.enabled ? installed : this.host.enable(installed.installationId);
    }
    /**
     * Notified when pending requests or sessions change (UI refresh). `sessionId` names the
     * conversation whose request changed, when there is one.
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    changed(sessionId) {
        for (const listener of [...this.listeners]) {
            try {
                listener(sessionId);
            }
            catch {
                /* Observers cannot affect package state. */
            }
        }
    }
    /**
     * Waits until the user approves or dismisses a request. Aborting (the agent's turn ended)
     * dismisses it, so no consent card outlives the call that asked for it.
     */
    awaitRequest(requestId, signal) {
        if (!this.requests.has(requestId))
            return Promise.resolve('dismissed');
        return new Promise((resolve) => {
            const waiters = this.waiters.get(requestId) ?? new Set();
            const done = (outcome) => {
                signal?.removeEventListener('abort', aborted);
                resolve(outcome);
            };
            const aborted = () => this.dismissDevRequest(requestId);
            waiters.add(done);
            this.waiters.set(requestId, waiters);
            signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted)
                aborted();
        });
    }
    settle(requestId, outcome) {
        const request = this.requests.get(requestId);
        if (!request)
            return;
        this.requests.delete(requestId);
        const waiters = this.waiters.get(requestId);
        this.waiters.delete(requestId);
        for (const done of waiters ?? [])
            done(outcome);
        this.changed(request.sessionId);
    }
    settleWhere(match, outcome) {
        for (const request of [...this.requests.values()])
            if (match(request))
                this.settle(request.requestId, outcome);
    }
    keptUserPackage(name) {
        return this.host
            .list()
            .some((item) => item.name === name && item.trustSource === 'user-import');
    }
    record(request) {
        for (const existing of this.requests.values()) {
            if (existing.path !== request.path || existing.kind !== request.kind)
                continue;
            const refreshed = { ...existing, ...request };
            this.requests.set(existing.requestId, refreshed);
            this.changed(refreshed.sessionId);
            return structuredClone(refreshed);
        }
        if (this.requests.size >= MAX_DEV_REQUESTS)
            throw new ModelAccessPackageError('profile_busy');
        const created = {
            ...request,
            requestId: randomUUID(),
            requestedAt: Date.now(),
        };
        this.requests.set(created.requestId, created);
        this.changed(created.sessionId);
        return structuredClone(created);
    }
    /**
     * Agent entry: records a request to run the package at `packagePath` as a dev session. The package is
     * previewed (never executed); the user approves in Desktop, which calls startDev with consent.
     */
    async requestDev(packagePath, sessionId) {
        this.host.assertReady();
        this.assertAllowed();
        const directory = await this.devDirectory(packagePath);
        for (const session of this.sessions.values())
            if (session.path === directory)
                throw new ModelAccessPackageError('dev_session_exists');
        const preview = await previewLocalModelAccessPackage(directory);
        return this.record({
            kind: 'run',
            path: directory,
            name: preview.manifest.name,
            version: preview.manifest.version,
            digest: preview.digest,
            ...(sessionId ? { sessionId } : {}),
            ...(this.keptUserPackage(preview.manifest.name) ? { replacesKept: true } : {}),
        });
    }
    /**
     * Agent entry: asks the user to keep the running dev content at `packagePath` as a user package. The
     * request names the running digest; keeping happens only when the user approves it.
     */
    async requestKeep(packagePath, sessionId) {
        this.host.assertReady();
        this.assertAllowed();
        const session = this.sessionForPath(await this.devDirectory(packagePath));
        if (!session)
            throw new ModelAccessPackageError('dev_session_missing');
        const item = this.host.list().find((entry) => entry.installationId === session.installationId);
        const digest = item?.pendingDigest ?? item?.activeDigest;
        if (!item || !digest)
            throw new ModelAccessPackageError('installation_missing');
        const running = await previewLocalModelAccessPackage(modelAccessSnapshotPath(this.host.root(), digest));
        return this.record({
            kind: 'keep',
            path: session.path,
            name: session.name,
            version: running.manifest.version,
            digest,
            ...(sessionId ? { sessionId } : {}),
            ...(item.keptDigest ? { replacesKept: true } : {}),
        });
    }
    /** The user keeps the running dev content a keep request named (the digest they were shown). */
    async approveKeep(input) {
        const request = this.requests.get(input.requestId);
        if (!request || request.kind !== 'keep')
            throw new ModelAccessPackageError('dev_request_missing');
        if (request.digest !== input.expectedDigest)
            throw new ModelAccessPackageError('package_changed');
        const session = this.sessionForPath(request.path);
        if (!session)
            throw new ModelAccessPackageError('dev_session_missing');
        await this.promote({
            sessionId: session.sessionId,
            expectedDigest: input.expectedDigest,
            trustNativeCode: input.trustNativeCode,
        });
        return session;
    }
    dismissDevRequest(requestId) {
        this.settle(requestId, 'dismissed');
    }
    requestsList() {
        return [...this.requests.values()].map((request) => structuredClone(request));
    }
    /** The session for a real path, if one is running (agent tool lookups). */
    sessionForPath(directory) {
        for (const session of this.sessions.values())
            if (session.path === directory)
                return structuredClone(session);
        return undefined;
    }
    /** Starts a dev session: the user consented to running the package at this exact path. */
    async startDev(input) {
        this.host.assertReady();
        this.assertAllowed();
        if (input.trustNativeCode !== true)
            throw new ModelAccessPackageError('trust_required');
        const directory = await this.devDirectory(input.path);
        for (const session of this.sessions.values())
            if (session.path === directory)
                return structuredClone(session);
        if (this.sessions.size >= MAX_DEV_SESSIONS)
            throw new ModelAccessPackageError('profile_busy');
        const preview = await previewLocalModelAccessPackage(directory);
        const taken = this.host.list().find((item) => item.name === preview.manifest.name);
        if (taken && taken.trustSource !== 'dev-session' && taken.trustSource !== 'user-import')
            throw new ModelAccessPackageError('package_name_taken');
        const registered = await this.host.register(directory, preview.digest, 'dev-session');
        const active = registered.enabled
            ? registered
            : await this.host.enable(registered.installationId);
        const session = {
            sessionId: randomUUID(),
            path: directory,
            installationId: active.installationId,
            name: preview.manifest.name,
            digest: preview.digest,
            startedAt: Date.now(),
        };
        this.sessions.set(session.sessionId, session);
        this.settleWhere((request) => request.kind === 'run' && request.path === directory, 'approved');
        this.changed();
        return structuredClone(session);
    }
    /**
     * Re-snapshots the session path and swaps the dev host slot; running calls finish on the old
     * generation. A changed package name is refused (it would be another installation).
     */
    async reload(sessionId) {
        this.host.assertReady();
        this.assertAllowed();
        const session = this.session(sessionId);
        const preview = await previewLocalModelAccessPackage(session.path);
        if (preview.manifest.name !== session.name)
            throw new ModelAccessPackageError('package_name_taken');
        const installation = await this.host.register(session.path, preview.digest, 'dev-session');
        const next = {
            ...session,
            digest: preview.digest,
            reloadedAt: Date.now(),
        };
        this.sessions.set(sessionId, next);
        return { ...structuredClone(next), installation };
    }
    /**
     * Ends the session: a package that took over a kept user package returns to the kept version,
     * any other is removed with its own data directory.
     */
    async stopDev(sessionId) {
        this.host.assertReady();
        const session = this.session(sessionId);
        this.sessions.delete(sessionId);
        this.settleWhere((request) => request.kind === 'keep' && request.path === session.path, 'dismissed');
        this.changed();
        const item = this.host.list().find((entry) => entry.installationId === session.installationId);
        if (item)
            await this.endDevPackage(item);
    }
    /**
     * Keeps the current dev content as a user package: the user consents to that exact digest, and
     * the package moves from the dev host group to the user group.
     */
    async promote(input) {
        this.host.assertReady();
        this.assertAllowed();
        if (input.trustNativeCode !== true)
            throw new ModelAccessPackageError('trust_required');
        const session = this.session(input.sessionId);
        const item = this.host.list().find((entry) => entry.installationId === session.installationId);
        if (!item)
            throw new ModelAccessPackageError('installation_missing');
        const digest = item.pendingDigest ?? item.activeDigest;
        if (!digest || digest !== input.expectedDigest)
            throw new ModelAccessPackageError('package_changed');
        await this.host.retag(item.installationId, 'user-import');
        this.sessions.delete(input.sessionId);
        this.settleWhere((request) => request.kind === 'keep' && request.path === session.path, 'approved');
        this.changed();
        await this.host.restart(item.installationId);
        const promoted = this.host.list().find((entry) => entry.installationId === item.installationId);
        if (!promoted)
            throw new ModelAccessPackageError('installation_missing');
        return structuredClone(promoted);
    }
    sessionsList() {
        return [...this.sessions.values()].map((session) => structuredClone(session));
    }
    /** Dev packages from an earlier run have no session (and no consent) any more. */
    async dropStaleDevPackages() {
        const live = new Set([...this.sessions.values()].map((session) => session.installationId));
        for (const item of this.host.list()) {
            if (item.trustSource !== 'dev-session' || live.has(item.installationId))
                continue;
            try {
                await this.endDevPackage(item);
            }
            catch {
                /* Retried at the next startup. */
            }
        }
    }
    async endDevPackage(item) {
        if (!item.keptDigest)
            return this.host.uninstall(item.installationId);
        await this.host.retag(item.installationId, 'user-import', item.keptDigest);
        await this.host.restart(item.installationId);
    }
    /**
     * Writes the running content of a user/dev package as a zip that installs to the same digest
     * (for handing a skill-made package to someone else, or re-importing it later).
     */
    async exportPackage(installationId, target) {
        this.host.assertReady();
        if (typeof target !== 'string' || !path.isAbsolute(target) || !target.endsWith('.zip'))
            throw new ModelAccessPackageError('invalid_package');
        const item = this.host.list().find((entry) => entry.installationId === installationId);
        if (!item)
            throw new ModelAccessPackageError('installation_missing');
        if (item.trustSource !== 'user-import' && item.trustSource !== 'dev-session')
            throw new ModelAccessPackageError('official_package_managed');
        const digest = item.activeDigest ?? item.pendingDigest;
        if (!digest)
            throw new ModelAccessPackageError('installation_missing');
        const directory = modelAccessSnapshotPath(this.host.root(), digest);
        const zip = new JSZip();
        await addDirectory(zip, directory, '');
        const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'w', mode: 0o600 });
        return { path: target, digest };
    }
    session(sessionId) {
        const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
        if (!session)
            throw new ModelAccessPackageError('dev_session_missing');
        return session;
    }
    assertAllowed() {
        if (!this.host.userPackagesAllowed())
            throw new ModelAccessPackageError('service_disabled');
    }
    async devDirectory(value) {
        if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096)
            throw new ModelAccessPackageError('invalid_package');
        let directory;
        try {
            directory = await realpath(value);
            if (!(await stat(directory)).isDirectory())
                throw new Error('not a directory');
        }
        catch {
            throw new ModelAccessPackageError('invalid_package');
        }
        return directory;
    }
    async withSource(source, use) {
        const materialized = await materializePackageSource(source, this.host.root());
        try {
            return await use(materialized.root);
        }
        finally {
            await materialized.release();
        }
    }
}
async function addDirectory(zip, directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => codeUnitOrder(a.name, b.name))) {
        const full = path.join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            await addDirectory(zip, full, name);
        else if (entry.isFile())
            zip.file(name, await readFile(full), { date: new Date(0) });
    }
}
/** Plain UTF-16 code unit order, independent of locale. */
function codeUnitOrder(a, b) {
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}
//# sourceMappingURL=user-packages.js.map