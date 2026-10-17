import Handlebars from 'handlebars';
import { PROMPT_REFRESH_INTERVAL_MS } from './contracts.js';
import { computePromptBundleVersion, computePromptCacheId, decryptPromptEnvelope, } from './storage/prompt-crypto.js';
import { PromptConfigError } from './errors.js';
import { createPromptReadContext } from './storage/read-context.js';
import { LocalPromptFileReader } from './storage/prompt-file-reader.js';
import { EncryptedPromptStorage } from './storage/encrypted-prompt-storage.js';
import { assertPromptRelativePath } from './storage/prompt-path.js';
const MAX_PROMPT_FILE_BYTES = 64 * 1024;
const MAX_PROMPT_BUNDLE_BYTES = 512 * 1024;
/** Owns encrypted prompt refresh, persistence, and immutable read-context capture. */
export class PromptConfigService {
    options;
    nowMs;
    refreshIntervalMs;
    refreshPromise;
    refreshAbort;
    refreshTimer;
    nextRefreshDelayMs;
    closed = false;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.refreshIntervalMs = options.refreshIntervalMs ?? PROMPT_REFRESH_INTERVAL_MS;
        this.nextRefreshDelayMs = this.refreshIntervalMs;
    }
    async ready() {
        const auth = this.options.auth.capture();
        await this.options.storage.ensureBuiltin(auth.scopeId, auth.keyVersion);
        this.startRefreshAndSchedule(true);
    }
    async close() {
        this.closed = true;
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.refreshAbort?.abort();
        if (this.refreshPromise) {
            try {
                await this.refreshPromise;
            }
            catch {
                // Refresh is best-effort during shutdown.
            }
        }
    }
    async authContextChanged() {
        this.options.reader.clearCache();
        this.refreshAbort?.abort();
        const auth = this.options.auth.capture();
        const current = await this.options.storage.ensureBuiltin(auth.scopeId, auth.keyVersion);
        if (current.storageMode !== 'encrypted')
            return;
        const context = this.contextFor(current, auth);
        if (!(await this.options.reader.validate(context))) {
            await this.options.storage.activateBuiltin(auth.scopeId, auth.keyVersion, this.nowMs());
        }
    }
    async capture() {
        const auth = this.options.auth.capture();
        const current = await this.options.storage.ensureBuiltin(auth.scopeId, auth.keyVersion);
        return this.contextFor(current, auth);
    }
    async captureBuiltin() {
        const auth = this.options.auth.capture();
        const current = await this.options.storage.captureBuiltin(auth.scopeId, auth.keyVersion);
        return this.contextFor(current, auth);
    }
    refreshIfDue() {
        return this.refresh();
    }
    refresh(force = false) {
        if (this.closed)
            return Promise.resolve({ kind: 'skipped' });
        if (this.refreshPromise)
            return this.refreshPromise;
        const controller = new AbortController();
        this.refreshAbort = controller;
        const operation = this.runRefresh(controller, force);
        this.refreshPromise = operation;
        return operation;
    }
    async runRefresh(controller, force) {
        try {
            return await this.refreshOnce(controller.signal, force);
        }
        finally {
            if (this.refreshAbort === controller)
                this.refreshAbort = undefined;
            if (this.refreshPromise)
                this.refreshPromise = undefined;
        }
    }
    async refreshOnce(signal, force) {
        const attempt = await this.prepareRefresh(force);
        if ('result' in attempt)
            return attempt.result;
        return this.fetchAndApply(attempt.auth, attempt.etag, signal);
    }
    async prepareRefresh(force) {
        const auth = this.options.auth.capture();
        const now = this.nowMs();
        const current = await this.options.storage.ensureBuiltin(auth.scopeId, auth.keyVersion);
        const checkedAgeMs = current.lastCheckedAtMs === undefined ? undefined : now - current.lastCheckedAtMs;
        if (!force && checkedAgeMs !== undefined && checkedAgeMs < this.refreshIntervalMs) {
            this.nextRefreshDelayMs = Math.max(1, this.refreshIntervalMs - checkedAgeMs);
            return { result: { kind: 'skipped' } };
        }
        this.nextRefreshDelayMs = this.refreshIntervalMs;
        const context = this.contextFor(current, auth);
        const remoteIsUsable = current.storageMode === 'encrypted' && (await this.options.reader.validate(context));
        if (current.storageMode === 'encrypted' && !remoteIsUsable) {
            await this.options.storage.activateBuiltin(auth.scopeId, auth.keyVersion, now);
        }
        const etag = remoteIsUsable ? current.version : undefined;
        return { auth, ...(etag ? { etag } : {}) };
    }
    async fetchAndApply(auth, etag, signal) {
        let result;
        try {
            result = await this.options.client.fetch({ auth, ...(etag ? { etag } : {}), signal });
        }
        catch {
            return this.finishFailedRefresh(auth);
        }
        if (!this.sameAuth(auth)) {
            await this.activateBuiltinForCurrentAuth();
            return { kind: 'stale' };
        }
        return this.applyFetchResult(result, auth);
    }
    async applyFetchResult(result, auth) {
        if (result.kind === 'not_modified') {
            await this.options.storage.markChecked(auth.scopeId, this.nowMs());
            return { kind: 'not_modified' };
        }
        if (result.kind === 'disabled') {
            await this.options.storage.activateBuiltin(auth.scopeId, auth.keyVersion, this.nowMs());
            return { kind: 'disabled' };
        }
        return this.applyUpdatedBundle(result, auth);
    }
    async applyUpdatedBundle(result, auth) {
        try {
            this.validateBundle(result.bundle, auth);
            if (!this.sameAuth(auth)) {
                await this.activateBuiltinForCurrentAuth();
                return { kind: 'stale' };
            }
            await this.options.storage.persistEncrypted({
                scopeId: auth.scopeId,
                bundle: result.bundle,
                cacheId: computePromptCacheId(result.bundle),
                rawPayload: result.rawPayload,
                nowMs: this.nowMs(),
                canActivate: () => this.sameAuth(auth),
            });
            if (!this.sameAuth(auth)) {
                await this.activateBuiltinForCurrentAuth();
                return { kind: 'stale' };
            }
            return { kind: 'updated' };
        }
        catch (error) {
            if (error instanceof PromptConfigError) {
                return this.finishInvalidBundleRefresh(auth);
            }
            return this.finishFailedRefresh(auth);
        }
    }
    /** A rejected control-plane bundle must not leave a broken remote pointer active. */
    async finishInvalidBundleRefresh(auth) {
        if (this.sameAuth(auth)) {
            await this.options.storage.activateBuiltin(auth.scopeId, auth.keyVersion, this.nowMs());
            return { kind: 'failed' };
        }
        await this.activateBuiltinForCurrentAuth();
        return { kind: 'stale' };
    }
    async finishFailedRefresh(auth) {
        if (this.sameAuth(auth)) {
            await this.options.storage.markChecked(auth.scopeId, this.nowMs());
            return { kind: 'failed' };
        }
        await this.activateBuiltinForCurrentAuth();
        return { kind: 'stale' };
    }
    validateBundle(bundle, auth) {
        if (bundle.algorithm !== 'AES-256-GCM' || bundle.keyVersion !== auth.keyVersion) {
            throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt bundle metadata is invalid');
        }
        if (bundle.files.length === 0) {
            throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt bundle is empty');
        }
        const paths = new Set();
        const caseInsensitivePaths = new Set();
        const plaintext = new Map();
        const key = this.options.keys.resolve(auth);
        let totalBytes = 0;
        for (const file of bundle.files) {
            this.registerBundlePath(file, bundle.version, paths, caseInsensitivePaths);
            const content = this.decryptBundleFile(file, key, auth.subject);
            validatePromptTemplate(content);
            const bytes = Buffer.byteLength(content, 'utf8');
            totalBytes += bytes;
            if (totalBytes > MAX_PROMPT_BUNDLE_BYTES) {
                throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt bundle size is invalid');
            }
            plaintext.set(file.path, content);
        }
        for (const allowedPath of this.options.allowedPaths) {
            if (!paths.has(allowedPath)) {
                throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt bundle key set is incomplete');
            }
        }
        if (computePromptBundleVersion(plaintext) !== bundle.version) {
            throw new PromptConfigError('PROMPT_VERSION_INVALID', 'Prompt bundle version is invalid');
        }
    }
    registerBundlePath(file, bundleVersion, paths, caseInsensitivePaths) {
        assertPromptRelativePath(file.path);
        const caseInsensitivePath = file.path.toLowerCase();
        if (file.version !== bundleVersion ||
            paths.has(file.path) ||
            caseInsensitivePaths.has(caseInsensitivePath)) {
            throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt bundle paths are invalid');
        }
        paths.add(file.path);
        caseInsensitivePaths.add(caseInsensitivePath);
    }
    decryptBundleFile(file, key, subject) {
        const content = decryptPromptEnvelope(file, { key, subject });
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_PROMPT_FILE_BYTES) {
            throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt file size is invalid');
        }
        return content;
    }
    contextFor(pointer, auth) {
        const key = pointer.storageMode === 'encrypted' ? this.options.keys.resolve(auth) : undefined;
        return createPromptReadContext({ ...pointer, scopeId: auth.scopeId, subject: auth.subject }, key);
    }
    sameAuth(snapshot) {
        const current = this.options.auth.capture();
        return (current.scopeId === snapshot.scopeId &&
            current.subject === snapshot.subject &&
            current.keyVersion === snapshot.keyVersion &&
            current.generation === snapshot.generation);
    }
    async activateBuiltinForCurrentAuth() {
        const auth = this.options.auth.capture();
        await this.options.storage.ensureBuiltin(auth.scopeId, auth.keyVersion);
        await this.options.storage.activateBuiltin(auth.scopeId, auth.keyVersion, this.nowMs());
    }
    scheduleNext() {
        if (this.closed || this.refreshTimer)
            return;
        const timer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.startRefreshAndSchedule();
        }, this.nextRefreshDelayMs);
        timer.unref?.();
        this.refreshTimer = timer;
    }
    startRefreshAndSchedule(force = false) {
        queueMicrotask(() => void this.refreshAndSchedule(force));
    }
    async refreshAndSchedule(force) {
        try {
            await this.refresh(force);
        }
        catch {
            // Periodic refresh is best-effort; the active pointer stays authoritative.
        }
        finally {
            this.scheduleNext();
        }
    }
}
function validatePromptTemplate(content) {
    try {
        Handlebars.precompile(content);
    }
    catch {
        throw new PromptConfigError('PROMPT_BUNDLE_INVALID', 'Prompt template syntax is invalid');
    }
}
//# sourceMappingURL=prompt-config.service.js.map