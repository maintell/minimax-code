import { ensureModelAccessPrivateDirectory, writeModelAccessPrivateFile } from './private-file.js';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { digest, identityHash, namespaceHash, ModelAccessCredentialError, parseCredentialState, } from './credential-state.js';
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
/** Profile-owned cleartext records. Bindings and payloads share one atomic commit. */
export class ModelAccessFileRecords {
    root;
    profileId;
    fileRecords = true;
    staged = new Map();
    active = new Map();
    heldWork = new Map();
    constructor(root, profileId) {
        this.root = root;
        this.profileId = profileId;
    }
    file() {
        return path.join(this.root, 'auth.json');
    }
    empty() {
        return { version: 1, profileId: this.profileId, records: {}, versions: {} };
    }
    lastGoodFile() {
        return path.join(this.root, 'auth.lastgood.json');
    }
    /**
     * A crash between rename and data flush can leave auth.json at full length, every byte zero.
     * Such a file is unknown rather than empty: its last good generation is read instead. Files
     * that are unsafe to read (symlink, oversize, readable by others) never fall back.
     */
    document() {
        const primary = this.readDocument(this.file());
        if (primary.kind === 'ok')
            return primary.doc;
        if (primary.kind === 'missing')
            return this.empty();
        if (primary.kind === 'invalid') {
            const fallback = this.readDocument(this.lastGoodFile());
            if (fallback.kind === 'ok')
                return fallback.doc;
        }
        throw new ModelAccessCredentialError('secret_invalid');
    }
    readDocument(file) {
        let text;
        try {
            const st = lstatSync(file);
            if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_AUTH_BYTES)
                return { kind: 'unsafe' };
            if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
                return { kind: 'unsafe' };
            text = readFileSync(file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return { kind: 'missing' };
            return { kind: 'unsafe' };
        }
        try {
            const doc = JSON.parse(text);
            this.validateDocument(doc);
            this.validateRecords(doc);
            return {
                kind: 'ok',
                text,
                doc: {
                    ...doc,
                    records: Object.assign(Object.create(null), doc.records),
                    versions: Object.assign(Object.create(null), doc.versions),
                },
            };
        }
        catch {
            return { kind: 'invalid', text };
        }
    }
    validateDocument(doc) {
        if (doc.version !== 1 || doc.profileId !== this.profileId)
            throw new Error('auth_schema');
        for (const field of [doc.records, doc.versions])
            if (!field || Array.isArray(field) || typeof field !== 'object')
                throw new Error('auth_schema');
        if (Object.values(doc.versions).some((v) => !Number.isSafeInteger(v) || v < 0))
            throw new Error('auth_version');
    }
    validateRecords(doc) {
        for (const [key, entry] of Object.entries(doc.records))
            if (!entry?.binding || key !== entry.binding.providerKey)
                throw new Error('auth_key');
        const state = parseCredentialState({
            version: 2,
            bindings: Object.values(doc.records).map((entry) => entry.binding),
        });
        for (const binding of state.bindings) {
            if (['__proto__', 'constructor', 'prototype'].includes(binding.providerKey) ||
                !Object.hasOwn(doc.records, binding.providerKey))
                throw new Error('auth_key');
            this.validateEntry(doc.records[binding.providerKey], binding);
        }
    }
    validateEntry(entry, binding) {
        const marker = entry.renewalStarted;
        if (marker !== undefined && !/^[a-f0-9]{64}$/u.test(marker))
            throw new Error('auth_renewal');
        if (binding.kind === 'direct-owned') {
            this.validateEnvelope(binding, entry.envelope);
            if (marker !== undefined && marker !== digest(entry.envelope))
                throw new Error('auth_renewal');
        }
    }
    state() {
        return {
            bindings: Object.values(this.document().records).map((entry) => structuredClone(entry.binding)),
        };
    }
    version(key) {
        return this.document().versions[key] ?? 0;
    }
    async initialize() {
        await ensureModelAccessPrivateDirectory(this.root);
    }
    async withKey(key, operation) {
        if (!key || ['__proto__', 'constructor', 'prototype'].includes(key))
            throw new ModelAccessCredentialError('credential_invalid');
        return this.lock(`account-${digest(key)}`, async (assertCurrent) => {
            this.active.set(key, { assertCurrent });
            this.heldWork.set(key, new Set());
            try {
                return await operation();
            }
            finally {
                await Promise.allSettled([...(this.heldWork.get(key) ?? [])]);
                this.staged.delete(key);
                this.heldWork.delete(key);
                this.active.delete(key);
            }
        });
    }
    retain(key, work) {
        this.heldWork.get(key)?.add(work);
    }
    /** Persist before spending a refresh token; only a new credential commit clears uncertainty. */
    async beginRenewal(key, borrowedFingerprint) {
        this.assertAccount(key);
        await this.lock('auth', async (assertCurrent) => {
            const doc = this.document();
            const entry = doc.records[key];
            let fingerprint = borrowedFingerprint;
            if (entry?.binding.kind === 'direct-owned' && entry.envelope)
                fingerprint = digest(entry.envelope);
            if (entry?.binding.kind === 'public')
                fingerprint = undefined;
            if (!entry || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint))
                throw new ModelAccessCredentialError('secret_missing');
            if (entry.renewalStarted === fingerprint)
                throw new Error('renewal_result_uncertain');
            entry.renewalStarted = fingerprint;
            await this.commit(doc, () => {
                assertCurrent();
                this.assertAccount(key);
            }, true);
        });
    }
    async write(slot, envelope) {
        this.assertAccount(slot.providerKey);
        if (Buffer.byteLength(envelope) > 128 * 1024)
            throw new ModelAccessCredentialError('credential_invalid');
        this.staged.set(slot.providerKey, envelope);
    }
    async read(slot) {
        const entry = this.document().records[slot.providerKey];
        if (!entry?.envelope ||
            entry.binding.installationId !== slot.installationId ||
            entry.binding.providerId !== slot.providerId)
            throw new ModelAccessCredentialError('secret_missing');
        return entry.envelope;
    }
    async remove(_slot) {
        /* The record commit, never slot cleanup, owns deletion. */
    }
    async settled() {
        await Promise.allSettled([...this.heldWork.values()].flatMap((set) => [...set]));
    }
    assertAccount(key) {
        const lease = this.active.get(key);
        if (!lease)
            throw new ModelAccessCredentialError('binding_conflict');
        lease.assertCurrent();
    }
    /** Merge exactly the changed keys, checking their expected records under the auth-file lock. */
    async save(before, next, beforeCommit) {
        const old = new Map(before.bindings.map((b) => [b.providerKey, b]));
        const after = new Map(next.bindings.map((b) => [b.providerKey, b]));
        const changed = [...new Set([...old.keys(), ...after.keys()])].filter((key) => JSON.stringify(old.get(key)) !== JSON.stringify(after.get(key)));
        await this.lock('auth', async (assertCurrent) => {
            const doc = this.document();
            for (const key of changed)
                this.applyRecord(doc, key, old.get(key), after.get(key));
            const assertOwners = () => {
                assertCurrent();
                for (const key of changed)
                    if (this.active.has(key))
                        this.assertAccount(key);
                beforeCommit?.();
            };
            assertOwners();
            await this.commit(doc, assertOwners);
        });
    }
    applyRecord(doc, key, previous, binding) {
        if (this.active.has(key))
            this.assertAccount(key);
        if (JSON.stringify(doc.records[key]?.binding) !== JSON.stringify(previous))
            throw new ModelAccessCredentialError('binding_conflict');
        if (!binding) {
            delete doc.records[key];
        }
        else {
            doc.records[key] = this.nextEntry(binding, doc.records[key]);
        }
        doc.versions[key] = (doc.versions[key] ?? 0) + 1;
    }
    nextEntry(binding, previous) {
        const key = binding.providerKey;
        const envelope = binding.kind === 'direct-owned' ? (this.staged.get(key) ?? previous?.envelope) : undefined;
        if (binding.kind === 'direct-owned')
            this.validateEnvelope(binding, envelope);
        const keepMarker = previous?.renewalStarted &&
            binding.kind !== 'public' &&
            !this.staged.has(key) &&
            previous.binding.identityRevision === binding.identityRevision;
        return {
            binding: structuredClone(binding),
            ...(envelope ? { envelope } : {}),
            ...(keepMarker ? { renewalStarted: previous.renewalStarted } : {}),
        };
    }
    /** Migration imports only when no newer file record exists; callers retain old slots on error. */
    async import(binding, envelope) {
        await this.withKey(binding.providerKey, async () => {
            const before = this.state();
            if (before.bindings.some((b) => b.providerKey === binding.providerKey) ||
                this.version(binding.providerKey) > 0)
                return;
            let next = structuredClone(binding);
            if (next.kind === 'direct-owned') {
                delete next.slot;
                if (!envelope)
                    throw new ModelAccessCredentialError('secret_missing');
                this.validateEnvelope(next, envelope);
                next = {
                    ...next,
                    namespaceHash: next.namespaceHash ?? namespaceHash(JSON.parse(envelope).identity),
                };
                this.staged.set(next.providerKey, envelope);
            }
            await this.save(before, { bindings: [...before.bindings, next] });
        });
    }
    validateEnvelope(binding, envelope) {
        try {
            const item = JSON.parse(envelope ?? '');
            if (binding.kind !== 'direct-owned' ||
                identityHash(item.identity) !== binding.identityHash ||
                typeof item.payload !== 'string')
                throw new Error();
        }
        catch {
            throw new ModelAccessCredentialError('secret_invalid');
        }
    }
    /**
     * `markerFirst` writes the new document to lastgood before auth.json, so a crash that zeroes
     * auth.json can never fall back to a generation without the renewal marker.
     */
    async commit(doc, assertCurrent, markerFirst = false) {
        const serialized = JSON.stringify(doc);
        if (Buffer.byteLength(serialized) > MAX_AUTH_BYTES)
            throw new ModelAccessCredentialError('credential_invalid');
        // lastgood is private as well. Only a valid generation becomes lastgood; an unreadable file is
        // kept aside first so the write that replaces it never loses what it held.
        const current = this.readDocument(this.file());
        if (current.kind === 'unsafe')
            throw new ModelAccessCredentialError('secret_invalid');
        if (current.kind === 'invalid')
            await this.atomic(path.join(this.root, `auth.bad-${Date.now()}.json`), current.text, assertCurrent);
        if (markerFirst)
            await this.atomic(this.lastGoodFile(), serialized, assertCurrent);
        else if (current.kind === 'ok')
            await this.atomic(this.lastGoodFile(), current.text, assertCurrent);
        await this.atomic(this.file(), serialized, assertCurrent);
    }
    async atomic(file, text, assertCurrent) {
        await writeModelAccessPrivateFile(file, text, assertCurrent);
    }
    async lock(name, operation) {
        await this.initialize();
        const target = path.join(this.root, `.${name}`);
        try {
            await mkdir(target, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        const targetInfo = lstatSync(target);
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
            throw new ModelAccessCredentialError('secret_store_locked_or_denied');
        let compromised = false;
        const release = await lockfile.lock(target, {
            realpath: false,
            stale: 30000,
            retries: { retries: 120, factor: 1.1, minTimeout: 10, maxTimeout: 250 },
            onCompromised: () => {
                compromised = true;
            },
        });
        const info = lstatSync(`${target}.lock`);
        const assertCurrent = () => {
            const now = lstatSync(`${target}.lock`);
            if (compromised || now.ino !== info.ino || now.dev !== info.dev)
                throw new ModelAccessCredentialError('binding_conflict');
        };
        try {
            return await operation(assertCurrent);
        }
        finally {
            try {
                await release();
            }
            catch {
                /* A compromised owner must not unlink a new owner's lock. */
            }
        }
    }
}
//# sourceMappingURL=file-records.js.map