import { safeStorage } from "electron";
import electronStore from "electron-store";
import { isSafeSshCredentialId } from "./config.js";
// OpenSSH askpass reads at most 1024 bytes, including the terminating newline.
const MAX_PASSWORD_BYTES = 1023;
const MAX_CIPHERTEXT_LENGTH = 16384;
export class SshCredentialError extends Error {
    constructor(code, cause) {
        super(code === 'credential_unavailable'
            ? 'The SSH password is unavailable.'
            : 'The encrypted SSH credential store is unavailable.');
        this.code = code;
        this.cause = cause;
        this.name = 'SshCredentialError';
    }
}

export function isValidSshPassword(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        !/[\r\n\u0000]/u.test(value) &&
        Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES);
}
/** Main/profile-owned memory with optional OS-encrypted persistence. */
export class SshCredentials {
    constructor(createStore, encryption) {
        this.createStore = createStore;
        this.encryption = encryption;
        this.memory = new Map();
        this.persisted = new Set();
    }
    stage(id, password) {
        requireCredentialId(id);
        if (!isValidSshPassword(password))
            throw new SshCredentialError('credential_unavailable');
        this.memory.set(id, password);
    }
    save(id) {
        requireCredentialId(id);
        const password = this.memory.get(id);
        if (password === undefined)
            throw new SshCredentialError('credential_unavailable');
        let store;
        try {
            this.requireEncryption();
            store = this.getStore();
            const ciphertext = this.encryption.encryptString(password).toString('base64');
            store.set(id, ciphertext);
            this.persisted.add(id);
        }
        catch (error) {
            this.memory.delete(id);
            this.persisted.delete(id);
            try {
                store?.delete(id);
            }
            catch (cleanupError) {
                throw new SshCredentialError('credential_storage_unavailable', {
                    errors: [error, cleanupError],
                    message: 'SSH credential save and cleanup failed',
                });
            }
            throw new SshCredentialError('credential_storage_unavailable', error);
        }
    }
    get(id) {
        requireCredentialId(id);
        const staged = this.memory.get(id);
        if (staged !== undefined)
            return staged;
        try {
            const ciphertext = this.getStore().get(id);
            if (ciphertext === undefined)
                return undefined;
            this.requireEncryption();
            if (typeof ciphertext !== 'string' ||
                ciphertext.length === 0 ||
                ciphertext.length > MAX_CIPHERTEXT_LENGTH ||
                !/^[A-Za-z0-9+/]+={0,2}$/u.test(ciphertext)) {
                throw new SshCredentialError('credential_storage_unavailable');
            }
            const password = this.encryption.decryptString(Buffer.from(ciphertext, 'base64'));
            if (!isValidSshPassword(password))
                throw new SshCredentialError('credential_storage_unavailable');
            this.memory.set(id, password);
            this.persisted.add(id);
            return password;
        }
        catch (error) {
            throw new SshCredentialError('credential_storage_unavailable', error);
        }
    }
    remove(id, commit) {
        requireCredentialId(id);
        const password = this.memory.get(id);
        let store;
        let ciphertext;
        try {
            // A newly staged, unremembered password has never touched disk.
            if (password === undefined || this.persisted.has(id)) {
                store = this.getStore();
                ciphertext = store.get(id);
                store.delete(id);
            }
        }
        catch (error) {
            // A store write may fail after replacing the file. Restore before reporting failure.
            try {
                if (typeof ciphertext === 'string')
                    store?.set(id, ciphertext);
            }
            catch (rollbackError) {
                throw new SshCredentialError('credential_storage_unavailable', {
                    errors: [error, rollbackError],
                    message: 'SSH credential removal rollback failed',
                });
            }
            throw new SshCredentialError('credential_storage_unavailable', error);
        }
        try {
            commit?.();
        }
        catch (error) {
            try {
                if (typeof ciphertext === 'string')
                    store?.set(id, ciphertext);
            }
            catch (rollbackError) {
                throw new SshCredentialError('credential_storage_unavailable', {
                    errors: [error, rollbackError],
                    message: 'SSH credential removal rollback failed',
                });
            }
            throw error;
        }
        this.memory.delete(id);
        this.persisted.delete(id);
    }
    getStore() {
        return (this.store ?? (this.store = this.createStore()));
    }
    requireEncryption() {
        if (!this.encryption.isEncryptionAvailable() ||
            this.encryption.getSelectedStorageBackend?.() === 'basic_text') {
            throw new SshCredentialError('credential_storage_unavailable');
        }
    }
}

function requireCredentialId(id) {
    if (!isSafeSshCredentialId(id))
        throw new SshCredentialError('credential_unavailable');
}
let instance;
function getInstance() {
    return (instance ?? (instance = new SshCredentials(() => new electronStore({ name: 'ssh-credentials' }), {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        ...(process.platform === 'linux'
            ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() }
            : {}),
        encryptString: (value) => safeStorage.encryptString(value),
        decryptString: (value) => safeStorage.decryptString(value),
    })));
}
/** Import-safe: neither Electron Store nor safeStorage is accessed before first use. */
export let sshCredentials = {
    stage: (id, password) => getInstance().stage(id, password),
    save: (id) => getInstance().save(id),
    get: (id) => getInstance().get(id),
    remove: (id, commit) => getInstance().remove(id, commit),
};
