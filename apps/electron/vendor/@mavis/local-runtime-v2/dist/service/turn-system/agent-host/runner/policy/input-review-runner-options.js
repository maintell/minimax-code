import { digestSafetyInput } from '../../../../content-safety/index.js';
/** Restricts input review to committed visible queries and isolates detached observers. */
export function inputReviewRunnerOptions(input, observe) {
    if (input.request.requiresInputReview !== true)
        return {};
    const userInput = input.canonicalUserInput.text;
    return {
        reviewUserInput: userInput,
        inputSafetyDigest: digestSafetyInput(input.request.input),
        ...(input.request.inputSafetyDecision
            ? { inputSafetyDecision: input.request.inputSafetyDecision }
            : {}),
        ...(observe
            ? {
                onInputReviewResolved: (rejected) => {
                    try {
                        observe({
                            sessionId: input.lease.sessionId,
                            turnId: input.lease.turnId,
                            userInput,
                            rejected,
                        });
                    }
                    catch {
                        // Detached title/observation work cannot change the owning Turn verdict.
                    }
                },
            }
            : {}),
    };
}
//# sourceMappingURL=input-review-runner-options.js.map