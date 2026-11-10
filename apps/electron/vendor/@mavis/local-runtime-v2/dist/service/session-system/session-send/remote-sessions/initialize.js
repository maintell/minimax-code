import { CloudSessionReader, RcSessionReader, } from '@mavis/agent-tools/desktop';
import { createRcDeviceSource } from './rc-device-source.js';
import { RemoteSessionReader } from './remote-session-reader.js';
import { createSshDeviceSource } from './ssh-device-source.js';
/**
 * The host-wide reader behind `session list/get/messages` with a non-local
 * source. SSH needs the desktop host port; Remote Control and cloud use the
 * managed login, and Remote Control also needs the host's RC device id.
 */
export function createRemoteSessionReader(input) {
    return new RemoteSessionReader({
        ssh: createSshDeviceSource(input.host),
        rc: createRcDeviceSource({ reader: new RcSessionReader(input.login), host: input.host }),
        cloud: new CloudSessionReader(input.login),
    });
}
//# sourceMappingURL=initialize.js.map