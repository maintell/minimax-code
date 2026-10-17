import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function resolveLegacyNativeCandidateInputs(options) {
    return (options.nativeCandidates ?? [
        {
            kind: 'sandbox-data',
            dbPath: join(options.sourceDataDir, 'opencode', 'data', 'opencode', 'opencode.db'),
        },
        {
            kind: 'sandbox-state',
            dbPath: join(options.sourceDataDir, 'opencode', 'state', 'opencode', 'opencode.db'),
        },
        {
            kind: 'xdg-data',
            dbPath: join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db'),
        },
        {
            kind: 'xdg-state',
            dbPath: join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'), 'opencode', 'opencode.db'),
        },
    ]);
}
export class LegacyOpencodeSourceCorruptionError extends Error {
    source;
    name = 'LegacyOpencodeSourceCorruptionError';
    constructor(source) {
        super(`Legacy OpenCode source is corrupt: ${source}`);
        this.source = source;
    }
}
export function decodeLegacyDisplayMessage(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Legacy OpenCode source is corrupt: display-message');
    }
    if (!record(value) || (value.msg_id !== undefined && typeof value.msg_id !== 'string')) {
        throw new Error('Legacy OpenCode source is corrupt: display-message');
    }
    return value;
}
export function buildLegacyMessagePage(messages, input) {
    const options = typeof input === 'number' ? { limit: input } : (input ?? {});
    const before = options.before
        ? messages.findIndex(({ msg_id: messageId }) => messageId === options.before)
        : messages.length;
    const eligible = before < 0 ? messages : messages.slice(0, before);
    const validLimit = options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0;
    const limit = validLimit ? Math.min(1000, Math.floor(options.limit)) : eligible.length;
    const selected = eligible.slice(Math.max(0, eligible.length - limit));
    return {
        messages: selected,
        ...(eligible.length > selected.length && selected[0]?.msg_id
            ? { nextCursor: selected[0].msg_id }
            : {}),
    };
}
export function scanLegacyMessages(raw) {
    return scanLegacyMessageValues(raw);
}
export function scanLegacyMessageValues(raw) {
    const rawHash = createHash('sha256');
    const parsedHash = createHash('sha256');
    parsedHash.update('[');
    const seenIds = new Set();
    const duplicateSourceMsgIds = new Set();
    let sourceCount = 0;
    let parsedCount = 0;
    let parseErrorCount = 0;
    let missingMsgIdCount = 0;
    let duplicateMsgIdCount = 0;
    for (const value of raw) {
        if (sourceCount > 0)
            rawHash.update('\n');
        rawHash.update(value);
        sourceCount += 1;
        try {
            const message = decodeLegacyDisplayMessage(value);
            if (parsedCount > 0)
                parsedHash.update(',');
            parsedHash.update(JSON.stringify(message));
            parsedCount += 1;
            const messageId = message.msg_id;
            if (!messageId)
                missingMsgIdCount += 1;
            else if (seenIds.has(messageId)) {
                duplicateMsgIdCount += 1;
                duplicateSourceMsgIds.add(messageId);
            }
            else
                seenIds.add(messageId);
        }
        catch {
            parseErrorCount += 1;
        }
    }
    parsedHash.update(']');
    return {
        sourceCount,
        parseErrorCount,
        missingMsgIdCount,
        duplicateMsgIdCount,
        duplicateSourceMsgIds: [...duplicateSourceMsgIds],
        rawChecksum: rawHash.digest('hex'),
        parsedChecksum: parsedHash.digest('hex'),
    };
}
export function emptyLegacyMessageScan() {
    return {
        sourceCount: 0,
        parseErrorCount: 0,
        missingMsgIdCount: 0,
        duplicateMsgIdCount: 0,
        duplicateSourceMsgIds: [],
        rawChecksum: hash(''),
        parsedChecksum: hash('[]'),
    };
}
export function normalizeLegacySessionType(value) {
    return value === 1 ? 'root' : 'branch';
}
export function normalizeLegacySessionStatus(value) {
    const normalized = value?.trim().toLowerCase();
    if (matches(normalized, ['finished', 'error', 'aborted', 'interrupted'])) {
        return normalized;
    }
    if (matches(normalized, ['completed', 'complete', 'success', 'succeeded', 'done'])) {
        return 'finished';
    }
    if (matches(normalized, ['failed', 'failure']))
        return 'error';
    if (matches(normalized, ['cancelled', 'canceled']))
        return 'aborted';
    if (!normalized)
        return 'finished';
    if ([
        'started',
        'running',
        'pending',
        'partial',
        'in_progress',
        'queued',
        'processing',
        'streaming',
        'active',
    ].includes(normalized))
        return 'started';
    return 'idle';
}
export function decodeLegacySessionRow(row) {
    const rawStatus = fieldString(row, 'status');
    return {
        sessionId: requiredField(row, 'session_id'),
        agentName: requiredField(row, 'agent_name'),
        workspaceDir: fieldString(row, 'workspace_dir') ?? '',
        runtime: 'opencode',
        sessionType: normalizeLegacySessionType(requiredNumber(row, 'session_type')),
        archived: Boolean(fieldNumber(row, 'compressed') ?? fieldNumber(row, 'archived') ?? 0),
        pinned: Boolean(fieldNumber(row, 'pinned') ?? 0),
        ...(has(row, 'title') ? { title: nullableField(row, 'title') } : {}),
        ...(has(row, 'parent_session_id')
            ? { parentSessionId: nullableField(row, 'parent_session_id') }
            : {}),
        ...extraDataFields(fieldString(row, 'extra_data')),
        status: normalizeLegacySessionStatus(rawStatus),
        createdAtMs: requiredTimestampMs(row, 'created_at'),
        updatedAtMs: requiredTimestampMs(row, 'updated_at'),
        ...namedString('legacyFrameworkSessionId', row, 'framework_session_id'),
        ...(has(row, 'status') ? { legacyRawStatus: rawStatus ?? null } : {}),
    };
}
export function decodeLegacyAgentRow(row) {
    const name = requiredField(row, 'agent_name');
    const displayName = legacyAgentDisplayName(row, name);
    return {
        name,
        displayName,
        ...namedString('description', row, 'description'),
        ...namedString('avatar', row, 'avatar'),
        ...namedString('persona', row, 'persona'),
        ...namedFirstString('systemPrompt', row, ['system_prompt', 'systemPrompt']),
        ...namedFirstString('defaultWorkspaceDir', row, ['default_workspace_dir', 'workspace_dir']),
        ...namedFirstString('rootSessionId', row, ['root_session_id', 'main_session_id']),
        ...namedTimestampMs('createdAtMs', row, 'created_at'),
        ...namedTimestampMs('updatedAtMs', row, 'updated_at'),
    };
}
function legacyAgentDisplayName(row, fallback) {
    if (has(row, 'display_name'))
        return requiredField(row, 'display_name');
    if (has(row, 'agent_display_name'))
        return requiredField(row, 'agent_display_name');
    return fallback;
}
function namedFirstString(key, value, sources) {
    const found = sources.map((source) => fieldString(value, source)).find(Boolean);
    return found ? { [key]: found } : {};
}
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function matches(value, choices) {
    return choices.includes(value ?? '');
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function has(value, key) {
    return record(value) && Object.hasOwn(value, key);
}
function fieldString(value, key) {
    return has(value, key) && typeof value[key] === 'string' ? value[key] : undefined;
}
function requiredField(value, key) {
    const found = fieldString(value, key);
    if (!found)
        corrupt(key);
    return found;
}
function fieldNumber(value, key) {
    const found = has(value, key) ? value[key] : undefined;
    if (typeof found === 'string' && found)
        return Number(found);
    return typeof found === 'number' ? found : undefined;
}
function requiredNumber(value, key) {
    const found = fieldNumber(value, key);
    if (found === undefined || !Number.isFinite(found))
        corrupt(key);
    return Math.floor(found);
}
function fieldTimestampMs(value, key) {
    const found = has(value, key) ? value[key] : undefined;
    if (typeof found === 'number')
        return Number.isFinite(found) ? found : undefined;
    if (typeof found !== 'string')
        return undefined;
    const numeric = Number(found);
    if (Number.isFinite(numeric))
        return numeric;
    const parsed = Date.parse(found);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function requiredTimestampMs(value, key) {
    const found = fieldTimestampMs(value, key);
    if (found === undefined)
        corrupt(key);
    return Math.floor(found);
}
function nullableField(value, key) {
    if (!has(value, key) || value[key] === null)
        return null;
    if (typeof value[key] === 'string')
        return value[key];
    return corrupt(key);
}
function namedString(key, value, source) {
    const found = fieldString(value, source);
    return found ? { [key]: found } : {};
}
function namedTimestampMs(key, value, source) {
    const found = fieldTimestampMs(value, source);
    return found === undefined ? {} : { [key]: found };
}
function extraDataFields(raw) {
    if (!raw)
        return { visibility: 'visible' };
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { visibility: 'visible' };
    }
    if (!record(value))
        return { visibility: 'visible' };
    return {
        visibility: value.visibility === 'hidden' ? 'hidden' : 'visible',
        ...(typeof value.purpose === 'string' && value.purpose ? { purpose: value.purpose } : {}),
    };
}
function corrupt(source) {
    throw new Error(`Legacy OpenCode source is corrupt: ${source}`);
}
//# sourceMappingURL=model.js.map