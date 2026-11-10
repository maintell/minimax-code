import { mkdir, rm } from 'node:fs/promises';
import { logger } from '@mavis/shared/local-runtime-logging';
import { ModelAccessPackageError } from '../errors.js';
import { accessBinding, extensionContext, installationDataDir, } from '../core/context.js';
/**
 * Per-installation housekeeping the package service delegates: the extension's `forget` for an
 * owned credential about to be deleted, and the installation's own data directory.
 */
export class ModelAccessInstallationHousekeeping {
    host;
    constructor(host) {
        this.host = host;
    }
    /** The provider's forget for an owned credential about to be deleted; never throws. */
    async forgetOwned(binding, payload) {
        let parsed = null;
        try {
            if (payload !== undefined)
                parsed = JSON.parse(payload);
        }
        catch {
            parsed = null;
        }
        // An unreadable keychain still lets the extension clean up what it can find on its own.
        if (parsed === null)
            logger.warn({ event: 'model_access_forget_without_payload' }, 'owned payload unreadable');
        await this.callForget(accessBinding(binding), parsed);
    }
    async forgetLateLogin(input) {
        await this.callForget(Object.freeze({
            providerKey: input.providerKey,
            installationId: input.installationId,
            providerId: input.providerId,
            kind: 'direct-owned',
        }), input.payload, input.generation);
    }
    async callForget(binding, payload, generation) {
        const { installationId, providerId } = binding;
        const resolved = generation
            ? {
                registration: generation.registration,
                handler: generation.registration.extension.providers[providerId],
            }
            : this.host.registry().providerOf(installationId, providerId);
        const forget = resolved?.handler?.forget;
        if (!resolved || resolved.registration.installationId !== installationId || !forget)
            return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.host.disposeTimeoutMs ?? 5_000);
        timer.unref?.();
        try {
            await forget.call(resolved.handler, extensionContext({
                directories: this.host.directories,
                profileId: this.host.profileId,
                installationId,
                generation: resolved.registration.generation,
                signal: controller.signal,
            }), binding, payload);
        }
        catch {
            // Never block the deletion; the code is the extension's, the message is never logged.
            logger.warn({ event: 'model_access_forget_failed', providerId }, 'provider forget failed');
        }
        finally {
            clearTimeout(timer);
        }
    }
    async ensureDataDir(installationId) {
        try {
            await mkdir(installationDataDir(this.host.root, installationId), {
                recursive: true,
                mode: 0o700,
            });
        }
        catch {
            throw new ModelAccessPackageError('storage_failed');
        }
    }
    async removeDataDir(installationId) {
        const directory = installationDataDir(this.host.root, installationId);
        try {
            // Windows can briefly lock a directory a just-ended process used: retry a few times.
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
        catch {
            logger.warn({ event: 'model_access_data_dir_retained' }, 'installation data not removed');
        }
    }
}
//# sourceMappingURL=housekeeping.js.map