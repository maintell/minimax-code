/**
 * An official Plugin publishes its MCP servers as local stdio processes on this
 * machine. Another source (a local preview, a managed Mini App server) never
 * qualifies, and an official server reached over a remote transport does not
 * run here either.
 *
 * The predicate narrows the entry to its stdio transport, so a caller reads the
 * stdio-only fields without repeating the qualification.
 */
export function isOfficialStdioServer(entry) {
    return entry.source === 'OFFICIAL' && entry.server.resolvedServer.transport.type === 'stdio';
}
//# sourceMappingURL=official-stdio.js.map