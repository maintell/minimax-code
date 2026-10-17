/**
 * Channel-domain wire/data contracts for the v2 IM owner.
 *
 * Migration copy (MR1 of the LocalRuntimeV2 IM migration): consolidated from
 * v1 `packages/local-runtime/src/channels/infra.ts` (contract section),
 * `messages/input.ts` (IM-facing message types) and
 * `channels/channel-im-receipts.ts` (receipt metadata types). The v1 sources
 * stay untouched until MR3 removes them; keep both sides field-compatible in
 * the meantime because they describe the same persisted YAML documents and
 * inbound payloads.
 *
 * Everything in this file must stay free of I/O, mutable state and transport
 * (Request/Response) types so every channel-system directory can depend on it.
 */
/**
 * Single source of truth for the local-runtime IM slash commands. The parser
 * allowlist, the `LocalChannelSlashCommandName` union and the slash-command
 * dispatch registry all derive from this constant so a new command is added in
 * exactly one place. `/pin` is intentionally NOT listed — the slash command
 * was retired (see knowledge/proposals/im-slash-compact-command.md §2.1). The
 * historical `bindingStore.pin()` storage API and `SessionStrategy='pin'`
 * value remain only to read old data; routing treats them as the normal Root
 * strategy.
 *
 * `/btw` is intentionally hidden this iteration — it is NOT a supported
 * command for now. The parser therefore treats `/btw …` as an ordinary message
 * (returns undefined → normal enqueue → LLM), same as retired `/pin`.
 */
export const LOCAL_CHANNEL_SLASH_COMMANDS = ['new', 'clear', 'stop', 'compact'];
//# sourceMappingURL=channel-contracts.js.map