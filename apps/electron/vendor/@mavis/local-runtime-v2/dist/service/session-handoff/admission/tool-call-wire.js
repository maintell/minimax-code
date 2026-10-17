const TOOL_CALL_ID_KEYS = ['tool_call_id', 'tool_callId', 'toolCallId', 'id'];
const TOOL_CALL_STATUS_KEYS = [
    'tool_call_status',
    'tool_callStatus',
    'toolCallStatus',
    'status',
];
const TOOL_CALL_ARGUMENT_KEYS = [
    'tool_call_args',
    'tool_call_args_json',
    'tool_callArgs',
    'tool_callArgsJson',
    'toolCallArgs',
    'toolCallArgsJson',
    'args',
    'arguments',
    'input',
];
const TOOL_CALL_RESULT_KEYS = [
    'tool_call_result_data',
    'tool_call_result_data_json',
    'tool_callResultData',
    'tool_callResultDataJson',
    'toolCallResultData',
    'toolCallResultDataJson',
    'result',
];
const TOOL_CALL_STATUS_BY_NAME = {
    pending: 1,
    started: 1,
    running: 1,
    done: 2,
    finished: 2,
    completed: 2,
    error: 3,
    failed: 3,
};
export function readHandoffToolCallWireFields(value) {
    const id = stringValue(firstDefined(value, TOOL_CALL_ID_KEYS));
    const status = normalizeStatus(firstDefined(value, TOOL_CALL_STATUS_KEYS));
    const args = firstDefined(value, TOOL_CALL_ARGUMENT_KEYS);
    const result = firstDefined(value, TOOL_CALL_RESULT_KEYS);
    return {
        name: stringValue(firstDefined(value, ['tool_name', 'toolName', 'name'])) ?? '',
        ...(id ? { id } : {}),
        ...(status === undefined ? {} : { status }),
        ...(args === undefined ? {} : { args }),
        ...(result === undefined ? {} : { result }),
    };
}
function firstDefined(source, keys) {
    for (const key of keys) {
        if (source[key] !== undefined)
            return source[key];
    }
    return undefined;
}
function stringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function normalizeStatus(value) {
    if (typeof value === 'number' && Number.isInteger(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim().toLowerCase();
    return /^\d+$/u.test(normalized) ? Number(normalized) : TOOL_CALL_STATUS_BY_NAME[normalized];
}
//# sourceMappingURL=tool-call-wire.js.map