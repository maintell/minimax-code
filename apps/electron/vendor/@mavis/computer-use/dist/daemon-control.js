import { createConnection } from 'node:net';
import { ComputerUseError, record } from './contracts.js';
import { CUA_VERSION } from './component.js';
/** Narrow 0.34.1 lifecycle protocol; product tools only use the SDK. Never retries. */
export function daemonControl(endpoint, method, args) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(endpoint);
        let bytes = '';
        let settled = false;
        const finish = (error, result) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve(result);
        };
        socket.setTimeout(2_000, () => finish(new ComputerUseError('computer_channel_timeout', 'Driver control did not respond.')));
        socket.on('error', (error) => finish(error));
        socket.on('end', () => finish(new ComputerUseError('computer_channel_closed', 'Driver control closed before a response.')));
        socket.on('connect', () => socket.write(`${JSON.stringify({ method, args })}\n`));
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            bytes += chunk;
            if (bytes.length > 65_536)
                return finish(new ComputerUseError('computer_protocol_error', 'Oversized lifecycle response.'));
            const newline = bytes.indexOf('\n');
            if (newline < 0)
                return;
            try {
                const response = record(JSON.parse(bytes.slice(0, newline)));
                const result = record(response?.result);
                if (response?.ok !== true || !result)
                    throw new ComputerUseError('computer_protocol_error', 'Driver refused the lifecycle request.');
                finish(undefined, result);
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}
export function validateDaemonMetadata(metadata, pid) {
    if (metadata.driver_version !== CUA_VERSION ||
        metadata.contract_version !== '0.8.0' ||
        metadata.tools_list_schema_version !== '1' ||
        metadata.capability_version !== '1' ||
        metadata.mcp_protocol_version !== '2025-06-18' ||
        metadata.pid !== pid ||
        metadata.embedded !== false) {
        throw new ComputerUseError('computer_component_version_mismatch', 'Driver metadata/PID does not match the owned 0.34.1 standalone component.');
    }
}
//# sourceMappingURL=daemon-control.js.map