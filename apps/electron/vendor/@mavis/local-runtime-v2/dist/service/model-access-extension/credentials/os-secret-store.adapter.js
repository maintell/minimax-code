import { createRequire } from 'node:module';
import { digest, MAX_SECRET_BYTES, ModelAccessCredentialError, SECRET_CHUNK_BYTES, } from './credential-state.js';
// Native calls can outlive a timeout and a service instance. Do not race cleanup with a late write.
const inProgress = new Map();
const MAX_CHUNKS = MAX_SECRET_BYTES / SECRET_CHUNK_BYTES;
function loadNativeKeyring() {
    try {
        return createRequire(import.meta.url)('@napi-rs/keyring');
    }
    catch {
        throw new ModelAccessCredentialError('secret_store_unavailable');
    }
}
function captureSlot(value) {
    const ok = !!value &&
        typeof value === 'object' &&
        [value.installationId, value.providerId, value.providerKey].every((part) => typeof part === 'string' && part.length > 0 && part.length <= 256) &&
        (value.slot === 'A' || value.slot === 'B');
    if (!ok)
        throw new ModelAccessCredentialError('credential_invalid');
    return Object.freeze({
        installationId: value.installationId,
        providerId: value.providerId,
        providerKey: value.providerKey,
        slot: value.slot,
    });
}
/**
 * Fixed A/B slots per providerKey. Chunk 0 is a header `{bytes, chunks, digest}`; the payload
 * follows in chunks 1..n. A write overwrites the slot (a stale slot from a crash included); a
 * read verifies the digest, so a torn write is `secret_invalid`, never a wrong credential.
 * No file, argv, environment or kernel-keyring fallback; no enumeration of other credentials.
 */
