import { MemoryControllerBase } from '../generated/memory-controller-base.gen.js';
import { NotImplementedError } from '../errors.js';
/** Memory V2 未装配（配置缺 memory.v2 分支）时的统一降级码；前端按未识别码降级。 */
const MEMORY_V2_DISABLED = { error: { code: 'memory-v2-disabled' } };
export class MemoryController extends MemoryControllerBase {
    memoryV2;
    /** v1 方法保持 NotImplemented；v2 方法全部委托给 §5.15 MemoryApplication。 */
    constructor(memoryV2) {
        super();
        this.memoryV2 = memoryV2;
    }
    async getMemoryV2Status(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.getStatus(req) : MEMORY_V2_DISABLED;
    }
    async listMemoryV2Sessions(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.listSessions(req) : MEMORY_V2_DISABLED;
    }
    async getMemoryV2SessionDoc(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.getSessionDoc(req) : MEMORY_V2_DISABLED;
    }
    async forgetMemoryV2Content(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.forgetContent(req) : MEMORY_V2_DISABLED;
    }
    async resetMemoryV2Scope(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.resetScope(req) : MEMORY_V2_DISABLED;
    }
    async prepareLegacyMemoryMigration(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.prepareLegacyMigration(req) : MEMORY_V2_DISABLED;
    }
    async acceptLegacyMemoryMigration(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.acceptLegacyMigration(req) : MEMORY_V2_DISABLED;
    }
    async discardLegacyMemoryMigration(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.discardLegacyMigration(req) : MEMORY_V2_DISABLED;
    }
    async getMemoryV2Onboarding(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.getOnboarding(req) : MEMORY_V2_DISABLED;
    }
    async completeMemoryV2Onboarding(_ctx, req) {
        return this.memoryV2 ? this.memoryV2.completeOnboarding(req) : MEMORY_V2_DISABLED;
    }
    async getMemory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getMemory');
    }
    async appendMemory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('appendMemory');
    }
    async writeMemory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('writeMemory');
    }
    async editMemory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('editMemory');
    }
    async searchMemory(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('searchMemory');
    }
    async listMemoryTopics(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listMemoryTopics');
    }
    async getMemoryTopic(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getMemoryTopic');
    }
    async writeMemoryTopic(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('writeMemoryTopic');
    }
    async deleteMemoryTopic(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteMemoryTopic');
    }
    async appendMemoryTopic(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('appendMemoryTopic');
    }
    async editMemoryTopic(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('editMemoryTopic');
    }
    async searchMemoryTopics(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('searchMemoryTopics');
    }
    async listMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listMemoryDaily');
    }
    async getMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getMemoryDaily');
    }
    async writeMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('writeMemoryDaily');
    }
    async appendMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('appendMemoryDaily');
    }
    async deleteMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('deleteMemoryDaily');
    }
    async listMemoryArchive(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listMemoryArchive');
    }
    async getMemoryArchive(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getMemoryArchive');
    }
    async writeMemorySummary(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('writeMemorySummary');
    }
    async snapshotForMemoryCleanup(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('snapshotForMemoryCleanup');
    }
    async archiveOldMemoryDaily(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('archiveOldMemoryDaily');
    }
    async triggerMemoryCleanup(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('triggerMemoryCleanup');
    }
    async markMemorySession(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('markMemorySession');
    }
    async getUnremindedMemorySessions(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getUnremindedMemorySessions');
    }
    async markMemoryReminded(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('markMemoryReminded');
    }
    async markMemoryReflected(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('markMemoryReflected');
    }
    async getMemoryReflectionTimestamp(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getMemoryReflectionTimestamp');
    }
}
//# sourceMappingURL=memory.controller.js.map