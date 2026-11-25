import { SAFETY_SCENE } from './api.js';
export async function reviewProjectName(review, name) {
    const text = name?.trim();
    // No checker (dev/test) never blocks, the same fail-open the other field
    // reviews use; there is no service to be unavailable in that case.
    if (!text || !review)
        return 'allow';
    const result = await review(text, SAFETY_SCENE.ProjectName);
    if (result.pass)
        return 'allow';
    return result.errorKind === 'rejected' ? 'blocked' : 'unavailable';
}
//# sourceMappingURL=project-fields.js.map