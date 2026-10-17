/**
 * `head [-n N] [file...]` — print the first N lines (default 10).
 *
 * GNU `head` accepts `-n -N` (negative — print all but last N) and
 * `-c N` (byte count); both unsupported → punt to sandbox.
 *
 * Multi-file output mirrors GNU: prepend `==> <file> <==` header with
 * a blank separator line before the second file onward.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
export const headHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'head'
    let n = 10;
    const files = [];
    let i = 1;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-n') {
            const v = argv[i + 1];
            if (v === undefined) {
                return { stdout: '', stderr: "head: option requires an argument -- 'n'\n", exitCode: 1 };
            }
            if (v.startsWith('-') || v.startsWith('+')) {
                // Negative / leading-+ forms are GNU extensions; punt.
                return { stdout: '', stderr: `head: unsupported -n form: ${v}\n`, exitCode: 1 };
            }
            const parsed = Number.parseInt(v, 10);
            if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== v) {
                return { stdout: '', stderr: `head: invalid number of lines: '${v}'\n`, exitCode: 1 };
            }
            n = parsed;
            i += 2;
            continue;
        }
        if (a.startsWith('-') && a !== '-') {
            return { stdout: '', stderr: `head: unsupported flag ${a}\n`, exitCode: 1 };
        }
        if (a === '-') {
            return { stdout: '', stderr: 'head: stdin not supported in local fast-path\n', exitCode: 1 };
        }
        files.push(a);
        i += 1;
    }
    if (files.length === 0) {
        return { stdout: '', stderr: 'head: stdin not supported in local fast-path\n', exitCode: 1 };
    }
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const showHeaders = files.length > 1;
    for (let idx = 0; idx < files.length; idx++) {
        abortIfCancelled(ctx);
        const arg = files[idx];
        const abs = await resolveLocalShellPath(arg, ctx.workspaceRoot);
        let st;
        try {
            st = await stat(abs);
        }
        catch (err) {
            const code = err.code;
            stderr +=
                code === 'ENOENT'
                    ? `head: cannot open '${arg}' for reading: No such file or directory\n`
                    : `head: ${arg}: ${err.message}\n`;
            exitCode = 1;
            continue;
        }
        if (st.isDirectory()) {
            stderr += `head: error reading '${arg}': Is a directory\n`;
            exitCode = 1;
            continue;
        }
        if (st.size > MAX_BYTES_PER_FILE) {
            stderr +=
                `head: ${arg}: file size ${st.size} exceeds local fast-path limit ` +
                    `${MAX_BYTES_PER_FILE} bytes; use the read tool instead\n`;
            exitCode = 1;
            continue;
        }
        let content;
        try {
            content = (await readFile(abs)).toString('utf-8');
        }
        catch (err) {
            stderr += `head: ${arg}: ${err.message}\n`;
            exitCode = 1;
            continue;
        }
        if (showHeaders) {
            if (idx > 0)
                stdout += '\n';
            stdout += `==> ${arg} <==\n`;
        }
        if (n === 0)
            continue;
        // Take first n lines, preserving the trailing newline policy: if the
        // selected slice was followed by more content in the file, we keep
        // the newline at the end of the last selected line; if it was the
        // full file we keep whatever was there originally.
        const lines = content.split('\n');
        const slice = lines.slice(0, n);
        const consumedAll = lines.length <= n;
        let chunk = slice.join('\n');
        if (!consumedAll) {
            // Cut to exactly n lines; ensure trailing newline so subsequent
            // headers begin on a fresh line.
            chunk += '\n';
        }
        stdout += chunk;
    }
    return { stdout, stderr, exitCode };
};
//# sourceMappingURL=head.js.map