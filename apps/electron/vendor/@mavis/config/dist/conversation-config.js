import fs from 'node:fs';
import yaml from 'js-yaml';
import { getConfigPath } from './config.js';
export const CONVERSATION_STOP_CONFIG_DEFAULTS = Object.freeze({
    stopSubAgent: true,
    stopAsyncBash: true,
});
const STOP_KEYS = ['stopSubAgent', 'stopAsyncBash'];
/**
 * Parses the stop switches from an already parsed config document. A missing
 * `conversation` section, a section that is not a mapping, a missing key and a
 * key that is not a YAML boolean all mean "use the default".
 */
export function parseConversationStopConfig(raw) {
    const section = isPlainRecord(raw.conversation) ? raw.conversation : {};
    const values = { ...CONVERSATION_STOP_CONFIG_DEFAULTS };
    const policySource = {
        stopSubAgent: 'default',
        stopAsyncBash: 'default',
    };
    const ignoredKeys = [];
    for (const key of STOP_KEYS) {
        const value = section[key];
        if (typeof value === 'boolean') {
            values[key] = value;
            policySource[key] = 'explicit';
        }
        else if (value !== undefined) {
            ignoredKeys.push(key);
        }
    }
    return { ...values, policySource, ...(ignoredKeys.length > 0 ? { ignoredKeys } : {}) };
}
/**
 * Reads the stop switches from config.yaml, afresh on every call. Never throws,
 * never caches and never writes: unlike `getConfig()` or `loadConfigFromFile()`
 * it does not chmod the file, migrate BYOK providers or sync managed presets.
 * Every failure falls back to the defaults and is described in `failure`.
 *
 * Synchronous on purpose. Callers read it inside a stop request, and a small
 * local file reads and parses well under a millisecond; the TUI also relies on
 * it to decide, before it aborts the root Run, whether to stop delegated agents,
 * in the same order as before. Writers replace the file atomically (write, then
 * rename), so no lock is needed: a read sees either the old or the new file.
 *
 * `configPath` defaults to `getConfigPath()`: the data directory of this
 * process, which the local runtime host pins to its own data directory when it
 * starts, so a stop always reads the file its runtime uses.
 */
export function readConversationStopConfig(configPath) {
    let path;
    try {
        path = configPath ?? getConfigPath();
    }
    catch {
        return readFailed({ reason: 'path_error' });
    }
    let text;
    try {
        text = fs.readFileSync(path, 'utf8');
    }
    catch (error) {
        const errorCode = errnoCode(error);
        // No config file at all is an ordinary install, not a failure.
        if (errorCode === 'ENOENT')
            return { ...parseConversationStopConfig({}), configPath: path };
        return readFailed({ reason: 'read_error', ...(errorCode ? { errorCode } : {}) }, path);
    }
    let parsed;
    try {
        parsed = yaml.load(text);
    }
    catch (error) {
        const line = yamlErrorLine(error);
        return readFailed({ reason: 'yaml_error', ...(line ? { line } : {}) }, path);
    }
    if (parsed == null)
        return { ...parseConversationStopConfig({}), configPath: path };
    if (!isPlainRecord(parsed))
        return readFailed({ reason: 'not_a_mapping' }, path);
    return { ...parseConversationStopConfig(parsed), configPath: path };
}
function readFailed(failure, configPath) {
    return {
        ...CONVERSATION_STOP_CONFIG_DEFAULTS,
        policySource: { stopSubAgent: 'read_failed', stopAsyncBash: 'read_failed' },
        failure,
        ...(configPath ? { configPath } : {}),
    };
}
function isPlainRecord(value) {
    return (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype);
}
function errnoCode(error) {
    const code = error?.code;
    return typeof code === 'string' ? code : undefined;
}
/** js-yaml reports a 0-based `mark.line`; only the number leaves this module. */
function yamlErrorLine(error) {
    const line = error?.mark?.line;
    return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line + 1 : undefined;
}
//# sourceMappingURL=conversation-config.js.map