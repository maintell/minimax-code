// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import { SandboxActivation, SandboxBackend, SandboxFilesystemMode, SandboxLocalAccess, SandboxNetworkMode, SandboxState, SandboxViolationOperation, SandboxViolationSource, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { isSandboxError, } from '../../service/sandbox/index.js';
import { AppError } from '../errors.js';
import { SandboxControllerBase } from '../generated/sandbox-controller-base.gen.js';
const DEFAULT_VIOLATION_LIMIT = 50;
const MAX_VIOLATION_LIMIT = 100;
const UNATTRIBUTED = 'unattributed';
export class SandboxController extends SandboxControllerBase {
    service;
    constructor(service) {
        super();
        this.service = service;
    }
    async getSandboxStatus(ctx, req) {
        void ctx;
        void req;
        return { status: toContractStatus(this.service.status()) };
    }
    async putSandboxConfig(ctx, req) {
        void ctx;
        const result = await runSandboxOperation(() => this.service.applyConfig(toProductConfig(req.config)));
        return { result: toContractApplyResult(result) };
    }
    async getSandboxViolations(ctx, req) {
        void ctx;
        const afterSequence = parseViolationCursor(req.cursor);
        const limit = normalizeViolationLimit(req.limit);
        const remaining = this.service
            .violations()
            .filter((violation) => violation.sequence > afterSequence);
        const page = remaining.slice(0, limit);
        const hasMore = remaining.length > page.length;
        const lastViolation = hasMore ? page.at(-1) : undefined;
        return {
            violations: page.map(toContractViolation),
            hasMore,
            ...(lastViolation ? { nextCursor: violationCursor(lastViolation.sequence) } : {}),
        };
    }
}
function toProductConfig(config) {
    return {
        enabled: config.enabled,
        filesystem: {
            policy: { mode: toFilesystemMode(config.filesystem.policy.mode) },
            denyRead: [...config.filesystem.denyRead],
            denyWrite: [...config.filesystem.denyWrite],
        },
        network: {
            policy: { mode: toNetworkMode(config.network.policy.mode) },
            deniedDomains: [...config.network.deniedDomains],
        },
        localAccess: toLocalAccess(config.localAccess),
    };
}
function toFilesystemMode(mode) {
    switch (mode) {
        case SandboxFilesystemMode.READ_ONLY:
            return 'read_only';
        case SandboxFilesystemMode.WORKSPACE_WRITE:
            return 'workspace_write';
        case SandboxFilesystemMode.DELETE_GUARD:
            return 'delete_guard';
        case SandboxFilesystemMode.FULL_ACCESS:
            return 'full_access';
        default:
            throw invalidConfig('config.filesystem.policy.mode');
    }
}
function toNetworkMode(mode) {
    switch (mode) {
        case SandboxNetworkMode.DENY:
            return 'deny';
        case SandboxNetworkMode.ALLOW_ALL:
            return 'allow_all';
        default:
            throw invalidConfig('config.network.policy.mode');
    }
}
function toLocalAccess(localAccess) {
    switch (localAccess) {
        case SandboxLocalAccess.OPEN:
            return 'open';
        case SandboxLocalAccess.RESTRICTED:
            return 'restricted';
        default:
            throw invalidConfig('config.localAccess');
    }
}
function toContractStatus(status) {
    return {
        surface: status.surface,
        state: toSandboxState(status.state),
        effectiveGeneration: status.effectiveGeneration,
        activeInvocations: status.activeInvocations,
        retiringInvocations: status.retiringInvocations,
        ...toContractBackendStatus(status),
        ...toContractPolicyStatus(status),
    };
}
function toContractBackendStatus(status) {
    return {
        ...(status.desiredBackend ? { desiredBackend: SandboxBackend.SRT_MACOS } : {}),
        ...(status.effectiveBackend ? { effectiveBackend: SandboxBackend.SRT_MACOS } : {}),
        ...(status.backendVersion ? { backendVersion: status.backendVersion } : {}),
        ...(status.upstreamVersion ? { upstreamVersion: status.upstreamVersion } : {}),
        ...(status.activation ? { activation: toSandboxActivation(status.activation) } : {}),
        ...(status.lastErrorCode ? { lastErrorCode: status.lastErrorCode } : {}),
    };
}
function toContractPolicyStatus(status) {
    return {
        ...(status.filesystemMode ? { filesystemMode: fromFilesystemMode(status.filesystemMode) } : {}),
        ...(status.networkMode ? { networkMode: fromNetworkMode(status.networkMode) } : {}),
        ...(status.localAccess ? { localAccess: fromLocalAccess(status.localAccess) } : {}),
        ...(status.deniedDomainRuleCount === undefined
            ? {}
            : { deniedDomainRuleCount: status.deniedDomainRuleCount }),
        ...(status.denyReadRuleCount === undefined
            ? {}
            : { denyReadRuleCount: status.denyReadRuleCount }),
    };
}
function toSandboxState(state) {
    return {
        disabled: SandboxState.DISABLED,
        initializing: SandboxState.INITIALIZING,
        ready: SandboxState.READY,
        failed: SandboxState.FAILED,
        closing: SandboxState.CLOSING,
        closed: SandboxState.CLOSED,
    }[state];
}
function toSandboxActivation(activation) {
    return {
        'applied-next-invocation': SandboxActivation.APPLIED_NEXT_INVOCATION,
        'applied-at-wrap': SandboxActivation.APPLIED_AT_WRAP,
        'applied-live-global': SandboxActivation.APPLIED_LIVE_GLOBAL,
        initialized: SandboxActivation.INITIALIZED,
        'disabled-retiring': SandboxActivation.DISABLED_RETIRING,
    }[activation];
}
function fromFilesystemMode(mode) {
    return {
        read_only: SandboxFilesystemMode.READ_ONLY,
        workspace_write: SandboxFilesystemMode.WORKSPACE_WRITE,
        delete_guard: SandboxFilesystemMode.DELETE_GUARD,
        full_access: SandboxFilesystemMode.FULL_ACCESS,
    }[mode];
}
function fromNetworkMode(mode) {
    return mode === 'deny' ? SandboxNetworkMode.DENY : SandboxNetworkMode.ALLOW_ALL;
}
function fromLocalAccess(access) {
    return access === 'restricted' ? SandboxLocalAccess.RESTRICTED : SandboxLocalAccess.OPEN;
}
function toContractApplyResult(result) {
    return {
        effectiveGeneration: result.effectiveGeneration,
        activation: toSandboxActivation(result.activation),
        changedFields: [...result.changedFields],
    };
}
function toContractViolation(violation) {
    return {
        violationId: violationCursor(violation.sequence),
        occurredAtMs: violation.timestampMs,
        invocationId: violation.invocationId ?? UNATTRIBUTED,
        sessionId: violation.sessionId ?? UNATTRIBUTED,
        turnId: violation.turnId ?? UNATTRIBUTED,
        ...(violation.toolCallId ? { toolCallId: violation.toolCallId } : {}),
        ...(violation.taskId ? { taskId: violation.taskId } : {}),
        effectiveGeneration: violation.effectiveGeneration ?? 0,
        operation: toViolationOperation(violation.operation),
        source: toViolationSource(violation.source),
        targetCategory: violation.target,
        ...(violation.withinInvocationRoots === undefined
            ? {}
            : { targetWithinInvocationRoots: violation.withinInvocationRoots }),
    };
}
function toViolationOperation(operation) {
    switch (operation) {
        case 'read_denied':
            return SandboxViolationOperation.READ_DENIED;
        case 'write_denied':
            return SandboxViolationOperation.WRITE_DENIED;
        case 'delete_denied':
            return SandboxViolationOperation.DELETE_DENIED;
        case 'network_denied':
            return SandboxViolationOperation.NETWORK_DENIED;
        default:
            return SandboxViolationOperation.SANDBOX_VIOLATION_OPERATION_UNSPECIFIED;
    }
}
function toViolationSource(source) {
    if (source === 'profile')
        return SandboxViolationSource.SEATBELT;
    if (source === 'proxy')
        return SandboxViolationSource.NETWORK_PROXY;
    return SandboxViolationSource.CONTROL_PLANE;
}
function normalizeViolationLimit(limit) {
    if (limit === undefined)
        return DEFAULT_VIOLATION_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_VIOLATION_LIMIT) {
        throw new AppError(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_VIOLATION_LIMIT}`);
    }
    return limit;
}
function parseViolationCursor(cursor) {
    if (cursor === undefined)
        return 0;
    const match = /^sbv_(\d+)$/.exec(cursor);
    const sequence = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'cursor is invalid');
    }
    return sequence;
}
function violationCursor(sequence) {
    return `sbv_${sequence}`;
}
function invalidConfig(field) {
    return new AppError(400, 'SANDBOX_CONFIG_INVALID', `${field} is invalid`);
}
async function runSandboxOperation(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (!isSandboxError(error))
            throw error;
        throw new AppError(sandboxErrorHttpStatus(error.code), error.code, error.message);
    }
}
function sandboxErrorHttpStatus(code) {
    if (code === 'SANDBOX_CONFIG_INVALID')
        return 400;
    if (code === 'SANDBOX_RESTART_REQUIRED')
        return 409;
    return 503;
}
//# sourceMappingURL=sandbox.controller.js.map