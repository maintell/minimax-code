/**
 * `wc [-l|-w|-c|-m] [file...]` — line / word / byte / char counts.
 *
 * GNU `wc` without flags prints `lines words bytes filename`. With a
 * single mode flag, only that count is shown. Multiple files get a
 * trailing `total` line.
 *
 * line count == number of `\n` bytes (final unterminated line does NOT
 * count, matching GNU).
 */
import { readFile, stat } from 'node:fs/promises';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
export const wcHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'wc'
    let mode = 'all';
    const files = [];
    let i = 1;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-l') {
            mode = 'lines';
            i += 1;
            continue;
        }
        if (a === '-w') {
            mode = 'words';
            i += 1;
            continue;
        }
        if (a === '-c') {
            mode = 'bytes';
            i += 1;
            continue;
        }
        if (a === '-m') {
            mode = 'chars';
            i += 1;
            continue;
        }
        if (a.startsWith('-') && a !== '-') {
            return { stdout: '', stderr: `wc: unsupported flag ${a}\n`, exitCode: 1 };
        }
        if (a === '-') {
            return { stdout: '', stderr: 'wc: stdin not supported in local fast-path\n', exitCode: 1 };
        }
        files.push(a);
        i += 1;
    }
    if (files.length === 0) {
        return { stdout: '', stderr: 'wc: stdin not supported in local fast-path\n', exitCode: 1 };
    }
    const totals = { lines: 0, words: 0, bytes: 0, chars: 0 };
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    function format(c, name) {
        const cols = [];
        if (mode === 'all' || mode === 'lines')
            cols.push(String(c.lines).padStart(8));
        if (mode === 'all' || mode === 'words')
            cols.push(String(c.words).padStart(8));
        if (mode === 'all' || mode === 'bytes')
            cols.push(String(c.bytes).padStart(8));
        if (mode === 'chars')
            cols.push(String(c.chars).padStart(8));
        return `${cols.join(' ')} ${name}\n`;
    }
    for (const arg of files) {
        abortIfCancelled(ctx);
        const abs = await resolveLocalShellPath(arg, ctx.workspaceRoot);
        let st;
        try {
            st = await stat(abs);
        }
        catch (err) {
            const code = err.code;
            stderr +=
                code === 'ENOENT'
                    ? `wc: ${arg}: No such file or directory\n`
                    : `wc: ${arg}: ${err.message}\n`;
            exitCode = 1;
            continue;
        }
        if (st.isDirectory()) {
            stderr += `wc: ${arg}: Is a directory\n`;
            // GNU wc emits zeros for directories with exit 1.
            const zero = { lines: 0, words: 0, bytes: 0, chars: 0 };
            stdout += format(zero, arg);
            exitCode = 1;
            continue;
        }
        if (st.size > MAX_BYTES_PER_FILE) {
            stderr +=
                `wc: ${arg}: file size ${st.size} exceeds local fast-path limit ` +
                    `${MAX_BYTES_PER_FILE} bytes; use the read tool instead\n`;
            exitCode = 1;
            continue;
        }
        let buf;
        try {
            buf = await readFile(abs);
        }
        catch (err) {
            stderr += `wc: ${arg}: ${err.message}\n`;
            exitCode = 1;
            continue;
        }
        const text = buf.toString('utf-8');
        let lines = 0;
        for (let k = 0; k < buf.length; k++) {
            if (buf[k] === 0x0a)
                lines += 1;
        }
        // Words: split on any whitespace run; empty result when text is all
        // whitespace.
        const words = text.split(/\s+/).filter((w) => w.length > 0).length;
        const c = { lines, words, bytes: buf.length, chars: text.length };
        stdout += format(c, arg);
        totals.lines += c.lines;
        totals.words += c.words;
        totals.bytes += c.bytes;
        totals.chars += c.chars;
    }
    if (files.length > 1) {
        stdout += format(totals, 'total');
    }
    return { stdout, stderr, exitCode };
};
//# sourceMappingURL=wc.js.map