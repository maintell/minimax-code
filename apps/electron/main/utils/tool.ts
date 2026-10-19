import { app } from "electron";
import { getDesktopConfig } from "../ipc/storage.ipc";
import { isEn } from "../config/env";
/**
 * 获取标准 Chrome User-Agent（移除 Electron 标识）
 * example: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @mmx-agent/electron/1.0.0 Chrome/148.0.7778.280 Electron/42.8.0 Safari/537.36
 * return: MiniMaxAgent Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.280 Safari/537.36
 */
export const getStandardUserAgent = () => {
    return ('MiniMaxAgent ' +
        app.userAgentFallback
            .replace(/@mmx-agent\/electron\/[\d.]+\s+/, '') // 移除 @mmx-agent/electron/x.x.x
            .replace(/\s+Electron\/[\d.]+/, '')); // 移除 Electron/x.x.x
};

/**
 * 当前是否是英文环境
 */
export const getIsEn = () => {
    try {
        const config = getDesktopConfig();
        return config.language === 'en';
    }
    catch {
        return isEn;
    }
};

