export { LegacyCredentialMigrationReceipt } from './migration/legacy-credential-receipt.js';
export {} from './composition/assemble.js';
export { buildCompatChannelSystemOwner } from './composition/compat-owner.js';
// Pure wire-mapping helpers consumed by application/channel (MR3 A). These are
// value exports of side-effect-free functions only; stores/runners stay private.
export { DEFAULT_PROJECT_KEY, normalizeAbsolutePath, projectKeyForWorkspace, workspaceDirFromProjectKey, } from './delivery/legacy-http/project-key.js';
export { buildAgentDefaultChannelContext } from './binding/default-channel-binding.js';
export { buildLocalChannelBindingKey } from './ingress/channel-inbound-utils.js';
export { normalizePrimaryAgentResolutionConflict } from './binding/family-gate.js';
export { channelModelInvalidReceiptText } from './delivery/channel-im-receipts.js';
export { CHANNEL_CLIENT_UNAVAILABLE } from './host-port.js';
export { LocalChannelClientUnavailableError } from './host-port.js';
export { buildNoChannelCapabilityPort } from './unsupported-port.js';
export { buildHostChannelWireInput } from './composition/host-input.js';
// IM follow-up routing: the host ports the runtime late-binds, and the steer
// producer id the merged-event lookup builds its receipt key from.
export { CHANNEL_STEER_PRODUCER_ID } from './ingress/follow-up/channel-follow-contracts.js';
//# sourceMappingURL=index.js.map