import { sshExecution } from "./ssh-execution.js";
import { SshRuntimeError, sshFailureDetails, sshOperationStatus, classifySshFailure } from "./errors.js";
import { resolveSshRuntimeEnvironment, buildSshCliSetupSpawnSpec } from "./ssh-command.js";
import { usesSshTestInstaller, readSshTestInstaller } from "./test-cli-installer.js";
import { resolveSshCliInstallTarget } from "./cli-install-target.js";
import { probeSshHost } from "./host-probe.js";
import { SshAppServerClient } from "./app-server-client.js";
import { startSshDiagnostic } from "./diagnostics.js";
const CLI_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const defaults = {
    resolveTarget: resolveSshCliInstallTarget,
    probe: probeSshHost,
    verify: async (connection, probe, _target, diagnostics) => {
        if (!probe.mcodePath || !probe.homeDir)
            throw new Error('Missing verified CLI path.');
        const client = new SshAppServerClient({
            target: {
                kind: 'ssh',
                host: connection.alias,
                endpoint: connection.endpoint,
                workspaceDir: probe.homeDir,
                mcodePath: probe.mcodePath,
            },
            clientVersion: (await import('electron')).app.getVersion(),
            initializeTimeoutMs: 60000,
            diagnosticId: diagnostics?.id,
        });
        try {
            const result = await client.start();
            if (!result.hostIdentity)
                throw new Error('Remote service identity is missing.');
            return result.hostIdentity.version;
        }
        finally {
            await client.stop();
        }
    },
};
/** Install the environment's MCode package, then verify its actual CLI and protocol. */
export async function setupRemoteMcodeCli(connection, runCommand, options = {}, dependencies = defaults) {
    let stage = 'configuration';
    let probe;
    const diagnostics = startSshDiagnostic('cli-setup', { alias: connection.alias });
    const finish = (result) => {
        diagnostics.record('result', {
            stage,
            success: result.success,
            error: result.success ? undefined : result.error,
            probeStatus: probe?.status,
            mcodeVersion: probe?.mcodeVersion,
            mcodePath: probe?.mcodePath,
        });
        return result;
    };
    try {
        // Discover before choosing an install target. Authentication/probe failures
        // must never trigger a fresh install in the default directory.
        probe = await dependencies.probe(connection, {
            ...options,
            diagnostics,
            requiredMcodePath: connection.mcodePath,
        });
        if (probe.status !== 'ready' && probe.status !== 'cli_missing') {
            return finish({
                success: false,
                error: probe.status === 'unreachable'
                    ? 'host_unreachable'
                    : probe.status === 'probe_failed'
                        ? 'install_failed'
                        : probe.status,
                stage,
                probe,
            });
        }
        const existingMcodePath = probe.mcodePath ?? connection.mcodePath;
        const environment = resolveSshRuntimeEnvironment();
        const testInstaller = usesSshTestInstaller(environment.buildEnv)
            ? readSshTestInstaller()
            : null;
        const target = testInstaller ? null : await dependencies.resolveTarget();
        const expectedVersion = target?.version;
        diagnostics.record('installer.selected', {
            buildEnv: environment.buildEnv,
            region: environment.region,
            source: testInstaller ? 'bundled-test' : target ? 'pinned-release' : 'official',
            expectedVersion,
            packageTag: testInstaller?.packageTag,
            remoteLogPath: testInstaller ? '$HOME/.minimax-code-test-logs/latest.log' : undefined,
        });
        const makeSpec = (ready) => buildSshCliSetupSpawnSpec(connection.endpoint, target, environment, diagnostics.id, ready, existingMcodePath);
        const spec = makeSpec();
        stage = 'install';
        diagnostics.record('install.started');
        const output = runCommand
            ? await runCommand(spec.command, spec.args, spec.input)
            : await sshExecution.run(connection.endpoint, (ready) => makeSpec(ready).args.at(-1), {
                timeoutMs: CLI_SETUP_TIMEOUT_MS,
                maxOutputBytes: 2 * 1024 * 1024,
                ...options,
                input: spec.input,
                diagnostics,
                captureDiagnosticOutput: true,
            });
        diagnostics.record('install.completed', { ...output });
        stage = 'verify';
        diagnostics.record('verify.started');
        options.onVerifying?.();
        probe = await dependencies.probe(connection, {
            ...(existingMcodePath
                ? { requiredMcodePath: existingMcodePath }
                : { requiredMcodeRelativePath: target?.launcherRelativePath ?? '.minimax-code/bin/mcode' }),
            inspectVersion: true,
            timeoutMs: 15000,
            diagnostics,
        });
        if (probe.status !== 'ready') {
            const error = probe.cliFailureReason ??
                (probe.status === 'unreachable'
                    ? 'host_unreachable'
                    : probe.status === 'probe_failed'
                        ? 'install_failed'
                        : probe.status);
            return finish({
                success: false,
                error,
                stage,
                probe,
                ...(probe.failureDetails ? { details: probe.failureDetails } : {}),
            });
        }
        diagnostics.record('handshake.started');
        const servingVersion = await dependencies.verify(connection, probe, target, diagnostics);
        diagnostics.record('handshake.completed', { servingVersion });
        if ((probe.mcodeVersion ?? expectedVersion) &&
            servingVersion !== (probe.mcodeVersion ?? expectedVersion)) {
            return finish({ success: false, error: 'service_version_pending', stage, probe });
        }
        return finish({ success: true, probe });
    }
    catch (error) {
        diagnostics.fail(error, { stage });
        const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
            ? error.stderr
            : '';
        const details = error instanceof SshRuntimeError && error.details
            ? error.details
            : sshFailureDetails('install_failed', {
                sshVerified: stage !== 'configuration',
                stage: stage === 'install' ? 'install' : 'bootstrap',
                stderr,
                mcodePath: probe?.mcodePath,
            });
        if (stderr.includes('MCODE_EXISTING_INSTALL_UNSUPPORTED:'))
            return finish({
                success: false,
                error: 'existing_install_unsupported',
                stage,
                probe,
                details,
            });
        if (stage === 'configuration')
            return finish({ success: false, error: 'installer_unavailable', stage });
        const status = sshOperationStatus(error);
        if (status)
            return finish({ success: false, error: status, stage, probe, details });
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'ENOENT')
            return finish({ success: false, error: 'ssh_not_found', stage, probe });
        if (code === 'app_server_protocol_mismatch')
            return finish({ success: false, error: 'protocol_mismatch', stage, probe, details });
        const commandStarted = error &&
            typeof error === 'object' &&
            'commandStarted' in error &&
            error.commandStarted === true;
        const classified = classifySshFailure(stderr, false, Boolean(commandStarted));
        const mapped = classified.code === 'ssh_auth_failed'
            ? 'auth_failed'
            : classified.code === 'ssh_host_key_untrusted'
                ? 'host_key_untrusted'
                : classified.code === 'ssh_host_unreachable'
                    ? 'host_unreachable'
                    : 'install_failed';
        return finish({
            success: false,
            error: stage === 'verify' && error instanceof SshRuntimeError ? 'cli_start_failed' : mapped,
            stage,
            probe,
            ...(mapped === 'install_failed' ? { details } : {}),
        });
    }
}
