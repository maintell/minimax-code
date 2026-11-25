import { streamSimple, } from '@earendil-works/pi-ai';
import { classifyLLMErrorToCode, LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';
import { BYOK_UPSTREAM_ERROR_SOURCE, formatByokErrorAttribution, isByokErrorAttribution, parseByokErrorAttribution, } from '@mavis/shared/byok-error-attribution';
import { redactSecretText } from '@mavis/shared/logging/redact-log-secret';
const MAX_ERROR_MESSAGE_LENGTH = 1_200;
export function withByokErrorAttribution(input) {
    const base = input.streamFn ?? streamSimple;
    return (async (model, context, options) => {
        try {
            const stream = await base(model, context, options);
            return wrapStream(stream, input.providerId, options?.signal);
        }
        catch (error) {
            if (options?.signal?.aborted)
                throw error;
            throw new Error(formatByokErrorMessage(error, input.providerId));
        }
    });
}
function formatByokErrorMessage(raw, providerId) {
    const rawMessage = errorText(raw);
    if (isByokErrorAttribution(rawMessage))
        return rawMessage;
    const classified = classifyLLMErrorToCode(raw);
    const detail = redactByokErrorMessage(withHttpStatus(classified?.message ?? rawMessage, rawMessage) || 'LLM provider request failed');
    return formatByokErrorAttribution({
        errorCode: classified?.status_code ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
        providerId,
        detail,
    });
}
/**
 * A JSON error body reduces to its inner `message`, which drops the HTTP status
 * (`413 {"type":"error",…}` becomes the bare sentence). Request-size recovery and
 * retry classification read this text and recognize the status, so keep it.
 */
function withHttpStatus(detail, rawMessage) {
    const status = /^([1-5]\d\d) /u.exec(rawMessage)?.[1];
    return status && detail && !detail.startsWith(`${status} `) ? `${status} ${detail}` : detail;
}
function redactByokErrorMessage(message) {
    return redactSecretText(message).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
function wrapStream(stream, providerId, signal) {
    const wrapped = Object.create(stream);
    Object.defineProperty(wrapped, Symbol.asyncIterator, {
        value: () => attributedEvents(stream, providerId, signal),
    });
    Object.defineProperty(wrapped, 'result', {
        value: () => attributedResult(stream, providerId, signal),
    });
    return wrapped;
}
async function* attributedEvents(stream, providerId, signal) {
    try {
        for await (const event of stream) {
            yield attributeEvent(event, providerId);
        }
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new Error(formatByokErrorMessage(error, providerId));
    }
}
async function attributedResult(stream, providerId, signal) {
    try {
        return attributeMessage(await stream.result(), providerId);
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new Error(formatByokErrorMessage(error, providerId));
    }
}
function attributeEvent(event, providerId) {
    return event.type === 'error' && event.reason === 'error'
        ? { ...event, error: attributeMessage(event.error, providerId) }
        : event;
}
function attributeMessage(message, providerId) {
    return message.stopReason === 'error' && message.errorMessage
        ? {
            ...message,
            errorMessage: formatByokErrorMessage(message.errorMessage, providerId),
        }
        : message;
}
function errorText(raw) {
    if (raw instanceof Error)
        return raw.message;
    return typeof raw === 'string' ? raw : '';
}
/** @internal Exported only for focused tests. */
export { BYOK_UPSTREAM_ERROR_SOURCE };
export function parseByokErrorStatus(raw, fallbackErrorCode) {
    const attributed = parseByokErrorAttribution(errorText(raw));
    if (!attributed)
        return undefined;
    return {
        errorCode: attributed.errorCode ?? fallbackErrorCode ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
        message: attributed.message,
        errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
        errorDetail: attributed.errorDetail,
        errorProviderId: attributed.errorProviderId,
    };
}
//# sourceMappingURL=byok-error-attribution.js.map