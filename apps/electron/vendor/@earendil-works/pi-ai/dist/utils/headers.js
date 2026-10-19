export function headersToRecord(headers) {
    const result = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}
//# sourceMappingURL=headers.js.map