include "../shared/common.thrift"
include "../shared/wrapper.thrift"

namespace js matrix.nested_include

struct EntryReq {
    1: required common.SharedValue value
}

struct EntryResp {
    1: required wrapper.WrappedValue value
}

service NestedIncludeService {
    EntryResp Get(1: EntryReq req) (api.get="/nested")
}
