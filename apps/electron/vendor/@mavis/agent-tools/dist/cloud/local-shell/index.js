/**
 * Local-shell fast-path package entry point. Exports the dispatcher
 * used by `CloudBashTool.execute` plus the handler map for tests and
 * future tools that want to whitelist additional commands.
 *
 * The dispatcher classifies a bash command into either a local-hit
 * result (handler ran in-process; sandbox was bypassed) or a skip
 * reason (caller falls back to the sandbox shell).
 */
export { tryLocalDispatch } from './dispatch.js';
export { LOCAL_HANDLERS } from './handlers/index.js';
export { LocalShellPathError } from './path-resolve.js';
export { parseCommand } from './parse.js';
//# sourceMappingURL=index.js.map