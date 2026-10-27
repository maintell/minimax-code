import { createHash } from 'node:crypto';
import { parsePluginHookDocuments, PLUGIN_HOOK_EVENTS, } from '@mavis/plugin-hooks';
import { HookConfigError } from './errors.js';
export const MAX_HOOK_CONFIG_BYTES = 256 * 1024;
const MAX_EXECUTABLE_HANDLERS = 64;
const MAX_HOOK_NAME_LENGTH = 64;
const EVENTS = new Set(PLUGIN_HOOK_EVENTS);
const MATCHERLESS_EVENTS = new Set(['UserPromptSubmit', 'Stop']);
const MANAGED_HANDLER_KEYS = new Set([
    'type',
    'name',
    'command',
    'commandWindows',
    'command_windows',
    'timeout',
]);
export function parseHookDocumentText(text) {
    if (Buffer.byteLength(text) > MAX_HOOK_CONFIG_BYTES) {
        return { ok: false, message: 'hooks.json exceeds the 256 KiB limit.' };
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { ok: false, message: 'hooks.json is not valid JSON.' };
    }
    return parseHookDocumentValue(value);
}
export function parseHookDocumentValue(value) {
    if (!isRecord(value))
        return { ok: false, message: 'hooks.json must contain a JSON object.' };
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        return { ok: false, message: 'The top-level "enabled" field must be a boolean.' };
    }
    if (!isRecord(value.hooks)) {
        return { ok: false, message: 'hooks.json must contain a "hooks" object.' };
    }
    for (const [event, groups] of Object.entries(value.hooks)) {
        if (!Array.isArray(groups)) {
            return { ok: false, message: `Hooks for "${event}" must be an array.` };
        }
        for (const group of groups) {
            if (!isRecord(group) || !Array.isArray(group.hooks)) {
                return {
                    ok: false,
                    message: `Each "${event}" entry must be an object with a "hooks" array.`,
                };
            }
        }
    }
    const document = value;
    return {
        ok: true,
        document,
        enabled: document.enabled === true,
        entries: enumerateEntries(document),
    };
}
export function emptyHookDocument() {
    return { hooks: {} };
}
export function serializeHookDocument(document) {
    return `${JSON.stringify(document, null, 2)}\n`;
}
/**
 * Validates and normalizes a settings-page definition with the same parser the
 * runtime uses, so a saved hook is never rejected later as malformed.
 */
