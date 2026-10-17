/**
 * 热更新模块状态管理
 */

import * as fs from "fs";
import * as path from "path";
import { getCategoryLogger } from "../../utils/logger";
import { STATE_FILENAME } from "./config";
import { getHotUpdateDir, ensureDir } from "./utils";
const logger = getCategoryLogger('update');
/**
 * 获取状态文件路径
 */
function getStateFilePath() {
    return path.join(getHotUpdateDir(), STATE_FILENAME);
}
/**
 * 读取本地状态
 */
export function readState() {
    const defaultState = {
        currentVersion: null,
        lastCheckTime: 0,
        lastUpdateTime: 0,
        enabled: true,
    };
    try {
        const statePath = getStateFilePath();
        if (fs.existsSync(statePath)) {
            const content = fs.readFileSync(statePath, 'utf-8');
            return { ...defaultState, ...JSON.parse(content) };
        }
    }
    catch (error) {
        logger.error(`[HotUpdate] Failed to read state: ${error}`);
    }
    return defaultState;
}
/**
 * 保存本地状态
 */
export function saveState(state) {
    try {
        ensureDir(getHotUpdateDir());
        const currentState = readState();
        const newState = { ...currentState, ...state };
        fs.writeFileSync(getStateFilePath(), JSON.stringify(newState, null, 2));
    }
    catch (error) {
        logger.error(`[HotUpdate] Failed to save state: ${error}`);
    }
}
