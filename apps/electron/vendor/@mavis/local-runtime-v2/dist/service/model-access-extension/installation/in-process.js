import { validateModelAccessExtension } from '../core/extension-validation.js';
import { captureModuleLimits, noteProviderLimits } from '../request/admission.js';
import { ModelAccessPackageError } from '../errors.js';
// ESM module caches outlive service instances. Only a fresh runtime process clears this set.
const attemptedModules = new Set();
const attemptedInstallations = new Set();
/**
 * The explicit in-process execution path (tests/compatibility): loads an extension module into
 * the runtime process and disposes it after its requests settle. A module URL is imported once
 * per process, so reactivation after a failure needs a restart.
 */
export class InProcessExtensions {
    options;
    closed;
    disposals = new Set();
    constructor(options, closed) {
        this.options = options;
        this.closed = closed;
    }
    claim(installationId, moduleUrl) {
        const installationKey = JSON.stringify([
            this.options.root,
            this.options.profileId,
            installationId,
        ]);
        if (attemptedModules.has(moduleUrl) || attemptedInstallations.has(installationKey))
            throw new ModelAccessPackageError('pending_restart');
        attemptedModules.add(moduleUrl);
        attemptedInstallations.add(installationKey);
    }
    async load(moduleUrl, manifest) {
        let expired = false;
        let timer;
        const load = async () => {
            const loaded = await import(/* @vite-ignore */ moduleUrl);
            if (!loaded || typeof loaded !== 'object' || !('default' in loaded))
                throw new ModelAccessPackageError('activation_failed');
            const extension = validateModelAccessExtension(manifest, loaded.default);
            // Optional per-provider limits beside the default export (SDK ModelAccessProviderLimits).
            noteProviderLimits(extension.providers, captureModuleLimits(loaded.providerLimits, manifest.providers.map((provider) => provider.id)));
            if (expired || this.closed()) {
                await this.dispose(extension);
                throw new ModelAccessPackageError('activation_failed');
            }
            return extension;
        };
        try {
            return await Promise.race([
                load(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        expired = true;
                        reject(new ModelAccessPackageError('activation_failed'));
                    }, this.options.activationTimeoutMs ?? 10_000);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    queue(extension, requestsSettled) {
        const entry = { settled: Promise.resolve() };
        this.disposals.add(entry);
        entry.settled = (async () => {
            try {
                await requestsSettled;
                await extension.dispose?.();
            }
            catch {
                /* Native cleanup settled with failure; same-process reactivation still requires restart. */
            }
            finally {
                this.disposals.delete(entry);
            }
        })();
        return entry;
    }
    dispose(extension, requestsSettled = Promise.resolve()) {
        return this.wait([this.queue(extension, requestsSettled).settled]);
    }
    /** Bounded wait for queued disposals (mutation lane). */
    waitAll() {
        return this.wait([...this.disposals].map((entry) => entry.settled));
    }
    /** Unbounded: profile ownership waits for actual native settlement. */
    async settled() {
        await Promise.allSettled([...this.disposals].map((entry) => entry.settled));
    }
    async wait(work) {
        let timer;
        try {
            await Promise.race([
                Promise.all(work),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, this.options.disposeTimeoutMs ?? 5_000);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=in-process.js.map