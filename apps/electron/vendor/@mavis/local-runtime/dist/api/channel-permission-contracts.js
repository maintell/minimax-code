/**
 * Channel permission wire contracts (IM MR3).
 *
 * Pure types shared between the v1 permission business (approval service,
 * permission routes, reply matching) and the Channel owner living in Local
 * Runtime V2. They moved out of `channels/permission-bridge.ts` when the v1
 * package stopped containing an IM implementation; the SHAPES are frozen —
 * the v2 permission bridge consumes events of exactly this form through the
 * `HostChannelSubsystemPort.permissionOutbound` seam.
 */
export {};
//# sourceMappingURL=channel-permission-contracts.js.map