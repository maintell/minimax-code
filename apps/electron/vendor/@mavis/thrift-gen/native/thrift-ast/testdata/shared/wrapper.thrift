include "common.thrift"

namespace js matrix.shared

struct WrappedValue {
    1: required common.SharedValue value
}
