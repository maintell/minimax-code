import { isDeepStrictEqual } from 'node:util';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { OsModelAccessSecretStore } from './os-secret-store.adapter.js';
import { ModelAccessPackageError } from '../errors.js';
import { logger } from '@mavis/shared/local-runtime-logging';
export async function migrateOsSlots(records, repository, bindings, profileId) {
    await records.initialize();
    if (repository.takeLegacySlots().length)
        throw new ModelAccessPackageError('credential_schema_mismatch');
    const keyring = new OsModelAccessSecretStore(profileId);
    for (const binding of bindings) {
        if (records.state().bindings.some((b) => b.providerKey === binding.providerKey))
            continue;
        const envelope = binding.kind === 'direct-owned'
            ? await keyring.read({ ...binding, slot: binding.slot ?? 'A' })
            : undefined;
        await records.import(binding, envelope);
    }
    await repository.transaction(async () => {
        const current = await repository.read();
        if (current.credentials && !isDeepStrictEqual(current.credentials.bindings, bindings))
            throw new ModelAccessPackageError('storage_failed');
        await repository.write({ ...current, credentials: undefined });
    });
    await cleanupSlots(bindings, keyring);
}
async function cleanupSlots(bindings, keyring) {
    for (const binding of bindings) {
        if (binding.kind !== 'direct-owned')
            continue;
        try {
            await keyring.remove({ ...binding, slot: binding.slot ?? 'A' });
        }
        catch {
            logger.warn({ event: 'model_access_legacy_slot_retained' }, 'Old credential cleanup deferred');
        }
    }
}
/** Compatibility for injected stores only; shared production profiles retain unknown schemas. */
export async function removeLegacySlots(repository, secrets, state, root) {
    const slots = repository.takeLegacySlots();
    if (!slots.length)
        return;
    logger.warn({ event: 'model_access_legacy_credentials_dropped', slots: slots.length }, 'legacy model-access credential state dropped; sign in again');
    const store = secrets;
    if (typeof store.removeLegacy === 'function')
        for (const slot of slots)
            await store.removeLegacy.call(secrets, slot);
    await repository.write({ ...state, credentials: { bindings: [] } });
    try {
        await rm(path.join(root, 'cli-instances'), { recursive: true, force: true });
    }
    catch {
        logger.warn({ event: 'model_access_legacy_cli_dir_retained' }, 'legacy CLI data not removed');
    }
}
//# sourceMappingURL=migrations.js.map