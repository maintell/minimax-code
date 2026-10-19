import { Value } from '@sinclair/typebox/value';
/** Revalidates a Hook-rewritten input against the authoritative runtime tool schema. */
export function isRuntimeToolInputValid(tools, toolName, value) {
    const tool = tools.find((candidate) => candidate.def.name === toolName);
    return Boolean(tool && Value.Check(tool.def.schema, value));
}
//# sourceMappingURL=input-validation.js.map