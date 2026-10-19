/**
 * `cat [file...]` — concatenate file contents to stdout.
 *
 * Local fast-path policy:
 *   - No flags. GNU `cat -n` etc. is rare in LLM file-op patterns; if
 *     a flag is present we punt to the sandbox so the LLM sees the
 *     canonical bash semantics.
 *   - 1 MiB per-file size cap. Files larger than that emit a stderr
 *     hint telling the LLM to use the `read` tool, and dispatcher does
 *     NOT fall back to sandbox (because forwarding a huge `cat` to the
 *     sandbox would also flood the LLM context). Hard exit code 1.
 *   - Missing files emit `cat: <path>: No such file or directory` (GNU
 *     parity) and exit non-zero, but continue with remaining files
 *     (matches GNU behavior).
 */
import { readFile, stat } from 'node:fs/promises';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_BYTES_PER_FILE = 1 * 1024 * 1024;
export const catHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'cat'
    const args = argv.slice(1);
    if (args.length === 0) {
        // GNU `cat` with no args reads stdin; we don't support stdin in
        // the local fast-path. Punt to sandbox.
        return { stdout: '', stderr: 'cat: stdin not supported in local fast-path\n', exitCode: 1 };
    }
    // Any flag → punt.
    for (const a of args) {
        if (a.startsWith('-') && a !== '-') {
            return { stdout: '', stderr: `cat: unsupported flag ${a}\n`, exitCode: 1 };
        }
        if (a === '-') {
            return { stdout: '', stderr: 'cat: stdin not supported in local fast-path\n', exitCode: 1 };
        }
    }
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const arg of args) {
        abortIfCancelled(ctx);
        const abs = await resolveLocalShellPath(arg, ctx.workspaceRoot);
        let st;
        try {
            st = await stat(abs);
        }
        catch (err) {
            const code = err.code;
            if (code === 'ENOENT') {
                stderr += `cat: ${arg}: No such file or directory\n`;
            }
            else if (code === 'EACCES') {
                stderr += `cat: ${arg}: Permission denied\n`;
            }
            else {
                stderr += `cat: ${arg}: ${err.message}\n`;
            }
            exitCode = 1;
            continue;
        }
        if (st.isDirectory()) {
            stderr += `cat: ${arg}: Is a directory\n`;
            exitCode = 1;
            continue;
        }
        if (st.size > MAX_BYTES_PER_FILE) {
            // Do NOT fall back to sandbox — large `cat` would flood LLM
            // context regardless of execution channel. Tell the LLM to use
            // the `read` tool which supports offset / limit.
            stderr +=
                `cat: ${arg}: file size ${st.size} exceeds local fast-path limit ` +
                    `${MAX_BYTES_PER_FILE} bytes; use the read tool instead\n`;
            exitCode = 1;
            continue;
        }
        try {
            const buf = await readFile(abs);
            stdout += buf.toString('utf-8');
        }
        catch (err) {
            stderr += `cat: ${arg}: ${err.message}\n`;
            exitCode = 1;
        }
    }
    return { stdout, stderr, exitCode };
};
//# sourceMappingURL=cat.js.map