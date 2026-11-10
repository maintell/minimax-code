import { createWebsiteDeployAfterLlmHook, createWebsiteDeployAfterToolCallHook, WebsiteDeployTurnState, } from './deploy/index.js';
import { projectWebsiteDeployRuntimeEvent } from './deploy/projection-writer.js';
/** One feature-local projection per Turn for every hosted Turn that exposes website_deploy. */
export function createWebsiteDeployTurnProjection() {
    const state = new WebsiteDeployTurnState();
    return {
        projectRuntimeEvent: (event) => projectWebsiteDeployRuntimeEvent(event, state),
        afterToolCallHook: createWebsiteDeployAfterToolCallHook(state),
        afterLlmCallHook: createWebsiteDeployAfterLlmHook(state),
    };
}
//# sourceMappingURL=initialize.js.map