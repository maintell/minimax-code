// ---------------------------------------------------------------------------------------------
// Workspace: the SDK specifiers an extension module may import. They are virtual modules: the
// host serves each from `sdk/author/` inside the realm and no package of that name exists on disk.
// The candidate, scan and artifact types live in `preview/contracts.ts`.
/** The four specifiers an extension module may import; the vm host provides them at load. */
export const EXTENSION_SDK_SPECIFIERS = [
    '@minimax/mcode-plugin-extension',
    '@minimax/mcode-plugin-extension/ui',
    '@minimax/mcode-plugin-extension/jsx-runtime',
    '@minimax/mcode-plugin-extension/jsx-dev-runtime',
];
export const EXTENSION_JSX_IMPORT_SOURCE = EXTENSION_SDK_SPECIFIERS[0];
/** Only `*.test.tsx` files may import it; the `extension test` realm serves it. */
export const EXTENSION_TESTING_SPECIFIER = '@minimax/mcode-plugin-extension/testing';
/** Codes the SDK table has no slot for; host-side only. */
const HOST_SERVICE_ERROR_CODES = [
    'INVOCATION_UNKNOWN',
    'ARGUMENT_INVALID',
    'STORE_KEY_INVALID',
    'STORE_QUOTA_EXCEEDED',
    'STATE_KEY_UNDECLARED',
    'MCP_SERVER_NOT_FOUND',
    'MCP_CALL_FAILED',
    /** A renderer answered a query that is unknown, already settled or of another session. */
    'EXTENSION_QUERY_UNKNOWN',
    /** A renderer answered a query with a payload that does not fit its op. */
    'EXTENSION_REQUEST_INVALID',
];
//# sourceMappingURL=contracts.js.map