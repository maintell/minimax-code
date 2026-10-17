/**
 * `grep [-r|-R] [-i] [-n] [-l] [-H|-h] [-E] [-F] [-A N] [-B N] [-C N]
 *       <pattern> <path...>` — search file contents.
 *
 * Strict subset (LLM-friendly defaults; advanced flags punt to sandbox):
 *   - No stdin: at least one path argument required.
 *   - No `-o`, `--include`, `--exclude`, `-P` (PCRE).
 *   - No `--color` ANSI.
 *
 * Notable behaviour:
 *   - Per-file size cap 512 KiB; larger files are grep'd partial with
 *     a stderr warning (LLM hint to use the read tool / sandbox).
 *   - NUL byte in first 8KiB → "Binary file <path> matches" output
 *     (only if pattern matched somewhere in the loaded portion).
 *   - Exit codes: 0 = match, 1 = no match, 2 = error.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_BYTES_PER_FILE = 512 * 1024;
function parseFlags(argv) {
    const opts = {
        recursive: false,
        caseInsensitive: false,
        showLineNumber: false,
        listFilesOnly: false,
        filenamePrefix: 'auto',
        extended: false,
        fixedString: false,
        afterContext: 0,
        beforeContext: 0,
    };
    const positional = [];
    // argv[0] === 'grep'
    let i = 1;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--') {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (a === '-r' || a === '-R') {
            opts.recursive = true;
            i += 1;
            continue;
        }
        if (a === '-i') {
            opts.caseInsensitive = true;
            i += 1;
            continue;
        }
        if (a === '-n') {
            opts.showLineNumber = true;
            i += 1;
            continue;
        }
        if (a === '-l') {
            opts.listFilesOnly = true;
            i += 1;
            continue;
        }
        if (a === '-H') {
            opts.filenamePrefix = 'force';
            i += 1;
            continue;
        }
        if (a === '-h') {
            opts.filenamePrefix = 'suppress';
            i += 1;
            continue;
        }
        if (a === '-E') {
            opts.extended = true;
            i += 1;
            continue;
        }
        if (a === '-F') {
            opts.fixedString = true;
            i += 1;
            continue;
        }
        if (a === '-A' || a === '-B' || a === '-C') {
            const v = argv[i + 1];
            if (v === undefined) {
                return { opts, positional, err: `grep: option requires an argument -- ${a.slice(1)}` };
            }
            const parsed = Number.parseInt(v, 10);
            if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== v) {
                return { opts, positional, err: `grep: invalid context value: ${v}` };
            }
            if (a === '-A')
                opts.afterContext = parsed;
            else if (a === '-B')
                opts.beforeContext = parsed;
            else {
                opts.afterContext = parsed;
                opts.beforeContext = parsed;
            }
            i += 2;
            continue;
        }
        if (a.startsWith('-') && a !== '-') {
            return { opts, positional, err: `grep: unsupported flag: ${a}` };
        }
        positional.push(a);
        i += 1;
    }
    return { opts, positional };
}
function escapeForFixed(s) {
    return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
async function grepOneFile(abs, displayPath, re, opts, showFilenamePrefix, out, counts, stderr) {
    let st;
    try {
        st = await stat(abs);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT') {
            stderr.value += `grep: ${displayPath}: No such file or directory\n`;
        }
        else {
            stderr.value += `grep: ${displayPath}: ${err.message}\n`;
        }
        return;
    }
    if (st.isDirectory()) {
        if (!opts.recursive) {
            stderr.value += `grep: ${displayPath}: Is a directory\n`;
        }
        return;
    }
    let buf;
    let truncated = false;
    try {
        if (st.size > MAX_BYTES_PER_FILE) {
            buf = Buffer.alloc(MAX_BYTES_PER_FILE);
            const fh = await (await import('node:fs/promises')).open(abs, 'r');
            try {
                await fh.read(buf, 0, MAX_BYTES_PER_FILE, 0);
            }
            finally {
                await fh.close();
            }
            truncated = true;
        }
        else {
            buf = await readFile(abs);
        }
    }
    catch (err) {
        stderr.value += `grep: ${displayPath}: ${err.message}\n`;
        return;
    }
    if (truncated) {
        stderr.value += `grep: ${displayPath}: truncated to ${MAX_BYTES_PER_FILE} bytes for local fast-path\n`;
    }
    // Binary detection: NUL byte in first 8KiB.
    const probeLen = Math.min(buf.length, 8 * 1024);
    let isBinary = false;
    for (let k = 0; k < probeLen; k++) {
        if (buf[k] === 0) {
            isBinary = true;
            break;
        }
    }
    const text = buf.toString('utf-8');
    if (isBinary) {
        if (re.test(text)) {
            counts.matchedAny = true;
            if (opts.listFilesOnly) {
                out.push(displayPath);
            }
            else {
                out.push(`Binary file ${displayPath} matches`);
            }
        }
        return;
    }
    const lines = text.split('\n');
    const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
    const effective = hasTrailingNewline ? lines.slice(0, -1) : lines;
    // Identify match indices first so we can render context windows without
    // duplicating lines.
    const matchIdx = [];
    for (let li = 0; li < effective.length; li++) {
        re.lastIndex = 0;
        if (re.test(effective[li]))
            matchIdx.push(li);
    }
    if (matchIdx.length === 0)
        return;
    counts.matchedAny = true;
    if (opts.listFilesOnly) {
        out.push(displayPath);
        return;
    }
    // Build window of indices to print. Multiple matches' context windows
    // merge naturally via set semantics; we order by line index for stable
    // output. We do NOT emit `--` separators between windows (simpler;
    // LLM still gets the line numbers when -n).
    const include = new Set();
    for (const mi of matchIdx) {
        const from = Math.max(0, mi - opts.beforeContext);
        const to = Math.min(effective.length - 1, mi + opts.afterContext);
        for (let k = from; k <= to; k++)
            include.add(k);
    }
    const sorted = [...include].sort((a, b) => a - b);
    for (const li of sorted) {
        const isMatch = matchIdx.includes(li);
        const sep = isMatch ? ':' : '-';
        let prefix = '';
        if (showFilenamePrefix)
            prefix += `${displayPath}${sep}`;
        if (opts.showLineNumber)
            prefix += `${li + 1}${sep}`;
        out.push(prefix + effective[li]);
    }
}
async function recursiveWalk(rootAbs, rootDisplay, workspaceRoot, files, signal) {
    if (signal?.aborted)
        throw new Error('Operation aborted');
    let entries;
    try {
        entries = await readdir(rootAbs, { withFileTypes: true });
    }
    catch {
        return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (signal?.aborted)
            throw new Error('Operation aborted');
        const childDisplay = rootDisplay.endsWith('/')
            ? `${rootDisplay}${e.name}`
            : `${rootDisplay}/${e.name}`;
        const childAbs = await resolveLocalShellPath(childDisplay, workspaceRoot);
        if (e.isDirectory()) {
            await recursiveWalk(childAbs, childDisplay, workspaceRoot, files, signal);
        }
        else if (e.isFile()) {
            files.push({ abs: childAbs, display: childDisplay });
        }
        // Skip symlinks / sockets / etc.
    }
}
export const grepHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    const { opts, positional, err } = parseFlags(argv);
    if (err !== undefined)
        return { stdout: '', stderr: `${err}\n`, exitCode: 2 };
    if (positional.length < 2) {
        return {
            stdout: '',
            stderr: 'grep: usage: grep [opts] PATTERN PATH [PATH...]\n',
            exitCode: 2,
        };
    }
    const [patternRaw, ...paths] = positional;
    const pattern = opts.fixedString ? escapeForFixed(patternRaw) : patternRaw;
    let re;
    try {
        re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
    }
    catch (e) {
        return {
            stdout: '',
            stderr: `grep: invalid regex: ${e.message}\n`,
            exitCode: 2,
        };
    }
    // Resolve all input paths via path-guard first; collect file list.
    const files = [];
    const stderr = { value: '' };
    for (const p of paths) {
        abortIfCancelled(ctx);
        const abs = await resolveLocalShellPath(p, ctx.workspaceRoot);
        let st;
        try {
            st = await stat(abs);
        }
        catch (e) {
            const code = e.code;
            if (code === 'ENOENT') {
                stderr.value += `grep: ${p}: No such file or directory\n`;
            }
            else {
                stderr.value += `grep: ${p}: ${e.message}\n`;
            }
            continue;
        }
        if (st.isDirectory()) {
            if (!opts.recursive) {
                stderr.value += `grep: ${p}: Is a directory\n`;
                continue;
            }
            await recursiveWalk(abs, p, ctx.workspaceRoot, files, ctx.signal);
        }
        else {
            files.push({ abs, display: p });
        }
    }
    // Decide filename prefix.
    let showPrefix;
    if (opts.filenamePrefix === 'force')
        showPrefix = true;
    else if (opts.filenamePrefix === 'suppress')
        showPrefix = false;
    else
        showPrefix = files.length > 1 || opts.recursive;
    const out = [];
    const counts = { matchedAny: false };
    for (const f of files) {
        abortIfCancelled(ctx);
        await grepOneFile(f.abs, f.display, re, opts, showPrefix, out, counts, stderr);
    }
    // Determine exit code BEFORE final newline insertion so callers see
    // canonical grep semantics.
    let exitCode = 0;
    if (!counts.matchedAny)
        exitCode = 1;
    // Any unrecoverable stderr emission that we treat as fatal? We treat
    // "Is a directory" / "No such file" as warnings -> exit 2 per GNU.
    if (stderr.value.length > 0 && !counts.matchedAny)
        exitCode = 2;
    return {
        stdout: out.length === 0 ? '' : `${out.join('\n')}\n`,
        stderr: stderr.value,
        exitCode,
    };
};
//# sourceMappingURL=grep.js.map