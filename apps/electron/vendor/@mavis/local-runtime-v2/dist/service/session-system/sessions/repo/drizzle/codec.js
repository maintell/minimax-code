import { parseAgentShellPreference, parseResolvedAgentShell, } from '../../../../agent-shell/index.js';
import { canonicalProjectWorkspaceDir } from '../../../shared/workspace.js';
import { SESSION_KINDS, SESSION_RUN_LOCATION_MODES, SESSION_RUNTIMES, SESSION_STATUSES, SESSION_VISIBILITIES, } from '../contract.js';
import { normalizePersistedSessionKind, normalizeSessionType } from './normalization.js';
import { readSessionMemoryPolicy } from '../../memory-policy.js';
export const CURRENT_SESSION_COLUMNAR_VERSION = 3;
export function encodeSessionRow(record, options) {
    const sessionType = normalizeSessionType(record.sessionType, 'Session.sessionType');
    validateSessionRecord({ ...record, sessionType });
    return {
        sessionId: record.sessionId,
        recordJson: preservedRecordJson({ ...record, sessionType }, options),
        updatedAtMs: record.updatedAtMs,
        columnarVersion: CURRENT_SESSION_COLUMNAR_VERSION,
        agentName: record.agentName,
        runtime: record.runtime,
        sessionType,
        status: record.status,
        archived: booleanBit(record.archived),
        visibility: valueOr(record.visibility, 'visible'),
        sessionKind: record.sessionKind,
        purpose: nullable(record.purpose),
        purposeKind: '',
        originCronId: nullable(record.originCronId),
        parentSessionId: nullable(record.parentSessionId),
        workspaceDir: record.workspaceDir,
        projectWorkspaceDir: nullable(canonicalProjectWorkspaceDir(record.workspaceDir, record.runLocation)),
        isDefaultWorkspace: booleanBit(record.isDefaultWorkspace === true),
        title: nullable(record.title),
        createdAtMs: record.createdAtMs,
        errorMessage: nullable(record.errorMessage),
        errorCode: nullable(record.errorCode),
        extraDataJson: serializeSessionExtraData(sessionExtraDataFromRecord({ ...record, sessionType })),
        projectId: projectId(options),
        historyRelativeDir: nullable(record.historyRelativeDir),
    };
}
export function decodeSessionRow(row) {
    if (row.columnarVersion !== CURRENT_SESSION_COLUMNAR_VERSION) {
        throw new Error(`Session ${row.sessionId}.columnar_version must be ${String(CURRENT_SESSION_COLUMNAR_VERSION)}`);
    }
    const updatedAtMs = requireSafeInteger(row.updatedAtMs, `Session ${row.sessionId}.updated_at_ms`);
    const extra = parseSessionExtraData(row.extraDataJson);
    const sessionType = normalizeSessionType(row.sessionType, `Session ${row.sessionId}.session_type`);
    const visibility = requireEnum(row.visibility, SESSION_VISIBILITIES, `Session ${row.sessionId}.visibility`);
    const sessionKind = normalizePersistedSessionKind({
        sessionKind: requireEnum(row.sessionKind, SESSION_KINDS, `Session ${row.sessionId}.session_kind`),
        sessionType,
        parentSessionId: row.parentSessionId,
        visibility,
        ...(row.purpose !== null ? { purpose: row.purpose } : {}),
        ...(row.originCronId !== null ? { originCronId: row.originCronId } : {}),
    });
    return withoutRootAppMode({
        sessionId: row.sessionId,
        agentName: requireString(row.agentName, `Session ${row.sessionId}.agent_name`),
        workspaceDir: requireString(row.workspaceDir, `Session ${row.sessionId}.workspace_dir`),
        isDefaultWorkspace: requireBit(row.isDefaultWorkspace, `Session ${row.sessionId}.is_default_workspace`) === 1,
        runtime: requireEnum(row.runtime, SESSION_RUNTIMES, `Session ${row.sessionId}.runtime`),
        sessionType,
        sessionKind,
        archived: requireBit(row.archived, `Session ${row.sessionId}.archived`) === 1,
        title: row.title,
        parentSessionId: row.parentSessionId,
        visibility,
        ...(row.purpose !== null ? { purpose: row.purpose } : {}),
        ...(row.originCronId !== null ? { originCronId: row.originCronId } : {}),
        ...extra,
        sessionDataVersion: nativeSessionDataVersion(row, extra),
        status: requireEnum(row.status, SESSION_STATUSES, `Session ${row.sessionId}.status`),
        ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
        ...(row.errorCode !== null
            ? {
                errorCode: requireSafeInteger(row.errorCode, `Session ${row.sessionId}.error_code`),
            }
            : {}),
        ...(row.historyRelativeDir !== null ? { historyRelativeDir: row.historyRelativeDir } : {}),
        createdAtMs: row.createdAtMs === null
            ? updatedAtMs
            : requireSafeInteger(row.createdAtMs, `Session ${row.sessionId}.created_at_ms`),
        updatedAtMs,
    });
}
function nativeSessionDataVersion(row, extra) {
    if (extra.sessionDataVersion !== undefined)
        return extra.sessionDataVersion;
    // Early native SideChat records omitted this field but wrote format 4 history.
    // Keep the historical format fixed when CURRENT_SESSION_DATA_VERSION advances.
    if (row.runtime === 'pi-agent' &&
        extra.sessionOrigin === 'local-runtime' &&
        extra.sideChatOrigin &&
        row.historyRelativeDir)
        return 4;
    return undefined;
}
export function sessionExtraDataFromRecord(record) {
    return compactExtraData({
        agentShell: record.agentShell,
        agentShellPreference: record.agentShellPreference,
        titleSource: record.titleSource,
        runLocation: record.runLocation,
        appMode: record.sessionType === 'branch' ? record.appMode : undefined,
        interactionMode: record.interactionMode,
        memoryPolicy: record.memoryPolicy,
        errorSource: record.errorSource,
        errorDetail: record.errorDetail,
        errorProviderId: record.errorProviderId,
        effectiveModel: record.effectiveModel,
        effectiveModelVariant: record.effectiveModelVariant,
        effectiveModelThinking: record.effectiveModelThinking,
        effectiveModelContextWindow: record.effectiveModelContextWindow,
        effectiveModelMaxOutputTokens: record.effectiveModelMaxOutputTokens,
        scratchpadPath: record.scratchpadPath,
        origin: record.origin,
        sideChatOrigin: record.sideChatOrigin,
        sessionDataVersion: record.sessionDataVersion,
        sessionOrigin: record.sessionOrigin,
        miniAppOrigin: record.miniAppOrigin,
        createdBySessionId: record.createdBySessionId,
    });
}
export function withoutRootAppMode(record) {
    if (record.sessionType !== 'root' || record.appMode === undefined)
        return record;
    const normalized = { ...record };
    delete normalized.appMode;
    return normalized;
}
export function serializeSessionExtraData(data) {
    validateExtraData(data);
    return JSON.stringify(compactExtraData(data));
}
export function parseSessionExtraData(raw) {
    const record = parseJsonObject(raw, 'extra_data_json');
    const runLocation = readRunLocation(record);
    return compactExtraData({
        runLocation,
        sideChatOrigin: readSideChatOrigin(record),
        titleSource: readOptionalEnum(record, 'titleSource', ['default', 'auto', 'manual'], 'extra_data_json'),
        appMode: readOptionalEnum(record, 'appMode', ['coding', 'work'], 'extra_data_json'),
        interactionMode: readOptionalEnum(record, 'interactionMode', ['plan', 'goal'], 'extra_data_json'),
        agentShell: record.agentShell === undefined ? undefined : parseResolvedAgentShell(record.agentShell),
        agentShellPreference: record.agentShellPreference === undefined
            ? undefined
            : parseAgentShellPreference(record.agentShellPreference),
        memoryPolicy: readOptionalSessionMemoryPolicy(record, 'memoryPolicy', 'extra_data_json'),
        errorSource: readOptionalString(record, 'errorSource', 'extra_data_json'),
        errorDetail: readOptionalString(record, 'errorDetail', 'extra_data_json'),
        errorProviderId: readOptionalString(record, 'errorProviderId', 'extra_data_json'),
        effectiveModel: readOptionalNullableString(record, 'effectiveModel', 'extra_data_json'),
        effectiveModelVariant: readOptionalNullableString(record, 'effectiveModelVariant', 'extra_data_json'),
        effectiveModelThinking: readOptionalModelThinkingSelection(record, 'effectiveModelThinking', 'extra_data_json'),
        effectiveModelContextWindow: readOptionalPositiveSafeInteger(record, 'effectiveModelContextWindow', 'extra_data_json'),
        effectiveModelMaxOutputTokens: readOptionalPositiveSafeInteger(record, 'effectiveModelMaxOutputTokens', 'extra_data_json'),
        scratchpadPath: readOptionalString(record, 'scratchpadPath', 'extra_data_json'),
        origin: readOptionalEnum(record, 'origin', ['user', 'root-repair'], 'extra_data_json'),
        sessionDataVersion: readOptionalSafeInteger(record, 'sessionDataVersion', 'extra_data_json'),
        sessionOrigin: readOptionalEnum(record, 'sessionOrigin', ['local-runtime', 'legacy-opencode', 'unknown'], 'extra_data_json'),
        miniAppOrigin: readMiniAppOrigin(record.miniAppOrigin),
        createdBySessionId: readOptionalString(record, 'createdBySessionId', 'extra_data_json'),
    });
}
/** Lenient: an unrecognized origin shape means "not a Mini App session", never a decode failure. */
function readMiniAppOrigin(value) {
    if (!isPlainObject(value))
        return undefined;
    const { pluginId, createdAtMs, hostSessionId } = value;
    if (typeof pluginId !== 'string' || pluginId.length === 0)
        return undefined;
    if (typeof createdAtMs !== 'number' || !Number.isSafeInteger(createdAtMs))
        return undefined;
    return {
        pluginId,
        createdAtMs,
        ...(typeof hostSessionId === 'string' && hostSessionId.length > 0 ? { hostSessionId } : {}),
    };
}
function validateExtraData(data) {
    if (data.runLocation) {
        assertSafeInteger(data.runLocation.createdAt, 'extra_data_json.runLocation.createdAt');
    }
    if (data.sessionDataVersion !== undefined) {
        assertSafeInteger(data.sessionDataVersion, 'extra_data_json.sessionDataVersion');
    }
    if (data.effectiveModelThinking) {
        validateModelThinkingSelection(data.effectiveModelThinking, 'extra_data_json.effectiveModelThinking');
    }
    assertOptionalPositiveSafeInteger(data.effectiveModelContextWindow, 'extra_data_json.effectiveModelContextWindow');
    assertOptionalPositiveSafeInteger(data.effectiveModelMaxOutputTokens, 'extra_data_json.effectiveModelMaxOutputTokens');
    if (data.memoryPolicy) {
        readSessionMemoryPolicy(data.memoryPolicy, 'extra_data_json.memoryPolicy');
    }
}
function readOptionalSessionMemoryPolicy(record, key, field) {
    const value = record[key];
    return value === undefined || value === null
        ? undefined
        : readSessionMemoryPolicy(value, `${field}.${key}`);
}
function readOptionalModelThinkingSelection(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return value;
    if (!isPlainObject(value))
        throw new Error(`${field}.${key} must be an object or null`);
    const selection = {
        ...optionalThinkingString(value, 'effort', `${field}.${key}`),
        ...optionalThinkingString(value, 'off_behavior', `${field}.${key}`),
        ...optionalThinkingBudgets(value, `${field}.${key}`),
    };
    return Object.keys(selection).length > 0 ? selection : null;
}
function validateModelThinkingSelection(selection, field) {
    if (selection.effort !== undefined && typeof selection.effort !== 'string') {
        throw new Error(`${field}.effort must be a string`);
    }
    if (selection.off_behavior !== undefined && typeof selection.off_behavior !== 'string') {
        throw new Error(`${field}.off_behavior must be a string`);
    }
    if (selection.budgets) {
        for (const key of ['minimal', 'low', 'medium', 'high']) {
            const value = selection.budgets[key];
            if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') {
                throw new Error(`${field}.budgets.${key} must be a string or number`);
            }
        }
    }
}
function optionalThinkingString(record, key, field) {
    const value = readOptionalString(record, key, field);
    return value === undefined ? {} : { [key]: value };
}
function optionalThinkingBudgets(record, field) {
    const value = record.budgets;
    if (value === undefined || value === null)
        return {};
    if (!isPlainObject(value))
        throw new Error(`${field}.budgets must be an object`);
    const budgets = {};
    for (const key of ['minimal', 'low', 'medium', 'high']) {
        const budget = value[key];
        if (budget === undefined || budget === null)
            continue;
        if (typeof budget !== 'string' && typeof budget !== 'number') {
            throw new Error(`${field}.budgets.${key} must be a string or number`);
        }
        budgets[key] = budget;
    }
    return Object.keys(budgets).length > 0 ? { budgets } : {};
}
function readSideChatOrigin(record) {
    const value = readOptionalObject(record, 'sideChatOrigin', 'extra_data_json');
    if (!value)
        return undefined;
    return {
        mainSessionId: readRequiredString(value, 'mainSessionId', 'sideChatOrigin'),
        capturedAtMs: requireSafeInteger(value.capturedAtMs, 'sideChatOrigin.capturedAtMs'),
        historyRevision: readRequiredString(value, 'historyRevision', 'sideChatOrigin'),
        ...(value.sourceMessageId === undefined
            ? {}
            : {
                sourceMessageId: readRequiredString(value, 'sourceMessageId', 'sideChatOrigin'),
            }),
        ...(value.inheritedThroughMessageId === undefined
            ? {}
            : {
                inheritedThroughMessageId: readRequiredString(value, 'inheritedThroughMessageId', 'sideChatOrigin'),
            }),
    };
}
function readRunLocation(record) {
    const value = readOptionalObject(record, 'runLocation', 'extra_data_json');
    if (!value)
        return undefined;
    const resolvedBranch = readOptionalString(value, 'resolvedBranch', 'extra_data_json.runLocation');
    const parentRepoDir = readOptionalString(value, 'parentRepoDir', 'extra_data_json.runLocation');
    return {
        mode: requireEnum(readRequiredString(value, 'mode', 'extra_data_json.runLocation'), SESSION_RUN_LOCATION_MODES, 'extra_data_json.runLocation.mode'),
        resolvedDir: readRequiredString(value, 'resolvedDir', 'extra_data_json.runLocation'),
        ...(resolvedBranch !== undefined ? { resolvedBranch } : {}),
        ...(parentRepoDir !== undefined ? { parentRepoDir } : {}),
        createdAt: requireSafeInteger(value.createdAt, 'extra_data_json.runLocation.createdAt'),
    };
}
function validateSessionRecord(record) {
    assertSafeInteger(record.createdAtMs, 'Session.createdAtMs');
    assertSafeInteger(record.updatedAtMs, 'Session.updatedAtMs');
    if (record.errorCode !== undefined)
        assertSafeInteger(record.errorCode, 'Session.errorCode');
}
function preservedRecordJson(record, options) {
    return options?.preservedRecordJson ?? v1InertRecordJson(record);
}
function v1InertRecordJson(record) {
    return JSON.stringify({
        sessionId: record.sessionId,
        agentName: '__local_runtime_v2__',
        workspaceDir: record.workspaceDir,
        runtime: record.runtime,
        sessionType: record.sessionType,
        archived: true,
        visibility: 'hidden',
        status: 'idle',
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
    });
}
function projectId(options) {
    return options?.projectId ?? null;
}
function booleanBit(value) {
    return value ? 1 : 0;
}
function nullable(value) {
    return value ?? null;
}
function valueOr(value, fallback) {
    return value ?? fallback;
}
function compactExtraData(data) {
    return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
function parseJsonObject(raw, field) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`${field} is not valid JSON`, { cause: error });
    }
    if (!isPlainObject(parsed))
        throw new Error(`${field} must be an object`);
    return parsed;
}
function readRequiredString(record, key, field) {
    const value = record[key];
    if (typeof value !== 'string')
        throw new Error(`${field}.${key} must be a string`);
    return value;
}
function readOptionalString(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`${field}.${key} must be a string`);
    return value;
}
function readOptionalNullableString(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return value;
    if (typeof value !== 'string')
        throw new Error(`${field}.${key} must be a string or null`);
    return value;
}
function readOptionalSafeInteger(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    return requireSafeInteger(value, `${field}.${key}`);
}
function readOptionalPositiveSafeInteger(record, key, field) {
    const raw = record[key];
    if (raw === undefined || raw === null)
        return raw;
    const value = requireSafeInteger(raw, `${field}.${key}`);
    if (value <= 0) {
        throw new Error(`${field}.${key} must be a positive safe integer`);
    }
    return value;
}
function readOptionalObject(record, key, field) {
    const value = record[key];
    if (value === undefined || value === null)
        return undefined;
    if (!isPlainObject(value))
        throw new Error(`${field}.${key} must be an object`);
    return value;
}
function readOptionalEnum(record, key, allowed, field) {
    const value = readOptionalString(record, key, field);
    return value === undefined ? undefined : requireEnum(value, allowed, `${field}.${key}`);
}
function requireString(value, field) {
    if (value === null)
        throw new Error(`${field} must be a string`);
    return value;
}
function requireEnum(value, allowed, field) {
    const result = allowed.find((candidate) => candidate === value);
    if (result === undefined)
        throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
    return result;
}
function requireBit(value, field) {
    if (value !== 0 && value !== 1)
        throw new Error(`${field} must be 0 or 1`);
    return value;
}
function assertSafeInteger(value, field) {
    requireSafeInteger(value, field);
}
function assertOptionalPositiveSafeInteger(value, field) {
    if (value === undefined || value === null)
        return;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive safe integer`);
    }
}
function requireSafeInteger(value, field) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${field} must be a safe integer`);
    }
    return value;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codec.js.map