import { fingerprintThreadGoalToolCall } from '@mavis/goal';
import { parseScriptPlainCommands } from '@mavis/permission';
/**
 * Tools that only read: the file reads the permission policy treats as
 * read-only, the Goal's own state read, and background-task queries.
 */
const READ_ONLY_TOOLS = new Set([
    'read',
    'glob',
    'grep',
    'list',
    'get_goal',
    'task_query',
    'task_output',
]);
/** Built-in shell tools whose `command` argument is judged as a shell command. */
const SHELL_TOOLS = new Set(['bash', 'shell']);
/** Last name segment of an MCP tool (`mcp__<server>__<tool>`) that runs a shell command. */
const MCP_SHELL_TOOLS = new Set([
    'execute_shell_command',
    'run_shell_command',
    'shell_command',
    'execute_command',
    'run_command',
    'shell',
    'bash',
]);
/**
 * Commands that cannot write anything whatever their arguments, across POSIX
 * shells, Windows `cmd` and PowerShell. This is deliberately not the permission
 * auto-approve whitelist: a command can be safe to run unprompted and still
 * write a file (`uniq in.log out.log`, `sort -o`, `git diff --output`).
 */
const SIDE_EFFECT_FREE_COMMANDS = new Set([
    'cat',
    'cd',
    'cut',
    'df',
    'du',
    'echo',
    'false',
    'grep',
    'head',
    'id',
    'ls',
    'nl',
    'ps',
    'pwd',
    'rev',
    'stat',
    'tail',
    'tr',
    'true',
    'uname',
    'wc',
    'which',
    'whoami',
    'chdir',
    'dir',
    'findstr',
    'tasklist',
    'tree',
    'type',
    'where',
    'get-childitem',
    'get-content',
    'get-item',
    'get-location',
    'get-process',
    'measure-object',
    'resolve-path',
    'select-string',
    'test-path',
]);
export function observeThreadGoalToolCall(call) {
    return {
        fingerprint: fingerprintThreadGoalToolCall(call),
        readOnly: isKnownReadOnlyToolCall(call.name, call.arguments),
    };
}
/**
 * A call is read-only when it is a known read tool, or a shell tool whose whole
 * command line is made of side-effect-free commands. Everything else, including
 * every tool this module does not know, is treated as possibly writing.
 */
function isKnownReadOnlyToolCall(name, args) {
    if (READ_ONLY_TOOLS.has(name))
        return true;
    if (!isShellTool(name))
        return false;
    const command = typeof args === 'object' && args !== null && 'command' in args ? args.command : undefined;
    if (typeof command !== 'string' || !command.trim())
        return false;
    return isSideEffectFreeShellScript(command) || isSideEffectFreeCommandLine(command);
}
function isShellTool(name) {
    if (SHELL_TOOLS.has(name))
        return true;
    if (!name.startsWith('mcp__'))
        return false;
    const tool = name.slice(name.lastIndexOf('__') + 2);
    return MCP_SHELL_TOOLS.has(tool);
}
function isSideEffectFreeExecutable(word) {
    if (!word)
        return false;
    const name = word.replaceAll('\\', '/').split('/').pop() ?? '';
    return SIDE_EFFECT_FREE_COMMANDS.has(name.toLowerCase().replace(/\.exe$/u, ''));
}
/**
 * A single-line POSIX shell script of plain commands, as the permission parser
 * reads it: any redirection, substitution or assignment makes it unparsable,
 * and every command in the sequence must be side-effect free. The parser treats
 * a newline as plain whitespace inside one command's words, so a multi-line
 * script would only be judged by its first command; it fails closed instead.
 */
function isSideEffectFreeShellScript(command) {
    if (/[\r\n]/u.test(command.trim()))
        return false;
    const commands = parseScriptPlainCommands(command);
    return (commands !== undefined &&
        commands.length > 0 &&
        commands.every((words) => isSideEffectFreeExecutable(words[0])));
}
/**
 * A Windows `cmd` or PowerShell line of simple commands joined by `&` or `&&`.
 * Any other separator or shell syntax — `;`, redirection, pipes, grouping,
 * escapes and variable or command expansion — fails closed, and every part
 * must start with a side-effect-free command.
 */
function isSideEffectFreeCommandLine(command) {
    if (/[;<>|^%!()`${}\r\n]/u.test(command))
        return false;
    const parts = command.split(/&&?/u).map((part) => part.trim());
    return parts.every((part) => isSideEffectFreeExecutable(part.split(/\s+/u)[0]));
}
//# sourceMappingURL=tool-call-observation.js.map