/**
 * Declare a platform-owned runtime tool as one object while preserving the
 * protocol-level split between LLM-facing `def` and side-effecting `impl`.
 */
export function defineRuntimeTool(tool) {
    const { name, label, description, schema, loading, namespace, promptGuidelines, prepareArguments, executionMode, operationClassifier, interruptOnSteer, source, execute, } = tool;
    const def = {
        name,
        ...(label !== undefined ? { label } : {}),
        description,
        schema,
        ...(loading !== undefined ? { loading } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
        ...(promptGuidelines !== undefined ? { promptGuidelines } : {}),
        ...(prepareArguments !== undefined
            ? { prepareArguments: prepareArguments }
            : {}),
        ...(executionMode !== undefined ? { executionMode } : {}),
        ...(operationClassifier !== undefined ? { operationClassifier } : {}),
        ...(interruptOnSteer !== undefined ? { interruptOnSteer } : {}),
    };
    return {
        def,
        impl: { execute },
        ...(source !== undefined ? { source } : {}),
    };
}
//# sourceMappingURL=define.js.map