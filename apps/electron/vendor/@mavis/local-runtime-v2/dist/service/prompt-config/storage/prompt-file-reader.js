import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptPromptEnvelope, promptCiphertextDigest } from './prompt-crypto.js';
import { PromptSnapshotInvalidError } from '../errors.js';
import { keyForPromptReadContext } from './read-context.js';
import { assertPromptRelativePath, promptPathWithin } from './prompt-path.js';
/** Reads either package files or encrypted version files without materializing plaintext on disk. */
export class LocalPromptFileReader {
    manifestCache = new Map();
    plaintextCache = new Map();
    maxCachedFiles;
    constructor(options = {}) {
        this.maxCachedFiles = options.maxCachedFiles ?? 128;
    }
    async read(context, relativePath) {
        assertPromptRelativePath(relativePath);
        if (context.storageMode !== 'encrypted') {
            return readOptionalFile(promptPathWithin(context.directory, relativePath));
        }
        const cacheKey = `${context.scopeId}\0${context.cacheId}\0${relativePath}`;
        const cached = this.plaintextCache.get(cacheKey);
        if (cached !== undefined)
            return cached;
        try {
            const manifest = await this.readManifest(context);
            const entry = manifest.files.find((file) => file.path === relativePath);
            // Catalog locale and mode resolution probes optional fallback paths.
            // Bundle completeness is checked before activation; this reader only
            // reports that this optional lookup has no remote value.
            if (!entry)
                return undefined;
            const envelopePath = promptPathWithin(context.directory, entry.envelope_path);
            const envelope = parseEnvelope(await readFile(envelopePath, 'utf8'));
            if (envelope.path !== relativePath ||
                envelope.version !== context.version ||
                promptCiphertextDigest(envelope.ciphertext) !== entry.ciphertext_sha256) {
                throw new PromptSnapshotInvalidError('Prompt envelope does not match its manifest');
            }
            const key = keyForPromptReadContext(context);
            if (!key)
                throw new PromptSnapshotInvalidError('Prompt snapshot key is unavailable');
            const content = decryptPromptEnvelope(envelope, { key, subject: context.subject });
            this.cache(cacheKey, content);
            return content;
        }
        catch (error) {
            if (error instanceof PromptSnapshotInvalidError)
                throw error;
            throw new PromptSnapshotInvalidError('Prompt encrypted file cannot be read');
        }
    }
    async validate(context) {
        if (context.storageMode !== 'encrypted')
            return true;
        try {
            const manifest = await this.readManifest(context);
            if (manifest.files.length === 0) {
                throw new PromptSnapshotInvalidError('Prompt manifest is empty');
            }
            for (const file of manifest.files)
                await this.read(context, file.path);
            return true;
        }
        catch {
            return false;
        }
    }
    clearCache() {
        this.manifestCache.clear();
        this.plaintextCache.clear();
    }
    async readManifest(context) {
        const cached = this.manifestCache.get(context.directory);
        if (cached)
            return cached;
        let parsed;
        try {
            parsed = JSON.parse(await readFile(join(context.directory, 'manifest.json'), 'utf8'));
        }
        catch {
            throw new PromptSnapshotInvalidError('Prompt manifest cannot be read');
        }
        const manifest = parseManifest(parsed);
        if (!manifest ||
            manifest.version !== context.version ||
            manifest.cache_id !== context.cacheId ||
            manifest.key_version !== context.keyVersion) {
            throw new PromptSnapshotInvalidError('Prompt manifest does not match its context');
        }
        this.manifestCache.set(context.directory, manifest);
        return manifest;
    }
    cache(key, content) {
        this.plaintextCache.delete(key);
        this.plaintextCache.set(key, content);
        while (this.plaintextCache.size > this.maxCachedFiles) {
            const oldest = this.plaintextCache.keys().next().value;
            if (oldest === undefined)
                return;
            this.plaintextCache.delete(oldest);
        }
    }
}
async function readOptionalFile(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
function parseManifest(value) {
    const header = parseManifestHeader(value);
    if (!header)
        return undefined;
    const files = header.files.map(parseManifestFile);
    if (files.some((file) => file === undefined))
        return undefined;
    return {
        version: header.version,
        cache_id: header.cacheId,
        storage_mode: 'encrypted',
        key_version: header.keyVersion,
        files: files,
    };
}
function parseManifestHeader(value) {
    if (!isRecord(value) || value.storage_mode !== 'encrypted' || !Array.isArray(value.files)) {
        return undefined;
    }
    if (typeof value.version !== 'string' ||
        typeof value.cache_id !== 'string' ||
        typeof value.key_version !== 'string') {
        return undefined;
    }
    return {
        version: value.version,
        cacheId: value.cache_id,
        keyVersion: value.key_version,
        files: value.files,
    };
}
function parseManifestFile(value) {
    if (!isRecord(value) ||
        typeof value.path !== 'string' ||
        typeof value.envelope_path !== 'string' ||
        typeof value.ciphertext_sha256 !== 'string') {
        return undefined;
    }
    try {
        assertPromptRelativePath(value.path);
        assertPromptRelativePath(value.envelope_path);
    }
    catch {
        return undefined;
    }
    return {
        path: value.path,
        envelope_path: value.envelope_path,
        ciphertext_sha256: value.ciphertext_sha256,
    };
}
function parseEnvelope(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new PromptSnapshotInvalidError('Prompt envelope cannot be parsed');
    }
    if (!isRecord(parsed) ||
        parsed.algorithm !== 'AES-256-GCM' ||
        typeof parsed.version !== 'string' ||
        typeof parsed.path !== 'string' ||
        typeof parsed.nonce !== 'string' ||
        typeof parsed.ciphertext !== 'string') {
        throw new PromptSnapshotInvalidError('Prompt envelope is invalid');
    }
    return {
        algorithm: 'AES-256-GCM',
        version: parsed.version,
        path: parsed.path,
        nonce: parsed.nonce,
        ciphertext: parsed.ciphertext,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=prompt-file-reader.js.map