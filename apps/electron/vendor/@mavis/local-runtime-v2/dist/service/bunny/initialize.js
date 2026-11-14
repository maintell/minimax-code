import { BunnyService } from './orchestration/bunny.service.js';
import { deleteBunnySetting, readBunnyInitializedAt, readBunnySetting, writeBunnySetting, } from '../../infra/db/bunny-store.js';
export { readBunnyInitializedAt };
/** Bunny 的设置项（权限模式、任务模型、初始化时间）只存在 Bunny 独立库的 bunny_settings 表。 */
export function initializeBunny(options) {
    const { bunnyDb, ...rest } = options;
    return new BunnyService({
        ...rest,
        preferences: {
            get: async (key) => readBunnySetting(bunnyDb, key),
            set: async (key, value) => writeBunnySetting(bunnyDb, key, value),
            delete: async (key) => deleteBunnySetting(bunnyDb, key),
        },
    });
}
//# sourceMappingURL=initialize.js.map