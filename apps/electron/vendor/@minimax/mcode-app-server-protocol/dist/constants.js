import { APP_SERVER_BINARY_PAYLOAD_ENCODINGS } from './binary-frame.js';
import { RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW, RUNTIME_TRANSPORT_MAX_STREAM_WINDOW, RUNTIME_TRANSPORT_PROTOCOL_VERSION, } from './runtime-transport.js';
/** Current outer wire version implemented by this package. */
export const APP_SERVER_PROTOCOL_VERSION = 1;
export const DEFAULT_APP_SERVER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const APP_SERVER_DESKTOP_SERVICE_METHOD = 'desktopService/transport';
export const APP_SERVER_RUNTIME_AUTH_CONTEXT_METHOD = 'runtime/authContext';
export const APP_SERVER_ACCOUNT_READ_METHOD = 'account/read';
export const APP_SERVER_ACCOUNT_LOGIN_START_METHOD = 'account/login/start';
export const APP_SERVER_ACCOUNT_LOGIN_CANCEL_METHOD = 'account/login/cancel';
export const APP_SERVER_ACCOUNT_LOGOUT_METHOD = 'account/logout';
export const APP_SERVER_ACCOUNT_LOGIN_COMPLETED_METHOD = 'account/login/completed';
export const APP_SERVER_ACCOUNT_UPDATED_METHOD = 'account/updated';
export const APP_SERVER_PREPARE_RESTART_METHOD = 'server/prepareRestart';
export const APP_SERVER_CONTROL_METHODS = [
    APP_SERVER_ACCOUNT_READ_METHOD,
    APP_SERVER_ACCOUNT_LOGIN_START_METHOD,
    APP_SERVER_ACCOUNT_LOGIN_CANCEL_METHOD,
    APP_SERVER_ACCOUNT_LOGOUT_METHOD,
    APP_SERVER_PREPARE_RESTART_METHOD,
];
export const APP_SERVER_METHODS = [
    'initialize',
    ...APP_SERVER_CONTROL_METHODS,
    APP_SERVER_DESKTOP_SERVICE_METHOD,
];
export const APP_SERVER_CLIENT_NOTIFICATION_METHODS = [
    'initialized',
    APP_SERVER_DESKTOP_SERVICE_METHOD,
];
export const APP_SERVER_SERVER_NOTIFICATION_METHODS = [
    APP_SERVER_ACCOUNT_LOGIN_COMPLETED_METHOD,
    APP_SERVER_ACCOUNT_UPDATED_METHOD,
    APP_SERVER_DESKTOP_SERVICE_METHOD,
];
export const APP_SERVER_ERROR_CODES = {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    overloaded: -32001,
    notInitialized: -32002,
    alreadyInitialized: -32003,
    unsupportedTransport: -32004,
    unsupportedProtocol: -32005,
    authOperationFailed: -32010,
};
export const APP_SERVER_DESKTOP_SERVICE_CAPABILITIES = {
    contract: 'DesktopService',
    transportMethod: APP_SERVER_DESKTOP_SERVICE_METHOD,
    transportProtocolVersion: RUNTIME_TRANSPORT_PROTOCOL_VERSION,
    requestFrame: 'RuntimeTransportWireRequestFrame',
    responseFrames: ['response-start', 'stream-chunk', 'stream-done', 'stream-error'],
    /**
     * Baseline payload encoding. Always base64 so a peer that predates the
     * binary framing keeps reading this field and stays on the JSON wire.
     * The negotiated encoding for one connection is reported separately as
     * `binaryPayloadEncoding` inside that connection's `initialize` result.
     */
    binaryPayloadEncoding: 'base64',
    /** Encodings this build can handle, best first. Purely additive. */
    binaryPayloadEncodings: APP_SERVER_BINARY_PAYLOAD_ENCODINGS,
    flowControl: ['streamWindow', 'stream-credit', 'abort'],
    defaultStreamWindow: RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW,
    maxStreamWindow: RUNTIME_TRANSPORT_MAX_STREAM_WINDOW,
};
export const APP_SERVER_DAEMON_STATE_VERSION = 1;
//# sourceMappingURL=constants.js.map