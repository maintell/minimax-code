export function normalizePersistedSessionRecord(record) {
    const sessionKind = normalizePersistedSessionKind(record);
    return {
        ...record,
        sessionType: normalizeSessionType(record.sessionType),
        sessionKind,
        status: normalizePersistedSessionStatus(record.status),
        visibility: normalizeVisibility(sessionKind, record.visibility),
    };
}
export function normalizePersistedSessionKind(input) {
    const sessionKind = input.sessionKind ?? deriveLegacySessionKind(input);
    if (input.sessionType !== undefined &&
        isTaskSession({
            sessionKind,
            sessionType: normalizeSessionType(input.sessionType),
            parentSessionId: input.parentSessionId,
            visibility: input.visibility,
            purpose: input.purpose ?? undefined,
        })) {
        return 'task';
    }
    return sessionKind;
}
export function normalizeSessionType(value, field = 'SessionType') {
    if (value === 'task' || value === 'branch')
        return 'branch';
    if (value === 'root')
        return 'root';
    throw new Error(`${field} must be one of: root, branch, task`);
}
export function normalizePersistedSessionStatus(status) {
    return status === undefined || status === null || status === 'finished' ? 'idle' : status;
}
export function deriveLegacySessionKind(input) {
    const purpose = input.purpose?.trim() ?? '';
    if (input.originCronId || purpose.startsWith('cron:'))
        return 'cron';
    if (isBranchChild(input) && startsWithAny(purpose, TASK_PURPOSE_PREFIXES))
        return 'task';
    if (isBranchChild(input) && startsWithAny(purpose, PEEK_PURPOSE_PREFIXES))
        return 'peek';
    if (startsWithAny(purpose, CHANNEL_PURPOSE_PREFIXES))
        return 'channel';
    return purpose ? 'unknown' : 'conversation';
}
/**
 * A pre-`session_kind` Task remains a Task when its hidden branch purpose
 * carries one of the durable Task prefixes.  New rows use `sessionKind`.
 */
export function isTaskSession(input) {
    return (input.sessionKind === 'task' ||
        (input.sessionType === 'branch' &&
            Boolean(input.parentSessionId) &&
            input.visibility === 'hidden' &&
            startsWithAny(input.purpose?.trim() ?? '', TASK_PURPOSE_PREFIXES)));
}
export function isPeekSession(input) {
    return (input.sessionKind === 'peek' ||
        (input.sessionType === 'branch' &&
            Boolean(input.parentSessionId) &&
            input.visibility === 'hidden' &&
            startsWithAny(input.purpose?.trim() ?? '', PEEK_PURPOSE_PREFIXES)));
}
export function sessionKindForLegacyPurposePrefix(prefix) {
    const normalized = prefix?.trim() ?? '';
    if (!normalized)
        return undefined;
    if (normalized === 'cron:')
        return 'cron';
    if (TASK_PURPOSE_PREFIXES.some((candidate) => normalized === candidate))
        return 'task';
    if (PEEK_PURPOSE_PREFIXES.some((candidate) => normalized === candidate))
        return 'peek';
    if (CHANNEL_PURPOSE_PREFIXES.some((candidate) => normalized === candidate))
        return 'channel';
    return undefined;
}
export function applySessionUpdate(existing, fields, fallbackUpdatedAtMs) {
    return {
        ...existing,
        ...pickDefinedUpdateFields(fields),
        ...(fields.sessionType === undefined
            ? {}
            : { sessionType: normalizeSessionType(fields.sessionType) }),
        ...pickOwnedUpdateFields(fields),
        updatedAtMs: fields.updatedAtMs ?? fallbackUpdatedAtMs,
    };
}
function normalizeVisibility(sessionKind, visibility) {
    if (sessionKind === 'task')
        return 'visible';
    if (sessionKind === 'peek' || sessionKind === 'channel')
        return 'hidden';
    return visibility;
}
function isBranchChild(input) {
    return ((input.sessionType === 'branch' || input.sessionType === 'task') &&
        Boolean(input.parentSessionId));
}
function startsWithAny(value, prefixes) {
    return prefixes.some((prefix) => value.startsWith(prefix));
}
function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
const DEFINED_UPDATE_FIELDS = [
    'agentName',
    'workspaceDir',
    'archived',
    'visibility',
    'status',
];
const OWNED_UPDATE_FIELDS = [
    'isDefaultWorkspace',
    'title',
    'parentSessionId',
    'purpose',
    'runLocation',
    'appMode',
    'interactionMode',
    'memoryPolicy',
    'errorMessage',
    'errorCode',
    'errorSource',
    'errorDetail',
    'errorProviderId',
    'effectiveModel',
    'effectiveModelVariant',
    'effectiveModelThinking',
    'effectiveModelContextWindow',
    'effectiveModelMaxOutputTokens',
    'scratchpadPath',
    'origin',
];
function pickDefinedUpdateFields(fields) {
    return Object.fromEntries(DEFINED_UPDATE_FIELDS.filter((key) => fields[key] !== undefined).map((key) => [
        key,
        fields[key],
    ]));
}
function pickOwnedUpdateFields(fields) {
    return Object.fromEntries(OWNED_UPDATE_FIELDS.filter((key) => own(fields, key)).map((key) => [key, fields[key]]));
}
const TASK_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:', 'team-plan:'];
const PEEK_PURPOSE_PREFIXES = ['peek_', 'peek:'];
const CHANNEL_PURPOSE_PREFIXES = ['channel:', 'im:'];
//# sourceMappingURL=normalization.js.map