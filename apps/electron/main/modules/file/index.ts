import { writeFileIfUnchanged } from "./conditional-write";
/**
 * File 工具执行器
 * 核心执行逻辑
 *
 * ## 安全架构说明
 * 路径遍历防护和敏感文件访问控制由 Agent 服务端（大模型）负责，
 * 客户端不进行路径的安全检查。这种架构设计的原因：
 * 1. 服务端大模型具备更强的语义理解能力，可以更准确地判断操作意图
 * 2. 避免客户端路径匹配导致的误报，影响正常功能
 * 3. 安全策略集中管理，便于更新和维护
 *
 * @see .matrix_memory/architecture/security.md
 */
import * as fs from "fs/promises";
import * as path from "path";
import { app, net, shell } from "electron";
import { glob } from "glob";
import extractZip from "extract-zip";
import { truncateTextByTokens, MAX_TOKENS, truncateFileList } from "../../utils/token";
import { logger } from "../../utils";
import { uploadMultipleToOSS } from "../oss";
import { chmodFileCommand } from "./permission";
export { chmodFileCommand };
import { executeRipgrep } from "./grep";
import { readBase64FileRange } from "./base64-range";
const FILE_META_FAILED = 0;
const FILE_META_SUCCESS = 1;
/**
 * 读取文件并按行格式化
 */
async function readFileWithLineNumbers(filePath, offset = 0, limit = 2000) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    const startLine = Math.max(0, offset);
    const endLine = Math.min(totalLines, startLine + limit);
    const selectedLines = lines.slice(startLine, endLine);
    const formattedLines = selectedLines.map((line, index) => {
        const lineNumber = startLine + index + 1;
        const truncatedLine = line.length > 2000 ? line.substring(0, 2000) + '...' : line;
        return `${lineNumber}|${truncatedLine}`;
    });
    const linesStr = formattedLines.join('\n');
    const processedLinesStr = truncateTextByTokens(linesStr, MAX_TOKENS);
    return {
        content: processedLinesStr,
        lines_read: selectedLines.length,
        total_lines: totalLines,
        truncated: endLine < totalLines || processedLinesStr.length !== linesStr.length,
    };
}
/**
 * 确保目录存在
 */
async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    }
    catch {
        // 忽略已存在的目录错误
    }
}
/**
 * 获取文件信息
 */
/**
 * 展开路径中的 ~ 符号为用户主目录
 */
export function expandTilde(filePath) {
    if (filePath.startsWith('~/') || filePath === '~') {
        const homeDir = app.getPath('home');
        return filePath.replace(/^~/, homeDir);
    }
    return filePath;
}
async function getFileInfo(filePath) {
    // 展开 ~ 路径
    const expandedPath = expandTilde(filePath);
    const stats = await fs.stat(expandedPath);
    const parsedPath = path.parse(expandedPath);
    return {
        name: parsedPath.base,
        path: expandedPath, // 返回展开后的完整路径
        size: stats.size,
        is_directory: stats.isDirectory(),
        is_file: stats.isFile(),
        is_symbolic_link: stats.isSymbolicLink(),
        created_at: stats.birthtime,
        modified_at: stats.mtime,
        accessed_at: stats.atime,
        mode: stats.mode,
    };
}
/**
 * 读取文件
 */
