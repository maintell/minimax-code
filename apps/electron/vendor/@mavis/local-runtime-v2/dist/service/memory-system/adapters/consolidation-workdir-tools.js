/**
 * §5.6 INCREMENTAL 整理 agent 的文件工具。
 *
 * 边界即安全模型：工具只接受工作目录内的相对 Markdown 文件路径（与
 * `createConsolidationWorkdir` 的命名约束一致），路径穿越、绝对路径与
 * 非 Markdown 文件一律拒绝。失败以 isError 工具结果返回，不抛出。
 */
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Type } from '@sinclair/typebox';
import { isMemoryPath, readFileWindow } from '../orchestration/memory-files.js';
/** 单文件覆写上限：防御模型失控输出；正常产物远小于此值。 */
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
async function resolveSafePath(workDir, name, allowMissing = false) {
    if (!isMemoryPath(name) || !name.endsWith('.md'))
        return undefined;
    const base = resolve(workDir);
    const full = resolve(join(base, name));
    if (!full.startsWith(base + sep))
        return undefined;
    const parts = name.split('/');
    let current = base;
    try {
        const root = await lstat(base);
        if (!root.isDirectory() || root.isSymbolicLink())
            return undefined;
        for (let i = 0; i < parts.length; i++) {
            current = join(current, parts[i]);
            const final = i === parts.length - 1;
            if (!(await isSafeEntry(current, final, allowMissing)))
                return undefined;
        }
        return full;
    }
    catch {
        return undefined;
    }
}
async function isSafeEntry(path, final, allowMissing) {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink())
            return false;
        return final ? stat.isFile() : stat.isDirectory();
    }
    catch (error) {
        return final && allowMissing && error.code === 'ENOENT';
    }
}
async function listFiles(root, prefix = '') {
    const names = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink())
            continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            names.push(...(await listFiles(root, path)));
        else if (entry.isFile() && entry.name.endsWith('.md'))
            names.push(path);
    }
    return names.sort();
}
export function createConsolidationWorkdirTools(workDir) {
    return [
        {
            name: 'list_files',
            description: 'List all files in the consolidation working directory.',
            parameters: Type.Object({}, { additionalProperties: false }),
            async execute() {
                try {
                    const names = await listFiles(workDir);
                    return { text: names.length > 0 ? names.join('\n') : '(empty)' };
                }
                catch {
                    return { text: 'Working directory is not readable.', isError: true };
                }
            },
        },
        {
            name: 'read_file',
            description: 'Read up to 200 lines of a working file. Use next_line_offset to continue; null means end of file.',
            parameters: Type.Object({ path: Type.String(), line_offset: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
            async execute(args) {
                const full = await resolveSafePath(workDir, args.path);
                if (!full)
                    return { text: `Invalid file name: ${String(args.path)}`, isError: true };
                try {
                    const result = readFileWindow(String(args.path), await readFile(full, 'utf8'), args.line_offset, 64 * 1024);
                    return result.status === 'ok'
                        ? { text: JSON.stringify(result.result) }
                        : { text: result.message, isError: true };
                }
                catch {
                    return { text: `File not found: ${String(args.path)}`, isError: true };
                }
            },
        },
        {
            name: 'write_file',
            description: 'Overwrite one file in the working directory with the given content. ' +
                'Only MEMORY.md and memory_summary.md need to be produced.',
            parameters: Type.Object({
                path: Type.String({ description: 'File name, e.g. MEMORY.md' }),
                content: Type.String(),
            }, { additionalProperties: false }),
            async execute(args) {
                if (args.path !== 'MEMORY.md' && args.path !== 'memory_summary.md')
                    return { text: 'Only the two memory artifacts are writable.', isError: true };
                const full = await resolveSafePath(workDir, args.path, true);
                if (!full)
                    return { text: `Invalid file name: ${String(args.path)}`, isError: true };
                const content = args.content;
                if (typeof content !== 'string') {
                    return { text: 'content must be a string.', isError: true };
                }
                if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
                    return { text: 'Content exceeds the per-file write limit.', isError: true };
                }
                try {
                    await writeFile(full, content, 'utf8');
                    return { text: `Wrote ${String(args.path)}.` };
                }
                catch {
                    return { text: `Failed to write ${String(args.path)}.`, isError: true };
                }
            },
        },
    ];
}
//# sourceMappingURL=consolidation-workdir-tools.js.map