namespace js matrix.common

typedef i64 TraceId

enum Status {
    UNKNOWN = 0,
    READY = 1,
}

struct CommonItem {
    1: required TraceId trace_id
    2: optional set<string> tags
}
