/**
 * IO ports of the host-neutral core tools (read / write / edit / bash / grep / glob).
 *
 * Only the calls the tools actually make, with node:fs/promises signatures, so
 * the desktop host passes physical-fs unchanged and other hosts adapt their own
 * filesystem. Errors follow node conventions: a missing path rejects with
 * `code: 'ENOENT'` (Pi's mutation queue and the read fallbacks depend on it).
 */
export {};
//# sourceMappingURL=ports.js.map