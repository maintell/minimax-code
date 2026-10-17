import { SAFETY_CHECK_V2_SCENE, SafetyCheckV2Error } from '@mavis/shared/safety-check-v2';
import { SAFETY_SCENE } from '../contracts.js';
import { callLocalSafetyCheckV2 } from './api-v2.js';
import { uploadAvatarForSafety } from './avatar-upload.js';
/** Agent 配置和定时任务标题只接受明确 Allow，Guide/Replace 不得改写后放行。 */
export async function reviewConfigV2(input) {
    if (!input.content.trim())
        return { pass: true };
    try {
        const request = await configRequest(input);
        const result = await callLocalSafetyCheckV2({ ...input, request });
        return {
            pass: result.action === 'allow',
            action: result.action,
            ...(result.action !== 'allow' ? { errorKind: 'rejected' } : {}),
        };
    }
    catch (error) {
        return {
            pass: false,
            errorKind: error instanceof SafetyCheckV2Error && error.kind === 'auth' ? 'auth_error' : 'local_error',
        };
    }
}
async function avatarReference(input) {
    if (input.content.startsWith('data:'))
        return uploadAvatarForSafety(input);
    const url = new URL(input.content);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid avatar URL');
    return { image_url: input.content };
}
async function configRequest(input) {
    switch (input.scene) {
        case SAFETY_SCENE.AgentConfigName:
            return { scene: SAFETY_CHECK_V2_SCENE.AgentConfigName, content_text: input.content };
        case SAFETY_SCENE.CronTitle:
            return { scene: SAFETY_CHECK_V2_SCENE.CronTitle, content_text: input.content };
        case SAFETY_SCENE.AgentConfigAvatar:
            return { scene: SAFETY_CHECK_V2_SCENE.AgentConfigAvatar, ...(await avatarReference(input)) };
        default:
            throw new Error('Unsupported config safety scene');
    }
}
//# sourceMappingURL=config-api.js.map