export async function readFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath, offset = 0, limit = 2000, encoding = 'utf-8', with_line_numbers = false, } = params;
        // 展开 ~ 路径
        const file_path = expandTilde(rawFilePath);
        try {
            await fs.access(file_path);
        }
        catch {
            return {
                success: false,
                error: `File not found: ${file_path}`,
                content: '',
                lines_read: 0,
                total_lines: 0,
                truncated: false,
                duration: Date.now() - startTime,
            };
        }
        // 如果是 base64 编码，直接读取原始文件，不添加行号
        if (encoding === 'base64') {
            const range = await readBase64FileRange(file_path, params.offset, params.limit);
            return {
                success: true,
                content: range.content,
                lines_read: 1,
                total_lines: 1,
                truncated: range.truncated,
                duration: Date.now() - startTime,
            };
        }
        // 如果不需要行号，直接读取原始文件内容
        if (!with_line_numbers) {
            const content = await fs.readFile(file_path, 'utf-8');
            const lines = content.split('\n');
            const totalLines = lines.length;
            const startLine = Math.max(0, offset);
            const endLine = Math.min(totalLines, startLine + limit);
            const selectedLines = lines.slice(startLine, endLine);
            const selectedLinesStr = selectedLines.join('\n');
            const processedSelectedLinesStr = truncateTextByTokens(selectedLinesStr, MAX_TOKENS);
            return {
                success: true,
                content: processedSelectedLinesStr,
                lines_read: selectedLines.length,
                total_lines: totalLines,
                truncated: endLine < totalLines || processedSelectedLinesStr.length !== content.length,
                duration: Date.now() - startTime,
            };
        }
        // 对于文本文件，使用行号格式
        const result = await readFileWithLineNumbers(file_path, offset, limit);
        return {
            success: true,
            ...result,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            content: '',
            lines_read: 0,
            total_lines: 0,
            truncated: false,
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 写入文件
 */
export async function writeFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath, content, create_dir = true, encoding = 'utf-8' } = params;
        const file_path = expandTilde(rawFilePath);
        if (create_dir) {
            const dir = path.dirname(file_path);
            await ensureDir(dir);
        }
        // 如果是 base64 编码，需要先转换为 Buffer
        if (params.expected_sha256 !== undefined) {
            await writeFileIfUnchanged(file_path, Buffer.from(content, encoding), params.expected_sha256);
        }
        else if (encoding === 'base64') {
            const buffer = Buffer.from(content, 'base64');
            await fs.writeFile(file_path, buffer);
        }
        else {
            await fs.writeFile(file_path, content, encoding);
        }
        const stats = await fs.stat(file_path);
        return {
            success: true,
            bytes_written: stats.size,
            file_path,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            bytes_written: 0,
            file_path: params.file_path,
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 编辑文件
 */
export async function editFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath, old_string, new_string, replace_all = false } = params;
        const file_path = expandTilde(rawFilePath);
        const content = await fs.readFile(file_path, 'utf-8');
        let newContent;
        let replacements = 0;
        if (replace_all) {
            const matches = content.split(old_string).length - 1;
            newContent = content.split(old_string).join(new_string);
            replacements = matches;
        }
        else {
            const index = content.indexOf(old_string);
            if (index === -1) {
                return {
                    success: false,
                    error: 'Old string not found in file',
                    replacements: 0,
                    duration: Date.now() - startTime,
                };
            }
            const secondIndex = content.indexOf(old_string, index + 1);
            if (secondIndex !== -1) {
                return {
                    success: false,
                    error: 'Old string is not unique. Use replace_all: true or provide more context.',
                    replacements: 0,
                    duration: Date.now() - startTime,
                };
            }
            newContent =
                content.substring(0, index) + new_string + content.substring(index + old_string.length);
            replacements = 1;
        }
        await fs.writeFile(file_path, newContent, 'utf-8');
        return {
            success: true,
            replacements,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            replacements: 0,
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 多次编辑文件
 */
export async function multiEditFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath, edits: editsStr } = params;
        const file_path = expandTilde(rawFilePath);
        const edits = JSON.parse(editsStr);
        let content = await fs.readFile(file_path, 'utf-8');
        let totalReplacements = 0;
        const editResults = [];
        for (let i = 0; i < edits.length; i++) {
            const edit = edits[i];
            const { old_str, new_str, replace_all } = edit;
            try {
                if (replace_all) {
                    const matches = content.split(old_str).length - 1;
                    content = content.split(old_str).join(new_str);
                    totalReplacements += matches;
                    editResults.push({ index: i, replacements: matches, success: true });
                }
                else {
                    const index = content.indexOf(old_str);
                    if (index === -1) {
                        throw new Error(`Edit ${i}: Old string not found`);
                    }
                    content =
                        content.substring(0, index) + new_str + content.substring(index + old_str.length);
                    totalReplacements += 1;
                    editResults.push({ index: i, replacements: 1, success: true });
                }
            }
            catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                    total_replacements: 0,
                    edit_results: editResults,
                    duration: Date.now() - startTime,
                };
            }
        }
        await fs.writeFile(file_path, content, 'utf-8');
        return {
            success: true,
            total_replacements: totalReplacements,
            edit_results: editResults,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            total_replacements: 0,
            edit_results: [],
            duration: Date.now() - startTime,
        };
    }
}
/**
 * Glob 文件搜索
 */
