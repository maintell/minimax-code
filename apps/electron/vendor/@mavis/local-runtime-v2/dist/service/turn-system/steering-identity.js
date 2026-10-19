export function steeringReceiptId(input) {
    return `steer:${input.producerId}\u0000${input.idempotencyKey}`;
}
export function steeringMessageKey(input) {
    return `steer:${input.producerId}:${input.idempotencyKey}`;
}
//# sourceMappingURL=steering-identity.js.map