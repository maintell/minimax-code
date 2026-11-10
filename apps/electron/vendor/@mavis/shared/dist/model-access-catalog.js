/** Pure projection for the new account list. Not wired into production routing yet. */
export function combineSubscriptionCatalogs(catalogs, preferences = {}) {
    const out = [];
    const seenAccounts = new Set();
    for (const catalog of catalogs) {
        if (!catalog.selected || seenAccounts.has(catalog.accountId))
            continue;
        seenAccounts.add(catalog.accountId);
        let cursor = 0;
        const seenModels = new Set();
        for (const model of catalog.models) {
            if (!model.id || seenModels.has(model.id))
                continue;
            seenModels.add(model.id);
            const index = out.findIndex((item) => item.id === model.id);
            const account = { accountId: catalog.accountId, model: structuredClone(model) };
            const existing = out[index];
            if (existing) {
                out[index] = {
                    ...existing,
                    reasoning: [...new Set([...existing.reasoning, ...(model.reasoning ?? [])])],
                    accounts: [...existing.accounts, account],
                };
                cursor = index + 1;
            }
            else {
                out.splice(cursor, 0, {
                    id: model.id,
                    name: model.name ?? model.id,
                    enabled: preferences[model.id]?.enabled !== false,
                    reasoning: [...new Set(model.reasoning ?? [])],
                    accounts: [account],
                });
                cursor += 1;
            }
        }
    }
    return out;
}
/** A whole request must fit one member; do not compose image/context/effort across accounts. */
export function subscriptionModelAccounts(model, request) {
    if (!model.enabled)
        return [];
    return model.accounts
        .filter(({ model: account }) => (!request.effort || account.reasoning?.includes(request.effort)) &&
        (request.input ?? []).every((kind) => (account.input ?? ['text']).includes(kind)) &&
        (request.contextTokens === undefined ||
            (account.contextWindow !== undefined &&
                account.contextWindow >= request.contextTokens)) &&
        (request.outputTokens === undefined ||
            (account.maxOutputTokens !== undefined &&
                account.maxOutputTokens >= request.outputTokens)))
        .map((entry) => entry.accountId);
}
//# sourceMappingURL=model-access-catalog.js.map