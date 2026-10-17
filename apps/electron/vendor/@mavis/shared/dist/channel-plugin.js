/**
 * ChannelPlugin — multi-channel plugin architecture type definitions.
 *
 * Replaces the BaseChannelPlugin inheritance model with a composition-based
 * adapter pattern. Each channel platform implements ChannelPlugin with
 * 4 required + 6 optional adapters.
 *
 * Design references:
 * - Composition over inheritance (组合优于继承)
 * - Dual-layer separation: channel messages via adapters, complex ops via CLI
 * - OpenClaw ChannelPlugin patterns (flat adapter composition)
 */
export {};
//# sourceMappingURL=channel-plugin.js.map