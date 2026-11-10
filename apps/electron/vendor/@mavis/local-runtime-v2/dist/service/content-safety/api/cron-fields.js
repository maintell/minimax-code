import { SAFETY_SCENE, reviewBlocks } from './api.js';
/** 标题和指令并发审核；标题复用名字场景，指令保留普通配置文本场景。 */
export async function cronReviewBlocks(review, name, prompt) {
    if (!review)
        return false;
    const fields = [
        { value: name, scene: SAFETY_SCENE.CronTitle },
        { value: prompt, scene: SAFETY_SCENE.ConfigField },
    ];
    const blocked = await Promise.all(fields.map(async ({ value, scene }) => {
        const text = value?.trim();
        return text ? reviewBlocks(await review(text, scene)) : false;
    }));
    return blocked.some(Boolean);
}
//# sourceMappingURL=cron-fields.js.map