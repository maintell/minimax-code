/** The active history no longer matches the snapshot a segment rebuild was built from. */
export class SegmentCheckpointConflictError extends Error {
    code;
    name = 'SegmentCheckpointConflictError';
    constructor(code) {
        super(`Segment checkpoint cannot replace the active history: ${code}`);
        this.code = code;
    }
}
//# sourceMappingURL=segment-checkpoint.js.map