import { types } from 'node:util';
import { IncrementalSha256 } from './incremental-sha256.js';
const ownedValues = new WeakSet();
const fingerprints = new WeakMap();
/**
 * Detach callback-owned History/event data before it becomes an in-run
 * identity or deferred delivery payload. Unsupported or cyclic values fail
 * closed. The digest is streamed so identity memory does not scale with the
 * encoded payload size. An optional previously owned snapshot lets fresh plain
 * data share unchanged immutable descendants while preserving input aliases.
 */
export function captureSemanticSnapshot(value, previous) {
    // Native cloning preserves external getters and aliases. Data-only wrappers
    // can instead share descendants already detached and frozen by this module.
    const snapshot = typeof value === 'object' && value !== null && ownedValues.has(value)
        ? value
        : freezeSemanticValue(cloneOwnedWrapper(value, previous) ?? structuredClone(value), new WeakSet());
    let fingerprint;
    return {
        value: snapshot,
        // Value-only consumers still validate and detach eagerly, but never encode
        // or hash the history. Only values frozen by this module may be reused.
        get fingerprint() {
            if (fingerprint !== undefined)
                return fingerprint;
            const object = typeof snapshot === 'object' && snapshot !== null ? snapshot : undefined;
            fingerprint = object ? fingerprints.get(object) : undefined;
            if (fingerprint === undefined) {
                const encoder = new SemanticIdentityEncoder(new IncrementalSha256());
                encodeValue(snapshot, new WeakSet(), encoder);
                fingerprint = encoder.digest();
                if (object)
                    fingerprints.set(object, fingerprint);
            }
            return fingerprint;
        },
    };
}
const NATIVE_CLONE_REQUIRED = Symbol('native-clone-required');
const PREVIOUS_SHARING_UNAVAILABLE = Symbol('previous-sharing-unavailable');
function plainDataDescriptors(value) {
    // Inspecting a Proxy would invoke traps that native structuredClone rejects.
    if (types.isProxy(value))
        return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype &&
        prototype !== null &&
        !(Array.isArray(value) && prototype === Array.prototype))
        return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((d) => d.enumerable && !('value' in d)))
        return undefined;
    return descriptors;
}
function isOwnedObject(value) {
    return typeof value === 'object' && value !== null && ownedValues.has(value);
}
function clonePrimitive(value) {
    if (value !== null && !['undefined', 'string', 'boolean', 'number'].includes(typeof value)) {
        throw NATIVE_CLONE_REQUIRED;
    }
    return value;
}
function cloneOwnedWrapper(value, previous) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const descriptors = plainDataDescriptors(value);
    const reusePrevious = isOwnedObject(previous);
    if (!descriptors)
        return undefined;
    if (!reusePrevious &&
        !Object.values(descriptors).some((d) => d.enumerable && isOwnedObject(d.value))) {
        return undefined;
    }
    try {
        return new OwnedWrapperCloner(value, descriptors, reusePrevious).clone(value, previous);
    }
    catch (error) {
        if (error === PREVIOUS_SHARING_UNAVAILABLE)
            return cloneOwnedWrapper(value);
        if (error === NATIVE_CLONE_REQUIRED)
            return undefined;
        throw error;
    }
}
class OwnedWrapperCloner {
    root;
    descriptors;
    reusePrevious;
    copies = new WeakMap();
    previousOwners = new WeakMap();
    constructor(root, descriptors, reusePrevious) {
        this.root = root;
        this.descriptors = descriptors;
        this.reusePrevious = reusePrevious;
    }
    clone(node, prior) {
        if (typeof node !== 'object' || node === null)
            return clonePrimitive(node);
        if (ownedValues.has(node)) {
            // Mixed owned and fresh inputs cannot merge distinct input aliases.
            if (this.reusePrevious)
                throw PREVIOUS_SHARING_UNAVAILABLE;
            return node;
        }
        const existing = this.copies.get(node);
        if (existing)
            return existing;
        const fields = node === this.root ? this.descriptors : plainDataDescriptors(node);
        if (!fields)
            throw NATIVE_CLONE_REQUIRED;
        const copy = Array.isArray(node) ? new Array(fields.length.value) : {};
        this.copies.set(node, copy);
        return this.cloneFields(node, fields, prior, copy);
    }
    candidate(node, prior) {
        if (!this.reusePrevious || !isOwnedObject(prior))
            return undefined;
        if (Array.isArray(prior) !== Array.isArray(node))
            return undefined;
        if (this.previousOwners.has(prior) && this.previousOwners.get(prior) !== node)
            return undefined;
        return prior;
    }
    cloneFields(node, fields, prior, copy) {
        const candidate = this.candidate(node, prior);
        let unchanged = sameOwnedShape(node, fields, candidate);
        for (const [key, field] of Object.entries(fields)) {
            if (!field.enumerable)
                continue;
            const priorChild = candidate && Object.hasOwn(candidate, key) ? candidate[key] : undefined;
            const child = this.clone(field.value, priorChild);
            if (unchanged && !Object.is(child, candidate[key]))
                unchanged = false;
            Object.defineProperty(copy, key, {
                value: child,
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        if (unchanged && candidate) {
            this.previousOwners.set(candidate, node);
            this.copies.set(node, candidate);
            return candidate;
        }
        return copy;
    }
}
function sameOwnedShape(node, fields, candidate) {
    if (!candidate)
        return false;
    const keys = Object.keys(fields).filter((key) => fields[key].enumerable);
    const priorKeys = Object.keys(candidate);
    return (keys.length === priorKeys.length &&
        keys.every((key, index) => key === priorKeys[index]) &&
        (!Array.isArray(node) || node.length === candidate['length']));
}
/**
 * Measures the streamed semantic representation without cloning or building
 * a canonical string. Used only for already-detached replay results.
 */
export function estimateSemanticValueSize(value) {
    const encoder = new SemanticIdentityEncoder();
    encodeValue(value, new WeakSet(), encoder);
    return encoder.byteSize;
}
const SEMANTIC_TAGS = [
    'null',
    'undefined',
    'string',
    'boolean',
    'number',
    'begin',
    'length',
    'end',
    'key',
];
const FRAME_PREFIXES = Object.fromEntries(SEMANTIC_TAGS.map((tag) => [tag, `${tag.length}:${tag}`]));
class SemanticIdentityEncoder {
    hash;
    byteSize = 0;
    constructor(hash) {
        this.hash = hash;
    }
    frame(tag, payload) {
        // Only string values and object/array keys can contain non-ASCII text.
        const payloadBytes = tag === 'string' || tag === 'key' ? Buffer.byteLength(payload) : payload.length;
        const prefix = FRAME_PREFIXES[tag];
        const payloadLength = `${payloadBytes}:`;
        this.byteSize += prefix.length + payloadLength.length + payloadBytes;
        // Tags and length fields are ASCII. Keep the payload in its own update so
        // UTF-8 surrogate handling remains identical at each frame boundary.
        this.hash?.update(`${prefix}${payloadLength}`);
        this.hash?.update(payload);
    }
    digest() {
        if (!this.hash)
            throw new Error('Semantic identity digest was not requested.');
        return this.hash.digestHex();
    }
}
function freezeSemanticValue(value, ancestors) {
    if (typeof value !== 'object' || value === null) {
        if (!['undefined', 'string', 'boolean', 'number'].includes(typeof value) && value !== null) {
            throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
        }
        return value;
    }
    if (ownedValues.has(value))
        return value;
    if (ancestors.has(value))
        throw new TypeError('Cyclic semantic identity values are unsupported.');
    assertSemanticObject(value);
    ancestors.add(value);
    for (const key of Object.keys(value))
        freezeSemanticValue(Reflect.get(value, key), ancestors);
    ancestors.delete(value);
    Object.freeze(value);
    ownedValues.add(value);
    return value;
}
function assertSemanticObject(value) {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Semantic identity values must contain only plain objects and arrays.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
    }
}
function encodeValue(value, ancestors, encoder) {
    if (encodePrimitive(value, encoder))
        return;
    if (typeof value !== 'object' || value === null) {
        throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
    }
    encodeObject(value, ancestors, encoder);
}
function encodePrimitive(value, encoder) {
    if (value === null) {
        encoder.frame('null', '');
        return true;
    }
    switch (typeof value) {
        case 'undefined':
            encoder.frame('undefined', '');
            return true;
        case 'string':
            encoder.frame('string', value);
            return true;
        case 'boolean':
            encoder.frame('boolean', value ? 'true' : 'false');
            return true;
        case 'number':
            encoder.frame('number', encodeNumber(value));
            return true;
        case 'object':
            return false;
        default:
            throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
    }
}
function encodeNumber(value) {
    if (Number.isNaN(value))
        return 'NaN';
    if (value === Number.POSITIVE_INFINITY)
        return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY)
        return '-Infinity';
    return Object.is(value, -0) ? '-0' : String(value);
}
function encodeObject(value, ancestors, encoder) {
    if (ancestors.has(value)) {
        throw new TypeError('Cyclic semantic identity values are unsupported.');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value))
            encodeArray(value, ancestors, encoder);
        else
            encodePlainObject(value, ancestors, encoder);
    }
    finally {
        ancestors.delete(value);
    }
}
function encodeArray(values, ancestors, encoder) {
    if (Object.getOwnPropertySymbols(values).length > 0) {
        throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
    }
    encoder.frame('begin', 'array');
    encoder.frame('length', String(values.length));
    Object.keys(values)
        .sort()
        .forEach((key) => {
        encoder.frame('key', key);
        encodeValue(Reflect.get(values, key), ancestors, encoder);
    });
    encoder.frame('end', 'array');
}
function encodePlainObject(value, ancestors, encoder) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Semantic identity values must contain only plain objects and arrays.');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
    }
    encoder.frame('begin', 'object');
    Object.keys(value)
        .sort()
        .forEach((key) => {
        encoder.frame('key', key);
        encodeValue(Reflect.get(value, key), ancestors, encoder);
    });
    encoder.frame('end', 'object');
}
//# sourceMappingURL=semantic-identity.js.map