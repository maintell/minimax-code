/**
 * Shared context type for bash permission helpers. Lives in its own
 * file to avoid runtime cyclic imports between `bash-permission.ts`,
 * `bash-write-target.ts`, and `bash-fast-allow.ts` — every consumer
 * pulls the type from here without depending on each other.
 */
export {};
//# sourceMappingURL=bash-context.js.map