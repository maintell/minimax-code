/**
 * website_deploy 的文件端口：路径围栏、类型探测、遍历、打包与上传都经由这里。
 * 缺省实现直接读写本机 workspace（cloud-runtime）；cloud-harness-server 传入走 compute 的实现，
 * 文件字节不经过宿主进程。
 */
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import JSZip from 'jszip';
import { resolveWithinWorkspace } from './path-guard.js';
const IGNORE_NAMES = [
    /^\.git$/u,
    /^node_modules$/u,
    /^\.DS_Store$/u,
    /^\.env(\..+)?$/u,
];
export function isWebsiteDeployIgnoredName(name) {
    return IGNORE_NAMES.some((pattern) => pattern.test(name));
}
export function createLocalWebsiteDeployFiles(workspaceRoot) {
    return {
        resolve: (inputPath) => resolveWithinWorkspace(inputPath, workspaceRoot),
        typeOf: localTypeOf,
        realpath: (path) => realpath(path),
        list: walkDeployableFiles,
        pack: async (files, signal) => localArchive(await packZip(files, signal)),
    };
}
async function localTypeOf(path) {
    try {
        const info = await lstat(path);
        if (info.isDirectory())
            return 'dir';
        return info.isFile() ? 'file' : 'other';
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function walkDeployableFiles(rootDir, signal, excludedDir) {
    const rootReal = await realpath(rootDir);
    const excludedReal = excludedDir ? await realpath(excludedDir) : undefined;
    const files = [];
    const stack = [rootReal];
    while (stack.length > 0) {
        if (signal?.aborted)
            throw new Error('aborted');
        const dir = stack.pop();
        if (!dir)
            break;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (isWebsiteDeployIgnoredName(entry.name))
                continue;
            const absPath = join(dir, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                const realDir = await realpath(absPath);
                if (excludedReal && realDir === excludedReal)
                    continue;
                stack.push(realDir);
                continue;
            }
            if (!entry.isFile())
                continue;
            const info = await lstat(absPath);
            if (!info.isFile())
                continue;
            files.push({
                absPath,
                relPath: relative(rootReal, absPath).split(sep).join('/'),
                bytes: info.size,
            });
        }
    }
    return files;
}
async function packZip(files, signal) {
    const zip = new JSZip();
    for (const file of files) {
        if (signal?.aborted)
            throw new Error('aborted');
        zip.file(file.relPath, createReadStream(file.absPath));
    }
    const archive = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
    if (signal?.aborted)
        throw new Error('aborted');
    return archive;
}
function localArchive(archive) {
    return {
        bytes: archive.byteLength,
        async put(url, { contentType, timeoutMs, signal }) {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const putSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
            const response = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                // Copy into a plain Uint8Array so the DOM `fetch` BodyInit contract is
                // satisfied across Node 22's generic Buffer typings.
                body: new Uint8Array(archive),
                signal: putSignal,
            });
            return !timeoutSignal.aborted && response.ok;
        },
        dispose: () => Promise.resolve(),
    };
}
//# sourceMappingURL=website-deploy-files.js.map