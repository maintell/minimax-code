export class HistoryToolGroupValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HistoryToolGroupValidationError';
    }
}
export function validateCompletedToolGroupSequence(input) {
    if (input.callIds.length === 0) {
        throw new HistoryToolGroupValidationError('assistant has no tool calls');
    }
    const uniqueCalls = new Set(input.callIds);
    if (uniqueCalls.size !== input.callIds.length) {
        throw new HistoryToolGroupValidationError('tool call ids must be unique');
    }
    let callOrdinal = 0;
    let bashSeen = false;
    for (const execution of input.executions) {
        const expectedCallId = input.callIds[callOrdinal];
        if (!expectedCallId) {
            throw new HistoryToolGroupValidationError('execution appears after the completed tool group');
        }
        if (!uniqueCalls.has(execution.callId)) {
            throw new HistoryToolGroupValidationError('execution references an undeclared tool call');
        }
        if (execution.callId !== expectedCallId) {
            throw new HistoryToolGroupValidationError('tool executions do not preserve declared call order');
        }
        if (execution.role === 'bashExecution') {
            if (bashSeen) {
                throw new HistoryToolGroupValidationError(`tool call ${execution.callId} has duplicate bash execution`);
            }
            bashSeen = true;
            continue;
        }
        callOrdinal += 1;
        bashSeen = false;
    }
    if (callOrdinal !== input.callIds.length) {
        throw new HistoryToolGroupValidationError(`incomplete tool group: tool call ${input.callIds[callOrdinal]} needs exactly one result`);
    }
}
export function resolveCompletedToolGroup(records, assistantOrdinal) {
    const assistant = records[assistantOrdinal];
    if (!assistant || assistant.message.role !== 'assistant') {
        throw new HistoryToolGroupValidationError('tool group anchor must be an assistant');
    }
    const callIds = readToolCallIds(assistant.message);
    const executions = [];
    let cursor = assistantOrdinal + 1;
    for (; cursor < records.length; cursor += 1) {
        const record = records[cursor];
        if (!record)
            break;
        const role = record.message.role;
        if (role !== 'bashExecution' && role !== 'toolResult')
            break;
        const callId = executionCallId(record) ?? inferBashCallId(records, cursor);
        if (!callId) {
            throw new HistoryToolGroupValidationError('execution has no tool call id');
        }
        executions.push({
            messageId: record.messageId,
            ordinal: cursor,
            callId,
            role,
        });
    }
    validateCompletedToolGroupSequence({ callIds, executions });
    return {
        assistantOrdinal,
        endExclusive: cursor,
        executionMessageIds: executions.map((execution) => execution.messageId),
        executions,
    };
}
function inferBashCallId(records, ordinal) {
    if (records[ordinal]?.message.role !== 'bashExecution')
        return undefined;
    for (let cursor = ordinal + 1; cursor < records.length; cursor += 1) {
        const record = records[cursor];
        if (!record ||
            (record.message.role !== 'bashExecution' && record.message.role !== 'toolResult')) {
            return undefined;
        }
        if (record.message.role === 'toolResult')
            return executionCallId(record);
    }
    return undefined;
}
export function assistantHasToolCalls(record) {
    return record?.message.role === 'assistant' && readToolCallIds(record.message).length > 0;
}
function readToolCallIds(message) {
    if (!Array.isArray(message.content))
        return [];
    const ids = [];
    for (const item of message.content) {
        if (!item || typeof item !== 'object')
            continue;
        const block = item;
        if (block.type === 'toolCall' && typeof block.id === 'string')
            ids.push(block.id);
    }
    return ids;
}
function executionCallId(record) {
    if (record.message.role === 'toolResult') {
        return typeof record.message.toolCallId === 'string' ? record.message.toolCallId : undefined;
    }
    if (typeof record.message.toolCallId === 'string')
        return record.message.toolCallId;
    if (typeof record.message.tool_call_id === 'string')
        return record.message.tool_call_id;
    return undefined;
}
//# sourceMappingURL=completed-tool-group.js.map