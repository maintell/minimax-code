/**
 * 热更新模块配置常量
 */

import { isEn, isProd, isStaging, isTest } from "../../config";
/** 热更新 CDN 基础 URL */
export let HOT_UPDATE_BASE_URL = isEn
    ? isProd
        ? 'https://file.cdn.minimax.io/public/minimax-agent/hot-update/en/prod'
        : isStaging
            ? 'https://file.cdn.minimax.io/public/minimax-agent/hot-update/en/staging'
            : isTest
                ? 'https://file.cdn.minimax.io/public/minimax-agent/hot-update/en/test'
                : ''
    : isProd
        ? 'https://filecdn.minimax.chat/public/minimax-agent/hot-update/zh/prod'
        : isStaging
            ? 'https://filecdn.minimax.chat/public/minimax-agent/hot-update/zh/staging'
            : isTest
                ? 'https://filecdn.minimax.chat/public/minimax-agent/hot-update/zh/test'
                : '';
/** 清单文件名 */
export let MANIFEST_FILENAME = 'manifest.json';
/** 热更新缓存目录名 */
export let HOT_UPDATE_DIR = 'hot-update';
/** 状态文件名 */
export let STATE_FILENAME = 'state.json';
/** 检查间隔（毫秒）- 默认 6 小时 */
export let CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** 默认最低支持热更新的应用版本 */
export let DEFAULT_MIN_APP_VERSION = '3.0.6';
