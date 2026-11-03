import { HTTPException } from 'hono/http-exception';
import { DesktopQuestionnaireServiceBase } from './desktop-questionnaire-service.js';
/**
 * Fail-closed stubs for the model provider / BYOK DesktopService contract.
 *
 * The BYOK IDL (weaver/idl e1d0defd9) is contract-first: agent-archon has no
 * local-runtime implementation yet, and these routes did not exist at all
 * before the contract sync that pulled the methods in as abstract members.
 * Every method answers 501 so the surface stays honest until the owning team
 * lands the real desktop implementation — replace the stubs there, not by
 * inventing partial semantics here.
 */
export class DesktopModelProviderServiceBase extends DesktopQuestionnaireServiceBase {
    notImplemented(method) {
        throw new HTTPException(501, {
            message: `DesktopService.${method} is not implemented on desktop yet (BYOK contract is ahead of the local-runtime implementation).`,
        });
    }
    listModels(_ctx, _req) {
        return this.notImplemented('ListModels');
    }
    selectModel(_ctx, _req) {
        return this.notImplemented('SelectModel');
    }
    listModelProviders(_ctx, _req) {
        return this.notImplemented('ListModelProviders');
    }
    listUserModelProviders(_ctx, _req) {
        return this.notImplemented('ListUserModelProviders');
    }
    listByokProviderPresets(_ctx, _req) {
        return this.notImplemented('ListByokProviderPresets');
    }
    getMiniMaxApiKeyStatus(_ctx, _req) {
        return this.notImplemented('GetMiniMaxApiKeyStatus');
    }
    upsertMiniMaxApiKey(_ctx, _req) {
        return this.notImplemented('UpsertMiniMaxApiKey');
    }
    createUserModelProvider(_ctx, _req) {
        return this.notImplemented('CreateUserModelProvider');
    }
    updateUserModelProvider(_ctx, _req) {
        return this.notImplemented('UpdateUserModelProvider');
    }
    duplicateUserModelProvider(_ctx, _req) {
        return this.notImplemented('DuplicateUserModelProvider');
    }
    deleteUserModelProvider(_ctx, _req) {
        return this.notImplemented('DeleteUserModelProvider');
    }
    testUserModelProvider(_ctx, _req) {
        return this.notImplemented('TestUserModelProvider');
    }
    testUserModel(_ctx, _req) {
        return this.notImplemented('TestUserModel');
    }
    updateUserModelParameters(_ctx, _req) {
        return this.notImplemented('UpdateUserModelParameters');
    }
    testUserModelCandidate(_ctx, _req) {
        return this.notImplemented('TestUserModelCandidate');
    }
    discoverUserModelsCandidate(_ctx, _req) {
        return this.notImplemented('DiscoverUserModelsCandidate');
    }
    saveUserModelProviderCandidate(_ctx, _req) {
        return this.notImplemented('SaveUserModelProviderCandidate');
    }
    discoverUserModels(_ctx, _req) {
        return this.notImplemented('DiscoverUserModels');
    }
    updateMinimaxModelContext(_ctx, _req) {
        return this.notImplemented('UpdateMinimaxModelContext');
    }
}
//# sourceMappingURL=desktop-model-provider-service-base.js.map