export class OsModelAccessSecretStore {
    load;
    timeoutMs;
    native;
    service;
    constructor(profileId, load = loadNativeKeyring, timeoutMs = 30_000) {
        this.load = load;
        this.timeoutMs = timeoutMs;
        if (!profileId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            throw new ModelAccessCredentialError('credential_invalid');
        this.service = `com.minimax.mcode.model-access.v2.${digest(profileId)}`;
    }
    async write(input, payload) {
        const slot = captureSlot(input);
        const bytes = Buffer.from(payload, 'utf8');
        if (!bytes.length || bytes.length > MAX_SECRET_BYTES) {
            bytes.fill(0);
            throw new ModelAccessCredentialError('credential_invalid');
        }
        await this.run(this.key(slot), () => this.writeChunks(slot, bytes, payload));
    }
    async writeChunks(slot, bytes, payload) {
        try {
            const chunks = Math.ceil(bytes.length / SECRET_CHUNK_BYTES);
            const previous = await this.header(slot);
            for (let index = 0; index < chunks; index++)
                await this.access(() => this.entry(slot, index + 1).setSecret(bytes.subarray(index * SECRET_CHUNK_BYTES, (index + 1) * SECRET_CHUNK_BYTES)));
            const header = JSON.stringify({ bytes: bytes.length, chunks, digest: digest(bytes) });
            await this.access(() => this.entry(slot, 0).setSecret(Buffer.from(header, 'utf8')));
            // Chunks a longer earlier payload left behind are removed after the header moved on.
            for (let index = chunks + 1; index <= (previous?.chunks ?? 0); index++)
                await this.deleteQuietly(this.entry(slot, index));
            if ((await this.readChunks(slot)) !== payload)
                throw new ModelAccessCredentialError('secret_invalid');
        }
        finally {
            bytes.fill(0);
        }
    }
    async read(input) {
        const slot = captureSlot(input);
        return this.run(this.key(slot), () => this.readChunks(slot), 'read');
    }
    async header(slot) {
        const value = await this.access(() => this.entry(slot, 0).getSecret());
        if (value === null)
            return undefined;
        try {
            const parsed = JSON.parse(Buffer.from(value).toString('utf8'));
            const { bytes, chunks } = parsed;
            if (!Number.isSafeInteger(bytes) ||
                !Number.isSafeInteger(chunks) ||
                chunks < 1 ||
                chunks > MAX_CHUNKS ||
                typeof parsed.digest !== 'string')
                throw new Error();
            return { bytes: bytes, chunks: chunks, digest: parsed.digest };
        }
        catch {
            throw new ModelAccessCredentialError('secret_invalid');
        }
        finally {
            value.fill(0);
        }
    }
    async readChunks(slot) {
        const header = await this.header(slot);
        if (!header)
            throw new ModelAccessCredentialError('secret_missing');
        const parts = [];
        try {
            for (let index = 1; index <= header.chunks; index++) {
                const value = await this.access(() => this.entry(slot, index).getSecret());
                if (value === null)
                    throw new ModelAccessCredentialError('secret_invalid');
                parts.push(Buffer.from(value));
                value.fill(0);
            }
            const bytes = Buffer.concat(parts);
            try {
                if (bytes.length !== header.bytes || digest(bytes) !== header.digest)
                    throw new ModelAccessCredentialError('secret_invalid');
                return bytes.toString('utf8');
            }
            finally {
                bytes.fill(0);
            }
        }
        finally {
            for (const part of parts)
                part.fill(0);
        }
    }
    async remove(input) {
        const slot = captureSlot(input);
        await this.run(this.key(slot), async () => {
            let header;
            try {
                header = await this.header(slot);
            }
            catch (error) {
                // A torn header still names nothing usable: delete every possible chunk. A store that
                // cannot be reached is reported, so the caller can log the retained slot.
                if (!(error instanceof ModelAccessCredentialError) || error.code !== 'secret_invalid')
                    throw error;
                header = { chunks: MAX_CHUNKS };
            }
            await this.deleteQuietly(this.entry(slot, 0));
            for (let index = 1; index <= (header?.chunks ?? 0); index++)
                await this.deleteQuietly(this.entry(slot, index));
        });
    }
    /** Removes the chunks of a pre-release (schema 1) slot; best effort, never throws. */
    async removeLegacy(slot) {
        const service = this.service.replace('.v2.', '.v1.');
        for (let index = 0; index < slot.chunks; index++) {
            const account = digest(JSON.stringify([slot.installationId, slot.providerId, slot.bindingRef, slot.slotId, index]));
            try {
                this.native ??= this.load();
                await new this.native.AsyncEntry(service, account, {
                    linux: { store: 'secret-service' },
                }).deleteCredential();
            }
            catch {
                /* Best effort: an unreachable store keeps the orphan, never the state. */
            }
        }
    }
    async settled() {
        const pending = [...inProgress.entries()]
            .filter(([key]) => key.startsWith(`${this.service}/`))
            .map(([, value]) => value.promise);
        await Promise.allSettled(pending);
    }
    key(slot) {
        return `${this.service}/${digest(JSON.stringify([slot.installationId, slot.providerId, slot.providerKey, slot.slot]))}`;
    }
    /**
     * One native mutation per slot at a time (concurrent reads share one native read); the host
     * already serializes writes per key. A timed-out call keeps the slot busy until it settles.
     */
    async run(key, operation, kind = 'mutation') {
        const existing = inProgress.get(key);
        if (existing && (existing.kind !== 'read' || kind !== 'read'))
            throw new ModelAccessCredentialError('secret_store_busy');
        const running = existing
            ? existing.promise
            : (async () => {
                await Promise.resolve();
                try {
                    return await operation();
                }
                finally {
                    inProgress.delete(key);
                }
            })();
        if (!existing)
            inProgress.set(key, { kind, promise: running });
        let timer;
        try {
            return await Promise.race([
                running,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new ModelAccessCredentialError('secret_store_timeout')), this.timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    entry(slot, index) {
        this.native ??= this.load();
        const account = digest(JSON.stringify([slot.installationId, slot.providerId, slot.providerKey, slot.slot, index]));
        try {
            return new this.native.AsyncEntry(this.service, account, {
                linux: { store: 'secret-service' },
            });
        }
        catch {
            throw new ModelAccessCredentialError('secret_store_unavailable');
        }
    }
    async deleteQuietly(entry) {
        try {
            await entry.deleteCredential();
        }
        catch {
            /* A missing or unreachable chunk is left; the header no longer names it. */
        }
    }
    async access(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof ModelAccessCredentialError)
                throw error;
            // Native errors can contain private paths or payloads. Do not attach a cause.
            throw new ModelAccessCredentialError('secret_store_locked_or_denied');
        }
    }
}
//# sourceMappingURL=os-secret-store.adapter.js.map