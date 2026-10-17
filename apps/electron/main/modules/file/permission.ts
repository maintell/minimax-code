/**
 * File Permission Module
 * 跨平台文件权限管理
 *
 * ## 平台差异说明
 *
 * ### Windows
 * - Windows 不使用 Unix 风格的权限位系统
 * - 可执行性由文件扩展名决定（.exe, .bat, .cmd, .ps1 等）
 * - chmod 操作在 Windows 上会优雅降级（返回成功但不执行实际操作）
 *
 * ### macOS/Linux
 * - 使用标准的 Unix 权限位（owner/group/others, read/write/execute）
 * - 支持完整的 chmod 操作
 * - 常用权限：755 (rwxr-xr-x), 644 (rw-r--r--), 744 (rwxr--r--)
 */

import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../../utils";
import { expandTilde } from ".";
/**
 * 将预设模式转换为八进制权限值
 */
function getModeValue(mode) {
    if (typeof mode === 'number') {
        return mode;
    }
    switch (mode) {
        case 'executable':
            return 0o755; // rwxr-xr-x - 所有人可读和执行，所有者可写
        case 'owner-executable':
            return 0o744; // rwxr--r-- - 仅所有者可执行
        case 'read-write':
            return 0o644; // rw-r--r-- - 所有人可读，所有者可写
        default:
            return 0o755;
    }
}
/**
 * 递归设置目录权限
 */
async function chmodRecursive(dirPath, mode) {
    // 先设置目录本身的权限
    await fs.chmod(dirPath, mode);
    // 读取目录内容
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    // 递归处理每个条目
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            await chmodRecursive(fullPath, mode);
        }
        else {
            await fs.chmod(fullPath, mode);
        }
    }
}
/**
 * 设置文件权限（添加可执行权限等）
 *
 * ## Windows 平台说明
 * - Windows 不使用 Unix 权限位
 * - 此函数在 Windows 上会返回成功但不执行实际操作
 * - 可执行性由文件扩展名决定（.exe, .bat, .cmd 等）
 *
 * ## Unix/Linux/macOS 平台
 * - 使用标准的 chmod 操作
 * - 支持递归设置目录权限
 * - 常用模式：
 *   - executable: 755 (rwxr-xr-x)
 *   - owner-executable: 744 (rwxr--r--)
 *   - read-write: 644 (rw-r--r--)
 *
 * @example
 * // 设置脚本为可执行
 * await chmodFileCommand({
 *   file_path: '~/scripts/deploy.sh',
 *   mode: 'executable'
 * });
 *
 * @example
 * // 使用自定义八进制权限
 * await chmodFileCommand({
 *   file_path: '/usr/local/bin/tool',
 *   mode: 0o755
 * });
 *
 * @example
 * // 递归设置目录权限
 * await chmodFileCommand({
 *   file_path: '~/bin/',
 *   mode: 'executable',
 *   recursive: true
 * });
 */
export async function chmodFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath, mode, recursive = false, is_windows: isWindows = false, } = params;
        const file_path = expandTilde(rawFilePath);
        logger.info(`[FileModule] chmod params: ${JSON.stringify(params)}`);
        // 检查文件是否存在
        try {
            await fs.access(file_path);
        }
        catch {
            return {
                success: false,
                error: `File not found: ${file_path}`,
                file_path,
                duration: Date.now() - startTime,
            };
        }
        // Windows 平台特殊处理
        if (isWindows) {
            logger.info(`[FileModule] chmod skipped on Windows: ${file_path}`);
            return {
                success: true,
                file_path,
                message: 'Windows does not use Unix permissions. Executable files are determined by extension (.exe, .bat, .cmd, etc.)',
                duration: Date.now() - startTime,
            };
        }
        // Unix-like 平台：执行 chmod
        const modeValue = getModeValue(mode);
        const stats = await fs.stat(file_path);
        if (stats.isDirectory() && recursive) {
            // 递归设置目录权限
            await chmodRecursive(file_path, modeValue);
            logger.info(`[FileModule] chmod completed (recursive): ${file_path} -> ${modeValue.toString(8)}`);
        }
        else {
            // 设置单个文件权限
            await fs.chmod(file_path, modeValue);
            logger.info(`[FileModule] chmod completed: ${file_path} -> ${modeValue.toString(8)}`);
        }
        return {
            success: true,
            file_path,
            applied_mode: `0${modeValue.toString(8)}`,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        logger.error(`[FileModule] chmod error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            file_path: params.file_path,
            duration: Date.now() - startTime,
        };
    }
}
