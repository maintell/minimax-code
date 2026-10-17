import { PLUGIN_HOOK_EVENTS, } from './contracts.js';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_EXECUTABLE_HANDLERS = 64;
const MAX_MATCHER_LENGTH = 256;
const EVENT_NAMES = new Set(PLUGIN_HOOK_EVENTS);
export function parsePluginHookDocuments(input) {
    const handlers = [];
    const diagnostics = [];
    let declarationOrder = 0;
    for (const document of input.documents) {
        const hooks = readHooksEnvelope(document.value);
        if (!hooks) {
            diagnostics.push(baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'));
            continue;
        }
        for (const [rawEvent, rawGroups] of Object.entries(hooks)) {
            if (!EVENT_NAMES.has(rawEvent)) {
                diagnostics.push(baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_EVENT_UNSUPPORTED'));
                continue;
            }
            const event = rawEvent;
            const groups = Array.isArray(rawGroups) ? rawGroups : [];
            if (!Array.isArray(rawGroups)) {
                diagnostics.push({
                    ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
                    event,
                });
                continue;
            }
            for (const group of groups) {
                const rawHandlers = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [];
                if (!isRecord(group) || !Array.isArray(group.hooks)) {
                    diagnostics.push({
                        ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
                        event,
                    });
                    continue;
                }
                const rawMatcher = group.matcher;
                if (rawMatcher !== undefined &&
                    (typeof rawMatcher !== 'string' ||
                        (!rawMatcher.trim() && input.sourceFormat === 'MINIMAX'))) {
                    diagnostics.push({
                        ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
                        event,
                    });
                    continue;
                }
                const matcher = typeof rawMatcher === 'string' && rawMatcher.trim() ? rawMatcher : undefined;
                if (!isValidMatcher(event, matcher, input.sourceFormat)) {
                    diagnostics.push({
                        ...baseDiagnostic(input.pluginName, document.sourcePath, 'HOOK_SCHEMA_INVALID'),
                        event,
                    });
                    continue;
                }
                for (const rawHandler of rawHandlers) {
                    const currentOrder = declarationOrder;
                    declarationOrder += 1;
                    if (!isRecord(rawHandler)) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (rawHandler.async !== undefined && typeof rawHandler.async !== 'boolean') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (rawHandler.asyncRewake !== undefined && typeof rawHandler.asyncRewake !== 'boolean') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (rawHandler.asyncRewake !== undefined && input.sourceFormat !== 'CLAUDE') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_HANDLER_UNSUPPORTED'));
                        continue;
                    }
                    if (rawHandler.args !== undefined && !Array.isArray(rawHandler.args)) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    const args = rawHandler.args;
                    if (Array.isArray(args) && args.some((item) => typeof item !== 'string')) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (args !== undefined && input.sourceFormat !== 'CLAUDE') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_HANDLER_UNSUPPORTED'));
                        continue;
                    }
                    const shell = rawHandler.shell;
                    if (shell !== undefined &&
                        (input.sourceFormat !== 'CLAUDE' || (shell !== 'bash' && shell !== 'powershell'))) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, input.sourceFormat === 'CLAUDE'
                            ? 'HOOK_SCHEMA_INVALID'
                            : 'HOOK_HANDLER_UNSUPPORTED'));
                        continue;
                    }
                    const condition = rawHandler.if;
                    if (condition !== undefined && typeof condition !== 'string') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (typeof condition === 'string' &&
                        (input.sourceFormat !== 'CLAUDE' || !isValidToolCondition(event, condition))) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_HANDLER_UNSUPPORTED'));
                        continue;
                    }
                    if (typeof rawHandler.type !== 'string') {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    const type = rawHandler.type;
                    if (type !== 'command' || rawHandler.async === true || rawHandler.asyncRewake === true) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_HANDLER_UNSUPPORTED'));
                        continue;
                    }
                    const command = commandValue(rawHandler);
                    const timeoutMs = timeoutValue(rawHandler.timeout);
                    if (rawHandler.additionalContextLimit !== undefined &&
                        input.sourceFormat === 'CODEX' &&
                        supportsAdditionalContextLimit(event) &&
                        !isValidAdditionalContextLimit(rawHandler.additionalContextLimit)) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    const additionalContextLimit = readAdditionalContextLimit(rawHandler.additionalContextLimit, event, input.sourceFormat);
                    if (!command || timeoutMs === undefined) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_SCHEMA_INVALID'));
                        continue;
                    }
                    if (handlers.length >= MAX_EXECUTABLE_HANDLERS) {
                        diagnostics.push(diagnostic(input, document.sourcePath, event, currentOrder, 'HOOK_HANDLER_LIMIT_EXCEEDED'));
                        continue;
                    }
                    handlers.push({
                        kind: 'command',
                        sourceFormat: input.sourceFormat,
                        pluginName: input.pluginName,
                        pluginRoot: input.pluginRoot,
                        sourcePath: document.sourcePath,
                        event,
                        ...(matcher?.trim() ? { matcher: matcher.trim() } : {}),
                        command,
                        ...(Array.isArray(args) ? { args: args } : {}),
                        ...(args === undefined && (shell === 'bash' || shell === 'powershell')
                            ? { shell }
                            : {}),
                        ...(typeof condition === 'string' ? { condition: condition.trim() } : {}),
                        timeoutMs,
                        ...(additionalContextLimit !== undefined ? { additionalContextLimit } : {}),
                        declarationOrder: currentOrder,
                    });
                }
            }
        }
    }
    return { handlers, diagnostics };
}
function readAdditionalContextLimit(value, event, sourceFormat) {
    if (value === undefined || sourceFormat !== 'CODEX')
        return undefined;
    if (!supportsAdditionalContextLimit(event))
        return undefined;
    return isValidAdditionalContextLimit(value) ? value : undefined;
}
function supportsAdditionalContextLimit(event) {
    return (event === 'PreToolUse' ||
        event === 'PostToolUse' ||
        event === 'SessionStart' ||
        event === 'UserPromptSubmit' ||
        event === 'SubagentStart');
}
function isValidAdditionalContextLimit(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isValidMatcher(event, matcher, sourceFormat) {
    if (matcher === undefined)
        return true;
    if (matcher.length > MAX_MATCHER_LENGTH)
        return false;
    if (matcher.trim() === '*' || event === 'UserPromptSubmit' || event === 'Stop')
        return true;
    if (sourceFormat === 'CODEX') {
        if (/^[A-Za-z0-9_|]+$/u.test(matcher))
            return true;
    }
    else {
        const alternatives = matcher.split(/[|,]/u).map((part) => part.trim());
        if (alternatives.every((part) => /^[A-Za-z0-9_.:/-]+$/u.test(part)))
            return true;
    }
    return isSafePluginHookMatcher(matcher);
}
function isValidToolCondition(event, condition) {
    if (event !== 'PreToolUse' && event !== 'PermissionRequest' && event !== 'PostToolUse')
        return false;
    const trimmed = condition.trim();
    if (!trimmed || trimmed.length > MAX_MATCHER_LENGTH)
        return false;
    const match = /^([A-Za-z0-9_.:/-]+)\(([^\r\n()]*)\)$/u.exec(trimmed);
    return Boolean(match?.[1] && match[2] !== undefined);
}
export function isSafePluginHookMatcher(pattern) {
    if (!pattern || pattern.length > MAX_MATCHER_LENGTH || hasUnsupportedGroupExtension(pattern)) {
        return false;
    }
    let escaped = false;
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (escaped) {
            const width = safeEscapeWidth(pattern, index);
            if (width === 0)
                return false;
            index += width - 1;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === ')' && /[*+?{]/u.test(pattern[index + 1] ?? ''))
            return false;
    }
    if (escaped)
        return false;
    if (hasExcessiveRepeatedQuantifiedAtom(pattern))
        return false;
    try {
        RegExp(pattern, 'u');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Compatible's JavaScript regexp engine and Codex's Rust regexp engine both support
 * non-capturing groups. Their look-around and named-group support differs, so
 * keep the portable subset (`(?:...)`) and reject every other `(?...)` form.
 */
function hasUnsupportedGroupExtension(pattern) {
    for (let offset = pattern.indexOf('(?'); offset >= 0; offset = pattern.indexOf('(?', offset + 2)) {
        if (pattern[offset + 2] !== ':')
            return true;
    }
    return false;
}
function hasExcessiveRepeatedQuantifiedAtom(pattern) {
    const counts = new Map();
    for (const match of pattern.matchAll(/((?:\\.|[A-Za-z0-9_.-]))(?:[*+?]|\{\d+(?:,\d*)?\})/gu)) {
        const atom = match[1];
        if (!atom)
            continue;
        const count = (counts.get(atom) ?? 0) + 1;
        if (count >= 4)
            return true;
        counts.set(atom, count);
    }
    return false;
}
function safeEscapeWidth(pattern, index) {
    const char = pattern[index];
    if (!char || /[1-9kKpPAZGz]/u.test(char))
        return 0;
    if (char === 'x')
        return /^[0-9A-Fa-f]{2}$/u.test(pattern.slice(index + 1, index + 3)) ? 3 : 0;
    if (char === 'u')
        return /^[0-9A-Fa-f]{4}$/u.test(pattern.slice(index + 1, index + 5)) ? 5 : 0;
    return /[dDsSwWbBfnrtv0\\.^$*+?()[\]{}|/-]/u.test(char) ? 1 : 0;
}
function readHooksEnvelope(value) {
    if (!isRecord(value))
        return undefined;
    return isRecord(value.hooks) ? value.hooks : value;
}
function commandValue(value) {
    const command = process.platform === 'win32'
        ? (value.commandWindows ?? value.command_windows ?? value.command)
        : value.command;
    return typeof command === 'string' && command.trim() ? command.trim() : undefined;
}
function timeoutValue(value) {
    if (value === undefined)
        return DEFAULT_TIMEOUT_MS;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
        return undefined;
    }
    return Math.min(value * 1_000, MAX_TIMEOUT_MS);
}
function baseDiagnostic(pluginName, sourcePath, code) {
    return { pluginName, sourcePath, code };
}
function diagnostic(input, sourcePath, event, declarationOrder, code) {
    return { pluginName: input.pluginName, sourcePath, event, declarationOrder, code };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=parser.js.map