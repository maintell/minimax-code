/**
 * System-reminder injected dependencies.
 *
 * The block assembly logic (registry / providers / blocks / service) lives in
 * this package and produces a `<system-reminder>` text block from a
 * `SystemReminderInput` payload. The host owns the IO-heavy data collection
 * (reading stores, scanning filesystem) and the cross-cutting runtime
 * collaborators (logger, request context, config, date formatting); it supplies
 * them through the small interfaces defined here.
 *
 *   - {@link DataCollector}: satisfied by the host's data collector. The
 *     service calls it once per `buildReminder` to gather the IO-heavy payload.
 *   - {@link NudgeRegistry}: satisfied by the host's nudge registry. The
 *     `boardNudgeProvider` reads + clears a pending nudge for the session.
 *   - {@link Logger} / {@link LogContext}: the host logging surface, injected
 *     so this package never imports a runtime logger.
 *   - {@link ReminderConfig}: the small config slice the service reads.
 *   - {@link DateFormatter}: host-local date formatting (timezone owned by host).
 *
 * No runtime fallback is exposed: dependencies are passed in directly via
 * constructor arguments or setters, so a missing wiring fails loudly at the
 * call site instead of silently no-opping. Hosts satisfy these shapes
 * structurally — no `implements` declaration required.
 */
export {};
//# sourceMappingURL=dependencies.js.map