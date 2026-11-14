import { isTrustedBuiltinCreationSource } from '@mavis/agent-tools/desktop/subagent-roles';
import { canonicalBuiltinName } from '../../builtin/catalog.js';
import { DETACHABLE_LEGACY_BUILTIN_NAMES } from '../../domain/names.js';
const PENDING_DETACH_NAMES = new Set(DETACHABLE_LEGACY_BUILTIN_NAMES);
export function collectAgentListCandidates(definitions, metas, options) {
    const byName = new Map(metas.map((meta) => [meta.name, meta]));
    const consumed = new Set();
    const candidates = collectBuiltinCandidates(definitions, byName, consumed);
    candidates.push(...collectCustomCandidates(metas, consumed, options));
    return candidates;
}
function collectBuiltinCandidates(definitions, byName, consumed) {
    const candidates = [];
    for (const definition of definitions) {
        const direct = byName.get(definition.name);
        // A manual canonical collision is an exact custom owner. Do not project
        // the trusted primary alias row (`main`) over it; the canonical-name
        // collision migration owns that physical conflict.
        if (direct && !isTrustedBuiltinCreationSource(direct.creationSource)) {
            for (const legacyName of definition.legacyNames)
                consumed.add(legacyName);
            continue;
        }
        const legacy = definition.legacyNames
            .map((name) => byName.get(name))
            .find((meta) => isTrustedBuiltinCreationSource(meta?.creationSource));
        const source = direct && isTrustedBuiltinCreationSource(direct.creationSource) ? direct : legacy;
        if (!source)
            continue;
        if (direct)
            consumed.add(direct.name);
        if (legacy)
            consumed.add(legacy.name);
        candidates.push({
            meta: source,
            canonicalViewName: definition.name,
            exactOwnerName: source.name,
            definition,
        });
    }
    return candidates;
}
function collectCustomCandidates(metas, consumed, options) {
    const search = options.search?.trim().toLowerCase();
    return metas.flatMap((meta) => {
        if (consumed.has(meta.name))
            return [];
        if (isRetiredBuiltin(meta))
            return [];
        if (search && !meta.name.toLowerCase().includes(search))
            return [];
        return [
            { meta, canonicalViewName: canonicalBuiltinName(meta.name), exactOwnerName: meta.name },
        ];
    });
}
/**
 * A trusted builtin row that no shipped definition consumed belongs to a
 * retired built-in (for example the pre-rename `momo` row behind Bunny). It
 * has no packaged definition and no Custom agent.md, so projecting it would
 * duplicate the current built-in in pickers and make content reads fail with
 * AGENT_CONFIG_NOT_FOUND. The row, its files and Sessions stay untouched; only
 * the roster omits it. General/Coder stay listed until startup detaches them.
 */
function isRetiredBuiltin(meta) {
    return (isTrustedBuiltinCreationSource(meta.creationSource) && !PENDING_DETACH_NAMES.has(meta.name));
}
//# sourceMappingURL=list-candidates.js.map