export function normalizeHookDefinition(definition) {
    const event = requireSupportedEvent(definition.event);
    const command = trimmedOrUndefined(definition.command);
    if (!command)
        invalidDefinition('HOOK_SCHEMA_INVALID');
    const matcher = MATCHERLESS_EVENTS.has(event)
        ? undefined
        : trimmedOrUndefined(definition.matcher);
    const commandWindows = trimmedOrUndefined(definition.commandWindows);
    const timeout = requireValidTimeout(definition.timeoutSeconds);
    const name = trimmedOrUndefined(definition.name);
    if (name && [...name].length > MAX_HOOK_NAME_LENGTH)
        invalidDefinition('HOOK_NAME_TOO_LONG');
    const normalized = {
        event,
        ...(matcher ? { matcher } : {}),
        command,
        ...(commandWindows ? { commandWindows } : {}),
        ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
        ...(name ? { name } : {}),
    };
    const verdict = validateRawHandler(event, matcher, handlerRecord(normalized));
    if ('errorCode' in verdict)
        invalidDefinition(verdict.errorCode);
    return normalized;
}
export function findHookEntry(entries, hookId) {
    const entry = entries.find((candidate) => candidate.hookId === hookId);
    if (!entry)
        throw new HookConfigError('LOCAL_HOOK_NOT_FOUND', 'Hook was not found.');
    return entry;
}
export function appendHook(source, definition) {
    const document = cloneDocument(source);
    const groups = (document.hooks[definition.event] ??= []);
    groups.push(newGroup(definition));
    return {
        document,
        location: { event: definition.event, groupIndex: groups.length - 1, handlerIndex: 0 },
    };
}
export function replaceHook(source, entry, definition) {
    const document = cloneDocument(source);
    const group = requireGroup(document, entry);
    const handlers = group.hooks;
    const previous = handlers[entry.handlerIndex];
    const handler = handlerRecord(definition, isRecord(previous) ? previous : {});
    if (definition.event === entry.event &&
        definition.matcher === trimmedOrUndefined(group.matcher)) {
        handlers[entry.handlerIndex] = handler;
        return { document, location: entry };
    }
    return { document, location: moveHandler(document, entry, definition, handler) };
}
/** Moves an edited handler into its own group, next to the old one when the event is unchanged. */
function moveHandler(document, entry, definition, handler) {
    const removedGroup = removeHandler(document, entry);
    const replacement = {
        ...(definition.matcher ? { matcher: definition.matcher } : {}),
        hooks: [handler],
    };
    const groups = (document.hooks[definition.event] ??= []);
    if (definition.event !== entry.event) {
        groups.push(replacement);
        return { event: definition.event, groupIndex: groups.length - 1, handlerIndex: 0 };
    }
    const groupIndex = removedGroup ? entry.groupIndex : entry.groupIndex + 1;
    groups.splice(groupIndex, 0, replacement);
    return { event: entry.event, groupIndex, handlerIndex: 0 };
}
export function deleteHook(source, entry) {
    const document = cloneDocument(source);
    removeHandler(document, entry);
    return document;
}
export function setHandlerEnabled(source, entry, enabled) {
    const document = cloneDocument(source);
    const handler = requireGroup(document, entry).hooks[entry.handlerIndex];
    if (!isRecord(handler)) {
        throw new HookConfigError('LOCAL_HOOK_NOT_FOUND', 'Hook was not found.');
    }
    if (enabled)
        delete handler.enabled;
    else
        handler.enabled = false;
    return document;
}
/** Turns the document on with only the handler at `location`, if any, enabled. */
export function enableOnlyHandler(source, entries, location) {
    const document = setDocumentEnabled(cloneDocument(source), true);
    for (const entry of entries) {
        const handler = document.hooks[entry.event]?.[entry.groupIndex]?.hooks?.[entry.handlerIndex];
        if (!isRecord(handler))
            continue;
        if (location && sameLocation(entry, location))
            delete handler.enabled;
        else
            handler.enabled = false;
    }
    return document;
}
export function setDocumentEnabled(source, enabled) {
    const document = cloneDocument(source);
    if ('enabled' in document) {
        document.enabled = enabled;
        return document;
    }
    return { enabled, ...document };
}
export function entryAt(entries, location) {
    return entries.find((entry) => sameLocation(entry, location));
}
/**
 * Pairs each entry that an edit left alone with its entry after the edit. An
 * edit removes at most one handler and inserts at most one, and keeps the
 * traversal order of the rest, so survivors line up by position even when
 * duplicate ids were renumbered.
 */
