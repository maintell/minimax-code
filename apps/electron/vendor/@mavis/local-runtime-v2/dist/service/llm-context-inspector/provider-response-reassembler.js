const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OBSERVED_EVENT_BYTES = 64 * 1024 * 1024;
/** Reassembles one provider-native response without retaining the event stream. */
export function createProviderResponseAssembler(apiId, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
    let observedBytes = 0;
    let failed = false;
    let omitted = false;
    let state;
    const fold = responseFolder(apiId);
    if (!fold)
        failed = true;
    return {
        observe(event) {
            if (failed || omitted || !fold)
                return;
            try {
                const serialized = JSON.stringify(event);
                if (serialized === undefined)
                    throw new Error('provider event is not JSON');
                observedBytes += Buffer.byteLength(serialized, 'utf8');
                if (observedBytes > DEFAULT_MAX_OBSERVED_EVENT_BYTES) {
                    omitted = true;
                    state = undefined;
                    return;
                }
                state = fold(state, JSON.parse(serialized));
            }
            catch {
                failed = true;
                state = undefined;
            }
        },
        snapshot() {
            if (omitted)
                return { state: 'OMITTED_TOO_LARGE' };
            if (failed || state === undefined)
                return { state: 'CAPTURE_FAILED' };
            try {
                const json = JSON.stringify(responseSnapshot(apiId, state));
                if (json === undefined)
                    return { state: 'CAPTURE_FAILED' };
                const byteLength = Buffer.byteLength(json, 'utf8');
                return byteLength > maxPayloadBytes
                    ? { state: 'OMITTED_TOO_LARGE', byteLength }
                    : { state: 'AVAILABLE', json, byteLength };
            }
            catch {
                return { state: 'CAPTURE_FAILED' };
            }
        },
    };
}
function responseSnapshot(apiId, state) {
    if (apiId === 'anthropic-messages' && isMessagesAssembly(state))
        return state.message;
    if (apiId === 'openai-completions' && isCompletionAssembly(state)) {
        return finalizeCompletionResponse(state.response);
    }
    if ((apiId === 'openai-responses' || apiId === 'openai-codex-responses') &&
        isResponsesAssembly(state)) {
        return state.response;
    }
    return state;
}
function finalizeCompletionResponse(response) {
    return {
        ...response,
        choices: (Array.isArray(response.choices) ? response.choices : []).map((rawChoice) => {
            if (!isObject(rawChoice))
                return rawChoice;
            const message = isObject(rawChoice.message) ? rawChoice.message : {};
            return {
                ...rawChoice,
                message: {
                    ...message,
                    content: message.content ?? null,
                    refusal: message.refusal ?? null,
                },
            };
        }),
    };
}
function responseFolder(apiId) {
    switch (apiId) {
        case 'anthropic-messages':
            return foldMessagesEvent;
        case 'openai-completions':
            return foldOpenAICompletionChunk;
        case 'openai-responses':
        case 'openai-codex-responses':
            return foldOpenAIResponseEvent;
        default:
            return undefined;
    }
}
function foldMessagesEvent(rawState, rawEvent) {
    if (!isObject(rawEvent) || typeof rawEvent.type !== 'string')
        return rawState;
    const state = asMessagesAssembly(rawState);
    applyMessagesEvent(state, rawEvent);
    syncMessagesContent(state);
    return state;
}
function applyMessagesEvent(state, event) {
    switch (event.type) {
        case 'message_start':
            startMessagesResponse(state, event.message);
            break;
        case 'content_block_start':
            startMessagesContentBlock(state, event);
            break;
        case 'content_block_delta':
            applyMessagesContentDelta(state, event);
            break;
        case 'content_block_stop':
            stopMessagesContentBlock(state, event.index);
            break;
        case 'message_delta':
            applyMessagesResponseDelta(state, event);
            break;
        default:
            break;
    }
}
function startMessagesResponse(state, rawMessage) {
    if (!isObject(rawMessage))
        return;
    const content = Array.isArray(rawMessage.content) ? rawMessage.content : [];
    state.message = { ...rawMessage, content: [...content] };
    state.blocks.clear();
    state.partialInputs.clear();
    for (const [blockIndex, block] of content.entries()) {
        if (isObject(block))
            state.blocks.set(blockIndex, { ...block });
    }
}
function startMessagesContentBlock(state, event) {
    const index = integer(event.index);
    if (index === undefined)
        return;
    const block = isObject(event.content_block) ? { ...event.content_block } : {};
    state.blocks.set(index, block);
    if (block.type === 'tool_use') {
        state.partialInputs.set(index, stringifyInitialToolInput(block.input));
    }
}
function applyMessagesContentDelta(state, event) {
    const index = integer(event.index);
    if (index === undefined)
        return;
    const block = state.blocks.get(index) ?? {};
    const delta = isObject(event.delta) ? event.delta : {};
    if (delta.type === 'text_delta')
        appendString(block, 'text', delta.text);
    else if (delta.type === 'thinking_delta')
        appendString(block, 'thinking', delta.thinking);
    else if (delta.type === 'signature_delta')
        appendString(block, 'signature', delta.signature);
    else if (delta.type === 'input_json_delta')
        applyMessagesToolInput(state, block, index, delta);
    else if (delta.type === 'citations_delta')
        appendMessagesCitation(block, delta.citation);
    state.blocks.set(index, block);
}
function applyMessagesToolInput(state, block, index, delta) {
    if (typeof delta.partial_json !== 'string')
        return;
    const partial = `${state.partialInputs.get(index) ?? ''}${delta.partial_json}`;
    state.partialInputs.set(index, partial);
    block.input = parsePartialJson(partial);
}
function appendMessagesCitation(block, citation) {
    if (citation === undefined)
        return;
    const citations = Array.isArray(block.citations) ? [...block.citations] : [];
    citations.push(citation);
    block.citations = citations;
}
function stopMessagesContentBlock(state, rawIndex) {
    const index = integer(rawIndex);
    if (index === undefined)
        return;
    const block = state.blocks.get(index);
    const partial = state.partialInputs.get(index);
    if (block && partial !== undefined)
        block.input = parsePartialJson(partial);
}
function applyMessagesResponseDelta(state, event) {
    if (isObject(event.delta))
        Object.assign(state.message, event.delta);
    if (!isObject(event.usage))
        return;
    state.message.usage = {
        ...(isObject(state.message.usage) ? state.message.usage : {}),
        ...event.usage,
    };
}
function syncMessagesContent(state) {
    state.message.content = [...state.blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block);
}
function asMessagesAssembly(value) {
    if (isMessagesAssembly(value))
        return value;
    return { message: {}, blocks: new Map(), partialInputs: new Map() };
}
function isMessagesAssembly(value) {
    return (isObject(value) &&
        value.message instanceof Object &&
        value.blocks instanceof Map &&
        value.partialInputs instanceof Map);
}
function foldOpenAICompletionChunk(rawState, rawEvent) {
    if (!isObject(rawEvent))
        return rawState;
    const state = asCompletionAssembly(rawState);
    mergeCompletionResponseMetadata(state.response, rawEvent);
    for (const rawChoice of Array.isArray(rawEvent.choices) ? rawEvent.choices : []) {
        foldCompletionChoice(state, rawChoice);
    }
    syncCompletionChoices(state);
    return state;
}
function mergeCompletionResponseMetadata(response, event) {
    for (const [key, value] of Object.entries(event)) {
        if (key !== 'choices')
            response[key] = value;
    }
    if (response.object === 'chat.completion.chunk')
        response.object = 'chat.completion';
}
function foldCompletionChoice(state, rawChoice) {
    if (!isObject(rawChoice))
        return;
    const index = integer(rawChoice.index) ?? 0;
    const choice = state.choices.get(index) ?? { index, message: {}, logprobs: null };
    const message = isObject(choice.message) ? choice.message : {};
    mergeCompletionChoiceMetadata(choice, rawChoice);
    mergeCompletionLogprobs(choice, rawChoice.logprobs);
    mergeCompletionDelta(message, rawChoice.delta);
    choice.message = message;
    state.choices.set(index, choice);
}
function mergeCompletionChoiceMetadata(choice, rawChoice) {
    for (const [key, value] of Object.entries(rawChoice)) {
        if (key !== 'delta' && key !== 'logprobs')
            choice[key] = value;
    }
}
function mergeCompletionDelta(message, rawDelta) {
    const delta = isObject(rawDelta) ? rawDelta : {};
    if (typeof delta.role === 'string')
        message.role = delta.role;
    appendString(message, 'content', delta.content);
    appendString(message, 'refusal', delta.refusal);
    for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        appendString(message, key, delta[key]);
    }
    foldLegacyFunctionCall(message, delta.function_call);
    foldCompletionToolCalls(message, delta.tool_calls);
    for (const [key, value] of Object.entries(delta)) {
        if (!COMPLETION_DELTA_KEYS.has(key))
            message[key] = value;
    }
}
function syncCompletionChoices(state) {
    state.response.choices = [...state.choices.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, choice]) => choice);
}
const COMPLETION_DELTA_KEYS = new Set([
    'role',
    'content',
    'refusal',
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'function_call',
    'tool_calls',
]);
function mergeCompletionLogprobs(choice, rawLogprobs) {
    if (!isObject(rawLogprobs)) {
        if (rawLogprobs === null && choice.logprobs === undefined)
            choice.logprobs = null;
        return;
    }
    const logprobs = isObject(choice.logprobs) ? choice.logprobs : {};
    for (const [key, value] of Object.entries(rawLogprobs)) {
        if ((key === 'content' || key === 'refusal') && Array.isArray(value)) {
            const accumulated = Array.isArray(logprobs[key]) ? [...logprobs[key]] : [];
            logprobs[key] = [...accumulated, ...value];
        }
        else {
            logprobs[key] = value;
        }
    }
    choice.logprobs = logprobs;
}
function foldLegacyFunctionCall(message, rawFunctionCall) {
    if (!isObject(rawFunctionCall))
        return;
    const fn = isObject(message.function_call) ? { ...message.function_call } : {};
    for (const [key, value] of Object.entries(rawFunctionCall)) {
        if (key === 'arguments')
            appendString(fn, key, value);
        else if (value !== undefined)
            fn[key] = value;
    }
    message.function_call = fn;
}
function asCompletionAssembly(value) {
    if (isCompletionAssembly(value))
        return value;
    return { response: {}, choices: new Map() };
}
function isCompletionAssembly(value) {
    return isObject(value) && value.response instanceof Object && value.choices instanceof Map;
}
function foldCompletionToolCalls(message, rawCalls) {
    if (!Array.isArray(rawCalls))
        return;
    const calls = Array.isArray(message.tool_calls) ? [...message.tool_calls] : [];
    for (const rawCall of rawCalls) {
        mergeCompletionToolCall(calls, rawCall);
    }
    message.tool_calls = calls;
}
function mergeCompletionToolCall(calls, rawCall) {
    if (!isObject(rawCall))
        return;
    const index = integer(rawCall.index) ?? calls.length;
    const call = isObject(calls[index]) ? { ...calls[index] } : {};
    if (rawCall.id !== undefined)
        call.id = rawCall.id;
    if (rawCall.type !== undefined)
        call.type = rawCall.type;
    mergeCompletionToolFunction(call, rawCall.function);
    for (const [key, value] of Object.entries(rawCall)) {
        if (!COMPLETION_TOOL_CALL_KEYS.has(key))
            call[key] = value;
    }
    calls[index] = call;
}
const COMPLETION_TOOL_CALL_KEYS = new Set(['index', 'id', 'type', 'function']);
function mergeCompletionToolFunction(call, rawFunction) {
    if (!isObject(rawFunction))
        return;
    const fn = isObject(call.function) ? { ...call.function } : {};
    for (const [key, value] of Object.entries(rawFunction)) {
        if (key === 'arguments')
            appendString(fn, key, value);
        else if (value !== undefined)
            fn[key] = value;
    }
    call.function = fn;
}
const RESPONSES_EVENT_HANDLERS = {
    'response.created': handleResponseCreated,
    'response.output_item.added': handleResponseOutputItem,
    'response.output_item.done': handleResponseOutputItem,
    'response.content_part.added': handleResponseContentPart,
    'response.content_part.done': handleResponseContentPart,
    'response.output_text.delta': handleResponseOutputTextDelta,
    'response.output_text.done': handleResponseOutputTextDone,
    'response.output_text.annotation.added': handleResponseOutputTextAnnotation,
    'response.refusal.delta': handleResponseRefusalDelta,
    'response.refusal.done': handleResponseRefusalDone,
    'response.function_call_arguments.delta': handleResponseFunctionArgumentsDelta,
    'response.function_call_arguments.done': handleResponseFunctionArgumentsDone,
    'response.reasoning_summary_part.added': handleResponseReasoningSummaryPart,
    'response.reasoning_summary_part.done': handleResponseReasoningSummaryPart,
    'response.reasoning_summary_text.delta': handleResponseReasoningSummaryTextDelta,
    'response.reasoning_summary_text.done': handleResponseReasoningSummaryTextDone,
    'response.reasoning_text.delta': handleResponseReasoningTextDelta,
    'response.reasoning_text.done': handleResponseReasoningTextDone,
    'response.completed': handleTerminalResponse,
    'response.incomplete': handleTerminalResponse,
    'response.failed': handleTerminalResponse,
};
function foldOpenAIResponseEvent(rawState, rawEvent) {
    if (!isObject(rawEvent) || typeof rawEvent.type !== 'string')
        return rawState;
    const state = asResponsesAssembly(rawState);
    RESPONSES_EVENT_HANDLERS[rawEvent.type]?.(state, rawEvent);
    syncResponseOutput(state);
    return state;
}
function handleResponseCreated(state, event) {
    if (!isObject(event.response))
        return;
    state.response = { ...event.response };
    seedResponseOutput(state, event.response.output);
}
function handleResponseOutputItem(state, event) {
    const index = integer(event.output_index) ?? state.output.size;
    if (isObject(event.item))
        state.output.set(index, { ...event.item });
}
function handleResponseContentPart(state, event) {
    const item = responseOutputItem(state, event.output_index);
    const content = Array.isArray(item.content) ? [...item.content] : [];
    const contentIndex = integer(event.content_index) ?? content.length;
    if (isObject(event.part))
        content[contentIndex] = { ...event.part };
    item.content = content;
}
function handleResponseOutputTextDelta(state, event) {
    appendString(responseContentPart(state, event, 'output_text'), 'text', event.delta);
}
function handleResponseOutputTextDone(state, event) {
    if (typeof event.text === 'string') {
        responseContentPart(state, event, 'output_text').text = event.text;
    }
}
function handleResponseRefusalDelta(state, event) {
    appendString(responseContentPart(state, event, 'refusal'), 'refusal', event.delta);
}
function handleResponseRefusalDone(state, event) {
    if (typeof event.refusal === 'string') {
        responseContentPart(state, event, 'refusal').refusal = event.refusal;
    }
}
function handleResponseFunctionArgumentsDelta(state, event) {
    appendString(responseOutputItem(state, event.output_index), 'arguments', event.delta);
}
function handleResponseFunctionArgumentsDone(state, event) {
    if (typeof event.arguments === 'string') {
        responseOutputItem(state, event.output_index).arguments = event.arguments;
    }
}
function handleResponseReasoningSummaryPart(state, event) {
    const item = responseOutputItem(state, event.output_index);
    const summary = Array.isArray(item.summary) ? [...item.summary] : [];
    const summaryIndex = integer(event.summary_index) ?? summary.length;
    if (isObject(event.part))
        summary[summaryIndex] = { ...event.part };
    item.summary = summary;
}
function handleResponseReasoningSummaryTextDelta(state, event) {
    const { item, summary, summaryIndex, part } = responseSummaryPart(state, event, true);
    appendString(part, 'text', event.delta);
    summary[summaryIndex] = part;
    item.summary = summary;
}
function handleResponseReasoningSummaryTextDone(state, event) {
    if (typeof event.text !== 'string')
        return;
    const { item, summary, summaryIndex, part } = responseSummaryPart(state, event, false);
    part.text = event.text;
    summary[summaryIndex] = part;
    item.summary = summary;
}
function responseSummaryPart(state, event, includeEmptyText) {
    const item = responseOutputItem(state, event.output_index);
    const summary = Array.isArray(item.summary) ? [...item.summary] : [];
    const summaryIndex = integer(event.summary_index) ?? 0;
    const part = isObject(summary[summaryIndex])
        ? { ...summary[summaryIndex] }
        : { type: 'summary_text', ...(includeEmptyText ? { text: '' } : {}) };
    return { item, summary, summaryIndex, part };
}
function handleResponseReasoningTextDelta(state, event) {
    appendString(responseContentPart(state, event, 'reasoning_text'), 'text', event.delta);
}
function handleResponseReasoningTextDone(state, event) {
    if (typeof event.text === 'string') {
        responseContentPart(state, event, 'reasoning_text').text = event.text;
    }
}
function handleResponseOutputTextAnnotation(state, event) {
    const part = responseContentPart(state, event, 'output_text');
    const annotations = Array.isArray(part.annotations) ? [...part.annotations] : [];
    const annotationIndex = integer(event.annotation_index) ?? annotations.length;
    annotations[annotationIndex] = event.annotation;
    part.annotations = annotations;
}
function handleTerminalResponse(state, event) {
    if (!isObject(event.response))
        return;
    const terminal = { ...state.response, ...event.response };
    const terminalOutput = Array.isArray(terminal.output) ? terminal.output : [];
    if (terminalOutput.length > 0)
        seedResponseOutput(state, terminalOutput);
    state.response = terminal;
}
function syncResponseOutput(state) {
    const output = [...state.output.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item);
    if (output.length > 0 &&
        (!Array.isArray(state.response.output) || state.response.output.length === 0)) {
        state.response.output = output;
    }
}
function asResponsesAssembly(value) {
    if (isResponsesAssembly(value))
        return value;
    return { response: {}, output: new Map() };
}
function isResponsesAssembly(value) {
    return isObject(value) && value.response instanceof Object && value.output instanceof Map;
}
function seedResponseOutput(state, value) {
    if (!Array.isArray(value))
        return;
    for (const [index, item] of value.entries()) {
        if (isObject(item))
            state.output.set(index, { ...item });
    }
}
function responseOutputItem(state, rawIndex) {
    const index = integer(rawIndex) ?? 0;
    const item = state.output.get(index) ?? {};
    state.output.set(index, item);
    return item;
}
function responseContentPart(state, event, type) {
    const item = responseOutputItem(state, event.output_index);
    const content = Array.isArray(item.content) ? [...item.content] : [];
    const index = integer(event.content_index) ?? 0;
    const part = isObject(content[index]) ? { ...content[index] } : { type };
    content[index] = part;
    item.content = content;
    return part;
}
function appendString(target, key, value) {
    if (typeof value === 'string')
        target[key] = `${string(target[key])}${value}`;
}
function stringifyInitialToolInput(value) {
    if (!isObject(value) || Object.keys(value).length === 0)
        return '';
    try {
        return JSON.stringify(value);
    }
    catch {
        return '';
    }
}
function parsePartialJson(value) {
    if (value.length === 0)
        return {};
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function integer(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function string(value) {
    return typeof value === 'string' ? value : '';
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=provider-response-reassembler.js.map