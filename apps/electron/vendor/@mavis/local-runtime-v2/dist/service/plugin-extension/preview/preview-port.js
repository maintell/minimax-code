/**
 * The `extension preview` / `withdraw` tool actions over the preview service. The user already
 * allowed `preview` through the tool's permission check before the call got here.
 */
export function createExtensionPreviewPort(deps) {
    const withReports = (activation) => {
        const { sessionId, pluginId, artifactDigest } = activation;
        if (!sessionId)
            return toActivation(activation);
        const findings = deps.findings?.report(sessionId, pluginId, artifactDigest);
        return {
            ...toActivation(activation),
            ...(findings?.overlay ? { overlayFindings: findings.overlay } : {}),
            ...(findings?.keptReload ? { keptReload: findings.keptReload } : {}),
            ...(findings?.editorTypes ? { editorTypesFinding: findings.editorTypes } : {}),
        };
    };
    return {
        async requestPreview(request) {
            return toResult(await deps.preview.preview({
                sessionId: request.sessionId,
                pluginId: request.pluginId,
                ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
            }));
        },
        withdraw: (sessionId, pluginId) => deps.preview.withdraw(sessionId, pluginId),
        activation(sessionId, pluginId) {
            const live = deps.activations.preview(sessionId, pluginId);
            return live ? withReports(live) : undefined;
        },
    };
}
function toResult(outcome) {
    if (outcome.status !== 'activated')
        return outcome;
    return {
        status: 'activated',
        activation: toActivation(outcome.activation),
        warnings: outcome.warnings,
    };
}
function toActivation(activation) {
    return {
        pluginId: activation.pluginId,
        artifactDigest: activation.artifactDigest,
        scan: activation.scan,
    };
}
//# sourceMappingURL=preview-port.js.map