export function pairSurvivingEntries(before, after, edit) {
    const kept = before.filter((entry) => !edit.removed || !sameLocation(entry, edit.removed));
    const remaining = after.filter((entry) => !edit.inserted || !sameLocation(entry, edit.inserted));
    return kept.flatMap((entry, index) => {
        const next = remaining[index];
        return next ? [[entry, next]] : [];
    });
}
export function limitExceededCount(entries) {
    return entries.filter((entry) => entry.errorCode === 'HOOK_HANDLER_LIMIT_EXCEEDED').length;
}
function sameLocation(left, right) {
    return (left.event === right.event &&
        left.groupIndex === right.groupIndex &&
        left.handlerIndex === right.handlerIndex);
}
function enumerateEntries(document) {
    const state = { entries: [], seenIds: new Map(), executable: 0 };
    for (const [event, groups] of Object.entries(document.hooks)) {
        for (const [groupIndex, group] of groups.entries()) {
            for (const [handlerIndex, rawHandler] of group.hooks.entries()) {
                state.entries.push(describeEntry(state, { event, groupIndex, handlerIndex }, group.matcher, rawHandler));
            }
        }
    }
    return state.entries;
}
function describeEntry(state, location, rawMatcher, rawHandler) {
    const handler = isRecord(rawHandler) ? rawHandler : {};
    const baseId = digestHandler(location.event, rawMatcher, handler);
    const occurrence = (state.seenIds.get(baseId) ?? 0) + 1;
    state.seenIds.set(baseId, occurrence);
    return {
        hookId: occurrence === 1 ? baseId : `${baseId}~${occurrence}`,
        ...location,
        declarationOrder: state.entries.length,
        definition: displayDefinition(location.event, rawMatcher, handler),
        enabledInFile: handler.enabled !== false,
        ...entryVerdict(state, location.event, rawMatcher, rawHandler),
    };
}
function entryVerdict(state, event, rawMatcher, rawHandler) {
    if (!isRecord(rawHandler))
        return { errorCode: 'HOOK_SCHEMA_INVALID' };
    if (rawHandler.enabled !== undefined && typeof rawHandler.enabled !== 'boolean') {
        return { errorCode: 'HOOK_SCHEMA_INVALID' };
    }
    const verdict = validateRawHandler(event, rawMatcher, rawHandler);
    if (!('executable' in verdict))
        return verdict;
    if (state.executable >= MAX_EXECUTABLE_HANDLERS) {
        return { errorCode: 'HOOK_HANDLER_LIMIT_EXCEEDED' };
    }
    state.executable += 1;
    return verdict;
}
function validateRawHandler(event, matcher, handler) {
    const parsed = parsePluginHookDocuments({
        pluginName: 'hook-config',
        pluginRoot: '/',
        sourceFormat: 'MINIMAX',
        documents: [
            {
                sourcePath: 'hooks.json',
                value: {
                    hooks: { [event]: [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [handler] }] },
                },
            },
        ],
    });
    const valid = parsed.handlers[0];
    if (valid) {
        return {
            executable: {
                event: valid.event,
                ...(valid.matcher ? { matcher: valid.matcher } : {}),
                command: valid.command,
                timeoutMs: valid.timeoutMs,
            },
        };
    }
    return { errorCode: parsed.diagnostics[0]?.code ?? 'HOOK_SCHEMA_INVALID' };
}
function digestHandler(event, matcher, handler) {
    const digest = createHash('sha256')
        .update(JSON.stringify([
        event,
        matcher ?? null,
        handler.command ?? null,
        handler.commandWindows ?? handler.command_windows ?? null,
        handler.timeout ?? null,
    ]))
        .digest('hex');
    return `h_${digest.slice(0, 16)}`;
}
function displayDefinition(event, matcher, handler) {
    const commandWindows = handler.commandWindows ?? handler.command_windows;
    const name = trimmedOrUndefined(handler.name);
    return {
        event,
        ...(typeof matcher === 'string' && matcher.trim() ? { matcher } : {}),
        command: typeof handler.command === 'string' ? handler.command : '',
        ...(typeof commandWindows === 'string' && commandWindows.trim() ? { commandWindows } : {}),
        ...(typeof handler.timeout === 'number' ? { timeoutSeconds: handler.timeout } : {}),
        ...(name ? { name } : {}),
    };
}
function handlerRecord(definition, base = {}) {
    const preserved = Object.fromEntries(Object.entries(base).filter(([key]) => !MANAGED_HANDLER_KEYS.has(key)));
    return {
        type: 'command',
        ...(definition.name ? { name: definition.name } : {}),
        command: definition.command,
        ...(definition.commandWindows ? { commandWindows: definition.commandWindows } : {}),
        ...(definition.timeoutSeconds !== undefined ? { timeout: definition.timeoutSeconds } : {}),
        ...preserved,
    };
}
function newGroup(definition) {
    return {
        ...(definition.matcher ? { matcher: definition.matcher } : {}),
        hooks: [handlerRecord(definition)],
    };
}
function requireGroup(document, entry) {
    const group = document.hooks[entry.event]?.[entry.groupIndex];
    if (!group || !Array.isArray(group.hooks) || entry.handlerIndex >= group.hooks.length) {
        throw new HookConfigError('LOCAL_HOOK_NOT_FOUND', 'Hook was not found.');
    }
    return group;
}
/** Removes one handler and prunes empty containers; returns whether its group was removed. */
function removeHandler(document, entry) {
    const group = requireGroup(document, entry);
    group.hooks.splice(entry.handlerIndex, 1);
    if (group.hooks.length > 0)
        return false;
    const groups = document.hooks[entry.event] ?? [];
    groups.splice(entry.groupIndex, 1);
    if (groups.length === 0)
        delete document.hooks[entry.event];
    return true;
}
function cloneDocument(document) {
    return structuredClone(document);
}
function requireSupportedEvent(value) {
    const event = trimmedOrUndefined(value);
    if (!event || !EVENTS.has(event))
        invalidDefinition('HOOK_EVENT_UNSUPPORTED');
    return event;
}
function requireValidTimeout(timeout) {
    if (timeout === undefined)
        return undefined;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10) {
        invalidDefinition('HOOK_SCHEMA_INVALID');
    }
    return timeout;
}
function trimmedOrUndefined(value) {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
}
function invalidDefinition(code) {
    throw new HookConfigError('LOCAL_HOOK_DEFINITION_INVALID', `Hook definition is invalid (${code}).`);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=hook-config-document.js.map