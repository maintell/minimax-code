import { isManagedRoutingBuildEnv } from '@mavis/agent-tools/desktop';
import { getRawRuntimeBuildEnv } from '../../../infra/config/routing-headers.js';
/**
 * Test-only override: an internal build started with this variable uses the
 * server reader regardless of the archon_biz switch. Kept until the archon_biz
 * endpoint serves the test environments; a production build ignores it.
 * @internal Exported only for focused tests.
 */
export const WEB_FETCH_SERVER_READER_ENV_VAR = 'MCODE_WEB_FETCH_SERVER_READER';
export function buildEnvServerSwitch(options = {}) {
    const env = options.env ?? process.env;
    const buildEnv = options.buildEnv ?? getRawRuntimeBuildEnv();
    const enabled = isManagedRoutingBuildEnv(buildEnv) && isTruthyFlag(env[WEB_FETCH_SERVER_READER_ENV_VAR]);
    return { serverReaderEnabled: () => enabled };
}
/** On when any of the switches is on. */
export function anyServerSwitch(...switches) {
    return {
        serverReaderEnabled: (userKey) => switches.some((item) => item.serverReaderEnabled(userKey)),
    };
}
function isTruthyFlag(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
}
//# sourceMappingURL=build-env-switch.js.map