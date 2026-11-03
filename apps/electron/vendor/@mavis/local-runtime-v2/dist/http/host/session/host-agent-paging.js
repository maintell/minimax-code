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
//# sourceMappingURL=host-agent-paging.js.map