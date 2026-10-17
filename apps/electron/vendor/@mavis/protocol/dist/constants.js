// Wire-level constants shared between cloud-runtime and archon-server.
// HTTP path strings, schema literals, and request header names are all part of
// the contract but are not data structures, so they live alongside the
// thrift-typescript generated types rather than in the IDL.
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_PACKAGE_NAME = '@mavis/protocol';
// Schema discriminator literals carried by HarnessControlReq / SessionExchangeReq
// payloads so consumers can guard against stray wire bodies.
export const HARNESS_CONTROL_SCHEMA = 'archon.harness.control.v1';
export const HARNESS_SESSION_EXCHANGE_SCHEMA = 'archon.harness.session.exchange.v1';
export const CONTINUATION_MATERIALIZE_SCHEMA = 'archon.continuation.materialize.v1';
export const CONTINUATION_EXPORT_SCHEMA = 'archon.continuation.export.v1';
export const SHARE_CONTINUATION_MANIFEST_SCHEMA = 'mavis.share.continuation.v1';
export const RUNTIME_EVENT_SCHEMA = 'archon.runtime.event.v1';
// HTTP paths exposed by cloud-runtime + archon-server. Stay in sync with the
// thrift IDL `api.post=...` annotations on each service method.
export const HARNESS_HTTP_AGENT_LOOP_START_PATH = '/archon/internal/api/v1/harness/control_harness';
export const ARCHON_HOST_HTTP_SESSION_EXCHANGE_PATH = '/archon/internal/api/v1/harness/session_exchange';
export const CONTINUATION_MATERIALIZE_PATH = '/archon/internal/api/v1/harness/continuation/materialize';
export const CONTINUATION_EXPORT_PATH = '/archon/internal/api/v1/harness/continuation/export';
// archon-server identity / authentication headers required on every cloud-runtime
// inbound and outbound RPC. See cloud-runtime/src/runtime-identity.ts and
// cloud-runtime/src/runtime-request-sk.ts for the lifecycle.
export const ARCHON_HARNESS_ID_HEADER = 'x-archon-harness-id';
export const ARCHON_USER_ID_HEADER = 'x-archon-user-id';
export const ARCHON_BIZ_ID_HEADER = 'x-archon-biz-id';
export const ARCHON_AUTHORIZATION_HEADER = 'authorization';
export const REQUEST_SK_HEADER = 'x-request-sk';
// Local Cron mutation callers use this internal header to retain the v1 metrics source dimension
// while sharing the generated DesktopService routes.
export const CRON_REQUEST_SOURCE_HEADER = 'X-Mavis-Cron-Request-Source';
export const CRON_REQUEST_SOURCES = ['ui', 'agent_tool'];
export function isCronRequestSource(value) {
    return typeof value === 'string' && CRON_REQUEST_SOURCES.includes(value);
}
// Cloud SR context numeric tags. These are not modeled as `enum` in the thrift
// IDL (they ride as plain `i32` fields with documentation comments), but cloud
// callers want named constants so they don't sprinkle magic 0/1/2 across the
// codebase. Values mirror the daemon-side enums of the same name.
export const SessionType = {
    Branch: 0,
    Root: 1,
};
export const AgentRole = {
    Worker: 0,
    Orchestrator: 1,
};
export const CreationSource = {
    Manual: 0,
    Auto: 1,
    Builtin: 2,
};
//# sourceMappingURL=constants.js.map