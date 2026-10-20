/**
 * Broker launch sample shared by `miniapp-broker.test.ts` (Main-side broker
 * request/response framing) and `miniapp-surface.test.ts` (Browser surface
 * resolution), so both stop hand-declaring the same Mini App summary and
 * launch coordinates.
 */
export let MINIAPP_BROKER_SAMPLE = {
    pluginId: 'weather-board',
    displayName: 'Weather Board',
    runtime: { kind: 'process', status: 'running' },
};
export function buildMiniAppBrokerLaunchFixture(runId = 'run-1') {
    return {
        miniApp: MINIAPP_BROKER_SAMPLE,
        launch: {
            origin: 'http://127.0.0.1:51234',
            surfacePath: '/weather',
            runId,
            loopbackToken: 'loopback-token-0123456789abcdef',
        },
    };
}
