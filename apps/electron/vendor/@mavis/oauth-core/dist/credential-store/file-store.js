import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWritePrivateFile, ensurePrivateDirectory } from '../fs/atomic-write.js';
import { CredentialRecordCorruptError, CredentialStorePermissionError, parseStoredCredential, } from './types.js';
const FILE_SCHEMA_VERSION = 1;
function recordKey(key) {
    return `${key.service}\0${key.account}`;
}
function parsePayload(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CredentialRecordCorruptError();
    }
    const payload = value;
    if (payload.schemaVersion !== FILE_SCHEMA_VERSION ||
        typeof payload.records !== 'object' ||
        payload.records === null ||
        Array.isArray(payload.records)) {
        throw new CredentialRecordCorruptError();
    }
    const records = Object.fromEntries(Object.entries(payload.records).map(([key, credential]) => [
        key,
        parseStoredCredential(credential),
    ]));
    return { schemaVersion: FILE_SCHEMA_VERSION, records };
}
export class FileStore {
    kind = 'file';
    authHome;
    path;
    constructor(options) {
        this.authHome = options.authHome;
        this.path = join(options.authHome, 'auth.json');
    }
    async get(key) {
        const payload = await this.readPayload();
        return payload.records[recordKey(key)] ?? null;
    }
    async put(key, credential) {
        const payload = await this.readPayload();
        payload.records[recordKey(key)] = parseStoredCredential(credential);
        await this.writePayload(payload);
    }
    async delete(key) {
        const payload = await this.readPayload();
        delete payload.records[recordKey(key)];
        await this.writePayload(payload);
    }
    async healthCheck() {
        await ensurePrivateDirectory(this.authHome);
        await this.assertPrivatePermissions();
    }
    async readPayload() {
        let raw;
        try {
            await this.assertPrivatePermissions();
            raw = await readFile(this.path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { schemaVersion: FILE_SCHEMA_VERSION, records: {} };
            }
            throw error;
        }
        try {
            return parsePayload(JSON.parse(raw));
        }
        catch (error) {
            if (error instanceof CredentialRecordCorruptError)
                throw error;
            throw new CredentialRecordCorruptError();
        }
    }
    async assertPrivatePermissions() {
        if (process.platform === 'win32')
            return;
        try {
            const [directory, file] = await Promise.all([stat(this.authHome), stat(this.path)]);
            if ((directory.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0) {
                throw new CredentialStorePermissionError();
            }
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
    }
    async writePayload(payload) {
        const validated = parsePayload(payload);
        await atomicWritePrivateFile(this.path, `${JSON.stringify(validated, null, 2)}\n`);
    }
}
//# sourceMappingURL=file-store.js.map