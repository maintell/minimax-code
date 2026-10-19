export class HttpStatusError extends Error {
    status;
    route;
    code;
    errorCode;
    serverMessage;
    bodyText;
    body;
    constructor(route, status, bodyText, body) {
        const normalized = normalizeHttpErrorBody(body, bodyText);
        super(normalized.serverMessage
            ? `HTTP ${status}: ${normalized.serverMessage}`
            : `HTTP ${status} for ${route.method} ${route.path}`);
        this.name = 'HttpStatusError';
        this.route = route;
        this.status = status;
        this.bodyText = bodyText;
        this.body = body;
        this.code = normalized.code;
        this.errorCode = normalized.errorCode;
        this.serverMessage = normalized.serverMessage;
    }
}
export class HttpServiceTimeoutError extends Error {
    timeoutMs;
    route;
    constructor(route, timeoutMs) {
        super(`HTTP service call timed out after ${timeoutMs}ms for ${route.method} ${route.path}`);
        this.name = 'HttpServiceTimeoutError';
        this.route = route;
        this.timeoutMs = timeoutMs;
    }
}
export class HttpRequestValidationError extends Error {
    code = 'INVALID_HTTP_REQUEST';
    constructor(cause) {
        super(cause instanceof Error ? cause.message : 'Invalid HTTP request', { cause });
        this.name = 'HttpRequestValidationError';
    }
}
export class RpcHttpError extends HttpStatusError {
    responseBody;
    constructor(route, status, responseBody) {
        super(route, status, responseBody, parseJsonBody(responseBody));
        this.name = 'RpcHttpError';
        this.responseBody = responseBody;
    }
}
export async function invokeHttpJson(options, route, req, callOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new Error('No fetch implementation is available for the thrift HTTP client');
    }
    const url = new URL(route.path, normalizeBaseUrl(options.baseUrl));
    const headers = mergeClientHeaders(options.headers, callOptions?.headers);
    if (!headers.has('Accept'))
        headers.set('Accept', 'application/json');
    const serialized = serializeHttpRequest(route, req, url, headers);
    if (serialized.body !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }
    const requestSignal = createHttpServiceRequestSignal(route, callOptions);
    let response;
    let body;
    try {
        response = await fetchImpl(url, {
            method: route.method === 'ANY' ? failAnyClientRoute(route) : route.method,
            headers,
            body: serialized.body,
            signal: requestSignal.signal,
        });
        body = await response.text();
    }
    catch (error) {
        if (requestSignal.timedOut) {
            throw new HttpServiceTimeoutError(route, callOptions?.timeoutMs ?? 0);
        }
        throw error;
    }
    finally {
        requestSignal.dispose();
    }
    if (!response.ok) {
        const error = new HttpStatusError(route, response.status, body, parseJsonBody(body));
        throw options.mapError ? options.mapError(error) : error;
    }
    if (!body)
        return undefined;
    return decodeHttpResponse(route, JSON.parse(body));
}
export function encodeHttpResponse(route, resp) {
    return encodeStructValue(route.responseSchema, resp);
}
export function decodeHttpResponse(route, resp) {
    return decodeStructValue(route.responseSchema, resp);
}
export function serializeHttpRequest(route, req, url, headers) {
    const bindings = route.bindings ?? [];
    if (isWholeJsonBodyRoute(route, bindings)) {
        return { body: JSON.stringify(encodeStructValue(route.requestSchema, req)) };
    }
    const requestRecord = asRecord(req, 'request');
    const jsonBody = {};
    let hasJsonBody = false;
    for (const binding of bindings) {
        if (binding.kind === 'none')
            continue;
        const value = requestRecord[binding.fieldName];
        if (value === undefined || value === null) {
            if (binding.requiredness === 'required') {
                throw new Error(`Missing required HTTP binding ${binding.kind}:${binding.wireName}`);
            }
            continue;
        }
        switch (binding.kind) {
            case 'path':
                replacePathParam(url, binding.wireName, encodePathBindingScalar(binding, value));
                break;
            case 'query':
                appendQueryBinding(url.searchParams, binding, value, route.requestSchema);
                break;
            case 'header':
                headers.set(binding.wireName, encodeBindingScalar(binding, value));
                break;
            case 'body':
                jsonBody[binding.wireName] = encodeBindingJsonValue(route.requestSchema, binding, value);
                hasJsonBody = true;
                break;
            case 'implicitBody':
                jsonBody[binding.wireName] = encodeBindingJsonValue(route.requestSchema, binding, value);
                hasJsonBody = true;
                break;
        }
    }
    assertNoUnresolvedPathParams(url, route);
    return hasJsonBody ? { body: JSON.stringify(jsonBody) } : {};
}
export async function parseHttpRequest(route, request, pathParams = {}) {
    try {
        const bindings = route.bindings ?? [];
        if (isWholeJsonBodyRoute(route, bindings)) {
            return decodeStructValue(route.requestSchema, await readJsonBody(request));
        }
        const url = new URL(request.url);
        const jsonBody = await readOptionalJsonRecord(request);
        const out = {};
        for (const binding of bindings) {
            if (binding.kind === 'none')
                continue;
            const value = readBindingValue(binding, url.searchParams, request.headers, jsonBody, pathParams);
            if (value === undefined) {
                if (binding.requiredness === 'required') {
                    throw new Error(`Missing required HTTP binding ${binding.kind}:${binding.wireName}`);
                }
                continue;
            }
            out[binding.fieldName] = decodeBindingJsonValue(route.requestSchema, binding, value);
        }
        return out;
    }
    catch (error) {
        if (error instanceof HttpRequestValidationError)
            throw error;
        throw new HttpRequestValidationError(error);
    }
}
function isWholeJsonBodyRoute(route, bindings) {
    return route.method !== 'GET' && bindings.every((binding) => binding.kind === 'implicitBody');
}
function failAnyClientRoute(route) {
    throw new Error(`Cannot invoke api.any route ${route.path} without a concrete HTTP method`);
}
function replacePathParam(url, wireName, value) {
    const token = `:${wireName}`;
    if (!url.pathname.includes(token)) {
        throw new Error(`Path binding ${wireName} is not present in route ${url.pathname}`);
    }
    url.pathname = url.pathname.replaceAll(token, value);
}
function assertNoUnresolvedPathParams(url, route) {
    const unresolved = url.pathname.match(/(^|\/)[:][^/]+/u);
    if (unresolved) {
        throw new Error(`Unresolved path binding ${unresolved[0].replace(/^\//u, '')} in route ${route.path}`);
    }
}
function appendQueryBinding(params, binding, value, requestSchema) {
    if (binding.valueKind === 'scalar') {
        params.append(binding.wireName, encodeBindingScalar(binding, value));
        return;
    }
    if (binding.valueKind === 'scalarList') {
        if (!Array.isArray(value))
            throw new Error(`Query binding ${binding.wireName} expected an array`);
        const itemBinding = scalarListItemBinding(binding);
        for (const item of value) {
            params.append(binding.wireName, encodeBindingScalar(itemBinding, item));
        }
        return;
    }
    if (binding.valueKind === 'struct') {
        if (!canUseDeepObjectQuery(binding)) {
            params.append(binding.wireName, JSON.stringify(encodeBindingJsonValue(requestSchema, binding, value)));
            return;
        }
        const record = asRecord(value, `query binding ${binding.wireName}`);
        for (const field of binding.structFields ?? []) {
            const childValue = record[field.fieldName];
            if (childValue === undefined || childValue === null)
                continue;
            if (field.valueKind !== 'scalar') {
                throw new Error(`Unsupported query binding ${binding.wireName}.${field.fieldName}`);
            }
            params.append(deepObjectQueryKey(binding, field), encodeBindingScalar(bindingFromStructField(binding, field), childValue));
        }
        return;
    }
    throw new Error(`Unsupported query binding ${binding.wireName} with type ${binding.tsType}`);
}
function readBindingValue(binding, params, headers, jsonBody, pathParams) {
    switch (binding.kind) {
        case 'path':
            return decodeScalar(binding, pathParams[binding.wireName]);
        case 'query':
            return readQueryBinding(binding, params);
        case 'header':
            return decodeScalar(binding, headers.get(binding.wireName) ?? undefined);
        case 'body':
        case 'implicitBody':
            return readJsonBodyBinding(jsonBody, binding);
        case 'none':
            return undefined;
    }
}
function readJsonBodyBinding(jsonBody, binding) {
    for (const key of [binding.wireName, binding.jsonName, binding.fieldName]) {
        if (key && Object.prototype.hasOwnProperty.call(jsonBody, key)) {
            return jsonBody[key];
        }
    }
    return undefined;
}
function readQueryBinding(binding, params) {
    if (binding.valueKind === 'scalar')
        return decodeScalar(binding, firstParam(params, binding.wireName));
    if (binding.valueKind === 'scalarList') {
        const values = params.getAll(binding.wireName);
        const itemBinding = scalarListItemBinding(binding);
        return values.length > 0 ? values.map((value) => decodeScalar(itemBinding, value)) : undefined;
    }
    if (binding.valueKind === 'struct') {
        const out = {};
        const jsonValue = firstParam(params, binding.wireName);
        if (jsonValue)
            Object.assign(out, parseJsonObject(jsonValue, `query binding ${binding.wireName}`));
        for (const field of binding.structFields ?? []) {
            const childBinding = bindingFromStructField(binding, field);
            const deepKey = deepObjectQueryKey(binding, field);
            const deepValue = firstParam(params, deepKey);
            const flatValue = firstParam(params, field.wireName);
            if (field.valueKind !== 'scalar') {
                if (deepValue !== undefined ||
                    hasNestedDeepObjectParam(params, deepKey) ||
                    flatValue !== undefined) {
                    throw new Error(`Unsupported query binding ${binding.wireName}.${field.fieldName}`);
                }
                continue;
            }
            const childValue = decodeScalar(childBinding, deepValue ?? flatValue);
            if (childValue !== undefined)
                out[field.fieldName] = childValue;
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    throw new Error(`Unsupported query binding ${binding.wireName} with type ${binding.tsType}`);
}
function bindingFromStructField(parent, field) {
    return {
        fieldName: field.fieldName,
        wireName: field.wireName,
        jsonName: field.jsonName,
        kind: 'query',
        fieldId: parent.fieldId,
        requiredness: field.requiredness,
        tsType: field.tsType,
        valueKind: field.valueKind,
    };
}
function scalarListItemBinding(binding) {
    return {
        ...binding,
        tsType: scalarListItemTsType(binding.tsType),
        valueKind: 'scalar',
    };
}
function scalarListItemTsType(tsType) {
    if (!tsType.endsWith('[]'))
        return tsType;
    const itemType = tsType.slice(0, -2);
    if (itemType.startsWith('(') && itemType.endsWith(')'))
        return itemType.slice(1, -1);
    return itemType;
}
function deepObjectQueryKey(parent, field) {
    return `${parent.wireName}[${field.wireName}]`;
}
function hasNestedDeepObjectParam(params, deepKey) {
    const nestedPrefix = `${deepKey}[`;
    for (const key of params.keys()) {
        if (key.startsWith(nestedPrefix))
            return true;
    }
    return false;
}
function canUseDeepObjectQuery(binding) {
    return (binding.structFields ?? []).every((field) => field.valueKind === 'scalar');
}
function encodeBindingJsonValue(schema, binding, value) {
    const fieldSchema = findSchemaField(schema, binding.fieldName);
    return encodeValue(fieldSchema?.value, value);
}
function decodeBindingJsonValue(schema, binding, value) {
    assertJsonScalarType(binding, value);
    const fieldSchema = findSchemaField(schema, binding.fieldName);
    return decodeValue(fieldSchema?.value, value);
}
function assertJsonScalarType(binding, value) {
    if (binding.valueKind !== 'scalar')
        return;
    if (binding.tsType === 'string' && typeof value !== 'string') {
        throw new Error(`Binding ${binding.wireName} expected a string`);
    }
    if ((binding.tsType === 'number' || binding.tsType === 'ThriftI64') &&
        (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`Binding ${binding.wireName} expected a finite number`);
    }
    if (binding.tsType === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Binding ${binding.wireName} expected a boolean`);
    }
}
function encodeStructValue(schema, value) {
    if (!schema)
        return value;
    return encodeRecord(schema, value);
}
function decodeStructValue(schema, value) {
    if (!schema)
        return value;
    return decodeRecord(schema, value);
}
function encodeValue(schema, value) {
    if (value === undefined || value === null || !schema)
        return value;
    switch (schema.kind) {
        case 'scalar':
            return value;
        case 'struct':
            return encodeRecord(schema.schema, value);
        case 'list':
        case 'set':
            if (!Array.isArray(value))
                throw new Error(`${schema.kind} JSON value must be an array`);
            return value.map((item) => encodeValue(schema.item, item));
        case 'map': {
            const record = asRecord(value, 'map JSON value');
            return Object.fromEntries(Object.entries(record)
                .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
                .map(([key, entryValue]) => [key, encodeValue(schema.value, entryValue)]));
        }
    }
}
function decodeValue(schema, value) {
    if (value === undefined || value === null || !schema)
        return value;
    switch (schema.kind) {
        case 'scalar':
            return value;
        case 'struct':
            return decodeRecord(schema.schema, value);
        case 'list':
        case 'set':
            if (!Array.isArray(value))
                throw new Error(`${schema.kind} JSON value must be an array`);
            return value.map((item) => decodeValue(schema.item, item));
        case 'map': {
            const record = asRecord(value, 'map JSON value');
            return Object.fromEntries(Object.entries(record).map(([key, entryValue]) => [
                key,
                decodeValue(schema.value, entryValue),
            ]));
        }
    }
}
function encodeRecord(schema, value) {
    const record = asRecord(value, `${schema.name} JSON value`);
    const out = {};
    for (const field of schema.fields) {
        const fieldValue = record[field.fieldName];
        if (fieldValue === undefined || fieldValue === null)
            continue;
        out[schemaFieldJsonName(field)] = encodeValue(field.value, fieldValue);
    }
    return out;
}
function decodeRecord(schema, value) {
    const record = asRecord(value, `${schema.name} JSON value`);
    const out = {};
    for (const field of schema.fields) {
        const jsonName = schemaFieldJsonName(field);
        let fieldValue;
        if (Object.prototype.hasOwnProperty.call(record, jsonName)) {
            fieldValue = record[jsonName];
        }
        else if (Object.prototype.hasOwnProperty.call(record, field.fieldName)) {
            fieldValue = record[field.fieldName];
        }
        else {
            continue;
        }
        if (fieldValue === undefined || fieldValue === null)
            continue;
        out[field.fieldName] = decodeValue(field.value, fieldValue);
    }
    return out;
}
function findSchemaField(schema, fieldName) {
    return schema?.fields.find((field) => field.fieldName === fieldName);
}
function schemaFieldJsonName(field) {
    return field.jsonName ?? field.wireName ?? field.thriftName ?? field.fieldName;
}
function encodeBindingScalar(binding, value) {
    if (binding.valueKind !== 'scalar') {
        throw new Error(`Binding ${binding.wireName} expected scalar type, got ${binding.tsType}`);
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    throw new Error(`Binding ${binding.wireName} expected scalar value`);
}
function encodePathBindingScalar(binding, value) {
    return encodeURIComponent(encodeBindingScalar(binding, value));
}
function decodeScalar(binding, value) {
    if (value === undefined)
        return undefined;
    if (binding.tsType === 'number' || binding.tsType === 'ThriftI64') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed))
            throw new Error(`Invalid numeric HTTP binding value ${value}`);
        return parsed;
    }
    if (binding.tsType === 'boolean') {
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
        throw new Error(`Invalid boolean HTTP binding value ${value}`);
    }
    return value;
}
async function readJsonBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD')
        return {};
    return request.json();
}
async function readOptionalJsonRecord(request) {
    if (request.method === 'GET' || request.method === 'HEAD')
        return {};
    const contentType = request.headers.get('Content-Type') ?? '';
    const text = await request.text();
    if (!text)
        return {};
    if (!contentType.toLowerCase().includes('application/json') && text.trim().length === 0) {
        return {};
    }
    return parseJsonObject(text, 'request body');
}
function parseJsonObject(value, context) {
    const parsed = JSON.parse(value);
    return asRecord(parsed, context);
}
function asRecord(value, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} must be a JSON object`);
    }
    return value;
}
function firstParam(params, key) {
    const value = params.get(key);
    return value === null ? undefined : value;
}
export function mergeClientHeaders(defaults, overrides) {
    const headers = new Headers(defaults);
    if (overrides) {
        for (const [key, value] of Object.entries(overrides))
            headers.set(key, value);
    }
    return headers;
}
export function createHttpServiceRequestSignal(route, options) {
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs === undefined) {
        return { signal: options?.signal, dispose() { }, timedOut: false };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(`timeoutMs must be a positive finite number for ${route.method} ${route.path}`);
    }
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
    }, timeoutMs);
    const signal = options?.signal
        ? combineAbortSignals([options.signal, timeoutController.signal])
        : timeoutController.signal;
    return {
        signal,
        dispose() {
            clearTimeout(timeoutId);
        },
        get timedOut() {
            return timedOut;
        },
    };
}
export function combineAbortSignals(signals) {
    const any = AbortSignal;
    if (typeof any.any === 'function')
        return any.any(signals);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}
function normalizeHttpErrorBody(body, bodyText) {
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
    const code = readStringField(record, 'code');
    const errorCode = readNumberField(record, 'errorCode') ?? readNumberField(record, 'error_code');
    const serverMessage = readStringField(record, 'serverMessage') ??
        readStringField(record, 'message') ??
        readStringField(record, 'error') ??
        (body === undefined && bodyText.trim().length > 0 ? bodyText : undefined);
    return { code, errorCode, serverMessage };
}
function readStringField(record, key) {
    if (!record || typeof record !== 'object')
        return undefined;
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
function readNumberField(record, key) {
    if (!record || typeof record !== 'object')
        return undefined;
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function parseJsonBody(value) {
    if (value.length === 0)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
//# sourceMappingURL=http-json.js.map