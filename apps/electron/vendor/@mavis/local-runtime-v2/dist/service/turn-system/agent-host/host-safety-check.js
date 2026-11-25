import { SAFETY_SCENE, } from '@mavis/shared/local-runtime-safety';
const PASS = { kind: 'pass' };
/** The desktop has no tool-stage review backend; an enabled tool stage fails closed. */
const NO_TOOL_REVIEW = { kind: 'unavailable', cause: 'upstream' };
/**
 * Desktop `ContentSafetyGate.check` over the dialog review port. The port is text-only and
 * takes no signal: attachments are not reviewed here, and an aborted request runs on to its
 * transport timeout.
 */
export function createDesktopSafetyCheck(review) {
    return async (input) => {
        const scene = dialogScene(input.stage);
        if (scene === undefined)
            return NO_TOOL_REVIEW;
        return toSafetyVerdict(await review(input.content, scene));
    };
}
function dialogScene(stage) {
    switch (stage) {
        case 'input':
            return SAFETY_SCENE.UserInput;
        case 'output':
            return SAFETY_SCENE.MessageOutput;
        case 'thinking':
            return SAFETY_SCENE.ThinkingContent;
        default:
            return undefined;
    }
}
function toSafetyVerdict(result) {
    if (result.pass)
        return PASS;
    const cause = unavailableCause(result.errorKind);
    if (cause)
        return { kind: 'unavailable', cause };
    if (result.action === 'guide') {
        return {
            kind: 'regenerate',
            ...(result.guide_prompt ? { guidePrompt: result.guide_prompt } : {}),
        };
    }
    if (result.action === 'replace' && result.suggestion?.trim()) {
        return { kind: 'regenerate', replacement: result.suggestion };
    }
    return { kind: 'block', ...(result.reason ? { reason: result.reason } : {}) };
}
function unavailableCause(errorKind) {
    switch (errorKind) {
        case 'local_error':
            return 'transport';
        case 'auth_error':
            return 'auth';
        case 'api_error':
            return 'upstream';
        default:
            return undefined;
    }
}
//# sourceMappingURL=host-safety-check.js.map