import { SAFETY_SCENE, reviewBlocks, } from '@mavis/shared/local-runtime-safety';
import { CronRepositoryError } from '../errors.js';
/** 标题使用定时任务标题独立场景，指令沿用普通文本；任一拒绝时不写入配置。 */
export async function assertCronContentSafe(review, fields) {
    if (!review)
        return;
    const items = [
        { value: fields.name, scene: SAFETY_SCENE.CronTitle },
        { value: fields.prompt, scene: SAFETY_SCENE.ConfigField },
    ];
    const blocked = await Promise.all(items.map(async ({ value, scene }) => {
        const text = value?.trim();
        return text ? reviewBlocks(await review(text, scene)) : false;
    }));
    if (blocked.some(Boolean)) {
        throw new CronRepositoryError('CONTENT_POLICY_VIOLATION', 'Content validation failed');
    }
}
//# sourceMappingURL=content-safety.js.map