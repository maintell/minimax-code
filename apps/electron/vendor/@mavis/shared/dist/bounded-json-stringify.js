const DEFAULT_REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_VALUE = '[Circular]';
const LIMIT_EXCEEDED = Symbol('bounded-json-limit-exceeded');
/**
 * Serializes with native JSON semantics while stopping before the emitted UTF-8 JSON can exceed
 * the configured budget. The optional string masker is called only after the raw string itself is
 * known to fit the remaining budget.
 */
export function boundedJsonStringify(value, options) {
    const { maxBytes } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError('maxBytes must be a non-negative safe integer');
    }
    const ancestors = [];
    const emittedValuesByContainer = new WeakMap();
    let isFirstCall = true;
    let measuredBytes = 0;
    const addBytes = (bytes) => {
        if (bytes > maxBytes - measuredBytes)
            throw LIMIT_EXCEEDED;
        measuredBytes += bytes;
    };
    const addJsonString = (text) => {
        addBytes(jsonStringByteLength(text, maxBytes - measuredBytes));
    };
    const addEntryPrefix = (parent, key, isRoot) => {
        if (isRoot)
            return;
        const emitted = emittedValuesByContainer.get(parent) ?? 0;
        if (emitted > 0)
            addBytes(1);
        if (!Array.isArray(parent)) {
            addJsonString(key);
            addBytes(1);
        }
        emittedValuesByContainer.set(parent, emitted + 1);
    };
    try {
        const serialized = JSON.stringify(value, function replacer(key, nested) {
            const isRoot = isFirstCall;
            isFirstCall = false;
            let output = nested;
            let shouldMaskString = false;
            if (!isRoot && options.isSensitiveFieldKey?.(key)) {
                output = options.redactedValue ?? DEFAULT_REDACTED_VALUE;
            }
            else if (typeof output === 'bigint') {
                output = output.toString();
            }
            else if (typeof output === 'string') {
                shouldMaskString = options.maskString !== undefined;
            }
            else if (output && typeof output === 'object') {
                while (ancestors.length > 0 && ancestors.at(-1) !== this)
                    ancestors.pop();
                if (ancestors.includes(output)) {
                    output = CIRCULAR_VALUE;
                }
                else {
                    ancestors.push(output);
                }
            }
            const parentIsArray = !isRoot && Array.isArray(this);
            if (output === undefined || typeof output === 'function' || typeof output === 'symbol') {
                if (isRoot) {
                    addBytes(4);
                }
                else if (parentIsArray) {
                    addEntryPrefix(this, key, false);
                    addBytes(4);
                }
                return output;
            }
            addEntryPrefix(this, key, isRoot);
            if (shouldMaskString && typeof output === 'string') {
                jsonStringByteLength(output, maxBytes - measuredBytes);
                output = options.maskString?.(output) ?? output;
            }
            if (typeof output === 'string') {
                addJsonString(output);
            }
            else if (output === null) {
                addBytes(4);
            }
            else if (typeof output === 'boolean') {
                addBytes(output ? 4 : 5);
            }
            else if (typeof output === 'number') {
                addBytes(Buffer.byteLength(JSON.stringify(output), 'utf8'));
            }
            else if (typeof output === 'object') {
                addBytes(2);
            }
            return output;
        });
        const json = serialized ?? 'null';
        const sizeBytes = Buffer.byteLength(json, 'utf8');
        if (sizeBytes > maxBytes) {
            return { status: 'limit_exceeded', atLeastBytes: maxBytes + 1 };
        }
        return { status: 'success', json, sizeBytes };
    }
    catch (error) {
        if (error === LIMIT_EXCEEDED) {
            return { status: 'limit_exceeded', atLeastBytes: maxBytes + 1 };
        }
        return {
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
}
function jsonStringByteLength(value, maxBytes) {
    let bytes = 2;
    if (bytes > maxBytes)
        throw LIMIT_EXCEEDED;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        let nextBytes;
        if (code === 0x22 || code === 0x5c) {
            nextBytes = 2;
        }
        else if (code <= 0x1f) {
            nextBytes =
                code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
        }
        else if (code <= 0x7f) {
            nextBytes = 1;
        }
        else if (code <= 0x7ff) {
            nextBytes = 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff) {
            const nextCode = value.charCodeAt(index + 1);
            if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
                nextBytes = 4;
                index += 1;
            }
            else {
                nextBytes = 6;
            }
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            nextBytes = 6;
        }
        else {
            nextBytes = 3;
        }
        if (nextBytes > maxBytes - bytes)
            throw LIMIT_EXCEEDED;
        bytes += nextBytes;
    }
    return bytes;
}
//# sourceMappingURL=bounded-json-stringify.js.map