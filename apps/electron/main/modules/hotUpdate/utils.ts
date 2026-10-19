/**
 * 热更新模块工具函数
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { app, net } from "electron";
import { compareVersions } from "../../utils";
import { getCategoryLogger } from "../../utils/logger";
import { HOT_UPDATE_DIR } from "./config";
const logger = getCategoryLogger('update');
// ==================== 路径相关 ====================
/**
 * 获取热更新缓存目录路径
 */
export function getHotUpdateDir() {
    return path.join(app.getPath('userData'), HOT_UPDATE_DIR);
}
/**
 * 获取热更新资源目录路径（解压后的资源）
 */
export function getHotUpdateResourceDir() {
    return path.join(getHotUpdateDir(), 'resources');
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
 * 使用 Electron net.fetch 发起 GET 请求
 */
export async function fetchText(url) {
    const response = await net.fetch(url, {
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
        },
    });
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
    const { expectedSha256, onProgress } = options || {};
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
                fileStream.write(Buffer.from(result.value));
                downloadedSize += result.value.length;
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
        // 验证 SHA256
        if (expectedSha256) {
            logger.info('[HotUpdate] Verifying file integrity...');
            const actualSha256 = await calculateFileSha256(destPath);
            if (actualSha256 !== expectedSha256) {
                // 删除损坏的文件
                fs.unlinkSync(destPath);
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
 * 解析热更新版本号
 * 格式：{appVersion}-renderer.{n}
 * 例如：3.0.3-renderer.1
 */
export function parseRendererVersion(version) {
    const match = version.match(/^(.+)-renderer\.(\d+)$/);
    if (!match) {
        return null;
    }
    return {
        appVersion: match[1],
        rendererNum: parseInt(match[2], 10),
    };
}
/**
 * 比较热更新版本号
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareRendererVersions(v1, v2) {
    // null 表示打包版本，任何热更新版本都 > null
    if (v1 === null && v2 === null)
        return 0;
    if (v1 === null)
        return -1;
    if (v2 === null)
        return 1;
    const parsed1 = parseRendererVersion(v1);
    const parsed2 = parseRendererVersion(v2);
    // 如果解析失败，按字符串比较
    if (!parsed1 || !parsed2) {
        return v1.localeCompare(v2);
    }
    // 先比较应用版本
    const appCompare = compareVersions(parsed1.appVersion, parsed2.appVersion);
    if (appCompare !== 0) {
        return appCompare;
    }
    // 应用版本相同，比较渲染版本号
    if (parsed1.rendererNum > parsed2.rendererNum)
        return 1;
    if (parsed1.rendererNum < parsed2.rendererNum)
        return -1;
    return 0;
}
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
