/**
 * OSS 模块
 * 上传/下载文件到 OSS
 */
import * as fs from "fs/promises";
import { createReadStream } from "fs";
import path_ from "path";
import { net } from "electron";
import { getUserInfo } from "../../ipc/storage.ipc";
import logger from "../../utils/logger";
import { isDev, isEn, DOMAIN_URL } from "../../config";
import { getStandardUserAgent } from "../../utils/tool";
import { assertSameLoginEpoch } from "@mavis/oauth-core";
const FILE_META_SUCCESS = 1;
const FILE_META_FAILED = 0;
const PATH = '/matrix/api/v1/log/upload';
const DESKTOP_UPLOAD_PATH = '/matrix/api/v1/desktop/upload';
let sharedAuthConfiguration;
export function configureOSSSharedAuthSession(session, options = {}) {
    const configuration = { session, ...options };
    sharedAuthConfiguration = configuration;
    return () => {
        if (sharedAuthConfiguration === configuration)
            sharedAuthConfiguration = undefined;
    };
}
/**
 * 获取预签名 URL
 * @returns 预签名 URL 响应
 */
export const getPresignedUrl = async (isLog = false, baseFileName) => {
    const userInfo = getUserInfo();
    const path = `${isDev
        ? isEn
            ? 'https://matrix-overseas-test.xaminim.com'
            : 'https://matrix-test.xaminim.com'
        : DOMAIN_URL}${isLog ? PATH : DESKTOP_UPLOAD_PATH}`;
    try {
        const configuration = sharedAuthConfiguration;
        if (!configuration) {
            throw new Error('Main OSS Shared OAuth session is not configured.');
        }
        const body = JSON.stringify({
            device_id: userInfo.deviceID,
            base_file_name: baseFileName,
        });
        let lease = await configuration.session.getAccessToken(30000);
        const fetchPresignedUrl = () => net.fetch(path, {
            method: 'POST',
            headers: {
                'User-Agent': getStandardUserAgent(),
                Origin: DOMAIN_URL,
                Referer: DOMAIN_URL + '/',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${lease.accessToken}`,
            },
            body,
        });
        let resp = await fetchPresignedUrl();
        if (resp.status === 401) {
            let decision = await configuration.session.handleUnauthorized(lease.generation, lease.loginEpoch);
            if (decision === 'retry') {
                await resp.arrayBuffer().catch(() => undefined);
                const requestEpoch = lease.loginEpoch;
                lease = await configuration.session.getAccessToken(30000);
                assertSameLoginEpoch(requestEpoch, lease.loginEpoch);
                resp = await fetchPresignedUrl();
                if (resp.status === 401) {
                    decision = await configuration.session.handleUnauthorized(lease.generation, lease.loginEpoch);
                }
            }
            if (decision === 'logout') {
                await configuration.onAccessTokenInvalidated?.();
            }
        }
        if (!resp.ok) {
            throw new Error(`OSS presigned URL request failed with HTTP ${resp.status}.`);
        }
        const data = (await resp.json());
        return data;
    }
    catch (error) {
        logger.error(`[OSS] Failed to get presigned URL: ${path}, error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
};

/**
 * 上传单个文件到 OSS
 * @param fileInfo 文件元信息
 * @returns 上传结果
 */
export const uploadToOSS = async (fileInfo, isLog = false) => {
    const { file_path } = fileInfo;
    if (!file_path) {
        return {
            ...fileInfo,
            success: FILE_META_FAILED,
            err_msg: 'No file path provided',
        };
    }
    let fileName = '';
    try {
        // 如果是 /user/download/xxx.mp4 -> xxx.mp4
        fileName = path_.basename(file_path);
    }
    catch (error) {
        // ignored
    }
    try {
        const { upload_url: presignedUrl, upload_id: uploadId } = await (0, getPresignedUrl)(isLog, fileName);
        logger.info(`[OSS] Upload ID: ${uploadId}`);
        if (!presignedUrl) {
            return {
                ...fileInfo,
                success: FILE_META_FAILED,
                err_msg: 'No presigned url provided',
            };
        }
        // 检查文件是否存在并获取大小
        let fileSize;
        try {
            const fileStat = await fs.stat(file_path);
            fileSize = fileStat.size;
        }
        catch {
            return {
                ...fileInfo,
                success: FILE_META_FAILED,
                err_msg: `File not found: ${file_path}`,
            };
        }
        // 使用 PUT 方法上传到预签名 URL
        // ⚠️ 注意：不要设置 Content-Type 和 Content-Length
        // 预签名 URL 的签名已包含这些信息，手动设置会导致签名不匹配
        const STREAM_THRESHOLD = 50 * 1024 * 1024; // 50MB
        let uploadResponse;
        if (fileSize >= STREAM_THRESHOLD) {
            // 大文件使用流式上传，避免 V8 OOM
            const fileStream = createReadStream(file_path);
            const body = new ReadableStream({
                start(controller) {
                    fileStream.on('data', (chunk) => {
                        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
                        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                            fileStream.pause();
                        }
                    });
                    fileStream.on('end', () => controller.close());
                    fileStream.on('error', (err) => controller.error(err));
                },
                pull() {
                    fileStream.resume();
                },
                cancel() {
                    fileStream.destroy();
                },
            });
            uploadResponse = await net.fetch(presignedUrl, {
                method: 'PUT',
                body,
                duplex: 'half',
            });
        }
        else {
            const fileBuffer = await fs.readFile(file_path);
            uploadResponse = await net.fetch(presignedUrl, {
                method: 'PUT',
                body: fileBuffer,
            });
        }
        logger.info(`[OSS] Upload response: ${JSON.stringify(uploadResponse)}`);
        if (!uploadResponse.ok) {
            // 获取错误响应体以便调试
            let errorBody = '';
            try {
                errorBody = await uploadResponse.text();
            }
            catch (e) {
                errorBody = '(unable to read error body)';
            }
            logger.error(`[OSS] Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
            logger.error(`[OSS] Error body: ${errorBody}`);
            return {
                ...fileInfo,
                success: FILE_META_FAILED,
                err_msg: `Upload failed with status: ${uploadResponse.status} ${uploadResponse.statusText}`,
            };
        }
        // 从预签名 URL 中提取 CDN URL（去掉查询参数）
        const cdnUrl = presignedUrl.split('?')[0];
        logger.info(`[OSS] Upload successful: from ${file_path} to ${cdnUrl}`);
        return {
            ...fileInfo,
            upload_id: uploadId,
            cdn_url: cdnUrl,
            success: FILE_META_SUCCESS,
        };
    }
    catch (error) {
        logger.error(`[OSS] Upload error: ${error}`);
        return {
            ...fileInfo,
            success: FILE_META_FAILED,
            err_msg: error instanceof Error ? error.message : 'Unknown error',
        };
    }
};

/**
 * 批量上传文件到 OSS
 * @param files 文件元信息数组
 * @returns 上传结果数组
 */
export const uploadMultipleToOSS = async (files, isLog = false) => {
    const results = [];
    for (const file of files) {
        results.push(await (0, uploadToOSS)(file, isLog));
    }
    return results;
};

/**
 * 从 OSS 下载文件到本地
 * @param cdnUrl CDN URL
 * @param filePath 本地文件路径
 * @returns 是否下载成功
 */
export const downloadFromOSS = async (cdnUrl, filePath) => {
    try {
        const response = await net.fetch(cdnUrl);
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }
        // 确保目标目录存在
        const dir = path_.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        const buffer = await response.arrayBuffer();
        await fs.writeFile(path_.normalize(filePath), Buffer.from(buffer));
        logger.info(`[OSS] Download successful: from ${cdnUrl} to ${filePath}`);
        return true;
    }
    catch (error) {
        logger.error(`[OSS] Download error: ${error}`);
        throw error;
    }
};

