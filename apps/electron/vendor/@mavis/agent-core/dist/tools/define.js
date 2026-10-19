/**
 * Declare a platform-owned runtime tool as one object while preserving the
 * protocol-level split between LLM-facing `def` and side-effecting `impl`.
 */
export function defineRuntimeTool(tool) {
    const { name, label, description, schema, loading, promptGuidelines, prepareArguments, executionMode, operationClassifier, source, execute, } = tool;
    const def = {
        name,
        ...(label !== undefined ? { label } : {}),
        description,
        schema,
        ...(loading !== undefined ? { loading } : {}),
        ...(promptGuidelines !== undefined ? { promptGuidelines } : {}),
        ...(prepareArguments !== undefined
            ? { prepareArguments: prepareArguments }
            : {}),
        ...(executionMode !== undefined ? { executionMode } : {}),
        ...(operationClassifier !== undefined ? { operationClassifier } : {}),
    };
    return {
        def,
        impl: { execute },
        ...(source !== undefined ? { source } : {}),
    };
}
//# sourceMappingURL=define.js.map