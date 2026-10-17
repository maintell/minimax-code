import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function isPersonaMissing(args) {
    const personaPath = join(args.agentConfigDir, 'PERSONA.md');
    if (args.builtin)
        return { missing: !args.builtinPersona?.trim(), personaPath };
    if (!args.identityDisplayName?.trim())
        return { missing: true, personaPath };
    let raw;
    try {
        raw = readFileSync(personaPath, 'utf-8');
    }
    catch {
        return { missing: true, personaPath };
    }
    const fmMatch = /^---\r?\n[\s\S]*?\r?\n---/.exec(raw);
    const body = fmMatch ? raw.slice(fmMatch[0].length).replace(/^\r?\n/, '') : raw;
    if (body.trim().length === 0)
        return { missing: true, personaPath };
    const normalized = body
        .replace(/[#*_`>\-[\]()!]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { missing: normalized.length < 100, personaPath };
}
export function agentDetailToIdentity(detail) {
    if (!detail.displayName && !detail.description && !detail.avatar)
        return null;
    return {
        ...(detail.displayName ? { display_name: detail.displayName } : {}),
        ...(detail.description ? { description: detail.description } : {}),
        ...(detail.avatar ? { avatar: detail.avatar } : {}),
    };
}
export function isBuiltinAgentDetail(detail) {
    return detail.creationSource === 3;
}
export function toCreationSource(value) {
    if (value === 3)
        return 'builtin';
    if (value === 2)
        return 'auto';
    return 'manual';
}
//# sourceMappingURL=local-data-agent-profile.js.map