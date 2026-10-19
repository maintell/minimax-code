/**
 * Session Clio v1 wire types.
 *
 * Field names are snake_case and mirror `EvalClioPayload` and its members in
 * `matrix/archon_server/archon_server_base.thrift` exactly. Every value here is
 * plain JSON: the producer keeps the original payload and its `seq` across
 * retries, so nothing in this module may carry class instances or `undefined`
 * holes. Absent optional members are omitted keys, never `undefined` values.
 */
/** `EvalCaptureOrigin`; Session Clio only captures the two Pi runtimes. */
export const EvalCaptureOrigin = {
    LocalPi: 101,
    CloudPi: 201,
};
/** `EvalStepType`; Session Clio owns 6/7/8 and never writes the raw Eval types. */
export const EvalStepType = {
    QaTurn: 6,
    QueryActivity: 7,
    SessionSeal: 8,
};
/** `EvalQueryTrigger`; only `Manual` advances the inactivity clock. */
export const EvalQueryTrigger = {
    Manual: 1,
    Automatic: 2,
};
/** `EvalTurnStatus`; `Unfinished` is minted by sealing only, never by a caller. */
export const EvalTurnStatus = {
    Completed: 1,
    Failed: 2,
    Canceled: 3,
    Unfinished: 4,
};
//# sourceMappingURL=wire.js.map