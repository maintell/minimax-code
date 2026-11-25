/**
 * Diagnostics (three.md §2.2): the stable codes, their message table, and the diagnostics and
 * coded error the runtime builds from it. Every code carries a `fix` the agent can apply directly;
 * the skill feeds `fix` back to the model verbatim. Texts mirror the design doc.
 */
import { OBSERVE_EVENT_NAMES } from './contracts/events.js';
const EXTENSION_ERROR_CODES = [
    'ARGUMENT_INVALID',
    'HOOK_MODULES_INVALID',
    'HOOK_MODULE_EXPORT_INVALID',
    'HOOK_MODULES_UNSUPPORTED_FORMAT',
    'MODS_NOT_SUPPORTED_YET',
    'EXTENSION_PACKAGE_INVALID',
    'EXTENSION_PACKAGE_SKIPPED',
    'EXTENSION_NAME_MISMATCH',
    'EXTENSION_EVENT_UNSUPPORTED',
    'EXTENSION_MATCHER_INVALID',
    'EXTENSION_DUPLICATE_ENTRY',
    'EXTENSION_REGISTER_SHAPE_INVALID',
    'EXTENSION_REGISTER_FAILED',
    'EXTENSION_ENTRY_MISMATCH',
    'EXTENSION_CALL_SHAPE_INVALID',
    'EXTENSION_STATE_SHAPE_INVALID',
    'EXTENSION_RENDER_SIDE_EFFECT',
    'EXTENSION_SHADOWING',
    'CALL_NOT_DECLARED',
    'EXTENSION_IMPORT_FORBIDDEN',
    'EXTENSION_COMPILE_FAILED',
    'EXTENSION_PREVIEW_NOT_ACTIVE',
    'EXTENSION_NAME_RESERVED',
    'EXTENSION_DISABLED',
    'STATE_WRITE_IN_RENDER',
    'PERMISSION_REQUIRED',
    'PERMISSION_DENIED',
    'CANCELLED',
    'PROMPT_READ_UNAVAILABLE',
    'AGENT_CONCURRENCY_LIMIT',
    'AGENT_UNKNOWN_TYPE',
    'AGENT_START_FAILED',
    'MCP_SERVER_AMBIGUOUS',
    'MCP_CALL_RATE_LIMITED',
    'GESTURE_QUEUE_FULL',
    'EXTENSION_CANDIDATE_DRIFTED',
    'EXTENSION_CORE_PROPS_INVALID',
    'INVOCATION_SETTLED',
    'ACTIVATION_RETIRED',
    'VIEW_LEASE_HELD',
    'EXTENSION_NEXT_TWICE',
];
const error = (message, fix) => ({
    level: 'error',
    message,
    fix,
});
const warning = (message, fix) => ({
    level: 'warning',
    message,
    fix,
});
export const EXTENSION_DIAGNOSTICS = Object.freeze({
    ARGUMENT_INVALID: error('A ctx call received invalid arguments', 'Use the request shape and value limits in the ctx API reference'),
    HOOK_MODULES_INVALID: error('`modules` is missing, lists more than one path, has an invalid suffix or points to a missing file', 'Set `modules` in `hooks/hooks.json` to one relative path with a `.js .mjs .cjs .jsx .ts .mts .cts .tsx` suffix and ensure the file exists'),
    HOOK_MODULE_EXPORT_INVALID: error('The module does not export a `register` function', 'Add `export function register(on) { … }` to the module'),
    HOOK_MODULES_UNSUPPORTED_FORMAT: error('The `.codex-plugin` package declares `modules`', 'Remove `modules` from the `.codex-plugin` package or use the `.minimax-plugin` format'),
    MODS_NOT_SUPPORTED_YET: error('Phase one does not load mods from compatibility-format plugin packages', 'Phase one loads only `.minimax-plugin` modules; use the `.minimax-plugin` format and rewrite the module following one §4'),
    EXTENSION_PACKAGE_INVALID: error('Package validation failed: the manifest or a declared `*.mcp.json`, Skill or agent is invalid', 'Fix `.minimax-plugin/plugin.json` or its declared files using the reader error in `message`; the manifest requires `schemaVersion: 1`, `name`, `version`, `description`, `author`, `icon`, `category`, `exampleQueries`, `apps`, `mcpServers`, `skills`'),
    EXTENSION_PACKAGE_SKIPPED: warning('One package declaration was skipped; the rest loads normally', 'Fix the corresponding file using the code in `message`, or remove the declaration from the manifest if it is not needed'),
    EXTENSION_NAME_MISMATCH: error('The manifest `name` does not match the preview `pluginId`', 'Set `name` in `.minimax-plugin/plugin.json` to `pluginId`, or call `preview` with the manifest name'),
    EXTENSION_EVENT_UNSUPPORTED: error('The event is neither `ui.render` nor one of the observe events', `Use \`on('ui.render', { site: 'above-prompt' }, hook)\` for the band above the composer and \`on('ui.render', { site: 'pane', id: '<字面量>' }, hook)\` for a pane; use ${OBSERVE_EVENT_NAMES.join(', ')} for observe events`),
    EXTENSION_MATCHER_INVALID: error('The matcher is not an object literal with string literal values, or names an unknown site or field', "Make the second argument of `on()` an object literal with string literal values (e.g. `{ site: 'above-prompt' }` or `{ site: 'pane', id: 'board' }`)"),
    EXTENSION_DUPLICATE_ENTRY: error('Two `ui.render` hooks share a site or pane `id`, or the same `id` is registered twice at a tree site', 'Register one `ui.render` for `above-prompt` (put everything in one `Box`) and one per pane `id`; register each tree-site `id` only once'),
    EXTENSION_REGISTER_SHAPE_INVALID: error('`on()` is not at the top level of the `register` body', 'Move `on()` to the top level of the `register` body, outside conditions, loops and callbacks and before any `await`'),
    EXTENSION_REGISTER_FAILED: error('`register(on)` threw during loading', 'Fix the module-top-level or `register` error in `message`, then run `preview` again; the previous version keeps running until fixed'),
    EXTENSION_ENTRY_MISMATCH: error('The `on()` calls made during loading differ from the validate record', 'Match runtime `on()` event names and matchers to the validate record; run `preview` again to refresh it'),
    EXTENSION_CALL_SHAPE_INVALID: error('A `ctx` call is not in full form, or the `mcp.call` server is not a literal', 'Use the full `ctx.<域>.<方法>(…)` form; make the first argument of `ctx.mcp.call` a string literal'),
    EXTENSION_STATE_SHAPE_INVALID: error('The `defineState` argument is not a literal', 'Use literal keys and defaults for `defineState` and place it at module top level'),
    EXTENSION_RENDER_SIDE_EFFECT: error('A statically visible `state.set` or `state.update` appears in the render body', 'Move `ctx.state.set` / `ctx.state.update` to an interaction callback, a `clock` callback or an observe event'),
    EXTENSION_SHADOWING: warning('A site hook never references `next`, so it hides every layer after it on that site', 'Include `await next()` in the drawing (or `return next()` to add nothing) to keep the layers of other plugins and the host default view; ignore this warning if hiding them is intentional'),
    CALL_NOT_DECLARED: error('A runtime call uses a method or server outside `calls:`', 'Call only methods and servers listed in `calls:`; edit the code and run `preview` again to add more'),
    EXTENSION_IMPORT_FORBIDDEN: error('An import is outside the package or uses a forbidden specifier, a file-header JSX pragma conflicts with host settings, or a value import uses a digest-excluded path (`.minimax-plugin/types/`, root `tsconfig.json`, `dist/`, `node_modules/`)', 'Import only the four SDK specifiers and package-relative paths; remove bare imports, `node:`, `data:` and absolute paths; remove file-header `@jsx` / `@jsxImportSource` / `@jsxRuntime` comments so the host controls JSX; use `import type` for excluded files or move them outside excluded paths'),
    EXTENSION_COMPILE_FAILED: error('esbuild compilation failed', 'Fix the source using the esbuild error in `message`'),
    EXTENSION_PREVIEW_NOT_ACTIVE: error('This session has no active preview of the plugin', 'Use `inspect` to confirm the plugin ID; no `withdraw` is needed if the preview was withdrawn or never activated. Disable or uninstall installed extensions in plugin management'),
    EXTENSION_NAME_RESERVED: error('The preview plugin name matches an `official` plugin', 'Rename the preview plugin; preview cannot replace an `official` plugin name'),
    EXTENSION_DISABLED: error('The circuit breaker disabled the plugin or hook', 'Fix the hook that tripped the breaker and run `preview` again, or ask the user to restore it in the plugin panel'),
    STATE_WRITE_IN_RENDER: error('`ctx.state` was written during render', 'Move `ctx.state.set` to an interaction callback, a `clock` callback or an observe event'),
    PERMISSION_REQUIRED: error('The permission decision could not be completed', 'The permission check itself failed; retry, or ask the user to add an allow rule for this server tool'),
    PERMISSION_DENIED: error('The call was denied by a permission rule or by the user on the authorization card', 'Do not retry automatically; tell the user what the call needed and let them decide again'),
    CANCELLED: error('The call was cancelled: the caller aborted its `signal`, or the preview was withdrawn or reloaded while it waited for authorization', 'Nothing to fix in the plugin; the next Invocation may call again'),
    PROMPT_READ_UNAVAILABLE: error('The composer did not answer in time', 'The session has no visible composer right now; retry from a later gesture'),
    AGENT_CONCURRENCY_LIMIT: error('Too many sub-agents from this plugin are running in the session', 'Wait for a `turn.complete` with one of your `agentId`s before spawning again'),
    AGENT_UNKNOWN_TYPE: error('`agentType` does not name an agent available in this session', 'Omit `agentType` to use `worker`, pass `explore` for read-only investigation, or use a built-in or plugin agent name'),
    AGENT_START_FAILED: error('The sub-agent could not be started', 'Use the reason in `message`; check `model` is a `provider/model` the session can use, then spawn again from a later Invocation'),
    MCP_SERVER_AMBIGUOUS: error('The server name matches both a user-configured server and another plugin server', "Use the full name for another plugin server: `'<插件名>/<声明名>'`"),
    MCP_CALL_RATE_LIMITED: error('`mcp.call` exceeded 60 calls per plugin per minute', 'Reduce call frequency: combine requests or cache results in `ctx.state`'),
    GESTURE_QUEUE_FULL: error('The gesture request queue for this plugin is full', 'Reduce rapid repeated actions; the UI has already asked the user to try again later'),
    EXTENSION_CANDIDATE_DRIFTED: error('Before activation, the candidate no longer matches this session record: a newer preview or reload bound another candidate, `withdraw` ran, or the snapshot changed', 'Run `preview` again; do not run concurrent previews for the same plugin'),
    EXTENSION_CORE_PROPS_INVALID: error("The props passed to `next(e')` do not match the site schema", 'Rewrite only fields allowed by the site and keep their types unchanged'),
    INVOCATION_SETTLED: error('`ctx` was called after the callback settled', 'Keep work in the callback `await` chain; do not use `setTimeout` or unawaited Promises'),
    ACTIVATION_RETIRED: error('A callback from a retired Activation fired', 'Run `preview` again or wait for the installed version to load'),
    VIEW_LEASE_HELD: error('The site is already mounted in another view', 'Close the other view, then reopen this one'),
    EXTENSION_NEXT_TWICE: error('`next` was called a second time in one hook invocation', 'Call `next` only once per hook; combine multiple pieces of content into one tree'),
});
export function isExtensionErrorCode(value) {
    return (typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXTENSION_DIAGNOSTICS, value));
}
export function createExtensionDiagnostic(code, details = {}) {
    const template = EXTENSION_DIAGNOSTICS[code];
    return {
        code,
        ...(details.file === undefined ? {} : { file: details.file }),
        ...(details.line === undefined ? {} : { line: details.line }),
        ...(details.column === undefined ? {} : { column: details.column }),
        message: details.detail ? `${template.message}: ${details.detail}` : template.message,
        fix: template.fix,
        level: template.level,
    };
}
/** Error carrying a stable code; thrown by host-provided runtime pieces. */
export class ExtensionError extends Error {
    code;
    constructor(code, detail) {
        super(createExtensionDiagnostic(code, detail ? { detail } : {}).message);
        this.name = 'ExtensionError';
        this.code = code;
    }
}
//# sourceMappingURL=diagnostics.js.map