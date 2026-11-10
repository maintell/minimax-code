import { trustedActivationDigest } from './lifecycle/registration.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelAccessHostSupervisor } from './host-process/process/supervisor.js';
import { ModelAccessHostGroupPool } from './host-process/process/group-pool.js';
import { modelAccessOrigin } from './contracts.js';
import { createModelAccessHostExtension } from './host-process/rpc/extension-proxy.js';
import { locateModelAccessHostEntry } from './host-process/entry-path.js';
import { installationDataDir } from './core/context.js';
import { previewLocalModelAccessPackage } from './package-snapshot.adapter.js';
import { ModelAccessPackageError } from './errors.js';
import { observeModelAccessWork } from './core/settlement.js';
import { fingerprintProxied, ModelAccessHostNetwork } from './host-process/network-env.js';
export class ModelAccessSubprocessLifecycle {
    host;
    control;
    supervisor;
    activations = new Map();
    recovery = new Map();
    network;
    /** The proxy fingerprint each current host started with. */
    startedProxy = new Map();
    forced = new Set();
    groupPool;
    constructor(host, control = {}) {
        this.host = host;
        this.control = control;
        if (control.network)
            this.network = control.network;
        else if (control.network !== false && !control.launch?.environment)
            this.network = new ModelAccessHostNetwork(path.join(host.options.root, 'host-ca'));
        if (control.groupHosts !== false)
            this.groupPool = new ModelAccessHostGroupPool();
        this.supervisor = new ModelAccessHostSupervisor({
            ...(this.groupPool ? { groupPool: this.groupPool, maxHosts: 192 } : {}),
            onUnexpectedExit: ({ installationId, packageGeneration, exit }) => this.hostExited(installationId, packageGeneration, exit.bystander === true),
        });
    }
    async activate(installationId) {
        // Only explicit enable/restart/update reach a package that used up its restarts; give it a
        // fresh restart budget.
        if (this.recovery.get(installationId)?.exhausted)
            this.recovery.delete(installationId);
        const preceding = this.activations.get(installationId) ?? Promise.resolve();
        const work = (async () => {
            try {
                await preceding;
            }
            catch {
                /* A failed candidate does not block the next update. */
            }
            await this.activateSerial(installationId);
        })();
        this.activations.set(installationId, work);
        try {
            await work;
        }
        finally {
            if (this.activations.get(installationId) === work)
                this.activations.delete(installationId);
        }
    }
    /**
     * True while a crashed host waits for its backoff or has used up its restarts. Background
     * reconciliation must leave it alone; explicit enable/restart/update still activate it.
     */
    holdsRecovery(installationId) {
        const entry = this.recovery.get(installationId);
        if (!entry)
            return false;
        return Boolean(entry.timer || entry.exhausted);
    }
    /** Graceful stop: new calls are refused, running calls finish, then the host exits. */
    retire(installationId) {
        const recovery = this.recovery.get(installationId);
        if (recovery?.timer)
            clearTimeout(recovery.timer);
        this.recovery.delete(installationId);
        this.startedProxy.delete(installationId);
        this.supervisor.retireCurrent(installationId);
    }
    deactivate(installationId) {
        const recovery = this.recovery.get(installationId);
        if (recovery?.timer)
            clearTimeout(recovery.timer);
        this.recovery.delete(installationId);
        this.startedProxy.delete(installationId);
        return this.supervisor.deactivate(installationId);
    }
    async close() {
        for (const entry of this.recovery.values())
            if (entry.timer)
                clearTimeout(entry.timer);
        this.recovery.clear();
        this.startedProxy.clear();
        await this.supervisor.close();
        await Promise.allSettled([...this.activations.values()]);
    }
    /** The installation to (re)start, unless it is disabled or already runs its active version. */
    activationTarget(installationId) {
        const item = this.host.item(installationId);
        const forced = this.forced.delete(installationId);
        if (!item?.enabled)
            return undefined;
        const current = this.host.registry().get(installationId)?.digest === item.activeDigest && !item.pendingDigest;
        if (current && !forced)
            return undefined;
        return { item, policy: this.host.policy().version() };
    }
    async activateSerial(installationId) {
        if (this.host.closed() || this.host.serviceDisabled?.())
            return;
        const captured = await this.host.enqueue(async () => this.activationTarget(installationId));
        if (!captured)
            return;
        const { item } = captured;
        let candidate;
        let staged;
        let committed = false;
        try {
            const digest = trustedActivationDigest(item);
            const { preview, directory } = await this.host.validateSnapshot(installationId, digest);
            const entryPath = this.control.launch?.entryPath ?? (await locateModelAccessHostEntry());
            const network = await this.network?.environment();
            let starting;
            await this.host.enqueue(async () => {
                if (this.host.closed() || this.host.item(installationId) !== item)
                    throw new ModelAccessPackageError('activation_failed');
                await this.host.ensureDataDir(installationId);
                starting = this.supervisor.stage({
                    installationId,
                    group: modelAccessOrigin(item.trustSource),
                    packageGeneration: item.generation + 1,
                    entryPath,
                    moduleUrl: pathToFileURL(path.join(directory, preview.manifest.entry)).href,
                    manifest: preview.manifest,
                    cwd: directory,
                    dataDir: installationDataDir(this.host.options.root, installationId),
                    runAsElectronNode: !!process.versions.electron,
                    startupTimeoutMs: this.host.options.activationTimeoutMs,
                    requestTimeoutMs: this.host.options.requestTimeoutMs,
                    ...this.control.launch,
                    ...(network ? { environment: network.env } : {}),
                });
            });
            candidate = await starting;
            const extension = await createModelAccessHostExtension(candidate.lease.peer, preview.manifest);
            if ((await previewLocalModelAccessPackage(directory)).digest !== digest)
                throw new ModelAccessPackageError('integrity_failed');
            const ready = candidate;
            await this.host.enqueue(async () => {
                if (this.host.closed() ||
                    this.host.item(installationId) !== item ||
                    this.host.policy().version() !== captured.policy)
                    throw new ModelAccessPackageError('activation_failed');
                ready.assertCurrent();
                staged = this.host.registry().stage({
                    installationId,
                    generation: item.generation + 1,
                    digest,
                    manifest: preview.manifest,
                    extension,
                    host: ready.lease,
                    ...(this.host.boundProvider
                        ? {
                            retiredProvider: (providerId) => !this.host.boundProvider(installationId, providerId),
                        }
                        : {}),
                });
                staged.assertCurrent();
                await this.host.put({
                    ...item,
                    activeDigest: digest,
                    pendingDigest: undefined,
                    generation: item.generation + 1,
                    enabled: true,
                    status: 'active',
                    errorCode: undefined,
                });
                staged.commit();
                ready.commit();
                committed = true;
                if (network)
                    this.startedProxy.set(installationId, network.proxy);
            });
        }
        catch (error) {
            if (!committed) {
                staged?.discard();
                await candidate?.discard();
                await this.host.enqueue(async () => {
                    if (this.host.closed() || this.host.item(installationId) !== item)
                        return;
                    const active = !!this.host.registry().get(installationId);
                    await this.host.put({
                        ...item,
                        status: active ? 'active' : 'failed',
                        ...(active ? { pendingDigest: undefined } : {}),
                        errorCode: error instanceof ModelAccessPackageError ? error.code : 'activation_failed',
                    });
                });
            }
        }
        finally {
            await candidate?.lease.release();
        }
    }
    /** Replace a current host with one started now, keeping its digest. */
    restart(installationId) {
        this.forced.add(installationId);
        return this.activate(installationId);
    }
    /**
     * A request began: when a look is due (every 2 s while no running host has a proxy, every 15 s
     * while one has), the system proxy is read and a host started on another one is replaced. Its
     * running calls drain on the old host; this request is not held for the read. Without requests
     * nothing is spawned, as Magpie looks only when a request gets its host (getLocked's
     * proxyMoved).
     */
    noteRequest() {
        if (!this.network || this.startedProxy.size === 0 || this.host.closed())
            return;
        observeModelAccessWork(this.lookAtProxy());
    }
    async lookAtProxy() {
        if (this.host.closed() || !this.network || this.startedProxy.size === 0)
            return;
        const started = [...this.startedProxy];
        const current = await this.network.lookIfDue(started.some(([, proxy]) => fingerprintProxied(proxy)));
        if (current === undefined)
            return;
        for (const [installationId, proxy] of started) {
            if (proxy === current || this.activations.has(installationId) || this.host.closed())
                continue;
            if (this.startedProxy.get(installationId) !== proxy)
                continue;
            await this.restart(installationId);
        }
    }
    /** `bystander`: a group mate crashed the shared process; this package is not charged. */
    hostExited(installationId, packageGeneration, bystander) {
        if (this.host.closed())
            return;
        observeModelAccessWork(this.host.enqueue(async () => {
            const item = this.host.item(installationId);
            const local = this.host.registry().get(installationId);
            if (!item?.enabled || local?.generation !== packageGeneration || this.host.closed())
                return;
            this.host.policy().invalidateInstallation(installationId);
            this.host.registry().remove(installationId);
            await this.host.put({
                ...item,
                pendingDigest: undefined,
                status: 'failed',
                errorCode: 'host_unavailable',
            });
            this.scheduleRecovery(installationId, !bystander);
        }));
    }
    /** `charged`: the restart counts against the package's limit (its own host failed). */
    scheduleRecovery(installationId, charged = true) {
        if (this.host.closed() || !this.host.item(installationId)?.enabled)
            return;
        const entry = this.recovery.get(installationId) ?? { failures: [] };
        if (entry.timer)
            return;
        entry.failures = entry.failures.filter((time) => time > Date.now() - 600_000);
        this.recovery.set(installationId, entry);
        const delay = this.recoveryDelay(entry, charged);
        if (delay === undefined)
            return;
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (this.host.closed() || !this.host.item(installationId)?.enabled)
                return;
            observeModelAccessWork(this.recover(installationId));
        }, delay);
        entry.timer.unref();
    }
    /** The wait before the next restart, counting a charged one; undefined once restarts are used up. */
    recoveryDelay(entry, charged) {
        // Stays stopped once the limit is hit, even after the window slides past those failures.
        if (entry.exhausted ||
            (charged && entry.failures.length >= (this.control.recoveryLimit ?? 5))) {
            entry.exhausted = true;
            return undefined;
        }
        const base = this.control.recoveryBaseMs ?? 1_000;
        if (!charged)
            return base;
        const delay = Math.min(60_000, base * 2 ** entry.failures.length);
        entry.failures.push(Date.now());
        return delay;
    }
    async recover(installationId) {
        try {
            await this.activate(installationId);
        }
        finally {
            if (!this.host.registry().get(installationId))
                this.scheduleRecovery(installationId);
        }
    }
}
//# sourceMappingURL=package-subprocess.js.map