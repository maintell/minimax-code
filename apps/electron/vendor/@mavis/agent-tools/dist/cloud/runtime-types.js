export const BizLine = { Mavis: 1 };
export const SessionType = { Branch: 0, Main: 1 };
export const AgentCreationSource = { Manual: 1, Auto: 2, Builtin: 3 };
export const SessionLifecycleStatus = {
    Idle: 0,
    Started: 1,
    Error: 2,
    Abort: 3,
};
export const ArchiveFilter = { Unarchived: 1, Archived: 2 };
export const DriveNodeType = { Folder: 1, File: 2 };
export const DriveNodeSource = {
    UserUpload: 1,
    AgentDeliverable: 2,
    SystemGenerated: 3,
};
export const DriveNodeStatus = { Pending: 1, Active: 2 };
export const FetchMode = { Default: 0, Deep: 1 };
export const BackgroundTaskKind = {
    Bash: 1,
    Subagent: 2,
    Workflow: 3,
    Custom: 4,
};
export const BackgroundTaskStatus = {
    Queued: 1,
    Running: 2,
    Stopping: 3,
    Succeeded: 4,
    Failed: 5,
    Canceled: 6,
    Lost: 7,
};
export const ShellJobStatus = {
    Running: 1,
    Succeeded: 2,
    Failed: 3,
    Canceled: 4,
    Lost: 5,
};
export const ShellExecutionPolicy = {
    ReusePersistent: 1,
    NewEphemeral: 2,
};
export const SHELL_EXECUTION_POLICY = ShellExecutionPolicy;
export const CommunicateSource = { ToolCall: 1, TeamEngine: 2 };
export const CommunicateDeliveryStatus = {
    Delivered: 1,
    CreateOkPromptFailed: 2,
    CreateFailed: 3,
};
export class OssMediaError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'OssMediaError';
    }
}
export const logger = {
    info: (...args) => console.info(...normalizeLogArgs(args)),
    warn: (...args) => console.warn(...normalizeLogArgs(args)),
    error: (...args) => console.error(...normalizeLogArgs(args)),
    debug: (...args) => console.debug(...normalizeLogArgs(args)),
};
function normalizeLogArgs(args) {
    if (args.length <= 1)
        return args;
    const [first, second, ...rest] = args;
    if (typeof second === 'string')
        return [second, first, ...rest];
    return args;
}
export function backgroundCtx() {
    return {};
}
const DEFAULT_CLOUD_MODEL_LIMITS = {
    contextWindow: 200_000,
    maxTokens: 128_000,
};
export function buildDefaultCloudLLMModelConfig(agentConfig, _input) {
    const modelRef = agentConfig.model;
    const modelId = modelRef.model_id.trim();
    const provider = modelRef.provider.trim();
    const baseUrl = modelRef.base_url?.trim();
    const apiKey = modelRef.api_key?.trim();
    if (!provider)
        throw new Error('ModelRef.provider is required');
    if (!modelId)
        throw new Error('ModelRef.model_id is required');
    if (!baseUrl)
        throw new Error('ModelRef.base_url is required');
    if (!apiKey)
        throw new Error('ModelRef.api_key is required');
    const contextWindow = modelRef.context_window ?? DEFAULT_CLOUD_MODEL_LIMITS.contextWindow;
    const maxTokens = modelRef.max_tokens ?? DEFAULT_CLOUD_MODEL_LIMITS.maxTokens;
    return Promise.resolve({
        model: {
            id: modelId,
            name: modelId,
            api: 'anthropic-messages',
            provider,
            baseUrl,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens,
        },
        apiKey,
        maxTokens,
    });
}
//# sourceMappingURL=runtime-types.js.map