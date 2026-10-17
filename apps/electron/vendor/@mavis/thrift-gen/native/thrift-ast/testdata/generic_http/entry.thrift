namespace js matrix.generic

include "common.thrift"

typedef i64 LocalId

struct GenericReq {
    1: required string tenant_id (api.path="tenant_id")
    2: optional list<common.CommonItem> items
    3: optional map<string, common.TraceId> trace_by_key
    4: optional LocalId parent_id = 42 (api.query="parent_id")
    5: optional string debug (api.none="")
}

struct GenericResp {
    1: required common.Status status
}

service GenericService {
    GenericResp Create(1: GenericReq req) (api.post="/generic/:tenant_id")
}
