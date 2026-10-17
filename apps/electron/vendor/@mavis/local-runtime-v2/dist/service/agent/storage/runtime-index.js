import { agents } from '../../../infra/db/schema/agents.js';
import { encodeAgentRoleForStorage } from '../domain/roles.js';
export function runtimeUpdateValues(fields) {
    const values = {};
    if (fields.agentRole !== undefined) {
        values.agentRole = encodeAgentRoleForStorage(fields.agentRole);
    }
    if (fields.mainSessionId !== undefined)
        values.mainSessionId = fields.mainSessionId;
    if (fields.creationSource !== undefined)
        values.creationSource = fields.creationSource;
    if (fields.greetingSent !== undefined)
        values.greetingSent = fields.greetingSent ? 1 : 0;
    if (fields.createdAtMs !== undefined)
        values.createdAt = fields.createdAtMs;
    if (fields.updatedAtMs !== undefined)
        values.updatedAt = fields.updatedAtMs;
    return values;
}
export function runtimeIndexForUpdate(name, fields) {
    const updatedAtMs = fields.updatedAtMs ?? Date.now();
    return {
        name,
        agentRole: fields.agentRole ?? 'worker',
        creationSource: 'manual',
        ...(fields.mainSessionId == null ? {} : { rootSessionId: fields.mainSessionId }),
        createdAtMs: fields.createdAtMs ?? updatedAtMs,
        updatedAtMs,
        ...(fields.greetingSent === undefined ? {} : { greetingSent: fields.greetingSent }),
    };
}
export function canonicalCustomRuntimeFields(runtimeMeta) {
    return {
        agentRole: runtimeMeta?.agentRole ?? 'worker',
        ...(runtimeMeta?.rootSessionId ? { rootSessionId: runtimeMeta.rootSessionId } : {}),
        creationSource: runtimeMeta?.creationSource === 'auto' ? 'auto' : 'manual',
        greetingSent: runtimeMeta?.greetingSent ?? false,
        ...(runtimeMeta?.pinned === undefined ? {} : { pinned: runtimeMeta.pinned }),
        ...(runtimeMeta?.pinnedAtMs === undefined ? {} : { pinnedAtMs: runtimeMeta.pinnedAtMs }),
    };
}
export function canonicalCustomTimestamps(runtimeMeta, file) {
    const createdAtMs = runtimeMeta?.createdAtMs ?? file?.createdAtMs ?? 0;
    return {
        createdAtMs,
        updatedAtMs: runtimeMeta?.updatedAtMs ?? file?.updatedAtMs ?? createdAtMs,
    };
}
//# sourceMappingURL=runtime-index.js.map