import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safePreviewDiagnosticV1 } from "@mavis/shared/document-preview";
import { noopDocumentPreviewLogger, describeDocumentPreviewError } from "../logging";
/** Production intentionally trusts no managed-component signing keys in this MR. */
export let OFFICE_COMPONENT_RELEASE_CONFIG = null;
// These are hard process-wide ceilings for validating historical signed
// manifests. A valid signature authenticates provenance, not resource size.
export let MAX_COMPONENT_ARCHIVE_BYTES = 512 * 1024 * 1024;
export let MAX_COMPONENT_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
            backendId: 'libreoffice-native',
        },
    };
}
const VALIDATION_DEADLINE_REASON = Symbol('office-component-validation-deadline');
const MANAGER_SHUTDOWN_REASON = Symbol('office-component-manager-shutdown');
class ComponentOperationAbortedError extends Error {
    constructor() {
        super('office component operation aborted');
        this.name = 'ComponentOperationAbortedError';
    }
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw new ComponentOperationAbortedError();
}
async function abortable(operation, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(new ComponentOperationAbortedError()));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(operation).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        if (signal.aborted)
            onAbort();
    });
}
function abortedOperation(signal) {
    return signal.reason === VALIDATION_DEADLINE_REASON
        ? failure('timeout', 'Managed component validation timed out', true)
        : failure('cancelled', 'Managed component validation was cancelled', true);
}
function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new TypeError('manifest contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map((item) => canonical(item)).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
        return `{${entries.join(',')}}`;
    }
    throw new TypeError('manifest contains an unsupported value');
}
export function canonicalizeOfficeComponentManifest(manifest) {
    const unsigned = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'signature'));
    return canonical(unsigned);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function semver(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/u.exec(value);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}
function compareVersion(left, right) {
    const a = semver(left);
    const b = semver(right);
    if (!a || !b)
        return left.localeCompare(right);
    for (let index = 0; index < 3; index += 1) {
        const leftPart = a[index];
        const rightPart = b[index];
        if (leftPart !== rightPart)
            return leftPart - rightPart;
    }
    if (!a[3] && b[3])
        return 1;
    if (a[3] && !b[3])
        return -1;
    return a[3].localeCompare(b[3]);
}
function safeRelative(value) {
    if (!value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value))
        return false;
    const parts = value.split('/');
    return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}
function containedPath(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
}
/**
 * Reject a lexical install path that crosses a symlink/junction at any level.
 * `realpath` proves where the target ends up, but cannot distinguish a
 * trusted directory tree from a redirecting intermediate component that
 * happens to point back inside the tree.
 */
