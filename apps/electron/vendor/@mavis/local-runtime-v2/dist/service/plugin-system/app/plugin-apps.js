/**
 * Fills Desktop-read Plugin App rows the way the Cloud BFF fills official ones: catalog branding
 * and the user's connection state join by provider. A provider outside the enabled catalog keeps
 * only its declared identity, so the row shows no connect action.
 */
export function withConnectorCatalog(apps, connectors) {
    const byProvider = new Map(connectors.map((connector) => [connector.provider, connector]));
    return apps.map((app) => {
        const connector = byProvider.get(app.provider);
        if (!connector)
            return app;
        const logoUrl = app.logoUrl || connector.logoUrl;
        return {
            ...app,
            ...(connector.displayName ? { displayName: connector.displayName } : {}),
            ...(logoUrl ? { logoUrl, darkLogoUrl: app.darkLogoUrl || logoUrl } : {}),
            ...(connector.status ? { status: connector.status } : {}),
            ...(connector.connection ? { connection: connector.connection } : {}),
            ...(connector.actions ? { actions: connector.actions } : {}),
        };
    });
}
//# sourceMappingURL=plugin-apps.js.map