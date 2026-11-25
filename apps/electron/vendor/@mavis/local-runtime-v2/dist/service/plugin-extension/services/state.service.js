import { jsonEqual } from '@mavis/shared/plugin-extension';
import { ExtensionServiceError } from '../errors.js';
import { isJsonObject, toJsonText } from '../json-value.js';
const STATE_KEY = /^[A-Za-z0-9_$.-]{1,128}$/u;
const MAX_STATE_KEYS = 256;
/** two.md §4 leaves the sizes as parameters; these are the phase-one values. */
const STATE_LIMITS = { maxValueBytes: 64 * 1024, maxBucketBytes: 1024 * 1024 };
/**
 * `ctx.state` on the main thread, bucketed by `(pluginId, sessionId)` and never persisted.
 * Buckets survive reloads and Worker rebuilds; each read re-aligns them to the declaration of
 * the reading artifact.
 */
export class ExtensionStateService {
    deps;
    declarations = new Map();
    buckets = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    declare(pluginId, artifactDigest, spec) {
        this.declarations.set(pair(pluginId, artifactDigest), validateStateSpec(spec));
    }
    /** The bucket as the activation's artifact declares it; read between Invocations too. */
    snapshot(origin) {
        const spec = this.specOf(origin);
        const bucket = this.align(origin, spec);
        const values = {};
        for (const [key, field] of Object.entries(spec)) {
            values[key] = structuredClone(bucket.values.get(key) ?? field.default);
        }
        return { values, version: bucket.version };
    }
    async set(callId, key, value) {
        await this.deps.boundary.run({ callId, domain: 'state', method: 'set' }, async (invocation) => {
            if (invocation.kind === 'render') {
                throw new ExtensionServiceError('STATE_WRITE_IN_RENDER', 'state is read-only in render');
            }
            const field = this.specOf(invocation.origin)[key];
            if (!field) {
                throw new ExtensionServiceError('STATE_KEY_UNDECLARED', `state key "${key}" is not declared`);
            }
            if (!sameShape(value, field.default)) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', `state "${key}" does not match its default`);
            }
            if (jsonEqual(this.bucket(invocation.origin).values.get(key) ?? field.default, value))
                return;
            this.write(invocation, key, value);
        });
    }
    deleteSession(sessionId) {
        for (const id of [...this.buckets.keys()]) {
            if (JSON.parse(id)[1] === sessionId)
                this.buckets.delete(id);
        }
    }
    write(invocation, key, value) {
        const bytes = Buffer.byteLength(toJsonText(value, 'state value'), 'utf8');
        const bucket = this.bucket(invocation.origin);
        const total = [...bucket.bytes.values()].reduce((sum, size) => sum + size, 0);
        if (bytes > STATE_LIMITS.maxValueBytes ||
            total - (bucket.bytes.get(key) ?? 0) + bytes > STATE_LIMITS.maxBucketBytes) {
            throw new ExtensionServiceError('ARGUMENT_INVALID', 'state value exceeds the size limit');
        }
        bucket.values.set(key, structuredClone(value));
        bucket.bytes.set(key, bytes);
        bucket.version += 1;
    }
    /** Drops removed keys and values whose shape no longer matches the declared default. */
    align(origin, spec) {
        const bucket = this.bucket(origin);
        for (const [key, value] of [...bucket.values]) {
            const field = spec[key];
            if (field && sameShape(value, field.default))
                continue;
            bucket.values.delete(key);
            bucket.bytes.delete(key);
            if (field) {
                this.deps.diagnose({
                    code: 'EXTENSION_STATE_SHAPE_INVALID',
                    message: `state "${key}" no longer matches its declaration; reset to the default`,
                    pluginId: origin.pluginId,
                    sessionId: origin.sessionId,
                });
            }
        }
        return bucket;
    }
    specOf(origin) {
        const { pluginId, artifactDigest } = origin;
        return this.declarations.get(pair(pluginId, artifactDigest)) ?? {};
    }
    bucket(origin) {
        const id = pair(origin.pluginId, origin.sessionId);
        let bucket = this.buckets.get(id);
        if (!bucket) {
            bucket = { values: new Map(), bytes: new Map(), version: 0 };
            this.buckets.set(id, bucket);
        }
        return bucket;
    }
}
/** Accepts the `defineState` spec (`{ key: { default } }`) with literal JSON defaults. */
function validateStateSpec(spec) {
    const entries = isJsonObject(spec) ? Object.entries(spec) : undefined;
    if (!entries || entries.length > MAX_STATE_KEYS)
        throw invalidSpec('expected an object of fields');
    const result = {};
    for (const [key, field] of entries) {
        if (!STATE_KEY.test(key))
            throw invalidSpec(`invalid key "${key}"`);
        if (!isJsonObject(field) || Object.keys(field).join() !== 'default') {
            throw invalidSpec(`field "${key}" must be { default }`);
        }
        const fallback = field.default;
        try {
            toJsonText(fallback, 'state default');
        }
        catch {
            throw invalidSpec(`default of "${key}" must be plain JSON`);
        }
        if (fallback !== undefined)
            result[key] = Object.freeze({ default: fallback });
    }
    return Object.freeze(result);
}
function invalidSpec(detail) {
    return new ExtensionServiceError('EXTENSION_STATE_SHAPE_INVALID', `defineState: ${detail}`);
}
/** Shape derived from the default: `null` accepts any JSON. */
function sameShape(value, fallback) {
    if (fallback === null)
        return true;
    if (Array.isArray(fallback))
        return Array.isArray(value);
    if (isJsonObject(fallback))
        return isJsonObject(value);
    return typeof value === typeof fallback;
}
function pair(first, second) {
    return JSON.stringify([first, second]);
}
//# sourceMappingURL=state.service.js.map