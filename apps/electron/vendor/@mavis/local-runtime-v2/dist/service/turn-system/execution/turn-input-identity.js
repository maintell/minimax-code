import { digestSafetyInput } from '../../content-safety/index.js';
export function digestTurnInput(input, clientIntent) {
    const identity = clientIntent === undefined ? input : { input, clientIntent };
    return digestSafetyInput(identity);
}
//# sourceMappingURL=turn-input-identity.js.map