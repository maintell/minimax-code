import { lstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { ModelAccessRegistry } from './core/registry.js';
import { parseModelAccessPolicyPreferences } from './core/policy-preferences.js';
import { ModelAccessPackageError } from './errors.js';
import { legacyCredentialSlots, parseCredentialState, serializeCredentialState, } from './credentials/credential-state.js';
import { parseRemoteDeliveryState } from './official/remote-state.js';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STATES = ['registered', 'active', 'disabled', 'pending-restart', 'failed'];
// Persisted values only. `official` is a derived display label (see trustSourceOf) and is never
// written, so a Desktop build without remote delivery still reads this file.
const TRUST_SOURCES = ['bundled', 'dev-import', 'user-import', 'dev-session'];
function validIdentity(item) {
    return (typeof item.installationId === 'string' &&
        /^[a-zA-Z0-9_-]{1,128}$/u.test(item.installationId) &&
        typeof item.name === 'string' &&
        item.name.length > 0 &&
        item.name.length <= 128 &&
        Number.isSafeInteger(item.generation) &&
        item.generation >= 1);
}
function validDigests(item) {
    if (!Array.isArray(item.trustedDigests) || item.trustedDigests.length > 128)
        return false;
    if (item.trustedDigests.some((digest) => typeof digest !== 'string' || !DIGEST.test(digest)))
        return false;
    return [item.activeDigest, item.pendingDigest, item.keptDigest].every((digest) => digest === undefined || item.trustedDigests.includes(digest));
}
function validState(item) {
    return (typeof item.enabled === 'boolean' &&
        STATES.includes(item.status) &&
        (item.trustSource === undefined || TRUST_SOURCES.includes(item.trustSource)));
}
function validateInstallation(item, ids, names) {
    const checks = [
        !!item && typeof item === 'object',
        !!item && validIdentity(item),
        !!item && validDigests(item),
        !!item && validState(item),
    ];
    if (!checks.every(Boolean))
        throw new ModelAccessPackageError('storage_failed');
    if (ids.has(item.installationId) || names.has(item.name))
        throw new ModelAccessPackageError('storage_failed');
    ids.add(item.installationId);
    names.add(item.name);
}
function parseSelections(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length > 128)
        throw new ModelAccessPackageError('storage_failed');
    return new ModelAccessRegistry(value).selections();
}
function parseCredentials(value) {
    if (value === undefined)
        return { credentials: undefined, legacySlots: [] };
    const legacy = legacyCredentialSlots(value);
    // Never released: an old-format state is read as empty, its slots are removed best effort.
    if (legacy)
        return { credentials: { bindings: [] }, legacySlots: legacy };
    return { credentials: parseCredentialState(value), legacySlots: [] };
}
function parseState(value, profileId) {
    if (!value || typeof value !== 'object')
        throw new ModelAccessPackageError('storage_failed');
    const state = value;
    if (state.schemaVersion !== 1 || state.profileId !== profileId)
        throw new ModelAccessPackageError('profile_mismatch');
    if (!Array.isArray(state.installations) || state.installations.length > 128)
        throw new ModelAccessPackageError('storage_failed');
    const ids = new Set();
    const names = new Set();
    for (const item of state.installations)
        validateInstallation(item, ids, names);
    const preferences = state.preferences === undefined
        ? undefined
        : parseModelAccessPolicyPreferences(state.preferences, profileId);
    const providerSelections = parseSelections(state.providerSelections);
    const { credentials, legacySlots } = parseCredentials(state.credentials);
    const remoteDelivery = parseRemoteDeliveryState(state.remoteDelivery);
    return {
        state: {
            schemaVersion: 1,
            profileId,
            installations: structuredClone(state.installations),
            preferences,
            providerSelections,
            credentials,
            ...(remoteDelivery ? { remoteDelivery } : {}),
        },
        legacySlots,
    };
}
function persisted(state) {
    const { credentials, ...rest } = state;
    return credentials === undefined
        ? rest
        : { ...rest, credentials: serializeCredentialState(credentials) };
}
/** Single runtime ownership plus atomic JSON pointer; never stores credentials or external paths. */
export class ModelAccessPackageRepository {
    root;
    profileId;
    shared;
    unlock;
    opened = false;
    leaseCheck;
    legacy = [];
    ownerFile;
    constructor(root, profileId, shared = false) {
        this.root = root;
        this.profileId = profileId;
        this.shared = shared;
    }
    async open() {
        try {
            await mkdir(this.root, { recursive: true, mode: 0o700 });
            const stat = await lstat(this.root);
            if (!stat.isDirectory() ||
                stat.isSymbolicLink() ||
                (await realpath(this.root)) !== path.resolve(this.root)) {
                throw new ModelAccessPackageError('storage_failed');
            }
            if (!this.shared)
                this.unlock = await lockfile.lock(this.root, { realpath: false, retries: 0 });
            this.opened = true;
            if (this.shared) {
                await this.transaction(async () => {
                    const directory = path.join(this.root, '.owners');
                    await mkdir(directory, { recursive: true, mode: 0o700 });
                    const info = await lstat(directory);
                    if (!info.isDirectory() || info.isSymbolicLink())
                        throw new ModelAccessPackageError('storage_failed');
                    this.ownerFile = path.join(directory, `${process.pid}-${randomUUID()}`);
                    const marker = await open(this.ownerFile, 'wx', 0o600);
                    try {
                        await marker.writeFile(String(process.pid));
                    }
                    finally {
                        await marker.close();
                    }
                });
            }
        }
        catch (error) {
            if (error instanceof ModelAccessPackageError)
                throw error;
            throw new ModelAccessPackageError('profile_busy');
        }
    }
    readCurrent() {
        this.assertOpen();
        try {
            const file = path.join(this.root, 'state.json');
            const info = lstatSync(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
                throw new Error();
            return parseState(JSON.parse(readFileSync(file, 'utf8')), this.profileId).state;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return { schemaVersion: 1, profileId: this.profileId, installations: [] };
            throw new ModelAccessPackageError('storage_failed');
        }
    }
    async transaction(run) {
        if (!this.shared)
            return run();
        let compromised = false;
        const release = await lockfile.lock(this.root, {
            realpath: false,
            stale: 30000,
            retries: { retries: 120, factor: 1.1, minTimeout: 5, maxTimeout: 250 },
            onCompromised: () => {
                compromised = true;
            },
        });
        const info = lstatSync(`${this.root}.lock`);
        this.leaseCheck = () => {
            const now = lstatSync(`${this.root}.lock`);
            if (compromised || now.ino !== info.ino || now.dev !== info.dev)
                throw new ModelAccessPackageError('profile_busy');
        };
        try {
            return await run();
        }
        finally {
            this.leaseCheck = undefined;
            await release();
        }
    }
    async read() {
        this.assertOpen();
        try {
            const file = path.join(this.root, 'state.json');
            const stat = await lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
                throw new ModelAccessPackageError('storage_failed');
            const parsed = parseState(JSON.parse(await readFile(file, 'utf8')), this.profileId);
            if (this.shared && parsed.legacySlots.length)
                throw new ModelAccessPackageError('credential_schema_mismatch');
            this.legacy = parsed.legacySlots;
            return parsed.state;
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return { schemaVersion: 1, profileId: this.profileId, installations: [] };
            }
            if (error instanceof ModelAccessPackageError)
                throw error;
            throw new ModelAccessPackageError('storage_failed');
        }
    }
    /** Slots of a dropped pre-release credential state, handed out once for removal. */
    takeLegacySlots() {
        const slots = this.legacy;
        this.legacy = [];
        return slots;
    }
    async write(state, beforeCommit) {
        this.assertOpen();
        const document = persisted(state);
        if (parseState(document, this.profileId).legacySlots.length)
            throw new ModelAccessPackageError('storage_failed');
        const serialized = JSON.stringify(document);
        if (Buffer.byteLength(serialized) > 1024 * 1024)
            throw new ModelAccessPackageError('storage_failed');
        const temporary = path.join(this.root, `state-${randomUUID()}.pending`);
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(serialized);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
        catch {
            throw new ModelAccessPackageError('storage_failed');
        }
        // Last admission check in the host lane; no await before submitting the atomic rename.
        this.leaseCheck?.();
        beforeCommit?.();
        try {
            await rename(temporary, path.join(this.root, 'state.json'));
            // The rename is the commit point. Never report a post-commit cleanup as rollback.
        }
        catch {
            throw new ModelAccessPackageError('storage_failed');
        }
    }
    async hasOtherOwners() {
        if (!this.shared)
            return false;
        const { readdir } = await import('node:fs/promises');
        const directory = path.join(this.root, '.owners');
        for (const name of await readdir(directory)) {
            if (path.join(directory, name) === this.ownerFile)
                continue;
            const pid = Number(name.split('-')[0]);
            if (!Number.isSafeInteger(pid) || pid < 1)
                continue;
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    return true;
            }
        }
        return false;
    }
    async close() {
        const unlock = this.unlock;
        this.unlock = undefined;
        this.opened = false;
        if (this.ownerFile) {
            const { unlink } = await import('node:fs/promises');
            try {
                await unlink(this.ownerFile);
            }
            catch {
                /* Stale marker is harmless; a future owner checks the pid. */
            }
            this.ownerFile = undefined;
        }
        await unlock?.();
    }
    assertOpen() {
        if (!this.opened)
            throw new ModelAccessPackageError('service_closed');
    }
}
//# sourceMappingURL=package-state.repository.js.map