export async function globSearchCommand(params) {
    const startTime = Date.now();
    try {
        const { pattern, path: searchPath = process.cwd(), ignore = [], limit } = params;
        logger.info(`[FileModule] Glob search: pattern="${pattern}", path="${searchPath}", limit=${limit || 'none'}`);
        logger.info(`[FileModule] Glob ignore patterns: ${ignore}`);
        // 检查路径是否存在
        try {
            const pathStats = await fs.stat(searchPath);
            logger.info(`[FileModule] Search path exists, isDirectory: ${pathStats.isDirectory()}`);
        }
        catch (err) {
            logger.error(`[FileModule] Search path does not exist or not accessible: ${err}`);
            return {
                success: false,
                error: `Search path not accessible: ${searchPath}`,
                files: [],
                count: 0,
                duration: Date.now() - startTime,
            };
        }
        // 执行 glob 搜索
        // 使用 sync 版本更可靠（glob v7.x）
        let files;
        try {
            logger.info(`[FileModule] Using glob.sync with pattern: "${pattern}"`);
            const globResult = glob.sync(pattern, {
                cwd: searchPath,
                absolute: true,
                ignore,
                nodir: true,
                dot: false, // 不匹配隐藏文件（如 .DS_Store）
            });
            // 确保返回的是数组
            files = Array.isArray(globResult) ? globResult : [];
            logger.info(`[FileModule] Glob.sync returned ${files.length} files`);
        }
        catch (globError) {
            logger.error(`[FileModule] Glob.sync failed: ${globError}`);
            return {
                success: false,
                error: `Glob search failed: ${globError instanceof Error ? globError.message : String(globError)}`,
                files: [],
                count: 0,
                duration: Date.now() - startTime,
            };
        }
        if (files.length === 0) {
            logger.info(`[FileModule] No files found! Trying to list directory contents for debugging...`);
            try {
                const dirContents = await fs.readdir(searchPath);
                logger.info(`[FileModule] Directory contents (${dirContents.length} items): ${dirContents}`);
                logger.info(`[FileModule] Pattern "${pattern}" did not match any of these files`);
            }
            catch (err) {
                logger.error(`[FileModule] Cannot read directory: ${err}`);
            }
            return {
                success: true,
                files: [],
                count: 0,
                duration: Date.now() - startTime,
            };
        }
        // 获取文件修改时间和大小并排序
        const filesWithStats = await Promise.all(files.map(async (file) => {
            try {
                const stats = await fs.stat(file);
                return { file, mtime: stats.mtime.getTime(), size: stats.size };
            }
            catch (error) {
                // 如果文件无法访问，返回默认值
                console.warn(`[FileModule] Cannot stat file: ${file}`, error);
                return { file, mtime: 0, size: 0 };
            }
        }));
        filesWithStats.sort((a, b) => b.mtime - a.mtime);
        let sortedFilesWithStats = filesWithStats;
        if (limit && limit > 0) {
            sortedFilesWithStats = sortedFilesWithStats.slice(0, limit);
        }
        const sortedFiles = sortedFilesWithStats.map((item) => item.file);
        const fileInfos = sortedFilesWithStats.map((item) => ({
            path: item.file,
            size: item.size,
        }));
        logger.info(`[FileModule] Glob search completed: found ${sortedFiles.length} files`);
        // 应用 token 限制截断
        // Glob 使用 50% 的限制，预留空间给 fileInfos 和 JSON 结构
        const { files: finalFiles, truncated, originalCount, } = truncateFileList(sortedFiles, Math.floor(MAX_TOKENS * 0.5));
        // 同步截断 fileInfos
        let finalFileInfos = fileInfos;
        if (truncated) {
            const finalFilesSet = new Set(finalFiles);
            finalFileInfos = fileInfos.filter((info) => finalFilesSet.has(info.path));
            logger.info(`[FileModule] Files truncated by token limit: ${originalCount} -> ${finalFiles.length}`);
        }
        return {
            success: true,
            files: finalFiles,
            fileInfos: finalFileInfos,
            count: originalCount, // 保持原始文件总数
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        logger.error(`[FileModule] Glob search error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            files: [],
            count: 0,
            duration: Date.now() - startTime,
        };
    }
}
/**
 * Grep 内容搜索
 * 使用 ripgrep 实现高性能文本搜索
 */
export async function grepSearchCommand(params) {
    const startTime = Date.now();
    try {
        logger.info(`[FileModule] Grep search: pattern="${params.pattern}", path="${params.path || 'cwd'}", mode="${params.output_mode || 'files_with_matches'}"`);
        // 调用 ripgrep 模块执行搜索
        const result = await executeRipgrep(params);
        if (result.success) {
            logger.info(`[FileModule] Grep search completed: ${result.total_matches} matches found in ${result.duration}ms`);
        }
        else {
            console.warn(`[FileModule] Grep search failed: ${result.error}`);
        }
        return result;
    }
    catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`[FileModule] Grep search error: ${error}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            total_matches: 0,
            duration,
        };
    }
}
/**
 * 列出目录
 */
export async function listDirectoryCommand(params) {
    const startTime = Date.now();
    try {
        const { path: rawDirPath, recursive = false, show_hidden = false, glob: globPattern } = params;
        const dirPath = expandTilde(rawDirPath);
        let files;
        if (recursive || globPattern) {
            const pattern = globPattern || '**/*';
            files = await glob(pattern, {
                cwd: dirPath,
                absolute: true,
                dot: show_hidden,
            });
        }
        else {
            const entries = await fs.readdir(dirPath);
            files = entries.map((entry) => path.join(dirPath, entry));
            if (!show_hidden) {
                files = files.filter((file) => !path.basename(file).startsWith('.'));
            }
        }
        const items = await Promise.all(files.map(async (file) => {
            try {
                return await getFileInfo(file);
            }
            catch {
                return null;
            }
        }));
        const validItems = items.filter((item) => item !== null);
        return {
            success: true,
            items: validItems,
            count: validItems.length,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            items: [],
            count: 0,
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 获取文件信息
 */
export async function statFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path } = params;
        const info = await getFileInfo(file_path);
        return {
            success: true,
            info,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            info: {},
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 删除文件
 */
export async function deleteFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath } = params;
        const file_path = expandTilde(rawFilePath);
        const stats = await fs.stat(file_path);
        if (stats.isDirectory()) {
            // 目录必须使用 recursive: true，否则会报 EISDIR 错误
            await fs.rm(file_path, { recursive: true, force: true });
        }
        else {
            await fs.unlink(file_path);
        }
        return {
            success: true,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 移动/重命名文件
 */
export async function moveFileCommand(params) {
    const startTime = Date.now();
    try {
        const { source_path: rawSourcePath, target_path: rawTargetPath, overwrite = false } = params;
        const source_path = expandTilde(rawSourcePath);
        const target_path = expandTilde(rawTargetPath);
        if (!overwrite) {
            try {
                await fs.access(target_path);
                return {
                    success: false,
                    error: 'Target file already exists',
                    duration: Date.now() - startTime,
                };
            }
            catch {
                // 目标不存在，继续
            }
        }
        const targetDir = path.dirname(target_path);
        await ensureDir(targetDir);
        await fs.rename(source_path, target_path);
        return {
            success: true,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 复制文件
 */
export async function copyFileCommand(params) {
    const startTime = Date.now();
    try {
        const { source_path: rawSourcePath, target_path: rawTargetPath, overwrite = false } = params;
        const source_path = expandTilde(rawSourcePath);
        const target_path = expandTilde(rawTargetPath);
        if (!overwrite) {
            try {
                await fs.access(target_path);
                return {
                    success: false,
                    error: 'Target file already exists',
                    duration: Date.now() - startTime,
                };
            }
            catch {
                // 目标不存在，继续
            }
        }
        const targetDir = path.dirname(target_path);
        await ensureDir(targetDir);
        await fs.copyFile(source_path, target_path);
        return {
            success: true,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 下载文件
 * 从 CDN URL 或 OSS 路径下载文件到指定路径
 */
export async function downloadFileCommand(params) {
    const startTime = Date.now();
    try {
        const { files: file_infos, workspace_dir } = params;
        if (!file_infos || file_infos.length === 0) {
            console.warn('[FileModule] No files to download');
            return {
                files: [],
            };
        }
        logger.info(`[FileModule] Downloading ${file_infos.length} file(s)`);
        logger.info(`[FileModule] Workspace dir: ${workspace_dir || 'not provided'}`);
        // 并行下载所有文件
        const downloadPromises = file_infos.map((fileInfo) => downloadAndUnzipFile(fileInfo, workspace_dir));
        const results = await Promise.all(downloadPromises);
        const successCount = results.filter((result) => result.success === FILE_META_SUCCESS).length;
        const failedCount = results.length - successCount;
        logger.info(`[FileModule] All files downloaded end, total: ${results.length}, success: ${successCount}, failed: ${failedCount}, duration: ${Date.now() - startTime}ms`);
        return {
            files: results,
        };
    }
    catch (error) {
        logger.error(`[FileModule] Download file error: ${error}`);
        throw error;
    }
}
// 下载并解压文件
async function downloadAndUnzipFile(fileInfo, workspace_dir) {
    const result = await downloadSingleFile(fileInfo.cdn_url, fileInfo.file_path, workspace_dir);
    // check 下是否需要解压
    if (fileInfo.auto_extract === true && result.success === FILE_META_SUCCESS) {
        try {
            const targetDir = await unzipFile(result.file_path || '');
            if (targetDir) {
                // 删掉 zip 文件
                await fs.unlink(result.file_path || '');
                logger.info(`[FileModule] delete source file: ${result.file_path}`);
                return {
                    ...result,
                    file_path: targetDir,
                };
            }
        }
        catch (error) {
            logger.error(`[FileModule] Unzip file error: ${error}`);
            return {
                ...result,
                success: FILE_META_FAILED,
                err_msg: error instanceof Error ? error.message : 'Unknown unzip file error',
            };
        }
    }
    return result;
}
/**
 * 解压缩 ZIP 文件
 * @param filePath - ZIP 文件的完整路径
 * @returns 是否解压成功
 * @throws 如果文件不存在、不是 ZIP 文件或解压失败
 *
 * @example
 * await unzipFile('/path/to/file.zip');
 * // 文件会被解压到 /path/to/ 目录下
 */
export async function unzipFile(filePath) {
    const startTime = Date.now();
    try {
        // 检查文件是否存在
        const fileExists = await fs
            .access(filePath)
            .then(() => true)
            .catch(() => false);
        if (!fileExists) {
            throw new Error(`File not found: ${filePath}`);
        }
        // 检查是否是 zip 文件
        if (!filePath.toLowerCase().endsWith('.zip')) {
            throw new Error('Only .zip files are supported');
        }
        // 获取解压目标目录（与 zip 文件同级）
        const targetDir = filePath.endsWith('.zip') ? filePath.slice(0, -4) : filePath;
        logger.info(`[FileModule] Unzipping ${filePath} to ${targetDir}...`);
        // 解压文件到与 zip 同级的目录
        await extractZip(filePath, { dir: targetDir });
        const duration = Date.now() - startTime;
        logger.info(`[FileModule] Unzip completed in ${duration}ms`);
        return targetDir;
    }
    catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`[FileModule] Unzip file error (${duration}ms): ${error}`);
        throw error;
    }
}
/**
 * 下载单个文件（支持 CDN URL 和 OSS 路径）
 * 路径回退逻辑：
 * 1. 如果 filePath 有值，使用 filePath
 * 2. 如果 filePath 为空但 workspace_dir 有值，使用 workspace_dir + 文件名
 * 3. 如果都为空，使用系统 Downloads 目录 + 文件名
 */
async function downloadSingleFile(cdnUrl, filePath, workspace_dir) {
    if (!cdnUrl) {
        console.warn('[FileModule] Missing cdn_url');
        return {
            file_path: '',
            cdn_url: '',
            success: FILE_META_FAILED,
            err_msg: 'Missing cdn_url',
        };
    }
    // 确定最终的文件保存路径
    let finalFilePath;
    if (filePath) {
        // 1. 判断是绝对路径还是相对路径
        if (path.isAbsolute(filePath)) {
            // 绝对路径，直接使用
            finalFilePath = filePath;
            logger.info(`[FileModule] Using provided absolute path: ${finalFilePath}`);
        }
        else {
            // 相对路径，需要拼接 workspace_dir 或 Downloads
            if (workspace_dir) {
                // 相对于 workspace_dir
                finalFilePath = path.join(workspace_dir, filePath);
                logger.info(`[FileModule] Relative path + workspace_dir: ${finalFilePath}`);
            }
            else {
                // 相对于 Downloads 目录
                const downloadsPath = app.getPath('downloads');
                finalFilePath = path.join(downloadsPath, filePath);
                logger.info(`[FileModule] Relative path + Downloads: ${finalFilePath}`);
            }
        }
    }
    else {
        // 从 URL 提取文件名
        const urlFileName = cdnUrl.split('/').pop() || `download_${Date.now()}`;
        const fileName = decodeURIComponent(urlFileName.split('?')[0]); // 移除 query string
        if (workspace_dir) {
            // 2. 如果有 workspace_dir，保存到 workspace_dir
            finalFilePath = path.join(workspace_dir, fileName);
            logger.info(`[FileModule] Using workspace_dir: ${finalFilePath}`);
        }
        else {
            // 3. 否则保存到系统 Downloads 目录
            const downloadsPath = app.getPath('downloads');
            finalFilePath = path.join(downloadsPath, fileName);
            logger.info(`[FileModule] Using system Downloads folder: ${finalFilePath}`);
        }
    }
    try {
        logger.info(`[FileModule] Downloading from: ${cdnUrl} to: ${finalFilePath}`);
        // 判断是否是 OSS 路径（不以 http:// 或 https:// 开头）
        if (!cdnUrl.startsWith('http://') && !cdnUrl.startsWith('https://')) {
            // 从 OSS 下载
            logger.info('[FileModule] Detected OSS path, using OSS module to download');
            // 确保目标目录存在
            const dirPath = path.dirname(finalFilePath);
            await ensureDir(dirPath);
            // depracated use https download instead
            return {
                success: FILE_META_FAILED,
                err_msg: 'Download failed from OSS, cdn_url must start with http',
                file_path: finalFilePath,
                cdn_url: cdnUrl,
            };
        }
        else {
            // 从 HTTP/HTTPS URL 下载
            logger.info('[FileModule] Detected HTTP URL, using fetch to download');
            const controller = new AbortController();
            const timeout = 120000; // 120秒超时
            const timeoutId = setTimeout(() => {
                controller.abort();
            }, timeout);
            const response = await net.fetch(cdnUrl, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            // 检查响应状态
            if (!response.ok) {
                return {
                    success: FILE_META_FAILED,
                    err_msg: `HTTP error: ${response.status} ${response.statusText}`,
                    file_path: filePath,
                    cdn_url: cdnUrl,
                };
            }
            // 获取响应数据作为 ArrayBuffer
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            logger.info(`[FileModule] Downloaded from HTTP: ${buffer.length} bytes`);
            // 确保目标目录存在
            const dirPath = path.dirname(finalFilePath);
            await ensureDir(dirPath);
            // 写入文件
            await fs.writeFile(finalFilePath, buffer);
            logger.info(`[FileModule] File downloaded successfully: ${finalFilePath} (${buffer.length} bytes)`);
        }
        return {
            file_path: finalFilePath,
            cdn_url: cdnUrl,
            success: FILE_META_SUCCESS,
        };
    }
    catch (error) {
        // 判断是否超时
        const isTimeout = error instanceof Error && error.name === 'AbortError';
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[FileModule] Download error for ${cdnUrl}: ${isTimeout ? 'TIMEOUT' : errorMsg}`);
        return {
            success: FILE_META_FAILED,
            err_msg: errorMsg,
            file_path: filePath,
            cdn_url: cdnUrl,
        };
    }
}
/**
 * 移动文件到回收站
 * 使用 Electron shell.trashItem() API
 */
export async function trashFileCommand(params) {
    const startTime = Date.now();
    try {
        const { file_path: rawFilePath } = params;
        const file_path = expandTilde(rawFilePath);
        await shell.trashItem(file_path);
        return {
            success: true,
            duration: Date.now() - startTime,
        };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: Date.now() - startTime,
        };
    }
}
/**
 * 上传文件到 OSS
 * 在主进程中处理 OSS 上传，密钥不会暴露到前端
 */
export async function uploadFileCommand(params) {
    try {
        const { files } = params;
        if (!files || files.length === 0) {
            console.warn('[FileModule] No files to upload');
            return { files: [] };
        }
        logger.info(`[FileModule] Uploading ${files.length} file(s) to OSS`);
        // 使用 OSS 模块批量上传
        const results = await uploadMultipleToOSS(files);
        logger.info(`[FileModule] All files upload completed`);
        return { files: results };
    }
    catch (error) {
        logger.error(`[FileModule] Upload file error: ${error}`);
        throw error;
    }
}