async function walkNoFollow(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!containedPath(resolvedRoot, resolvedCandidate))
        return false;
    try {
        const rootInfo = await lstat(resolvedRoot, { bigint: true });
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
            return false;
        const relative = path.relative(resolvedRoot, resolvedCandidate);
        const parts = relative.split(path.sep);
        let current = resolvedRoot;
        for (let index = 0; index < parts.length; index += 1) {
            current = path.join(current, parts[index]);
            const info = await lstat(current, { bigint: true });
            if (info.isSymbolicLink())
                return false;
            if (index < parts.length - 1 && !info.isDirectory())
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function statIdentityFromStats(stats) {
    const size = Number(stats.size);
    if (stats.dev <= 0n || stats.ino <= 0n || !Number.isSafeInteger(size) || size < 0) {
        return null;
    }
    return { dev: stats.dev.toString(), ino: stats.ino.toString(), size };
}
function sameFileStatIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}
/**
 * Read the active-version pointer as a file capability, not as a pathname.
 * The no-follow descriptor and before/after identity checks reject a symlink
 * or replacement at the pointer itself, while walkNoFollow rejects redirecting
 * parents in the persisted tuple directory.
 */
async function readPersistedPointer(tupleRoot, pointerPath) {
    let handle = null;
    try {
        if (!(await walkNoFollow(tupleRoot, pointerPath)))
            return null;
        const lexicalInfo = await lstat(pointerPath, { bigint: true });
        const lexicalIdentity = statIdentityFromStats(lexicalInfo);
        if (!lexicalInfo.isFile() || lexicalInfo.isSymbolicLink() || !lexicalIdentity)
            return null;
        handle = await open(pointerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const openedInfo = await handle.stat({ bigint: true });
        const openedIdentity = statIdentityFromStats(openedInfo);
        if (!openedInfo.isFile() || openedInfo.isSymbolicLink() || !openedIdentity)
            return null;
        if (!sameFileStatIdentity(lexicalIdentity, openedIdentity))
            return null;
        const content = await handle.readFile('utf8');
        const afterReadInfo = await handle.stat({ bigint: true });
        const afterReadIdentity = statIdentityFromStats(afterReadInfo);
        if (!afterReadIdentity || !sameFileStatIdentity(openedIdentity, afterReadIdentity))
            return null;
        const currentPathInfo = await lstat(pointerPath, { bigint: true });
        const currentPathIdentity = statIdentityFromStats(currentPathInfo);
        if (!currentPathInfo.isFile() ||
            currentPathInfo.isSymbolicLink() ||
            !currentPathIdentity ||
            !sameFileStatIdentity(openedIdentity, currentPathIdentity)) {
            return null;
        }
        return { identity: openedIdentity, content, version: content.trim() };
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function sameEntrypointIdentity(left, right) {
    return sameFileStatIdentity(left, right) && left.sha256 === right.sha256;
}
function parseEntrypointIdentity(value) {
    if (!isRecord(value))
        return null;
    if (typeof value.dev !== 'string' ||
        !/^\d+$/u.test(value.dev) ||
        typeof value.ino !== 'string' ||
        !/^\d+$/u.test(value.ino) ||
        typeof value.size !== 'number' ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.sha256)) {
        return null;
    }
    return { dev: value.dev, ino: value.ino, size: value.size, sha256: value.sha256 };
}
function digestManifest(manifest) {
    return createHash('sha256').update(canonical(manifest), 'utf8').digest('hex');
}
async function digestOpenFile(handle) {
    try {
        const hash = createHash('sha256');
        const stream = createReadStream('', {
            fd: handle.fd,
            autoClose: false,
            start: 0,
            highWaterMark: 1024 * 1024,
        });
        for await (const chunk of stream)
            hash.update(chunk);
        return hash.digest('hex');
    }
    catch {
        return null;
    }
}
/**
 * Validate a persisted entrypoint using a canonical containment check and a
 * no-follow descriptor.  The lstat/open/fstat identity comparison closes the
 * common pathname replacement race before the path is handed to discovery.
 */
async function validateEntrypointPath(rootDir, entrypoint) {
    let handle = null;
    try {
        // Reject a substituted install root before resolving any child path.  A
        // canonical containment check by itself would happily follow a junction
        // introduced between process launches.
        const lexicalRootInfo = await lstat(rootDir, { bigint: true });
        if (!lexicalRootInfo.isDirectory() || lexicalRootInfo.isSymbolicLink())
            return null;
        const canonicalRoot = await realpath(rootDir);
        const rootInfo = await lstat(canonicalRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
            return null;
        const lexical = path.resolve(entrypoint);
        if (!(await walkNoFollow(rootDir, lexical)))
            return null;
        const canonical = await realpath(lexical);
        if (!containedPath(canonicalRoot, canonical))
            return null;
        const lexicalInfo = await lstat(lexical, { bigint: true });
        if (!lexicalInfo.isFile() || lexicalInfo.isSymbolicLink())
            return null;
        const lexicalIdentity = statIdentityFromStats(lexicalInfo);
        if (!lexicalIdentity)
            return null;
        handle = await open(lexical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat({ bigint: true });
        const openedIdentity = statIdentityFromStats(opened);
        if (!opened.isFile() || opened.isSymbolicLink() || !openedIdentity)
            return null;
        if (!sameFileStatIdentity(lexicalIdentity, openedIdentity))
            return null;
        // Compare the canonical target as well; if a parent directory was swapped
        // between lstat and open, the identity no longer matches this target.
        const canonicalInfo = await lstat(canonical, { bigint: true });
        const canonicalIdentity = statIdentityFromStats(canonicalInfo);
        if (!canonicalInfo.isFile() || canonicalInfo.isSymbolicLink() || !canonicalIdentity) {
            return null;
        }
        if (!sameFileStatIdentity(openedIdentity, canonicalIdentity))
            return null;
        const sha256 = await digestOpenFile(handle);
        if (!sha256)
            return null;
        const afterHash = await handle.stat({ bigint: true });
        const afterIdentity = statIdentityFromStats(afterHash);
        if (!afterIdentity || !sameFileStatIdentity(openedIdentity, afterIdentity))
            return null;
        return {
            canonicalPath: canonical,
            identity: { ...openedIdentity, sha256 },
        };
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function validSha(value) {
    return /^[a-f0-9]{64}$/u.test(value);
}
function parseComponent(value) {
    if (!isRecord(value))
        return null;
    const requiredString = (key) => typeof value[key] === 'string' ? value[key] : null;
    const componentId = requiredString('componentId');
    const version = requiredString('version');
    const platform = requiredString('platform');
    const arch = requiredString('arch');
    const url = requiredString('url');
    const sha256 = requiredString('sha256');
    const entrypoint = requiredString('entrypoint');
    const noticePath = requiredString('noticePath');
    const license = requiredString('license');
    const archiveFormat = requiredString('archiveFormat');
    const signature = value.nativeSignature;
    if (componentId !== 'libreoffice-native' ||
        !version ||
        !semver(version) ||
        (platform !== 'darwin' && platform !== 'win32') ||
        (arch !== 'x64' && arch !== 'arm64') ||
        !url?.startsWith('https://') ||
        !sha256 ||
        !validSha(sha256) ||
        !entrypoint ||
        !safeRelative(entrypoint) ||
        !noticePath ||
        !safeRelative(noticePath) ||
        license !== 'MPL-2.0' ||
        archiveFormat !== 'zip' ||
        !isRecord(signature))
        return null;
    const sizeBytes = typeof value.sizeBytes === 'number' ? value.sizeBytes : null;
    const unpackedSizeBytes = typeof value.unpackedSizeBytes === 'number' ? value.unpackedSizeBytes : null;
    const maxArchiveEntries = typeof value.maxArchiveEntries === 'number' ? value.maxArchiveEntries : null;
    if (sizeBytes === null ||
        unpackedSizeBytes === null ||
        maxArchiveEntries === null ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_COMPONENT_ARCHIVE_BYTES ||
        !Number.isSafeInteger(unpackedSizeBytes) ||
        unpackedSizeBytes <= 0 ||
        unpackedSizeBytes > MAX_COMPONENT_UNPACKED_BYTES ||
        !Number.isSafeInteger(maxArchiveEntries) ||
        maxArchiveEntries <= 0 ||
        maxArchiveEntries > 100000)
        return null;
    let nativeSignature;
    if (signature.kind === 'apple-codesign' &&
        typeof signature.teamId === 'string' &&
        signature.teamId.length > 0) {
        nativeSignature = { kind: 'apple-codesign', teamId: signature.teamId };
    }
    else if (signature.kind === 'authenticode' &&
        typeof signature.publisherSha256 === 'string' &&
        validSha(signature.publisherSha256)) {
        nativeSignature = { kind: 'authenticode', publisherSha256: signature.publisherSha256 };
    }
    else
        return null;
    return {
        componentId,
        version,
        platform,
        arch,
        url,
        sha256,
        sizeBytes,
        unpackedSizeBytes,
        maxArchiveEntries,
        archiveFormat,
        entrypoint,
        license,
        noticePath,
        nativeSignature,
    };
}
export function parseOfficeComponentManifest(value) {
    if (!isRecord(value) || value.schema !== 'mavis.office_component_manifest.v1')
        return null;
    const signature = value.signature;
    if (!isRecord(signature) ||
        signature.algorithm !== 'ed25519' ||
        typeof signature.keyId !== 'string' ||
        !signature.keyId ||
        typeof signature.valueBase64 !== 'string' ||
        !signature.valueBase64)
        return null;
    if (!Number.isSafeInteger(value.generatedAtMs) || !Number.isSafeInteger(value.expiresAtMs))
        return null;
    if (!Array.isArray(value.components) ||
        value.components.length === 0 ||
        value.components.length > 64)
        return null;
    const components = value.components.map(parseComponent);
    if (components.some((entry) => entry === null))
        return null;
    const seen = new Set();
    for (const component of components) {
        const key = `${component.componentId}:${component.platform}:${component.arch}:${component.version}`;
        if (seen.has(key))
            return null;
        seen.add(key);
    }
    return {
        schema: 'mavis.office_component_manifest.v1',
        generatedAtMs: value.generatedAtMs,
        expiresAtMs: value.expiresAtMs,
        signature: {
            algorithm: 'ed25519',
            keyId: signature.keyId,
            valueBase64: signature.valueBase64,
        },
        components: components,
    };
}
export function assertOfficeComponentManifest(value) {
    if (!parseOfficeComponentManifest(value)) {
        throw new TypeError('invalid office component manifest');
    }
}
function publicKey(value) {
    if (typeof value !== 'string' && !(value instanceof Uint8Array))
        return value;
    if (typeof value === 'string' && value.includes('BEGIN'))
        return createPublicKey(value);
    const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
    if (bytes.length !== 32)
        throw new TypeError('Ed25519 public key must be 32 bytes');
    // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410).
    return createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
        format: 'der',
        type: 'spki',
    });
}
export function verifyOfficeComponentManifest(manifest, trustedKeys) {
    try {
        const key = trustedKeys[manifest.signature.keyId];
        if (!key)
            return false;
        const signature = Buffer.from(manifest.signature.valueBase64, 'base64');
        if (signature.length !== 64)
            return false;
        return verify(null, Buffer.from(canonicalizeOfficeComponentManifest(manifest), 'utf8'), publicKey(key), signature);
    }
    catch {
        return false;
    }
}
async function defaultProbeEntrypoint(entrypoint, expectedVersion, signal, logger = noopDocumentPreviewLogger) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(false);
            return;
        }
        let output = '';
        const allowedEnvironment = new Set([
            'PATH',
            'HOME',
            'USERPROFILE',
            'TEMP',
            'TMP',
            'TMPDIR',
            'SystemRoot',
            'WINDIR',
            'LANG',
            'LC_ALL',
        ]);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowedEnvironment.has(key) && value));
        const child = spawn(entrypoint, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env,
        });
        const onData = (chunk) => {
            output = `${output}${chunk.toString('utf8')}`.slice(0, 4096);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* noop */
            }
            logger.warn({
                msg: '[DocumentPreview][component-manager] entrypoint version probe timed out',
                check: 'probe',
                entrypoint,
                expectedVersion,
            });
            resolve(false);
        }, 2000);
        const abort = () => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* noop */
            }
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', (error) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            logger.warn({
                msg: '[DocumentPreview][component-manager] entrypoint version probe failed to spawn',
                check: 'probe',
                entrypoint,
                expectedVersion,
                ...describeDocumentPreviewError(error),
            });
            resolve(false);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            const verified = code === 0 && output.includes(expectedVersion);
            if (!verified) {
                logger.warn({
                    msg: '[DocumentPreview][component-manager] entrypoint version probe did not verify',
                    check: 'probe',
                    entrypoint,
                    expectedVersion,
                    exitCode: code,
                });
            }
            resolve(verified);
        });
    });
}
export class OfficeComponentManager {
    constructor(options = {}) {
        this.controllers = new Set();
        this.activeOperations = new Set();
        this.states = new Map();
        this.shuttingDown = false;
        this.log = options.logger ?? noopDocumentPreviewLogger;
        this.rootDir =
            options.rootDir ??
                path.join(options.userDataDir ?? path.join(os.homedir(), '.minimax'), 'document-preview', 'components');
        this.releaseConfig =
            options.releaseConfig === undefined ? OFFICE_COMPONENT_RELEASE_CONFIG : options.releaseConfig;
        this.trustedPublicKeys = options.trustedPublicKeys ?? {};
        this.now = options.now ?? (() => Date.now());
        this.verifyNativeSignature = options.verifyNativeSignature ?? (async () => false);
        this.probeEntrypoint =
            options.probeEntrypoint ??
                ((entrypoint, expectedVersion, signal) => defaultProbeEntrypoint(entrypoint, expectedVersion, signal, this.log));
        this.validationTimeoutMs = Math.max(1000, Math.min(options.validationTimeoutMs ?? 30000, 30000));
    }
    async status(tuple) {
        if (this.shuttingDown)
            return failure('cancelled', 'Managed component status was cancelled', true);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(VALIDATION_DEADLINE_REASON), this.validationTimeoutMs);
        this.controllers.add(controller);
        const operation = (async () => {
            try {
                const key = `${tuple.platform}-${tuple.arch}`;
                const state = this.states.get(key) ?? (await this.loadPersistedState(tuple, controller.signal));
                throwIfAborted(controller.signal);
                if (state && (await this.isInstalled(state, controller.signal))) {
                    return {
                        ok: true,
                        value: {
                            backendId: 'libreoffice-native',
                            availability: 'available',
                            version: state.component.version,
                            platform: tuple.platform,
                            arch: tuple.arch,
                        },
                    };
                }
                return {
                    ok: true,
                    value: {
                        backendId: 'libreoffice-native',
                        availability: 'unavailable',
                        reason: 'managed_component_not_available',
                        platform: tuple.platform,
                        arch: tuple.arch,
                    },
                };
            }
            catch (error) {
                if (controller.signal.aborted)
                    return abortedOperation(controller.signal);
                this.log.error({
                    msg: '[DocumentPreview][component-manager] managed component status check failed',
                    check: 'status',
                    platform: tuple.platform,
                    arch: tuple.arch,
                    ...describeDocumentPreviewError(error),
                });
                return failure('component_unavailable', error instanceof Error ? error.message : 'Managed component status failed', true);
            }
        })();
        this.activeOperations.add(operation);
        try {
            return await operation;
        }
        finally {
            clearTimeout(timeout);
            this.controllers.delete(controller);
            this.activeOperations.delete(operation);
        }
    }
    async resolveEntrypoint(tuple) {
        if (this.shuttingDown)
            return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(VALIDATION_DEADLINE_REASON), this.validationTimeoutMs);
        this.controllers.add(controller);
        const operation = (async () => {
            try {
                const state = this.states.get(`${tuple.platform}-${tuple.arch}`) ??
                    (await this.loadPersistedState(tuple, controller.signal));
                if (!state)
                    return null;
                throwIfAborted(controller.signal);
                const validated = await this.validateInstalledState(state, controller.signal);
                throwIfAborted(controller.signal);
                return validated?.canonicalPath ?? null;
            }
            catch {
                return null;
            }
        })();
        this.activeOperations.add(operation);
        try {
            return await operation;
        }
        finally {
            clearTimeout(timeout);
            this.controllers.delete(controller);
            this.activeOperations.delete(operation);
        }
    }
    async shutdown() {
        this.shuttingDown = true;
        for (const controller of this.controllers)
            controller.abort(MANAGER_SHUTDOWN_REASON);
        const operations = [...this.activeOperations];
        if (operations.length === 0)
            return;
        await Promise.race([
            Promise.allSettled(operations),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    }
    async validateInstalledEntrypoint(state) {
        const validated = await validateEntrypointPath(state.rootDir, state.entrypoint);
        if (!validated)
            return null;
        if (state.entrypointIdentity &&
            !sameEntrypointIdentity(state.entrypointIdentity, validated.identity)) {
            return null;
        }
        return validated;
    }
    /**
     * Validate both the executable capability and the install record that
     * authenticated it.  A regular file at the expected path is not enough:
     * an interrupted install can leave such a file behind, and accepting it
     * would bypass archive/signature/version verification.
     */
    async validateInstalledState(state, signal) {
        throwIfAborted(signal);
        const validated = await this.validateInstalledEntrypoint(state);
        throwIfAborted(signal);
        if (!validated)
            return null;
        try {
            const metadataPath = path.join(state.rootDir, '.component.json');
            const metadataInfo = await lstat(metadataPath, { bigint: true });
            if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink())
                return null;
            const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
            if (metadata.schema !== 'mavis.office_component_install.v2')
                return null;
            const component = parseComponent(metadata.component);
            const persistedIdentity = parseEntrypointIdentity(metadata.entrypointIdentity);
            const manifest = parseOfficeComponentManifest(metadata.manifest);
            if (!component ||
                !persistedIdentity ||
                !manifest ||
                metadata.nativeSignatureVerified !== true ||
                typeof metadata.manifestSha256 !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(metadata.manifestSha256))
                return null;
            const keys = { ...this.trustedPublicKeys, ...(this.releaseConfig?.trustedPublicKeys ?? {}) };
            if (metadata.manifestSha256 !== digestManifest(manifest) ||
                !verifyOfficeComponentManifest(manifest, keys) ||
                manifest.expiresAtMs <= this.now())
                return null;
            const authenticatedComponent = selectComponent(manifest, state.tuple);
            if (!authenticatedComponent)
                return null;
            if (canonical(component) !== canonical(state.component))
                return null;
            if (canonical(authenticatedComponent) !== canonical(state.component))
                return null;
            if (!sameEntrypointIdentity(persistedIdentity, validated.identity))
                return null;
            // Signature verification is intentionally repeated after restart and
            // immediately before exposing the executable capability.  A persisted
            // boolean records what happened at install time; it is not trust by
            // itself.
            const signatureVerified = await abortable(this.verifyNativeSignature(state.rootDir, component, signal), signal);
            throwIfAborted(signal);
            if (!signatureVerified)
                return null;
            return validated;
        }
        catch (error) {
            if (signal.aborted || error instanceof ComponentOperationAbortedError)
                throw error;
            this.log.warn({
                msg: '[DocumentPreview][component-manager] installed component state failed verification',
                check: 'install-record',
                platform: state.tuple.platform,
                arch: state.tuple.arch,
                ...describeDocumentPreviewError(error),
            });
            return null;
        }
    }
    async loadPersistedState(tuple, signal) {
        throwIfAborted(signal);
        const tupleRoot = this.tupleRoot(tuple);
        let pointerSnapshot;
        let version;
        try {
            if (!(await walkNoFollow(this.rootDir, tupleRoot)))
                return null;
            const tupleInfo = await lstat(tupleRoot, { bigint: true });
            if (!tupleInfo.isDirectory() || tupleInfo.isSymbolicLink())
                return null;
            const pointerPath = path.join(tupleRoot, '.current');
            const pointer = await readPersistedPointer(tupleRoot, pointerPath);
            if (!pointer)
                return null;
            pointerSnapshot = pointer;
            version = pointer.version;
        }
        catch (error) {
            if (signal.aborted || error instanceof ComponentOperationAbortedError)
                throw error;
            return null;
        }
        throwIfAborted(signal);
        if (!semver(version))
            return null;
        const versionRoot = path.resolve(tupleRoot, version);
        if (!versionRoot.startsWith(`${path.resolve(tupleRoot)}${path.sep}`))
            return null;
        try {
            if (!(await walkNoFollow(tupleRoot, versionRoot)))
                return null;
            const versionInfo = await lstat(versionRoot, { bigint: true });
            if (!versionInfo.isDirectory() || versionInfo.isSymbolicLink())
                return null;
            const metadataPath = path.join(versionRoot, '.component.json');
            if (!(await walkNoFollow(versionRoot, metadataPath)))
                return null;
            const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
            if (metadata.schema !== 'mavis.office_component_install.v2')
                return null;
            const component = parseComponent(metadata.component);
            const entrypointIdentity = parseEntrypointIdentity(metadata.entrypointIdentity);
            if (!component ||
                !entrypointIdentity ||
                component.platform !== tuple.platform ||
                component.arch !== tuple.arch ||
                component.version !== version)
                return null;
            const entrypoint = path.resolve(versionRoot, component.entrypoint);
            const state = {
                tuple,
                component,
                rootDir: versionRoot,
                entrypoint,
                entrypointIdentity,
            };
            if (!(await this.validateInstalledState(state, signal)))
                return null;
            throwIfAborted(signal);
            // Native-signature validation is asynchronous and may yield long enough
            // for another process to replace `.current`.  Cache only the state named
            // by the exact pointer file and content authenticated at the start.
            const currentPointer = await readPersistedPointer(tupleRoot, path.join(tupleRoot, '.current'));
            if (!currentPointer ||
                !sameFileStatIdentity(currentPointer.identity, pointerSnapshot.identity) ||
                currentPointer.content !== pointerSnapshot.content) {
                return null;
            }
            throwIfAborted(signal);
            const key = `${tuple.platform}-${tuple.arch}`;
            this.states.set(key, state);
            return state;
        }
        catch (error) {
            if (signal.aborted || error instanceof ComponentOperationAbortedError)
                throw error;
            return null;
        }
    }
    async isInstalled(state, signal) {
        return Boolean(await this.validateInstalledState(state, signal));
    }
    tupleRoot(tuple) {
        return path.join(this.rootDir, 'libreoffice-native', `${tuple.platform}-${tuple.arch}`);
    }
}

function selectComponent(manifest, tuple) {
    const matching = manifest.components
        .filter((component) => component.componentId === 'libreoffice-native' &&
        component.platform === tuple.platform &&
        component.arch === tuple.arch)
        .sort((left, right) => compareVersion(right.version, left.version));
    return matching[0] ?? null;
}
