/**
 * 热更新模块工具函数
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { app, net } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { HOT_UPDATE_DIR, SHELL_FINGERPRINT_FILENAME } from "./config";
const logger = getCategoryLogger('update');
// ==================== 路径相关 ====================
/**
 * 获取热更新缓存目录路径
 */
export function getHotUpdateDir() {
    return path.join(app.getPath('userData'), HOT_UPDATE_DIR);
}
/**
 * 读取打包时写入 dist/ 的壳指纹；缺失或格式错误返回 null（该包不接收热更新）
 */
export function readShellFingerprint(appPath = app.getAppPath()) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(appPath, 'dist', SHELL_FINGERPRINT_FILENAME), 'utf8'));
        return typeof raw.shellFingerprint === 'string' && /^[0-9a-f]{64}$/.test(raw.shellFingerprint)
            ? raw.shellFingerprint
            : null;
    }
    catch {
        return null;
    }
}
/**
 * 确保目录存在
 */
export function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}
// ==================== 网络请求 ====================
/**
 * 使用 Electron net.fetch 发起 GET 请求；404 返回 null（该通道/版本尚未发布热更新）
 */
export async function fetchText(url) {
    const response = await net.fetch(url, {
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
        },
    });
    if (response.status === 404 || response.status === 403) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
}
/**
 * 计算文件的 SHA256 哈希值
 */
export async function calculateFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
/**
 * 使用 Electron net.fetch 下载文件到本地
 */
export async function downloadFile(url, destPath, options) {
    ensureDir(path.dirname(destPath));
    const { expectedSha256, expectedSize, onProgress } = options || {};
    const response = await net.fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
    let downloadedSize = 0;
    const fileStream = fs.createWriteStream(destPath);
    const reader = response.body?.getReader?.();
    if (!reader) {
        throw new Error('Response body is not readable');
    }
    try {
        let done = false;
        while (!done) {
            const result = await reader.read();
            done = result.done;
            if (result.value) {
                downloadedSize += result.value.length;
                if (expectedSize !== undefined && downloadedSize > expectedSize) {
                    throw new Error(`Download exceeds expected size ${expectedSize}`);
                }
                if (!fileStream.write(Buffer.from(result.value))) {
                    await new Promise((resolve) => fileStream.once('drain', () => resolve()));
                }
                if (onProgress && totalSize > 0) {
                    onProgress(downloadedSize, totalSize);
                }
            }
        }
        await new Promise((resolve, reject) => {
            fileStream.end((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        if (expectedSize !== undefined && downloadedSize !== expectedSize) {
            throw new Error(`Size mismatch: expected ${expectedSize}, got ${downloadedSize}`);
        }
        // 验证 SHA256
        if (expectedSha256) {
            logger.info('[HotUpdate] Verifying file integrity...');
            const actualSha256 = await calculateFileSha256(destPath);
            if (actualSha256 !== expectedSha256) {
                throw new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
            }
            logger.info('[HotUpdate] File integrity verified');
        }
    }
    catch (error) {
        fileStream.destroy();
        // 删除不完整或损坏的文件
        if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
        }
        throw error;
    }
    finally {
        // 释放 reader 资源
        reader?.releaseLock?.();
    }
}
// ==================== 版本相关 ====================
/**
 * 获取当前应用版本
 */
export function getAppVersion() {
    return app.getVersion();
}
/**
 * 获取应用基础版本号（去掉 -test.xx, -staging.xx 等后缀）
 * 例如：3.0.6-test.76 -> 3.0.6
 */
export function getBaseAppVersion() {
    const version = app.getVersion();
    // 匹配 x.y.z 格式，忽略后面的 -xxx.xx 后缀
    const match = version.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
}
