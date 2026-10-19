import { HTTPException } from 'hono/http-exception';
import { SkillControllerBase } from '../generated/skill-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
export class SkillController extends SkillControllerBase {
    service;
    constructor(service = unimplementedSkillService) {
        super();
        this.service = service;
    }
    async listSkills(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.listSkills(req));
    }
    async listSkillHub(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.listSkillHub(req));
    }
    async installSkill(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.installSkill(req));
    }
    async previewSkill(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.previewSkill(req));
    }
    async createSkill(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.createSkill(req));
    }
    async getSkill(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.getSkill(req));
    }
    async listSkillFiles(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.listSkillFiles(req));
    }
    async getSkillFile(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.getSkillFile(req));
    }
    async deleteSkill(ctx, req) {
        void ctx;
        return preserveSkillError(() => this.service.deleteSkill(req));
    }
    async setSkillEnabled(ctx, req) {
        void ctx;
        const result = await this.service.setSkillEnabled({
            skillName: req.skillName,
            ...(req.locationUri ? { locationUri: req.locationUri } : {}),
            ...(req.agentName ? { agentName: req.agentName } : {}),
        }, req.enabled);
        if (!result)
            throw new AppError(404, 'SKILL_NOT_FOUND', 'Skill not found');
        return result;
    }
    async listRuntimeSkills(ctx, req) {
        void ctx;
        return this.service.listRuntimeSkills(req);
    }
}
const unimplementedSkillService = {
    listSkills: () => Promise.reject(new NotImplementedError('listSkills')),
    listSkillHub: () => Promise.reject(new NotImplementedError('listSkillHub')),
    installSkill: () => Promise.reject(new NotImplementedError('installSkill')),
    previewSkill: () => Promise.reject(new NotImplementedError('previewSkill')),
    createSkill: () => Promise.reject(new NotImplementedError('createSkill')),
    getSkill: () => Promise.reject(new NotImplementedError('getSkill')),
    listSkillFiles: () => Promise.reject(new NotImplementedError('listSkillFiles')),
    getSkillFile: () => Promise.reject(new NotImplementedError('getSkillFile')),
    deleteSkill: () => Promise.reject(new NotImplementedError('deleteSkill')),
    setSkillEnabled: () => Promise.reject(new NotImplementedError('setSkillEnabled')),
    listRuntimeSkills: () => Promise.reject(new NotImplementedError('listRuntimeSkills')),
};
export const skillController = new SkillController();
/** Retain the published Skill error envelope across the owner migration. */
async function preserveSkillError(action) {
    try {
        return await action();
    }
    catch (error) {
        if (error instanceof AppError)
            throw new HTTPException(error.status, {
                res: Response.json({ error: error.message, code: error.key }, { status: error.status }),
            });
        throw error;
    }
}
//# sourceMappingURL=skill.controller.js.map