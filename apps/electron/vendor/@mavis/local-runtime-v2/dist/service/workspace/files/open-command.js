import { execFile as execFileCallback } from 'node:child_process';
import { basename, dirname, extname, win32 } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../../infra/logging/logger.js';
import { json } from './file-api-shared.js';
const execFile = promisify(execFileCallback);
const defaultOpenCommandRuntime = {
    platform: process.platform,
    env: process.env,
    run: async (file, args, options) => {
        await execFile(file, args, options);
    },
};
let openCommandRuntime = defaultOpenCommandRuntime;
/** @internal Exported only for focused tests. */
export function __setLocalFileApiOpenCommandForTests(nextRuntime) {
    openCommandRuntime = nextRuntime
        ? { ...defaultOpenCommandRuntime, ...nextRuntime }
        : defaultOpenCommandRuntime;
}
export async function runOpenCommand(action, target) {
    const command = resolveOpenCommand(action, target, openCommandRuntime);
    if (!command) {
        return json({ error: `Opening files is not supported on ${openCommandRuntime.platform}` }, { status: 501 });
    }
    try {
        await openCommandRuntime.run(command.file, command.args, {
            windowsHide: !command.windowsShow,
            windowsVerbatimArguments: command.windowsVerbatimArguments,
        });
        return json({ ok: true });
    }
    catch (error) {
        const code = getOpenCommandErrorCode(error);
        // explorer.exe can report a numeric non-zero exit code after Windows has
        // already accepted the open request. Preserve that compatibility, but do
        // not hide spawn failures such as ENOENT, EACCES, or EPERM.
        if (openCommandRuntime.platform === 'win32' && typeof code === 'number') {
            return json({ ok: true });
        }
        logger.warn({
            action,
            platform: openCommandRuntime.platform,
            executable: basename(command.file),
            targetKind: extname(target) ? 'file' : 'directory',
            errorCode: code ?? 'UNKNOWN',
        }, 'Local file open command failed');
        return json({ error: 'Unable to open the local file', code: 'OPEN_COMMAND_FAILED' }, { status: 422 });
    }
}
function getOpenCommandErrorCode(error) {
    if (!error || typeof error !== 'object' || !('code' in error))
        return undefined;
    const code = error.code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}
function resolveOpenCommand(action, target, runtime = openCommandRuntime) {
    if (runtime.platform === 'darwin') {
        return { file: 'open', args: action === 'reveal' ? ['-R', target] : [target] };
    }
    if (runtime.platform === 'win32') {
        const windowsDirectory = runtime.env.WINDIR || runtime.env.SystemRoot;
        const explorer = windowsDirectory
            ? win32.join(windowsDirectory, 'explorer.exe')
            : 'explorer.exe';
        return action === 'reveal'
            ? {
                file: explorer,
                args: [`/select,"${target}"`],
                windowsShow: true,
                windowsVerbatimArguments: true,
            }
            : {
                file: explorer,
                args: [`"${target}"`],
                windowsShow: true,
                windowsVerbatimArguments: true,
            };
    }
    if (runtime.platform === 'linux') {
        return { file: 'xdg-open', args: [action === 'reveal' ? dirname(target) : target] };
    }
    return undefined;
}
//# sourceMappingURL=open-command.js.map