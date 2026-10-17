import { buildToolTrimCandidate } from './history-reduction.js';
/**
 * A thresholded ToolResult candidate has already passed the shared byte
 * watermark and minimum-savings policy. Admission only verifies the measured
 * Provider footprint and final request limits; it does not reuse the legacy
 * destructive trim's 30% ratio.
 */
export async function evaluateToolResultCompactionAdmission(input) {
    validateLimits(input.limits);
    const measurement = await input.measurePair({
        beforeMessages: input.h0,
        afterMessages: input.candidate.messages,
    });
    validateFootprint(measurement.before, 'before');
    validateFootprint(measurement.after, 'after');
    if (measurement.after.inputTokens >= measurement.before.inputTokens &&
        measurement.after.serializedBytes >= measurement.before.serializedBytes) {
        return { admitted: false, reason: 'no_reduction', candidate: input.candidate, measurement };
    }
    if (measurement.after.inputTokens > input.limits.providerInputLimit) {
        return { admitted: false, reason: 'token_fit', candidate: input.candidate, measurement };
    }
    if (!fitsSerializedBytes(measurement, input.limits.maxSerializedInputBytes)) {
        return {
            admitted: false,
            reason: 'serialized_byte_fit',
            candidate: input.candidate,
            measurement,
        };
    }
    return { admitted: true, candidate: input.candidate, measurement };
}
export async function evaluateToolTrimAdmission(input) {
    validateLimits(input.limits);
    const candidate = input.candidate ?? buildToolTrimCandidate(input.h0);
    if (candidate.trimmedResultCount === 0) {
        return { admitted: false, reason: 'no_candidate', candidate };
    }
    const measurement = await input.measurePair({
        beforeMessages: input.h0,
        afterMessages: candidate.messages,
    });
    validateFootprint(measurement.before, 'before');
    validateFootprint(measurement.after, 'after');
    if (!passesReductionGate(measurement)) {
        return { admitted: false, reason: 'insufficient_reduction', candidate, measurement };
    }
    if (measurement.after.inputTokens > input.limits.providerInputLimit) {
        return { admitted: false, reason: 'token_fit', candidate, measurement };
    }
    if (!fitsSerializedBytes(measurement, input.limits.maxSerializedInputBytes)) {
        return { admitted: false, reason: 'serialized_byte_fit', candidate, measurement };
    }
    return { admitted: true, candidate, measurement };
}
const MAX_RETAINED_CONTEXT_PERCENT = 30n;
function passesReductionGate(measurement) {
    return (measurement.before.inputTokens > 0 &&
        BigInt(measurement.after.inputTokens) * 100n <=
            BigInt(measurement.before.inputTokens) * MAX_RETAINED_CONTEXT_PERCENT);
}
function validateLimits(limits) {
    validatePositiveSafeInteger(limits.providerInputLimit, 'providerInputLimit');
    if (limits.maxSerializedInputBytes !== undefined) {
        validatePositiveSafeInteger(limits.maxSerializedInputBytes, 'maxSerializedInputBytes');
    }
}
function fitsSerializedBytes(measurement, explicitLimit) {
    return measurement.after.serializedBytes <= (explicitLimit ?? measurement.before.serializedBytes);
}
function validateFootprint(footprint, side) {
    validateNonNegativeSafeInteger(footprint.inputTokens, `${side}.inputTokens`);
    validateNonNegativeSafeInteger(footprint.serializedBytes, `${side}.serializedBytes`);
}
function validateNonNegativeSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Tool trim admission ${field} must be a non-negative safe integer.`);
    }
}
function validatePositiveSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Tool trim admission ${field} must be a positive safe integer.`);
    }
}
//# sourceMappingURL=tool-trim-admission.js.map