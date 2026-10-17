/**
 * Query-string helpers extracted from `api/host.ts`
 * (boy-scout against the 2000-LoC cap). Pure functions, no host state.
 *
 * Tested via the host integration tests in `local-api-host.test.ts`.
 */
export function readBooleanSearchParam(url, name) {
    const value = url.searchParams.get(name);
    return value === '1' || value === 'true' || value === 'yes';
}
export function readPositiveIntSearchParam(url, name) {
    const parsed = Number.parseInt(url.searchParams.get(name) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
export function readNonNegativeIntSearchParam(url, name) {
    const parsed = Number.parseInt(url.searchParams.get(name) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
export function pageLocalAgentInfos(agents, url, primaryAgentName) {
    let visible = agents;
    if (readBooleanSearchParam(url, 'excludePrimary')) {
        visible = visible.filter((agent) => !isPrimaryAgentRecord(agent, primaryAgentName));
    }
    if (readBooleanSearchParam(url, 'excludeSourceProject')) {
        visible = visible.filter((agent) => typeof agent.sourceProject !== 'string' && typeof agent.source_project !== 'string');
    }
    if (readBooleanSearchParam(url, 'excludeLegacy')) {
        visible = visible.filter((agent) => agent.creationSource !== 'legacy' && agent.creationSource !== 'legacy-import');
    }
    const offset = readNonNegativeIntSearchParam(url, 'offset') ?? 0;
    const limit = readPositiveIntSearchParam(url, 'limit');
    return limit === undefined ? visible.slice(offset) : visible.slice(offset, offset + limit);
}
function isPrimaryAgentRecord(agent, primaryAgentName) {
    return agent.name === primaryAgentName || agent.name === 'mavis' || agent.name === 'main';
}
//# sourceMappingURL=host-agent-paging.js.map