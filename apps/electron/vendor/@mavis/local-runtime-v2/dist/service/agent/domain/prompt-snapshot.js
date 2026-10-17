import { createHash } from 'node:crypto';
export function describeAgentPromptSnapshot(snapshot) {
    return {
        schema_version: 2,
        mode: snapshot.mode,
        ...(snapshot.version ? { package_version: snapshot.version } : {}),
        template_sha256: hash(snapshot.template),
        system_prompt_sha256: hash(snapshot.systemPrompt),
    };
}
function hash(text) {
    return createHash('sha256').update(text).digest('hex');
}
//# sourceMappingURL=prompt-snapshot.js.map