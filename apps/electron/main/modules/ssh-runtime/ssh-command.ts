import { userInfo } from "node:os";
import { isValidSshConnectionEndpoint, isSafeAbsoluteRemotePath } from "./config";
import { usesSshTestInstaller, readSshTestInstaller } from "./test-cli-installer";
export let MCODE_PUBLIC_INSTALLER_URL = 'https://filecdn.minimax.chat/public/install.sh';
/** Quote one argument for the remote POSIX shell used by OpenSSH. */
export function quoteRemoteShellArg(value) {
    return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
const SSH_NONINTERACTIVE_OPTIONS = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    // Never join or create a user-owned multiplexed connection. Cleanup owns this tree only.
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ControlPersist=no',
    // The application supplies its own command/input, including the shell-request mode.
    '-o',
    'RemoteCommand=none',
    '-o',
    'StdinNull=no',
    '-o',
    'ForkAfterAuthentication=no',
];
const SSH_KEEPALIVE_OPTIONS = [
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
];
/** Build fixed OpenSSH options plus one validated Main-owned endpoint. */
export function buildSshConnectionArgs(endpoint) {
    if (!isValidSshConnectionEndpoint(endpoint)) {
        throw new Error('invalid_ssh_connection_endpoint');
    }
    if (endpoint.kind === 'ssh_config') {
        return [
            ...(endpoint.hostname ? ['-o', `HostName=${endpoint.hostname}`] : []),
            ...(endpoint.port !== undefined ? ['-p', String(endpoint.port)] : []),
            ...(endpoint.identityFile ? ['-i', endpoint.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
            endpoint.hostAlias,
        ];
    }
    const args = [];
    if (endpoint.credentialId) {
        // Password grants and OpenSSH must refer to the exact same destination,
        // even when the user's SSH config has a matching Host/User/HostName entry.
        args.push('-l', sshPasswordUser(endpoint), '-o', `HostName=${endpoint.hostname}`, '-o', 'CanonicalizeHostname=no');
    }
    if (endpoint.port !== undefined)
        args.push('-p', String(endpoint.port));
    if (endpoint.identityFile) {
        args.push('-i', endpoint.identityFile, '-o', 'IdentitiesOnly=yes');
    }
    args.push(endpoint.user ? `${endpoint.user}@${endpoint.hostname}` : endpoint.hostname);
    return args;
}
export function sshPasswordUser(endpoint) {
    return endpoint.user ?? userInfo().username;
}
export function buildSshExecArgs(endpoint, mode, remoteCommand, keepalive = false, confirmHostKey = false) {
    return [
        mode,
        ...(endpoint.kind === 'manual' && endpoint.credentialId
            ? [
                '-o',
                'BatchMode=no',
                '-o',
                'PreferredAuthentications=password',
                '-o',
                'PubkeyAuthentication=no',
                '-o',
                'KbdInteractiveAuthentication=no',
                '-o',
                'NumberOfPasswordPrompts=1',
                '-o',
                confirmHostKey ? 'StrictHostKeyChecking=ask' : 'StrictHostKeyChecking=yes',
                '-o',
                'FingerprintHash=sha256',
                ...SSH_NONINTERACTIVE_OPTIONS.slice(2),
            ]
            : SSH_NONINTERACTIVE_OPTIONS),
        ...(keepalive ? SSH_KEEPALIVE_OPTIONS : []),
        ...buildSshConnectionArgs(endpoint),
        remoteCommand,
    ];
}
/** Build an OpenSSH invocation without a local shell or user-controlled options. */
export function buildSshAppServerSpawnSpec(target, environment, confirmHostKey = false) {
    const discovery = target.mcodePath
        ? ''
        : [
            buildRemoteProbeCommand(),
            `printf '${SSH_BOOTSTRAP_PROBE_END}\\n'`,
            '[ -n "$mcode_path" ] || exit 127',
        ].join('; ') + '; ';
    const launcher = target.mcodePath ? quoteRemoteShellArg(target.mcodePath) : '"$mcode_path"';
    const bootstrap = [
        ...(environment
            ? [
                `MAVIS_BUILD_ENV=${quoteRemoteShellArg(environment.buildEnv)}`,
                `MAVIS_REGION=${quoteRemoteShellArg(environment.region)}`,
            ]
            : []),
        launcher,
        'app-server daemon bootstrap --auth-mode remote-oauth </dev/null',
    ].join(' ');
    const remoteCommand = [
        'umask 077',
        `startup_dir="$(mktemp -d "\${TMPDIR:-/tmp}/mcode-bootstrap.XXXXXX")" || exit 1`,
        'startup_log="$startup_dir/stderr"',
        `trap 'rm -f "$startup_log" "$startup_log.stdout"; rmdir "$startup_dir"' EXIT HUP INT TERM`,
        // Capture stderr before emitting the failure record: separate SSH streams may
        // otherwise deliver the record before the actual error. Never consume proxy stdin.
        `${bootstrap} >"$startup_log.stdout" 2>"$startup_log"`,
        'startup_exit=$?',
        'if [ "$startup_exit" -ne 0 ]; then',
        `startup_error="$(cat "$startup_log" "$startup_log.stdout" | head -c 8192 | base64 | tr -d '\r\n')"`,
        `printf '\n{"action":"bootstrap","state":{"status":"failed","exitCode":%s,"stderrBase64":"%s"}}\n' "$startup_exit" "$startup_error"`,
        'exit "$startup_exit"',
        'fi',
        'cat "$startup_log.stdout"',
        'cat "$startup_log" >&2',
        'rm -f "$startup_log" "$startup_log.stdout"',
        'rmdir "$startup_dir"',
        'trap - EXIT HUP INT TERM',
        `exec ${launcher} app-server proxy`,
    ]
        .join('; ')
        .replace('then;', 'then');
    return {
        command: 'ssh',
        args: buildSshExecArgs(target.endpoint, '-T', discovery + remoteCommand, true, confirmHostKey),
    };
}
/** Keep the remote managed-service lane aligned with the Desktop credential issuer. */
export function resolveSshRuntimeEnvironment(env = process.env) {
    // Match local-runtime initialization even when saved SSH hosts restore first.
    const desktopLane = {
        dev: 'test',
        development: 'test',
        test: 'test',
        staging: 'staging',
        prod: 'prod',
        production: 'prod',
    };
    const rawBuildEnv = env.MAVIS_BUILD_ENV ?? desktopLane[env.NEXT_PUBLIC_BUILD_ENV ?? 'test'];
    const buildEnv = rawBuildEnv === 'test' ||
        rawBuildEnv === 'staging' ||
        rawBuildEnv === 'prod' ||
        rawBuildEnv === 'dev'
        ? rawBuildEnv
        : 'dev';
    const rawRegion = env.MAVIS_REGION;
    const region = rawRegion === 'cn' || rawRegion === 'en'
        ? rawRegion
        : env.NEXT_PUBLIC_LOCALE === 'zh'
            ? 'cn'
            : 'en';
    return { buildEnv, region };
}
/** Build the interactive PTY used by the Desktop terminal for one SSH project. */
export function buildSshTerminalSpawnSpec(target) {
    const workspace = quoteRemoteShellArg(target.workspaceDir);
    const remoteCommand = [
        // Do not open a usable shell in HOME when a saved project was moved or removed.
        `CDPATH= cd ${workspace} || exit $?`,
        'if [ -n "$SHELL" ] && [ -x "$SHELL" ]',
        'then exec "$SHELL" -l',
        'elif command -v bash >/dev/null 2>&1',
        'then exec bash -l',
        'else exec sh -l',
        'fi',
    ].join('; ');
    return {
        command: 'ssh',
        args: buildSshExecArgs(target.endpoint, '-tt', remoteCommand, true),
    };
}
/**
 * Build the explicit user-triggered remote CLI install/repair command.
 *
 * The renderer supplies only an approved host alias. The installer source and
 * every shell token stay owned by Main, and the temporary script is removed
 * after execution.
 */
export function buildSshCliSetupSpawnSpec(endpoint, target = null, runtimeEnvironment = resolveSshRuntimeEnvironment(), diagnosticId, inputReady = ':', existingMcodePath) {
    if (existingMcodePath && !isSafeAbsoluteRemotePath(existingMcodePath))
        throw new Error('invalid_mcode_install_path');
    const testInstaller = usesSshTestInstaller(runtimeEnvironment.buildEnv)
        ? readSshTestInstaller()
        : null;
    const url = target?.installer.url ?? MCODE_PUBLIC_INSTALLER_URL;
    const environment = testInstaller && diagnosticId
        ? `MCODE_SSH_DIAGNOSTIC_ID=${quoteRemoteShellArg(diagnosticId)}`
        : !testInstaller && target
            ? buildInstallerEnvironment(target)
            : '';
    const input = testInstaller ? Buffer.from(testInstaller.script, 'utf8') : undefined;
    const preparation = input
        ? [
            inputReady,
            `dd bs=1 count=${input.byteLength} of="$installer" 2>/dev/null`,
            `test "$(wc -c < "$installer" | tr -d '[:space:]')" = '${input.byteLength}'`,
        ]
        : [
            `if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 ${quoteRemoteShellArg(url)} -o "$installer"`,
            `elif command -v wget >/dev/null 2>&1; then wget -q --timeout=120 --tries=2 -O "$installer" ${quoteRemoteShellArg(url)}`,
            'else exit 127',
            'fi',
        ];
    const remoteCommand = [
        'set -eu',
        ...(existingMcodePath
            ? [
                `existing_mcode=${quoteRemoteShellArg(existingMcodePath)}`,
                // Use only the existing or remembered prefix. Never choose a fallback
                // directory when an installed launcher cannot be updated safely.
                `case "$existing_mcode" in */bin/mcode) MCODE_INSTALL_DIR="\${existing_mcode%/bin/mcode}" ;; *) echo 'MCODE_EXISTING_INSTALL_UNSUPPORTED: expected a managed bin/mcode launcher' >&2; exit 82 ;; esac`,
                `case "$MCODE_INSTALL_DIR" in ''|/) echo 'MCODE_EXISTING_INSTALL_UNSUPPORTED: expected a dedicated installation prefix' >&2; exit 82 ;; esac`,
                // A deleted prefix can be recreated at its remembered location. An
                // existing unknown installation (including a dangling symlink) stays protected.
                `if [ ! -e "$MCODE_INSTALL_DIR" ] && [ ! -L "$MCODE_INSTALL_DIR" ]; then :; elif { ! grep -Eq '"product"[[:space:]]*:[[:space:]]*"minimax-code"' "$MCODE_INSTALL_DIR/install.json" 2>/dev/null && [ ! -f "$MCODE_INSTALL_DIR/lib/node_modules/@minimax/code/package.json" ] && [ ! -f "$MCODE_INSTALL_DIR/lib/node_modules/@minimax-ai/code/package.json" ]; } || [ -d "$MCODE_INSTALL_DIR/lib/node_modules/@minimax/mcode" ]; then echo 'MCODE_EXISTING_INSTALL_UNSUPPORTED: update this CLI with its original package manager; no alternative installation was created' >&2; exit 82; fi`,
                'export MCODE_INSTALL_DIR',
                'export MCODE_NO_MODIFY_PATH=1',
            ]
            : []),
        `installer="$(mktemp "\${TMPDIR:-/tmp}/mcode-install.XXXXXX")"`,
        `cleanup() { rm -f "$installer"; }`,
        'trap cleanup EXIT HUP INT TERM',
        ...preparation,
        ...(!testInstaller && target
            ? [
                'if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$installer")"; else digest="$(shasum -a 256 "$installer")"; fi',
                `test "\${digest%% *}" = ${quoteRemoteShellArg(target.installer.sha256)}`,
            ]
            : []),
        `${environment ? `${environment} ` : ''}bash "$installer" </dev/null`,
    ].join('; ');
    return {
        command: 'ssh',
        args: buildSshExecArgs(endpoint, '-T', remoteCommand, true),
        ...(input ? { input } : {}),
    };
}
function buildInstallerEnvironment(target) {
    const values = {
        packageName: target.packageName,
        version: target.version,
        registry: target.registry,
        integrity: target.integrity,
        repair: target.installer.repairValue,
    };
    return Object.keys(values)
        .map((key) => `${target.installer.environment[key]}=${quoteRemoteShellArg(values[key])}`)
        .join(' ');
}
const SSH_ATTACHMENT_UPLOAD_MARKER = '__MCODE_SSH_UPLOAD_V1__=';
/** Build the bounded stdin upload used for one user-selected attachment. */
export function buildSshAttachmentUploadSpawnSpec(target, uploadId, fileName, sizeBytes, readyCommand) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
        throw new Error('invalid_upload_size');
    const relativePath = `.minimax/ssh-uploads/${uploadId}/${fileName}`;
    const quotedRelativePath = quoteRemoteShellArg(relativePath);
    const remoteCommand = [
        'set -eu',
        'umask 077',
        `upload_path="$HOME"/${quotedRelativePath}`,
        'mkdir -p "$(dirname "$upload_path")"',
        `temporary_path="$(mktemp "\${upload_path}.partial.XXXXXX")"`,
        'trap \'rm -f "$temporary_path"\' EXIT HUP INT TERM',
        'if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum; elif command -v shasum >/dev/null 2>&1; then checksum=shasum; else exit 127; fi',
        'head -c 1 </dev/null >/dev/null',
        readyCommand,
        sizeBytes === 0 ? ': > "$temporary_path"' : `head -c ${sizeBytes} > "$temporary_path"`,
        'received="$(wc -c < "$temporary_path" | tr -d \'[:space:]\')"',
        `test "$received" = '${sizeBytes}'`,
        'if [ "$checksum" = sha256sum ]; then digest="$(sha256sum "$temporary_path")"; else digest="$(shasum -a 256 "$temporary_path")"; fi',
        `digest="\${digest%% *}"`,
        'mv "$temporary_path" "$upload_path"',
        `printf '\\n${SSH_ATTACHMENT_UPLOAD_MARKER}%s\\n' "$upload_path"`,
        'printf \'size=%s\\nsha256=%s\\n\' "$received" "$digest"',
    ].join('; ');
    return {
        command: 'ssh',
        args: buildSshExecArgs(target.endpoint, '-T', remoteCommand, true),
    };
}
export function parseSshAttachmentUploadPath(output) {
    const markerIndex = output.lastIndexOf(SSH_ATTACHMENT_UPLOAD_MARKER);
    if (markerIndex < 0)
        return null;
    const value = output.slice(markerIndex + SSH_ATTACHMENT_UPLOAD_MARKER.length).split(/\r?\n/u)[0];
    return value?.trim() || null;
}
export let SSH_BOOTSTRAP_PROBE_END = '__MCODE_SSH_BOOTSTRAP_V1__';
export function buildRemoteProbeCommand(configuredMcodePath, requiredRelativePath, requiredPath, inspectVersion = false) {
    if (requiredPath && !isSafeAbsoluteRemotePath(requiredPath))
        throw new Error('invalid_mcode_install_path');
    const trustedConfiguredPath = configuredMcodePath && isSafeAbsoluteRemotePath(configuredMcodePath) ? configuredMcodePath : '';
    const quotedConfiguredPath = trustedConfiguredPath
        ? quoteRemoteShellArg(trustedConfiguredPath)
        : '';
    if (requiredRelativePath &&
        (!/^[.A-Za-z0-9_-]+(?:\/[.A-Za-z0-9_-]+)+$/u.test(requiredRelativePath) ||
            requiredRelativePath.split('/').some((part) => part === '.' || part === '..'))) {
        throw new Error('invalid_mcode_install_path');
    }
    const defaultCandidates = '"$HOME/.minimax-code/bin/mcode" "$(command -v mcode 2>/dev/null || true)" "$HOME/.local/bin/mcode" "$HOME/.mcode/bin/mcode" "$HOME/.minimax/bin/mcode" /usr/local/bin/mcode';
    const candidates = requiredPath
        ? quoteRemoteShellArg(requiredPath)
        : requiredRelativePath
            ? `"$HOME"/${quoteRemoteShellArg(requiredRelativePath)}`
            : `${quotedConfiguredPath || "''"} ${defaultCandidates}`;
    return [
        `printf '__MCODE_SSH_PROBE_V1__\\n'`,
        `printf 'hostname=%s\\n' "$(hostname 2>/dev/null || true)"`,
        `printf 'remote_user=%s\\n' "$(id -un 2>/dev/null || true)"`,
        `printf 'home_dir=%s\\n' "$HOME"`,
        `mcode_path=''`,
        `for candidate in ${candidates}; do if [ -n "$candidate" ] && [ -x "$candidate" ]; then mcode_path="$candidate"; break; fi; done`,
        `printf 'mcode_path=%s\\n' "$mcode_path"`,
        ...(inspectVersion
            ? [
                `if [ -n "$mcode_path" ]; then mcode_version="$("$mcode_path" --version </dev/null)"; printf 'mcode_version=%s\\n' "$mcode_version"; fi`,
            ]
            : []),
    ].join('; ');
}
