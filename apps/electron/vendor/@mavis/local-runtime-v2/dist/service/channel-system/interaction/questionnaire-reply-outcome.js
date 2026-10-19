/**
 * Channel-facing questionnaire reply settle contract.
 *
 * Migration copy (MR1) of v1 `questionnaire/reply-outcome.ts`, reduced to the
 * outcome union: the contract adapters consume via `settleQuestionnaireReply`.
 * The v1 error classifier was NOT migrated — classification happens on the
 * side that owns the questionnaire service (v1 `questionnaire/reply-outcome.ts`
 * / tui), and the channel side only ever receives the settled outcome.
 */
export {};
//# sourceMappingURL=questionnaire-reply-outcome.js.map