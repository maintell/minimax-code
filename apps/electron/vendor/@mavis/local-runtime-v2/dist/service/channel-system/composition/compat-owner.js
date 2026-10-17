import { assembleChannelSystemOwner } from './assemble.js';
export function buildCompatChannelSystemOwner(input) {
    if (input.enableChannel && !input.channelWire) {
        throw new Error('ASSEMBLY_ERROR: channel capability is enabled but the v1 host supplied no channelWire bundle');
    }
    if (!input.enableChannel || !input.channelWire)
        return undefined;
    const wire = input.channelWire();
    // The v1 bundle types conversation as optional (a standalone v1 host may
    // have none), but the v2 owner cannot execute channel turns without the
    // ingress view — fail the assembly loudly instead of constructing a deaf
    // subsystem.
    const conversation = wire.conversation;
    if (!conversation) {
        throw new Error('ASSEMBLY_ERROR: the channel wire bundle carries no runtime conversation view');
    }
    // MR3: the v1 bundle is purely capability closures + primitives (the v1
    // store/infra/runner override seams were deleted with the v1
    // implementation), so it flows into the v2 wire unchanged.
    return assembleChannelSystemOwner({
        messages: input.messages,
        sessions: input.sessions,
        wire: { ...wire, conversation, deferChannelStartup: true },
    });
}
//# sourceMappingURL=compat-owner.js.map