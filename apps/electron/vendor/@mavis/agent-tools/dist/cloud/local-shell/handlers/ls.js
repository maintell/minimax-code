/**
 * `ls [-a] [-A] [-l] [-1] [-d] [-h] [paths...]` — list directory contents.
 *
 * Local fast-path policy:
 *   - No `-color` ANSI output; LLM context is plain text.
 *   - `-h` only affects `-l`'s size formatting.
 *   - When multiple paths are given, each directory is preceded by a
 *     `<path>:` header (GNU parity); single dir → no header.
 *   - Sorted alphabetically (default GNU).
 */
import { readdir, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
function parseOpts(argv) {
    const opts = {
        showAll: false,
        showAlmostAll: false,
        longFormat: false,
        oneColumn: true,
        dirAsEntry: false,
        humanSize: false,
    };
    const paths = [];
    // argv[0] === 'ls'
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            paths.push(...argv.slice(i + 1));
            break;
        }
        if (a.startsWith('-') && a.length > 1) {
            for (let k = 1; k < a.length; k++) {
                const c = a[k];
                if (c === 'a')
                    opts.showAll = true;
                else if (c === 'A')
                    opts.showAlmostAll = true;
                else if (c === 'l')
                    opts.longFormat = true;
                else if (c === '1')
                    opts.oneColumn = true;
                else if (c === 'd')
                    opts.dirAsEntry = true;
                else if (c === 'h')
                    opts.humanSize = true;
                else
                    return { opts, paths, err: `ls: unsupported flag: -${c}` };
            }
            continue;
        }
        paths.push(a);
    }
    return { opts, paths };
}
function formatHumanSize(n) {
    if (n < 1024)
        return String(n);
    const units = ['K', 'M', 'G', 'T', 'P'];
    let val = n / 1024;
    let unitIdx = 0;
    while (val >= 1024 && unitIdx < units.length - 1) {
        val /= 1024;
        unitIdx += 1;
    }
    return val >= 10 ? `${Math.round(val)}${units[unitIdx]}` : `${val.toFixed(1)}${units[unitIdx]}`;
}
function modeString(mode, isDir, isLink) {
    // Render a 10-char rwx string. Type char first.
    let s = isLink ? 'l' : isDir ? 'd' : '-';
    const triplets = [
        [0o400, 0o200, 0o100],
        [0o040, 0o020, 0o010],
        [0o004, 0o002, 0o001],
    ];
    for (const [r, w, x] of triplets) {
        s += mode & r ? 'r' : '-';
        s += mode & w ? 'w' : '-';
        s += mode & x ? 'x' : '-';
    }
    return s;
}
function formatMtime(ms) {
    // Match GNU ls "MMM DD HH:MM" or "MMM DD  YYYY" for >6mo old; keep
    // it simple and always use the short form for predictability.
    const d = new Date(ms);
    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];
    const day = String(d.getDate()).padStart(2, ' ');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${months[d.getMonth()]} ${day} ${hh}:${mm}`;
}
async function listDir(dirPath, opts) {
    let entries;
    try {
        entries = await readdir(dirPath, { withFileTypes: true });
    }
    catch (err) {
        const code = err.code;
        const msg = code === 'ENOENT'
            ? `ls: cannot access '${dirPath}': No such file or directory`
            : code === 'ENOTDIR'
                ? `ls: cannot access '${dirPath}': Not a directory`
                : code === 'EACCES'
                    ? `ls: cannot open directory '${dirPath}': Permission denied`
                    : `ls: cannot access '${dirPath}': ${err.message}`;
        return { stdout: '', stderr: `${msg}\n`, exitCode: 2 };
    }
    let names = entries.map((e) => e.name);
    if (opts.showAll) {
        names = ['.', '..', ...names];
    }
    else if (!opts.showAlmostAll) {
        names = names.filter((n) => !n.startsWith('.'));
    }
    names.sort((a, b) => a.localeCompare(b));
    if (!opts.longFormat) {
        return { stdout: names.length === 0 ? '' : `${names.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    // -l rendering. Compute total blocks (sum of stat.blocks) for header.
    const rows = [];
    let totalBlocks = 0;
    for (const name of names) {
        const full = name === '.' ? dirPath : name === '..' ? join(dirPath, '..') : join(dirPath, name);
        let st;
        try {
            st = await lstat(full);
        }
        catch {
            rows.push(`?????????? ? ? ? ? ${name}`);
            continue;
        }
        const isLink = st.isSymbolicLink();
        const isDir = st.isDirectory();
        totalBlocks += st.blocks;
        const size = opts.humanSize ? formatHumanSize(st.size) : String(st.size);
        rows.push(`${modeString(st.mode, isDir, isLink)} ${st.nlink} ${st.uid} ${st.gid} ${size.padStart(8)} ${formatMtime(st.mtimeMs)} ${name}`);
    }
    const out = `total ${totalBlocks}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
    return { stdout: out, stderr: '', exitCode: 0 };
}
export const lsHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    const { opts, paths, err } = parseOpts(argv);
    if (err !== undefined)
        return { stdout: '', stderr: `${err}\n`, exitCode: 1 };
    const targets = paths.length === 0 ? [ctx.workspaceRoot] : paths;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const showHeaders = targets.length > 1;
    for (let idx = 0; idx < targets.length; idx++) {
        abortIfCancelled(ctx);
        const arg = targets[idx];
        const abs = await resolveLocalShellPath(arg, ctx.workspaceRoot);
        let st;
        try {
            st = await stat(abs);
        }
        catch (e) {
            const code = e.code;
            stderr +=
                code === 'ENOENT'
                    ? `ls: cannot access '${arg}': No such file or directory\n`
                    : `ls: cannot access '${arg}': ${e.message}\n`;
            exitCode = 2;
            continue;
        }
        if (!st.isDirectory() || opts.dirAsEntry) {
            // Single entry rendering.
            if (showHeaders && idx > 0)
                stdout += '\n';
            if (opts.longFormat) {
                const isLink = (await lstat(abs)).isSymbolicLink();
                const size = opts.humanSize ? formatHumanSize(st.size) : String(st.size);
                stdout += `${modeString(st.mode, st.isDirectory(), isLink)} ${st.nlink} ${st.uid} ${st.gid} ${size.padStart(8)} ${formatMtime(st.mtimeMs)} ${arg}\n`;
            }
            else {
                stdout += `${arg}\n`;
            }
            continue;
        }
        if (showHeaders) {
            if (idx > 0)
                stdout += '\n';
            stdout += `${arg}:\n`;
        }
        const r = await listDir(abs, opts);
        stdout += r.stdout;
        stderr += r.stderr;
        if (r.exitCode !== 0)
            exitCode = Math.max(exitCode, r.exitCode);
    }
    return { stdout, stderr, exitCode };
};
//# sourceMappingURL=ls.js.map