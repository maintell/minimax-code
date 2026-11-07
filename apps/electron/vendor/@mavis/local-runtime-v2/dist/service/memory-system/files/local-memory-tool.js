import { LocalMemoryFacade } from './local-memory-facade.js';
import { formatLocalDate } from './local-memory-store-utils.js';
import { LocalMemoryError } from './types.js';
import { emitResourceAmbiguityTelemetry } from '../../agent/index.js';
const VALID = new Set([
    'user:read',
    'user:search',
    'user:append',
    'main:read',
    'main:search',
    'main:append',
    'main:edit',
    'main:write',
    'topic:read',
    'topic:search',
    'topic:append',
    'topic:edit',
    'topic:create',
    'topic:delete',
    'summary:write',
]);
const READ_OPERATIONS = new Set([
    'user:read',
    'user:search',
    'main:read',
    'main:search',
    'topic:read',
    'topic:search',
]);
export async function executeLocalMemoryTool(...args) {
    const execution = args.length === 1
        ? args[0]
        : {
            facade: args[0],
            ctx: args[1],
            input: args[2],
            emitBusEvent: args[3],
            metrics: args[4],
            readAgentNames: args[5],
            access: args[6],
        };
    const { input, metrics } = execution;
    const access = typeof execution.access === 'boolean'
        ? { agentScopeEnabled: execution.access }
        : execution.access;
    const result = await runLocalMemoryTool({ ...execution, access });
    const key = `${input.target}:${input.operation}`;
    // Bounded label guard: only the VALID enum reaches the metric; anything else
    // (user-supplied strings) collapses to 'invalid'.
    metrics?.incr('memory_tool_call_total', {
        operation: VALID.has(key) ? key : 'invalid',
        status: result.details.ok === false ? 'error' : 'ok',
    });
    // Structured copy of the same result for PTC programs; the text is unchanged.
    const common = { target: input.target, operation: input.operation };
    return {
        text: result.text,
        details: result.details,
        data: result.details.ok === false
            ? { ok: false, ...common, code: 'code' in result.details ? result.details.code : undefined }
            : { ok: true, ...common, ...('data' in result ? result.data : {}) },
    };
}
function validateMemoryAccess(input, access) {
    const key = `${input.target}:${input.operation}`;
    if (!VALID.has(key))
        throw new LocalMemoryError('INVALID_OPERATION', `invalid memory operation ${key}`);
    if (input.target !== 'user' && access?.agentScopeEnabled !== true) {
        throw new LocalMemoryError('AGENT_SCOPE_DISABLED', 'Agent-scoped Memory is unavailable for this Agent profile.');
    }
    if (input.target !== 'user' && READ_OPERATIONS.has(key) && access?.readEnabled === false) {
        throw new LocalMemoryError('MEMORY_READ_DISABLED', 'Memory reads are disabled for this session.');
    }
    if (!READ_OPERATIONS.has(key) && access?.writeEnabled === false) {
        throw new LocalMemoryError('MEMORY_WRITE_DISABLED', 'Memory writes are disabled for this session.');
    }
}
async function runLocalMemoryTool(execution) {
    const { ctx, input, emitBusEvent, readAgentNames, access } = execution;
    try {
        const key = `${input.target}:${input.operation}`;
        validateMemoryAccess(input, access);
        // user target → user scope; main/topic/summary → agent scope addressed by the
        // session's agent directory name. Local agents have no numeric id, so the
        // schema's optional `agentId` is ignored here.
        const scope = input.target === 'user' ? 'user' : 'agent';
        const agentName = scope === 'agent' ? requireAgentName(ctx.agentName) : '';
        const memoryReadNames = scope === 'agent' ? normalizeReadAgentNames(agentName, readAgentNames) : [];
        const handler = createMemoryOperationHandlers({
            ...execution,
            memoryReadNames,
            scope,
            agentName,
        })[key];
        if (!handler)
            throw new LocalMemoryError('INVALID_OPERATION', `invalid memory operation ${key}`);
        return await handler();
    }
    catch (err) {
        const code = err instanceof LocalMemoryError ? err.code : 'LOCAL_MEMORY_TOOL_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        // The failure is already returned to the model as the tool result text, but
        // emit a memory-domain event too so "which memory operation failed for which
        // agent and why" is one queryable bus event, not a parse of tool-result text.
        // Metadata only — never the memory content.
        emitBusEvent?.('memory.tool_failed', {
            operation: `${input.target}:${input.operation}`,
            sessionId: ctx.sessionId,
            agentName: ctx.agentName,
            code,
            message,
        });
        return { text: `memory tool failed [${code}]: ${message}`, details: { ok: false, code } };
    }
}
function createMemoryOperationHandlers(context) {
    const { facade, input, memoryReadNames, agentName } = context;
    const mark = (text, data = {}) => markMemoryWritten(context, text, data);
    return {
        'user:read': async () => {
            const memory = await facade.getUserMemory();
            return ok(memory.content, { target: input.target }, readData(memory));
        },
        'main:read': () => readMainMemory(facade, memoryReadNames, input.target),
        'user:search': async () => {
            const matches = await facade.searchUserMemory(requireString(input.query, 'query'));
            return ok(JSON.stringify(matches, null, 2), {}, { matches });
        },
        'main:search': async () => {
            const query = requireString(input.query, 'query');
            const matches = await searchMainMemory(facade, memoryReadNames, query);
            return ok(JSON.stringify(matches, null, 2), {}, { matches });
        },
        'user:append': async () => {
            const content = requireString(input.content, 'content');
            const { sizeBytes } = await facade.appendUserMemory(content, input.reason);
            return ok(`Appended user memory (${sizeBytes} bytes).`, {}, { sizeBytes });
        },
        'main:append': async () => {
            const content = requireString(input.content, 'content');
            const { sizeBytes } = await facade.appendMemory(agentName, content);
            return mark(`Appended memory (${sizeBytes} bytes).`, { sizeBytes });
        },
        'main:edit': async () => {
            const result = await facade.editMemory(agentName, requireString(input.oldString, 'oldString'), requireString(input.newString, 'newString'), input.replaceAll);
            return mark(`Edited memory: ${result.replacements} replacement(s).`, {
                replacements: result.replacements,
                sizeBytes: result.result.sizeBytes,
            });
        },
        'main:write': async () => {
            const content = requireString(input.content, 'content');
            const { sizeBytes } = await facade.writeMemory(agentName, content);
            return mark(`Wrote memory (${sizeBytes} bytes).`, { sizeBytes });
        },
        'topic:read': () => readTopicMemory(facade, memoryReadNames, requireString(input.topicName, 'topicName'), context),
        'topic:search': async () => {
            const query = requireString(input.query, 'query');
            const topics = await searchTopicMemory(facade, memoryReadNames, query);
            return ok(JSON.stringify(topics, null, 2), {}, { topics });
        },
        'topic:append': async () => {
            const topicName = requireString(input.topicName, 'topicName');
            const content = requireString(input.content, 'content');
            const { newSizeBytes } = await facade.appendTopic(agentName, topicName, content);
            return mark(`Appended topic (${newSizeBytes} bytes).`, { sizeBytes: newSizeBytes });
        },
        'topic:edit': async () => {
            const result = await facade.editTopic(agentName, {
                topicName: requireString(input.topicName, 'topicName'),
                oldString: requireString(input.oldString, 'oldString'),
                newString: requireString(input.newString, 'newString'),
                replaceAll: input.replaceAll,
            });
            return mark(`Edited topic: ${result.replacements} replacement(s).`, {
                replacements: result.replacements,
                sizeBytes: result.newSizeBytes,
            });
        },
        'topic:create': async () => {
            await facade.writeTopic(agentName, requireString(input.topicName, 'topicName'), input.description ?? '', requireString(input.content, 'content'));
            return mark('Created topic memory.');
        },
        'topic:delete': async () => {
            const topicName = requireString(input.topicName, 'topicName');
            const deleted = await facade.deleteTopic(agentName, topicName);
            return mark(`Deleted topic: ${deleted}.`, { deleted });
        },
        'summary:write': async () => {
            await facade.writeMemorySummary(agentName, requireString(input.content, 'content'));
            return mark('Wrote memory summary.');
        },
    };
}
async function markMemoryWritten({ facade, ctx, scope, emitBusEvent }, text, data = {}) {
    if (ctx.sessionId && scope === 'agent' && ctx.agentName) {
        try {
            await facade.markSession(today(), ctx.sessionId, ctx.agentName, true);
        }
        catch (err) {
            // Memory write succeeded but tracking did not — without this the session's
            // wroteMemory/reflection state silently drifts and "why was this session not
            // flagged as having written memory" is only inferable by absence.
            emitBusEvent?.('memory.tool_tracking_failed', {
                sessionId: ctx.sessionId,
                agentName: ctx.agentName,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return ok(text, {}, data);
}
function normalizeReadAgentNames(executionTarget, readAgentNames) {
    const names = [executionTarget, ...(readAgentNames ?? [])]
        .map((name) => name.trim())
        .filter(Boolean);
    return [...new Set(names)];
}
async function readMainMemory(facade, sourceNames, target) {
    const entries = await readSources(sourceNames, (sourceAgent) => facade.getAgentMemory(sourceAgent));
    const nonEmpty = entries.filter(({ value }) => value.content.trim().length > 0);
    const sources = nonEmpty.map(({ sourceAgent, value }) => ({
        sourceAgent,
        content: value.content,
    }));
    const single = sourceNames.length <= 1 ? entries[0]?.value : undefined;
    const text = sourceNames.length <= 1 ? (single?.content ?? '') : JSON.stringify(sources, null, 2);
    let data = { content: '', sizeBytes: 0 };
    if (sourceNames.length > 1)
        data = { sources };
    else if (single)
        data = readData(single);
    return ok(text, {
        target,
        ...(sourceNames.length > 1
            ? { sourceAgents: nonEmpty.map(({ sourceAgent }) => sourceAgent) }
            : {}),
    }, data);
}
async function searchMainMemory(facade, sourceNames, query) {
    const entries = await readSources(sourceNames, (sourceAgent) => facade.searchMemory(sourceAgent, query));
    if (sourceNames.length <= 1)
        return entries[0]?.value ?? [];
    return entries.flatMap(({ sourceAgent, value }) => value.map((result) => ({ ...result, sourceAgent })));
}
async function readTopicMemory(facade, sourceNames, topicName, { emitBusEvent, metrics }) {
    const candidates = (await readSources(sourceNames, async (sourceAgent) => {
        const topics = await facade.listTopics(sourceAgent);
        if (!topics.some((topic) => topic.name === topicName))
            return undefined;
        return facade.getTopic(sourceAgent, topicName);
    })).flatMap(({ sourceAgent, value }) => (value ? [{ sourceAgent, value }] : []));
    const empty = { content: '', sizeBytes: 0 };
    if (sourceNames.length <= 1) {
        const topic = candidates[0]?.value;
        // description is not part of this text, so data leaves it out too.
        return ok(topic?.body ?? '', {}, topic ? { content: topic.body, sizeBytes: topic.sizeBytes } : empty);
    }
    if (candidates.length === 0)
        return ok('', {}, empty);
    const canonical = candidates.find(({ sourceAgent }) => sourceAgent === sourceNames[0]);
    if (!canonical && candidates.length > 1) {
        emitResourceAmbiguityTelemetry({ emitBusEvent, metrics }, 'memory', candidates.length);
        throw new LocalMemoryError('AMBIGUOUS_AGENT_RESOURCE', `Memory topic:${topicName} is ambiguous across sources: ${candidates
            .map(({ sourceAgent }) => sourceAgent)
            .join(', ')}`);
    }
    const selected = canonical ?? candidates[0];
    const { name, description, body, sizeBytes } = selected.value;
    return ok(JSON.stringify({ sourceAgent: selected.sourceAgent, ...selected.value }, null, 2), {}, {
        sourceAgent: selected.sourceAgent,
        name,
        description,
        content: body,
        sizeBytes,
    });
}
async function searchTopicMemory(facade, sourceNames, query) {
    const entries = await readSources(sourceNames, (sourceAgent) => facade.searchTopics(sourceAgent, query));
    if (sourceNames.length <= 1)
        return entries[0]?.value ?? [];
    return entries.flatMap(({ sourceAgent, value }) => value.map((result) => ({ ...result, sourceAgent })));
}
async function readSources(sourceNames, read) {
    return Promise.all(sourceNames.map(async (sourceAgent) => ({
        sourceAgent,
        value: await read(sourceAgent),
    })));
}
function requireAgentName(agentName) {
    const normalized = agentName?.trim();
    if (!normalized)
        throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'agent_name is required');
    return normalized;
}
function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0)
        throw new LocalMemoryError('MISSING_FIELD', `${name} is required`);
    return value;
}
function ok(text, details = {}, data = {}) {
    return { text, details: { ok: true, ...details }, data };
}
function readData(memory) {
    return {
        content: memory.content,
        sizeBytes: memory.sizeBytes,
        ...(memory.updatedAt ? { updatedAt: memory.updatedAt } : {}),
    };
}
function today() {
    return formatLocalDate();
}
//# sourceMappingURL=local-memory-tool.js.map