/** Synthetic only: no account, filesystem, network or vendor SDK. */
export function fixtureManifest() {
    return {
        schemaVersion: 1,
        name: '@fixture/model-access',
        version: '1.0.0',
        entry: './dist/index.mjs',
        engines: { mcodeSdk: '^1' },
        trust: 'native-code',
        platforms: ['darwin', 'win32', 'linux'],
        providers: [
            { id: 'fixture', credentialSchema: 1, credentialKinds: ['borrowed-current', 'direct-owned'] },
        ],
        sources: [
            {
                id: 'fixture',
                hostAgentId: 'fixture-app',
                capabilities: {
                    login: { methods: [{ id: 'device', kind: 'device-code', targets: ['global'] }] },
                    subscriptionBorrow: { variants: [{ id: 'cli', targets: ['global', 'cn'] }] },
                    apiKeyScan: { readers: [{ id: 'config', targets: ['global', 'cn'] }] },
                },
            },
        ],
    };
}
export function fixtureExtension() {
    const identity = {
        providerId: 'fixture',
        region: 'global',
        tenant: 'test',
        subject: 'synthetic',
    };
    return {
        sources: {
            fixture: {
                login: {
                    device: {
                        begin: async () => ({
                            view: { kind: 'cli', message: 'fixture' },
                            result: Promise.resolve({
                                kind: 'direct-owned',
                                providerId: 'fixture',
                                identity,
                                credentialSchema: 1,
                                payload: 'synthetic',
                            }),
                            cancel() { },
                        }),
                    },
                },
                subscriptionBorrow: {
                    cli: {
                        discover: async () => [],
                        resolve: async () => ({ identity, credentialRevision: 1, payload: 'synthetic' }),
                    },
                },
                apiKeyScan: { config: { scan: async () => [] } },
            },
        },
        providers: {
            fixture: {
                resolveOwned: async () => ({ identity, credentialRevision: 1, payload: 'synthetic' }),
                models: async () => [{ id: 'test-model', api: 'openai-completions' }],
                bindTransport: async () => ({
                    api: 'openai-completions',
                    modelId: 'test-model',
                    baseUrl: 'https://fixture.invalid',
                }),
                classifyError: () => ({ category: 'network', code: 'fixture_error', retryable: false }),
            },
        },
    };
}
export function registration(installationId = 'fixture-install', generation = 1) {
    return {
        installationId,
        generation,
        digest: `sha256:${'a'.repeat(64)}`,
        manifest: fixtureManifest(),
        extension: fixtureExtension(),
    };
}
//# sourceMappingURL=fixtures.test-support.js.map