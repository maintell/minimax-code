namespace go canonical

include "../common.thrift"
include "../plugin.thrift"

struct EntryValue {
    1: required common.CommonValue common
    2: required plugin.PluginValue plugin
}
