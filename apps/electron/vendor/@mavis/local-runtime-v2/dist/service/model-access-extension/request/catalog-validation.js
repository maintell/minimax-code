import { ModelAccessRequestError, requestRecord } from './validation.js';
function invalid() {
    throw new ModelAccessRequestError('request_invalid');
}
function text(value) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > 1024 ||
        /[\u0000-\u001f]/u.test(value))
        invalid();
    return value;
}
function number(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        invalid();
    return value;
}
function timestamp(value) {
    const result = number(value);
    if (!Number.isSafeInteger(result) || result < 1)
        invalid();
    return result;
}
function optionalNumber(item, key) {
    return item[key] === undefined ? {} : { [key]: number(item[key]) };
}
function optionalTime(item, key) {
    return item[key] === undefined ? {} : { [key]: timestamp(item[key]) };
}
function array(value, capture, limit) {
    if (!Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > limit ||
        Reflect.ownKeys(value).length !== value.length + 1)
        invalid();
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            invalid();
        result.push(capture(descriptor.value));
    }
    return Object.freeze(result);
}
function modality(value) {
    if (value !== 'text' && value !== 'image' && value !== 'audio' && value !== 'video')
        invalid();
    return value;
}
export function captureRequestModel(value) {
    const item = requestRecord(value, [
        'id',
        'api',
        'name',
        'contextWindow',
        'maxOutputTokens',
        'input',
        'reasoning',
        'tools',
        'creditMultiplier',
    ]);
    if (item.tools !== undefined && typeof item.tools !== 'boolean')
        invalid();
    return Object.freeze({
        id: text(item.id),
        api: text(item.api),
        ...(item.name === undefined ? {} : { name: text(item.name) }),
        ...optionalNumber(item, 'contextWindow'),
        ...optionalNumber(item, 'maxOutputTokens'),
        ...optionalNumber(item, 'creditMultiplier'),
        ...(item.tools === undefined ? {} : { tools: item.tools }),
        ...(item.input === undefined ? {} : { input: array(item.input, modality, 4) }),
        ...(item.reasoning === undefined ? {} : { reasoning: array(item.reasoning, text, 16) }),
    });
}
export function captureRequestModels(value) {
    const models = array(value, captureRequestModel, 4096);
    if (new Set(models.map((model) => model.id)).size !== models.length)
        invalid();
    return models;
}
function window(value) {
    const item = requestRecord(value, [
        'name',
        'unit',
        'used',
        'amount',
        'limit',
        'resetAt',
        'runsOutAt',
    ]);
    return Object.freeze({
        name: text(item.name),
        unit: text(item.unit),
        ...optionalNumber(item, 'used'),
        ...optionalNumber(item, 'amount'),
        ...optionalNumber(item, 'limit'),
        ...optionalTime(item, 'resetAt'),
        ...optionalTime(item, 'runsOutAt'),
    });
}
export function captureRequestUsage(value) {
    const item = requestRecord(value, ['status', 'queriedAt', 'plan', 'windows', 'expiryStatus']);
    const queriedAt = timestamp(item.queriedAt);
    if (item.status === 'unsupported' || item.status === 'failed' || item.status === 'unknown') {
        if (item.plan !== undefined || item.windows !== undefined || item.expiryStatus !== undefined)
            invalid();
        return Object.freeze({ status: item.status, queriedAt });
    }
    if (item.status !== 'available')
        invalid();
    return Object.freeze({
        status: item.status,
        queriedAt,
        ...(item.plan === undefined ? {} : { plan: text(item.plan) }),
        windows: array(item.windows, window, 64),
        expiryStatus: expiryStatus(item.expiryStatus),
    });
}
function expiryStatus(value) {
    if (value !== 'known' && value !== 'unknown' && value !== 'not_applicable')
        invalid();
    return value;
}
//# sourceMappingURL=catalog-validation.js.map