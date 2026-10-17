/**
 * `tail [-n N] [file...]` — print the last N lines (default 10).
 *
 * Unsupported:
 *   - `-f` (follow / streaming) — sandbox handles this when needed.
 *   - `-n +N` (from line N) — punt.
 *   - `-c N` (byte count) — punt.
 *
 * Multi-file output mirrors GNU: prepend `==> <file> <==` header.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
export const tailHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'tail'
    let n = 10;
    const files = [];
    let i = 1;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-f' || a === '-F' || a === '--follow') {
            return { stdout: '', stderr: `tail: ${a} not supported in local fast-path\n`, exitCode: 1 };
        }
        if (a === '-n') {
            const v = argv[i + 1];
            if (v === undefined) {
                return { stdout: '', stderr: "tail: option requires an argument -- 'n'\n", exitCode: 1 };
            }
            if (v.startsWith('+') || v.startsWith('-')) {
                return { stdout: '', stderr: `tail: unsupported -n form: ${v}\n`, exitCode: 1 };
            }
            const parsed = Number.parseInt(v, 10);
            if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== v) {
                return { stdout: '', stderr: `tail: invalid number of lines: '${v}'\n`, exitCode: 1 };
            }
            n = parsed;
            i += 2;
            continue;
        }
        if (a.startsWith('-') && a !== '-') {
            return { stdout: '', stderr: `tail: unsupported flag ${a}\n`, exitCode: 1 };
        }
        if (a === '-') {
            return { stdout: '', stderr: 'tail: stdin not supported in local fast-path\n', exitCode: 1 };
        }
        files.push(a);
        i += 1;
    }
    if (files.length === 0) {
        return { stdout: '', stderr: 'tail: stdin not supported in local fast-path\n', exitCode: 1 };
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
                    ? `tail: cannot open '${arg}' for reading: No such file or directory\n`
                    : `tail: ${arg}: ${err.message}\n`;
            exitCode = 1;
            continue;
        }
        if (st.isDirectory()) {
            stderr += `tail: error reading '${arg}': Is a directory\n`;
            exitCode = 1;
            continue;
        }
        if (st.size > MAX_BYTES_PER_FILE) {
            stderr +=
                `tail: ${arg}: file size ${st.size} exceeds local fast-path limit ` +
                    `${MAX_BYTES_PER_FILE} bytes; use the read tool instead\n`;
            exitCode = 1;
            continue;
        }
        let content;
        try {
            content = (await readFile(abs)).toString('utf-8');
        }
        catch (err) {
            stderr += `tail: ${arg}: ${err.message}\n`;
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
        // Drop the trailing empty token created by `.split('\n')` when the
        // file ends with a newline, so `tail -n 2` of "a\nb\nc\n" yields
        // "b\nc\n" rather than "c\n" + a phantom blank.
        const lines = content.split('\n');
        const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
        const effectiveLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
        const slice = effectiveLines.slice(Math.max(0, effectiveLines.length - n));
        let chunk = slice.join('\n');
        if (chunk.length > 0)
            chunk += '\n';
        stdout += chunk;
    }
    return { stdout, stderr, exitCode };
};
//# sourceMappingURL=tail.js.map