/**
 * Initial visible async panel duration. The client owns its pausable timer.
 */
export const ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS = 60;
/**
 * How long a Goal question waits (Goal mode with the `skip` policy) before the
 * runtime answers it with each question's recommended option. 60 s matches the
 * async panel countdown above and is shorter than the 5 min deadline of legacy
 * Goal questionnaires, so a Goal stops for at most one minute per question.
 */
export const GOAL_SKIP_AUTO_SELECT_MS = ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS * 1_000;
//# sourceMappingURL=contracts.js.map