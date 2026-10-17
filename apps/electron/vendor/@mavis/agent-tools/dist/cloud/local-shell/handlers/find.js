/**
 * `find <path> [-name <pattern>] [-type f|d] [-maxdepth N]` —
 * recursively list entries under `path`, optionally filtered by glob
 * name and type.
 *
 * Strict subset. Any flag outside the supported set → unsupported
 * → punt to sandbox. Path-guard is applied at every visited entry so
 * symlinks pointing outside the workspace abort the walk.
 *
 * Output: one entry per line, paths are rendered relative to the
 * starting `path` argument (matching GNU `find` invocation style:
 * `find foo` outputs `foo/...`).
 */
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { resolveLocalShellPath } from '../path-resolve.js';
import { abortIfCancelled } from './types.js';
const MAX_ENTRIES = 50_000;
/** Glob → RegExp. `*` matches any chars except `/`; `?` matches one char. */
function globToRegExp(glob) {
    let re = '^';
    for (const ch of glob) {
        if (ch === '*')
            re += '[^/]*';
        else if (ch === '?')
            re += '[^/]';
        else if ('\\^$.+()[]{}|'.includes(ch))
            re += `\\${ch}`;
        else
            re += ch;
    }
    re += '$';
    return new RegExp(re);
}
export const findHandler = async (argv, ctx) => {
    abortIfCancelled(ctx);
    // argv[0] === 'find'
    if (argv.length < 2) {
        return { stdout: '', stderr: 'find: missing path argument\n', exitCode: 1 };
    }
    const startArg = argv[1];
    if (startArg.startsWith('-')) {
        return { stdout: '', stderr: 'find: starting path must precede expression\n', exitCode: 1 };
    }
    const opts = {};
    let i = 2;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '-name') {
            const v = argv[i + 1];
            if (v === undefined) {
                return { stdout: '', stderr: "find: missing argument to '-name'\n", exitCode: 1 };
            }
            opts.namePattern = globToRegExp(v);
            i += 2;
            continue;
        }
        if (a === '-type') {
            const v = argv[i + 1];
            if (v !== 'f' && v !== 'd') {
                return {
                    stdout: '',
                    stderr: `find: -type expects 'f' or 'd', got '${v ?? ''}'\n`,
                    exitCode: 1,
                };
            }
            opts.typeFilter = v;
            i += 2;
            continue;
        }
        if (a === '-maxdepth') {
            const v = argv[i + 1];
            if (v === undefined) {
                return { stdout: '', stderr: "find: missing argument to '-maxdepth'\n", exitCode: 1 };
            }
            const parsed = Number.parseInt(v, 10);
            if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== v) {
                return {
                    stdout: '',
                    stderr: `find: '-maxdepth' expects non-negative integer, got '${v}'\n`,
                    exitCode: 1,
                };
            }
            opts.maxDepth = parsed;
            i += 2;
            continue;
        }
        return { stdout: '', stderr: `find: unsupported expression: ${a}\n`, exitCode: 1 };
    }
    const startAbs = await resolveLocalShellPath(startArg, ctx.workspaceRoot);
    const out = [];
    let truncated = false;
    const stack = [{ abs: startAbs, rel: startArg, depth: 0 }];
    while (stack.length > 0) {
        abortIfCancelled(ctx);
        const cur = stack.pop();
        let entries;
        let isDir = false;
        try {
            entries = await readdir(cur.abs, { withFileTypes: true });
            isDir = true;
        }
        catch (err) {
            const code = err.code;
            if (code === 'ENOTDIR') {
                // It's a plain file: filter & emit.
                if (matchesFile(cur, opts)) {
                    out.push(cur.rel);
                    if (out.length >= MAX_ENTRIES) {
                        truncated = true;
                        break;
                    }
                }
                continue;
            }
            if (code === 'ENOENT') {
                return {
                    stdout: '',
                    stderr: `find: '${cur.rel}': No such file or directory\n`,
                    exitCode: 1,
                };
            }
            return {
                stdout: '',
                stderr: `find: '${cur.rel}': ${err.message}\n`,
                exitCode: 1,
            };
        }
        // Emit the directory itself (find prints traversed dirs too).
        if (matchesDir(cur, opts)) {
            out.push(cur.rel);
            if (out.length >= MAX_ENTRIES) {
                truncated = true;
                break;
            }
        }
        if (!isDir)
            continue;
        if (opts.maxDepth !== undefined && cur.depth >= opts.maxDepth)
            continue;
        // Children. Push in reverse so order is alphabetical on pop.
        entries.sort((a, b) => b.name.localeCompare(a.name));
        for (const e of entries) {
            const childAbs = join(cur.abs, e.name);
            const childRel = cur.rel.endsWith(sep) ? `${cur.rel}${e.name}` : `${cur.rel}${sep}${e.name}`;
            // Verify path-guard for every child before descending so symlink
            // tricks abort cleanly.
            await resolveLocalShellPath(childRel, ctx.workspaceRoot).catch((err) => {
                throw err;
            });
            stack.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
        }
    }
    let stderr = '';
    if (truncated) {
        stderr += `find: truncated at ${MAX_ENTRIES} entries (local fast-path cap)\n`;
    }
    return {
        stdout: out.length === 0 ? '' : `${out.join('\n')}\n`,
        stderr,
        exitCode: 0,
    };
};
function matchesDir(frame, opts) {
    if (opts.typeFilter === 'f')
        return false;
    if (opts.namePattern && !opts.namePattern.test(basename(frame.rel)))
        return false;
    return true;
}
function matchesFile(frame, opts) {
    if (opts.typeFilter === 'd')
        return false;
    if (opts.namePattern && !opts.namePattern.test(basename(frame.rel)))
        return false;
    return true;
}
function basename(p) {
    const idx = p.lastIndexOf(sep);
    return idx === -1 ? p : p.slice(idx + 1);
}
//# sourceMappingURL=find.js.map