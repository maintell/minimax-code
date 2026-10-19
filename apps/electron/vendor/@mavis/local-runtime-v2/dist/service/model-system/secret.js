export function maskSecret(value) {
    return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}
//# sourceMappingURL=secret.js.map