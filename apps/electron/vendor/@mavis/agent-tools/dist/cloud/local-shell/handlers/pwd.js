/**
 * `pwd` — print the absolute workspace root path.
 *
 * GNU `pwd` accepts `-L` / `-P` flags; the local handler does NOT,
 * because the workspace path is already a canonical realpath (per
 * cloud-runtime startup wiring). Any flags → unsupported → sandbox.
 */
import { abortIfCancelled } from './types.js';
export const pwdHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'pwd'. Reject any flags / args.
    if (argv.length > 1) {
        return { stdout: '', stderr: `pwd: too many arguments\n`, exitCode: 1 };
    }
    return { stdout: `${ctx.workspaceRoot}\n`, stderr: '', exitCode: 0 };
};
//# sourceMappingURL=pwd.js.map