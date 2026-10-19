import { LocalMemoryToolDef } from '@mavis/agent-tools/desktop';
const READ_OPERATIONS = new Set(['read', 'search']);
const WRITE_OPERATIONS = new Set(['append', 'edit', 'create', 'delete', 'write']);
const READ_TARGETS = new Set(['user', 'main', 'topic']);
function filterLiteralUnion(schema, allowed) {
    return {
        ...schema,
        anyOf: schema.anyOf?.filter((candidate) => typeof candidate.const === 'string' ? allowed.has(candidate.const) : true),
    };
}
function memorySchemaForPolicy(schema, policy) {
    const properties = schema.properties;
    if (!properties)
        return schema;
    const operationSchema = properties.operation;
    const targetSchema = properties.target;
    if (!operationSchema || !targetSchema)
        return schema;
    const operationValues = new Set();
    if (policy.readEnabled)
        READ_OPERATIONS.forEach((operation) => operationValues.add(operation));
    if (policy.writeEnabled)
        WRITE_OPERATIONS.forEach((operation) => operationValues.add(operation));
    const targetValues = policy.writeEnabled ? undefined : READ_TARGETS;
    const nextProperties = {
        ...properties,
        operation: filterLiteralUnion(operationSchema, operationValues),
        ...(targetValues ? { target: filterLiteralUnion(targetSchema, targetValues) } : {}),
    };
    if (!policy.writeEnabled) {
        for (const field of [
            'description',
            'content',
            'oldString',
            'newString',
            'replaceAll',
            'reason',
        ]) {
            delete nextProperties[field];
        }
    }
    if (!policy.readEnabled)
        delete nextProperties.query;
    return { ...schema, properties: nextProperties };
}
function memoryDescriptionForPolicy(policy) {
    if (!policy.writeEnabled) {
        return 'Read and search local memory. Supports target=user|main|topic.';
    }
    if (!policy.readEnabled) {
        return 'Append, edit, create, delete, or write local memory. Supports target=user|main|topic|summary with validated operation combinations; user append requires reason and summary write requires confirmation.';
    }
    return LocalMemoryToolDef.description;
}
export function withLocalMemoryPolicyGuidance(tool, policy) {
    if (tool.def.name !== LocalMemoryToolDef.name || (policy.readEnabled && policy.writeEnabled)) {
        return tool;
    }
    return {
        ...tool,
        def: {
            ...tool.def,
            description: memoryDescriptionForPolicy(policy),
            schema: memorySchemaForPolicy(tool.def.schema, policy),
        },
    };
}
//# sourceMappingURL=local-memory-policy-guidance.js.map