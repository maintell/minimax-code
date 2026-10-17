import { HTTPException } from 'hono/http-exception';
import { DesktopServiceBase } from '@mavis/thrift-gen/generated/desktop-service/server';
import { DesktopMemoryService } from '../memory/desktop-memory-service.js';
export class DesktopServiceMemoryBase extends DesktopServiceBase {
    agentResolver;
    memoryService;
    constructor(memory, agentResolver, telemetryHost) {
        super();
        this.agentResolver = agentResolver;
        this.memoryService = memory
            ? new DesktopMemoryService(memory, agentResolver, telemetryHost)
            : undefined;
    }
    getMemory(...args) {
        return this.requireMemoryService().getMemory(...args);
    }
    appendMemory(...args) {
        return this.requireMemoryService().appendMemory(...args);
    }
    writeMemory(...args) {
        return this.requireMemoryService().writeMemory(...args);
    }
    editMemory(...args) {
        return this.requireMemoryService().editMemory(...args);
    }
    searchMemory(...args) {
        return this.requireMemoryService().searchMemory(...args);
    }
    listMemoryTopics(...args) {
        return this.requireMemoryService().listMemoryTopics(...args);
    }
    getMemoryTopic(...args) {
        return this.requireMemoryService().getMemoryTopic(...args);
    }
    writeMemoryTopic(...args) {
        return this.requireMemoryService().writeMemoryTopic(...args);
    }
    deleteMemoryTopic(...args) {
        return this.requireMemoryService().deleteMemoryTopic(...args);
    }
    appendMemoryTopic(...args) {
        return this.requireMemoryService().appendMemoryTopic(...args);
    }
    editMemoryTopic(...args) {
        return this.requireMemoryService().editMemoryTopic(...args);
    }
    searchMemoryTopics(...args) {
        return this.requireMemoryService().searchMemoryTopics(...args);
    }
    listMemoryDaily(...args) {
        return this.requireMemoryService().listMemoryDaily(...args);
    }
    getMemoryDaily(...args) {
        return this.requireMemoryService().getMemoryDaily(...args);
    }
    writeMemoryDaily(...args) {
        return this.requireMemoryService().writeMemoryDaily(...args);
    }
    appendMemoryDaily(...args) {
        return this.requireMemoryService().appendMemoryDaily(...args);
    }
    deleteMemoryDaily(...args) {
        return this.requireMemoryService().deleteMemoryDaily(...args);
    }
    writeMemorySummary(...args) {
        return this.requireMemoryService().writeMemorySummary(...args);
    }
    listMemoryArchive(...args) {
        return this.requireMemoryService().listMemoryArchive(...args);
    }
    getMemoryArchive(...args) {
        return this.requireMemoryService().getMemoryArchive(...args);
    }
    snapshotForMemoryCleanup(...args) {
        return this.requireMemoryService().snapshotForMemoryCleanup(...args);
    }
    archiveOldMemoryDaily(...args) {
        return this.requireMemoryService().archiveOldMemoryDaily(...args);
    }
    triggerMemoryCleanup(...args) {
        return this.requireMemoryService().triggerMemoryCleanup(...args);
    }
    markMemorySession(...args) {
        return this.requireMemoryService().markMemorySession(...args);
    }
    getUnremindedMemorySessions(...args) {
        return this.requireMemoryService().getUnremindedMemory(...args);
    }
    markMemoryReminded(...args) {
        return this.requireMemoryService().markMemoryReminded(...args);
    }
    markMemoryReflected(...args) {
        return this.requireMemoryService().markMemoryReflected(...args);
    }
    getMemoryReflectionTimestamp(...args) {
        return this.requireMemoryService().getMemoryReflectionTs(...args);
    }
    requireMemoryService() {
        if (!this.memoryService)
            throw new HTTPException(501, { message: 'memory service unavailable' });
        return this.memoryService;
    }
}
//# sourceMappingURL=desktop-memory-service-base.js.map