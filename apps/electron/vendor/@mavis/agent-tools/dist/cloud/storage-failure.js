const RECOVERY = 'Storage writes are blocked until quota or free space is restored. Do not repeat the same ' +
    'copy/download/write, sleep or poll for space, regenerate successful media, change HOME, ' +
    'use /tmp, symlinks or mounts, or delete user files to bypass this failure. ' +
    'For an unmodified original cloud image/video already confirmed by a successful generation ' +
    'or query result in this turn, deliver its exact Matrix Drive node_id in the final response as ' +
    '<deliver-assets><media type="image" src="commit-id-NODE_ID" /></deliver-assets>, replacing NODE_ID with ' +
    'the confirmed ID and using type="video" for video. This needs no local copy or node-map write. Never guess an ID or reuse ' +
    'the original ID for edited/derived files. Otherwise report that delivery is blocked and end the turn.';
/** Recognize narrowly shaped filesystem diagnostics rather than quota keywords. */
function diagnosticCode(text) {
    for (const line of text.split('\n')) {
        // Require an actual diagnostic shape, not a filename, error guide or a
        // paragraph mentioning EDQUOT. stdout can include ordinary file contents.
        const node = /^(?:error: |Error: )?(EDQUOT: disk quota exceeded|ENOSPC: no space left on device|Unknown system error -122[^\n]*), (?:open|write|mkdir|rename|copyfile)\b/iu.exec(line);
        if (node)
            return /^ENOSPC/iu.test(node[1] ?? '') ? 'ENOSPC' : 'EDQUOT';
        const shell = /^(?:cp|mv|mkdir|touch|tee|install|dd|write|bash|\/bin\/bash): (?:[^\n]*: )?(Disk quota exceeded|No space left on device)\s*$/iu.exec(line);
        if (shell)
            return /^Disk/iu.test(shell[1] ?? '') ? 'EDQUOT' : 'ENOSPC';
        const python = /^(?:OSError|IOError): \[Errno (122|28)\] (?:Disk quota exceeded|No space left on device)(?::|$)/u.exec(line);
        if (python)
            return python[1] === '122' ? 'EDQUOT' : 'ENOSPC';
    }
    return undefined;
}
export function shellStorageFailure(stdout, stderr, exitCode) {
    if (typeof exitCode === 'number' && exitCode !== 0) {
        return diagnosticCode(`${stderr}\n${stdout}`);
    }
    // `mcode-tools ... 2>&1 | head` can hide the failing exit status. Recognize
    // only its standalone node-map write diagnostic in that case, not arbitrary
    // successful output mentioning a quota (e.g. documentation or command echo).
    const output = `${stdout}\n${stderr}`.trim();
    if (/^error: [^\n]*, (?:open|write|rename) ['"][^'"\n]*\/\.minimax\/\.node-map\.[^'"\n]+\.tmp['"]$/iu.test(output)) {
        return diagnosticCode(output);
    }
    return undefined;
}
export function withStorageFailure(result, code) {
    if (!code)
        return result;
    const guidance = `<storage_error code="CLOUD_WORKSPACE_STORAGE_FULL" cause="${code}" retryable="false">\n${RECOVERY}\n</storage_error>`;
    return {
        ...result,
        text: `${result.text}\n\n${guidance}`,
        content: [...result.content, { type: 'text', text: guidance }],
        isError: true,
        details: {
            ...result.details,
            is_error: true,
            code: 'CLOUD_WORKSPACE_STORAGE_FULL',
            storage_code: code,
            retryable: false,
        },
    };
}
/** Called only with exceptions thrown by the native file mutation operation. */
export function fileStorageFailure(toolName, error) {
    if (!(error instanceof Error))
        return undefined;
    const nativeError = error;
    const errno = nativeError.code === 'Unknown system error -122' && nativeError.errno === -122
        ? 'EDQUOT'
        : nativeError.code;
    if (errno !== undefined && errno !== 'EDQUOT' && errno !== 'ENOSPC')
        return undefined;
    const code = errno === 'EDQUOT' || errno === 'ENOSPC' ? errno : diagnosticCode(error.message);
    if (!code)
        return undefined;
    const text = 'File mutation failed because storage is exhausted.';
    return withStorageFailure({ tool_name: toolName, text, content: [{ type: 'text', text }] }, code);
}
//# sourceMappingURL=storage-failure.js.map