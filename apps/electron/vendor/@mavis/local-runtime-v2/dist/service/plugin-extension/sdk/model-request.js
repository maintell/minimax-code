import { ExtensionServiceError } from '../errors.js';
function invalid(message) {
    return new ExtensionServiceError('ARGUMENT_INVALID', message);
}
export function validate(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw invalid('model.complete takes a request object');
    const { model, prompt, system, maxTokens, timeoutMs } = raw;
    const qualified = qualifiedModel(model);
    if (typeof prompt !== 'string' || prompt.length === 0)
        throw invalid('prompt is required');
    const systemValue = optionalSystem(system);
    const tokens = optionalPositive(maxTokens, 'maxTokens');
    if (tokens !== undefined && !Number.isInteger(tokens))
        throw invalid('maxTokens must be an integer');
    const timeout = optionalTimeout(timeoutMs);
    return { ...qualified, prompt, system: systemValue, maxTokens: tokens, timeoutMs: timeout };
}
function qualifiedModel(model) {
    if (typeof model !== 'string' ||
        !model.includes('/') ||
        model.startsWith('/') ||
        model.endsWith('/'))
        throw invalid('model is required and must be provider/model');
    const separator = model.indexOf('/');
    return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}
function optionalSystem(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw invalid('system must be a string');
    return value;
}
function optionalPositive(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw invalid(`${name} must be a positive finite number`);
    return value;
}
function optionalTimeout(value) {
    const timeout = optionalPositive(value, 'timeoutMs');
    if (timeout !== undefined && timeout > 2147483647)
        throw invalid('timeoutMs must be at most 2147483647');
    return timeout;
}
//# sourceMappingURL=model-request.js.map