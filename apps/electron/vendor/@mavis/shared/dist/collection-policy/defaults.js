/**
 * Built-in collection baseline: the policy used when remote configuration is absent or invalid,
 * plus the rules that stay on no matter what remote configuration says.
 */
import { COLLECTION_POLICY_SCHEMA_VERSION } from './types.js';
/**
 * Extensions that are never a user-facing command. Windows PATH directories are dominated by
 * these: 85% of the observed PATH inventory was documentation, data and library files rather
 * than commands. This list is PATH-only — the workspace inventory keeps `.md`, `.json`, `.rs`
 * and friends, which are exactly the signal there.
 */
export const DEFAULT_PATH_COMMAND_EXCLUDE_EXTENSIONS = Object.freeze([
    '.acm',
    '.ax',
    '.bin',
    '.blb',
    '.bmp',
    '.cab',
    '.cap',
    '.cat',
    '.chm',
    '.cpl',
    '.csv',
    '.dat',
    '.db',
    '.dll',
    '.gif',
    '.h',
    '.hpp',
    '.htm',
    '.html',
    '.ico',
    '.iec',
    '.inf',
    '.ini',
    '.jpg',
    '.json',
    '.lng',
    '.man',
    '.md',
    '.mof',
    '.mp4',
    '.nls',
    '.ocx',
    '.pdf',
    '.png',
    '.pri',
    '.rll',
    '.rs',
    '.rtf',
    '.sdi',
    '.sig',
    '.svg',
    '.sys',
    '.tbl',
    '.tlb',
    '.toc',
    '.tsp',
    '.txt',
    '.uce',
    '.wim',
    '.wmv',
    '.xml',
    '.xsl',
    '.yaml',
    '.yml',
    '.zip',
]);
export const DEFAULT_MAX_PATH_COMMANDS = 2_000;
export const DEFAULT_MAX_PATH_COMMAND_BYTES = 32 << 10;
/**
 * File names that are noise in every environment: blank names, bare version or timestamp
 * numbers, GUID-named payloads and backup copies. These are built into the matcher, so a remote
 * document can add rules but can never re-admit this noise.
 */
export const BUILT_IN_NOISY_COMMAND_NAME_PATTERNS = Object.freeze([
    /^\s*$/u,
    /[\s\u0000-\u001f\u007f]/u,
    /^[0-9]+(?:[._-][0-9]+)*$/u,
    /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/iu,
    /^[0-9a-f]{32}$/iu,
    /\.(?:bak|backup|old|orig|disabled)(?:$|[._-])/iu,
]);
/**
 * Meta-info field paths a remote document may omit. Schema, runtime identity and collection
 * bookkeeping (scan limits, filtered/retained counts, policy versions) are deliberately absent:
 * a payload that cannot be interpreted or audited is worse than a verbose one. Excluding a
 * listed parent omits its whole subtree.
 */
export const EXCLUDABLE_METADATA_FIELDS = Object.freeze({
    system: true,
    'system.os_name': true,
    'system.os_version': true,
    'system.arch': true,
    'system.timezone': true,
    'system.locale': true,
    'system.terminal': true,
    'environment.shell': true,
    'environment.path_commands': true,
    'environment.runtimes': true,
    'workspace.current_directory': true,
    'workspace.total_files': true,
    'workspace.total_bytes': true,
    'workspace.file_types': true,
    'workspace.directory_tree': true,
    'workspace.git': true,
    'workspace.git.branch': true,
    'workspace.git.remote_branch': true,
    'workspace.git.commit': true,
    config_files: true,
});
/**
 * Environment variables the collector reads today. A remote document can deny any of them; it
 * can never name a variable outside this set, because collection never reads one.
 */
export const READABLE_ENVIRONMENT_KEYS = Object.freeze({
    PATH: true,
    PATHEXT: true,
    SHELL: true,
    COMSPEC: true,
    TERM: true,
    TERM_PROGRAM: true,
    WT_SESSION: true,
});
/**
 * Defaults keep today's behaviour: no extra workspace, environment or metadata filtering beyond
 * the collector's own safety baseline, and PATH noise removed.
 */
export const DEFAULT_COLLECTION_POLICY = Object.freeze({
    schema_version: COLLECTION_POLICY_SCHEMA_VERSION,
    workspace: Object.freeze({ exclude_globs: Object.freeze([]) }),
    path_commands: Object.freeze({
        exclude_extensions: DEFAULT_PATH_COMMAND_EXCLUDE_EXTENSIONS,
        exclude_name_globs: Object.freeze([]),
        max_commands: DEFAULT_MAX_PATH_COMMANDS,
        max_bytes: DEFAULT_MAX_PATH_COMMAND_BYTES,
    }),
    environment: Object.freeze({ exclude_keys: Object.freeze([]) }),
    metadata: Object.freeze({ exclude_fields: Object.freeze([]) }),
});
//# sourceMappingURL=defaults.js.map