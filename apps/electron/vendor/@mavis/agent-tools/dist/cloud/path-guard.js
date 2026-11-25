/**
 * Workspace 路径围栏 —— 任何 cloud tool 访问 fs 之前都要先过这一关,
 * 防止 LLM 通过 `..` / 绝对路径 / **符号链接** 跳出工作目录。
 *
 * Cloud Host 默认 always-allow,该围栏是唯一的 fs 边界。`realpath()`
 * 用来抗符号链接逃逸(symlink 指向工作目录外部时同样拒绝),不存在的
 * 目标(write 新文件)通过递归向上找最近存在的祖先实现 containment。
 *
 * `realpathOf` 缺省为本机 `realpath`;文件不在本机时(cloud-harness-server 走 compute)
 * 由调用方传入,不存在的路径须以 `code: 'ENOENT'` 报错。
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
export async function assertWithinWorkspace(absolutePath, workspaceRoot, realpathOf = realpath) {
    const rootReal = await realpathOf(workspaceRoot);
    let candidate = resolve(absolutePath);
    const suffixParts = [];
    while (true) {
        let ancestorReal;
        try {
            ancestorReal = await realpathOf(candidate);
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw err;
            }
            const parent = dirname(candidate);
            if (parent === candidate) {
                throw new Error(`Workspace path escapes Cloud Host root: ${absolutePath}`);
            }
            suffixParts.unshift(basename(candidate));
            candidate = parent;
            continue;
        }
        const finalPath = suffixParts.length === 0 ? ancestorReal : resolve(ancestorReal, ...suffixParts);
        const rel = relative(rootReal, finalPath);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error(`Workspace path escapes Cloud Host root: ${absolutePath}`);
        }
        return;
    }
}
/**
 * 把一个用户给定的(可能相对)路径解析成绝对路径,然后过 workspace 围栏。
 * 返回经过 `path.resolve` 的绝对路径,供 fs 操作直接使用。
 */
export async function resolveWithinWorkspace(inputPath, workspaceRoot, realpathOf = realpath) {
    const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
    await assertWithinWorkspace(abs, workspaceRoot, realpathOf);
    return abs;
}
//# sourceMappingURL=path-guard.js.map