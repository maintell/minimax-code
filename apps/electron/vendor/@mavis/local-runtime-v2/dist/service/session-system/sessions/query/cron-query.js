export function createSessionCronQuery(repository) {
    return {
        listCreatedByCron: (options) => repository.listByCronOriginPage(options),
        getMany: (sessionIds) => repository.getMany(sessionIds),
    };
}
//# sourceMappingURL=cron-query.js.map