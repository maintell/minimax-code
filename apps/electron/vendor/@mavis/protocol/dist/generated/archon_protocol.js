/* eslint-disable */
// AUTO-GENERATED from weaver/idl/matrix/archon_server/archon_protocol.thrift via
// @creditkarma/thrift-typescript. Do NOT edit by hand. Run `pnpm gen:ts` in
// packages/protocol to regenerate.
//
// Enums follow thrift-typescript convention (numeric `enum`). Structs are
// emitted as plain TS interfaces (IXxx). Wire format is JSON of these shapes,
// so enum values land on the wire as numbers and `map<K,V>` lands as a JSON
// object (Record<K,V>).
export var InstalledPluginSource;
(function (InstalledPluginSource) {
    InstalledPluginSource[InstalledPluginSource["OFFICIAL"] = 1] = "OFFICIAL";
    InstalledPluginSource[InstalledPluginSource["LOCAL"] = 2] = "LOCAL";
})(InstalledPluginSource || (InstalledPluginSource = {}));
export var PluginCapabilityType;
(function (PluginCapabilityType) {
    PluginCapabilityType[PluginCapabilityType["APP"] = 1] = "APP";
    PluginCapabilityType[PluginCapabilityType["MCP"] = 2] = "MCP";
    PluginCapabilityType[PluginCapabilityType["SKILL"] = 3] = "SKILL";
})(PluginCapabilityType || (PluginCapabilityType = {}));
export var ProtocolErrorCode;
(function (ProtocolErrorCode) {
    ProtocolErrorCode[ProtocolErrorCode["INVALID_REQUEST"] = 1] = "INVALID_REQUEST";
    ProtocolErrorCode[ProtocolErrorCode["NOT_FOUND"] = 2] = "NOT_FOUND";
    ProtocolErrorCode[ProtocolErrorCode["PERMISSION_DENIED"] = 3] = "PERMISSION_DENIED";
    ProtocolErrorCode[ProtocolErrorCode["CONFLICT"] = 4] = "CONFLICT";
    ProtocolErrorCode[ProtocolErrorCode["TIMEOUT"] = 5] = "TIMEOUT";
    ProtocolErrorCode[ProtocolErrorCode["ABORTED"] = 6] = "ABORTED";
    ProtocolErrorCode[ProtocolErrorCode["RUNTIME_UNAVAILABLE"] = 7] = "RUNTIME_UNAVAILABLE";
    ProtocolErrorCode[ProtocolErrorCode["INTERNAL"] = 8] = "INTERNAL";
    ProtocolErrorCode[ProtocolErrorCode["USAGE_LIMIT_EXCEEDED"] = 42212] = "USAGE_LIMIT_EXCEEDED";
    ProtocolErrorCode[ProtocolErrorCode["INTERNAL_ERROR"] = 50001] = "INTERNAL_ERROR";
    ProtocolErrorCode[ProtocolErrorCode["LLM_CREDITS_EXHAUSTED"] = 50110] = "LLM_CREDITS_EXHAUSTED";
    ProtocolErrorCode[ProtocolErrorCode["LLM_RATE_LIMITED"] = 50111] = "LLM_RATE_LIMITED";
    ProtocolErrorCode[ProtocolErrorCode["LLM_AUTH_ERROR"] = 50112] = "LLM_AUTH_ERROR";
    ProtocolErrorCode[ProtocolErrorCode["LLM_UPSTREAM_ERROR"] = 50113] = "LLM_UPSTREAM_ERROR";
    ProtocolErrorCode[ProtocolErrorCode["LLM_MIGRATION_ERROR"] = 50114] = "LLM_MIGRATION_ERROR";
    ProtocolErrorCode[ProtocolErrorCode["SAFETY_UNAVAILABLE"] = 50200] = "SAFETY_UNAVAILABLE";
    ProtocolErrorCode[ProtocolErrorCode["SAFETY_SENSITIVE"] = 50201] = "SAFETY_SENSITIVE";
    ProtocolErrorCode[ProtocolErrorCode["CORRUPTED_THINKING"] = 60001] = "CORRUPTED_THINKING";
})(ProtocolErrorCode || (ProtocolErrorCode = {}));
export var PermissionPolicyType;
(function (PermissionPolicyType) {
    PermissionPolicyType[PermissionPolicyType["ALWAYS_ALLOW"] = 1] = "ALWAYS_ALLOW";
    PermissionPolicyType[PermissionPolicyType["ALWAYS_ASK"] = 2] = "ALWAYS_ASK";
    PermissionPolicyType[PermissionPolicyType["DENY"] = 3] = "DENY";
})(PermissionPolicyType || (PermissionPolicyType = {}));
export var ThinkingLevel;
(function (ThinkingLevel) {
    ThinkingLevel[ThinkingLevel["OFF"] = 1] = "OFF";
    ThinkingLevel[ThinkingLevel["MINIMAL"] = 2] = "MINIMAL";
    ThinkingLevel[ThinkingLevel["LOW"] = 3] = "LOW";
    ThinkingLevel[ThinkingLevel["MEDIUM"] = 4] = "MEDIUM";
    ThinkingLevel[ThinkingLevel["HIGH"] = 5] = "HIGH";
    ThinkingLevel[ThinkingLevel["XHIGH"] = 6] = "XHIGH";
})(ThinkingLevel || (ThinkingLevel = {}));
export var ThinkingMode;
(function (ThinkingMode) {
    ThinkingMode[ThinkingMode["SWITCHABLE"] = 1] = "SWITCHABLE";
    ThinkingMode[ThinkingMode["FORCED_ON"] = 2] = "FORCED_ON";
})(ThinkingMode || (ThinkingMode = {}));
export var HookEvent;
(function (HookEvent) {
    HookEvent[HookEvent["SESSION_START"] = 1] = "SESSION_START";
    HookEvent[HookEvent["SESSION_END"] = 2] = "SESSION_END";
    HookEvent[HookEvent["USER_PROMPT_SUBMIT"] = 3] = "USER_PROMPT_SUBMIT";
    HookEvent[HookEvent["PRE_TOOL_USE"] = 4] = "PRE_TOOL_USE";
    HookEvent[HookEvent["POST_TOOL_USE"] = 5] = "POST_TOOL_USE";
    HookEvent[HookEvent["MESSAGE_COMPLETE"] = 6] = "MESSAGE_COMPLETE";
    HookEvent[HookEvent["STREAM_CHUNK"] = 7] = "STREAM_CHUNK";
    HookEvent[HookEvent["STREAM_CHUNK_THRESHOLD"] = 8] = "STREAM_CHUNK_THRESHOLD";
})(HookEvent || (HookEvent = {}));
export var HookType;
(function (HookType) {
    HookType[HookType["SCRIPT"] = 1] = "SCRIPT";
    HookType[HookType["PROMPT"] = 2] = "PROMPT";
})(HookType || (HookType = {}));
export var MemoryScope;
(function (MemoryScope) {
    MemoryScope[MemoryScope["USER"] = 1] = "USER";
    MemoryScope[MemoryScope["AGENT"] = 2] = "AGENT";
    MemoryScope[MemoryScope["SESSION_LEGACY"] = 3] = "SESSION_LEGACY";
})(MemoryScope || (MemoryScope = {}));
export var HostToolCapability;
(function (HostToolCapability) {
    HostToolCapability[HostToolCapability["SHELL"] = 1] = "SHELL";
    HostToolCapability[HostToolCapability["MAVIS_BASE"] = 2] = "MAVIS_BASE";
    HostToolCapability[HostToolCapability["FILE"] = 3] = "FILE";
    HostToolCapability[HostToolCapability["MEMORY"] = 4] = "MEMORY";
    HostToolCapability[HostToolCapability["WEB"] = 5] = "WEB";
    HostToolCapability[HostToolCapability["OTHER"] = 6] = "OTHER";
    HostToolCapability[HostToolCapability["BASE"] = 7] = "BASE";
    HostToolCapability[HostToolCapability["CONNECTOR"] = 8] = "CONNECTOR";
})(HostToolCapability || (HostToolCapability = {}));
export var AttachmentKind;
(function (AttachmentKind) {
    AttachmentKind[AttachmentKind["FILE"] = 0] = "FILE";
    AttachmentKind[AttachmentKind["IMAGE"] = 1] = "IMAGE";
    AttachmentKind[AttachmentKind["VIDEO"] = 2] = "VIDEO";
    AttachmentKind[AttachmentKind["AUDIO"] = 3] = "AUDIO";
})(AttachmentKind || (AttachmentKind = {}));
export var RuntimeActionType;
(function (RuntimeActionType) {
    RuntimeActionType[RuntimeActionType["PERMISSION"] = 1] = "PERMISSION";
    RuntimeActionType[RuntimeActionType["USER_QUESTION"] = 2] = "USER_QUESTION";
})(RuntimeActionType || (RuntimeActionType = {}));
export var RuntimeStopReasonType;
(function (RuntimeStopReasonType) {
    RuntimeStopReasonType[RuntimeStopReasonType["END_TURN"] = 1] = "END_TURN";
    RuntimeStopReasonType[RuntimeStopReasonType["REQUIRES_ACTION"] = 2] = "REQUIRES_ACTION";
    RuntimeStopReasonType[RuntimeStopReasonType["ERROR"] = 3] = "ERROR";
    RuntimeStopReasonType[RuntimeStopReasonType["ABORT"] = 4] = "ABORT";
})(RuntimeStopReasonType || (RuntimeStopReasonType = {}));
export var RuntimeEventStatus;
(function (RuntimeEventStatus) {
    RuntimeEventStatus[RuntimeEventStatus["RUNNING"] = 1] = "RUNNING";
    RuntimeEventStatus[RuntimeEventStatus["WAITING_ACTION"] = 2] = "WAITING_ACTION";
    RuntimeEventStatus[RuntimeEventStatus["IDLE"] = 3] = "IDLE";
    RuntimeEventStatus[RuntimeEventStatus["FAILED"] = 4] = "FAILED";
    RuntimeEventStatus[RuntimeEventStatus["ABORTED"] = 5] = "ABORTED";
    RuntimeEventStatus[RuntimeEventStatus["COMPLETED"] = 6] = "COMPLETED";
})(RuntimeEventStatus || (RuntimeEventStatus = {}));
export var RuntimeEventType;
(function (RuntimeEventType) {
    RuntimeEventType[RuntimeEventType["STREAM_RESP"] = 1] = "STREAM_RESP";
    RuntimeEventType[RuntimeEventType["ACTION_REQUIRED"] = 2] = "ACTION_REQUIRED";
    RuntimeEventType[RuntimeEventType["SESSION_STATUS"] = 3] = "SESSION_STATUS";
    RuntimeEventType[RuntimeEventType["TURN_TERMINAL"] = 4] = "TURN_TERMINAL";
    RuntimeEventType[RuntimeEventType["DEBUG_TRACE"] = 5] = "DEBUG_TRACE";
    RuntimeEventType[RuntimeEventType["MESSAGE_PERSISTED"] = 6] = "MESSAGE_PERSISTED";
})(RuntimeEventType || (RuntimeEventType = {}));
export var RuntimeDebugTraceLevel;
(function (RuntimeDebugTraceLevel) {
    RuntimeDebugTraceLevel[RuntimeDebugTraceLevel["DEBUG"] = 1] = "DEBUG";
    RuntimeDebugTraceLevel[RuntimeDebugTraceLevel["INFO"] = 2] = "INFO";
    RuntimeDebugTraceLevel[RuntimeDebugTraceLevel["WARN"] = 3] = "WARN";
    RuntimeDebugTraceLevel[RuntimeDebugTraceLevel["ERROR"] = 4] = "ERROR";
})(RuntimeDebugTraceLevel || (RuntimeDebugTraceLevel = {}));
export var HarnessControlMode;
(function (HarnessControlMode) {
    HarnessControlMode[HarnessControlMode["START"] = 1] = "START";
    HarnessControlMode[HarnessControlMode["ABORT"] = 2] = "ABORT";
    HarnessControlMode[HarnessControlMode["RESOLVE_ACTION"] = 3] = "RESOLVE_ACTION";
    HarnessControlMode[HarnessControlMode["REWIND"] = 4] = "REWIND";
    HarnessControlMode[HarnessControlMode["INJECT"] = 5] = "INJECT";
    HarnessControlMode[HarnessControlMode["START_TRANSFER"] = 6] = "START_TRANSFER";
})(HarnessControlMode || (HarnessControlMode = {}));
export var AgentToolMode;
(function (AgentToolMode) {
    AgentToolMode[AgentToolMode["OMIT"] = 1] = "OMIT";
    AgentToolMode[AgentToolMode["INLINE"] = 2] = "INLINE";
    AgentToolMode[AgentToolMode["TOOL_SEARCH"] = 3] = "TOOL_SEARCH";
})(AgentToolMode || (AgentToolMode = {}));
export var SystemReminderFrequencyType;
(function (SystemReminderFrequencyType) {
    SystemReminderFrequencyType[SystemReminderFrequencyType["FIRST_TURN_ONLY"] = 1] = "FIRST_TURN_ONLY";
    SystemReminderFrequencyType[SystemReminderFrequencyType["EVERY_TURN"] = 2] = "EVERY_TURN";
    SystemReminderFrequencyType[SystemReminderFrequencyType["TURN_BACKOFF"] = 3] = "TURN_BACKOFF";
    SystemReminderFrequencyType[SystemReminderFrequencyType["COOLDOWN"] = 4] = "COOLDOWN";
    SystemReminderFrequencyType[SystemReminderFrequencyType["ONE_SHOT"] = 5] = "ONE_SHOT";
})(SystemReminderFrequencyType || (SystemReminderFrequencyType = {}));
export var CommunicateSource;
(function (CommunicateSource) {
    CommunicateSource[CommunicateSource["ToolCall"] = 1] = "ToolCall";
    CommunicateSource[CommunicateSource["TeamEngine"] = 2] = "TeamEngine";
})(CommunicateSource || (CommunicateSource = {}));
export var HarnessSessionTransferPurpose;
(function (HarnessSessionTransferPurpose) {
    HarnessSessionTransferPurpose[HarnessSessionTransferPurpose["DISPATCH_WORKSPACE_UPLOAD"] = 1] = "DISPATCH_WORKSPACE_UPLOAD";
    HarnessSessionTransferPurpose[HarnessSessionTransferPurpose["CHANGE_SET_DOWNLOAD"] = 2] = "CHANGE_SET_DOWNLOAD";
})(HarnessSessionTransferPurpose || (HarnessSessionTransferPurpose = {}));
export var SafetyCheckVersion;
(function (SafetyCheckVersion) {
    SafetyCheckVersion[SafetyCheckVersion["V1"] = 1] = "V1";
    SafetyCheckVersion[SafetyCheckVersion["V2"] = 2] = "V2";
})(SafetyCheckVersion || (SafetyCheckVersion = {}));
export var RespDataType;
(function (RespDataType) {
    RespDataType[RespDataType["AGENT_MESSAGE"] = 2] = "AGENT_MESSAGE";
    RespDataType[RespDataType["AGENT_MESSAGE_CHUNK"] = 6] = "AGENT_MESSAGE_CHUNK";
    RespDataType[RespDataType["HEARTBEAT"] = 10] = "HEARTBEAT";
})(RespDataType || (RespDataType = {}));
export var ToolCallStatus;
(function (ToolCallStatus) {
    ToolCallStatus[ToolCallStatus["START"] = 1] = "START";
    ToolCallStatus[ToolCallStatus["FINISHED"] = 2] = "FINISHED";
    ToolCallStatus[ToolCallStatus["FAILED"] = 3] = "FAILED";
})(ToolCallStatus || (ToolCallStatus = {}));
export var MsgType;
(function (MsgType) {
    MsgType[MsgType["AGENT_CONTENT"] = 1] = "AGENT_CONTENT";
    MsgType[MsgType["AGENT_TOOL_CALL"] = 2] = "AGENT_TOOL_CALL";
    MsgType[MsgType["SYSTEM_EVENT"] = 3] = "SYSTEM_EVENT";
})(MsgType || (MsgType = {}));
//# sourceMappingURL=archon_protocol.js.map