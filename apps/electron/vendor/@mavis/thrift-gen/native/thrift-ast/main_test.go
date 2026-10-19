package main

import (
	"path/filepath"
	"testing"
)

func TestExtractDesktopServiceIR(t *testing.T) {
	ir, err := extractThriftIR("testdata", "desktop_service.thrift")
	if err != nil {
		t.Fatalf("extractThriftIR() error = %v", err)
	}

	if ir.IRVersion != 2 {
		t.Fatalf("IRVersion = %d, want 2", ir.IRVersion)
	}
	if ir.Source.Entry != "desktop_service.thrift" {
		t.Fatalf("Source.Entry = %q", ir.Source.Entry)
	}
	if wantSuffix := filepath.Join("native", "thrift-ast", "testdata"); !hasPathSuffix(ir.Source.IDLDir, wantSuffix) {
		t.Fatalf("Source.IDLDir = %q, want suffix %q", ir.Source.IDLDir, wantSuffix)
	}
	file := requireFile(t, ir, "desktop_service.thrift")
	if file.Namespaces["js"] != "matrix.desktop_service" {
		t.Fatalf("namespace js = %q", file.Namespaces["js"])
	}
	if len(file.Structs) != 2 {
		t.Fatalf("len(Structs) = %d, want 2", len(file.Structs))
	}
	pingReq := requireStruct(t, file, "PingReq")
	message := requireField(t, pingReq, "message")
	if message.Type.Kind != "builtin" || message.Type.Name != "string" {
		t.Fatalf("PingReq.message type = %+v", message.Type)
	}
	service := requireService(t, file, "DesktopService")
	method := requireFunction(t, service, "Ping")
	if method.ReturnType == nil || method.ReturnType.Kind != "identifier" || method.ReturnType.Name != "PingResp" {
		t.Fatalf("method return type = %+v", method.ReturnType)
	}
	if len(method.Annotations) != 1 || method.Annotations[0].Key != "api.post" || method.Annotations[0].Values[0] != "/minimax-desktop/api/v1/ping" {
		t.Fatalf("method annotations = %+v", method.Annotations)
	}
}

func TestExtractCanonicalIncludePaths(t *testing.T) {
	ir, err := extractThriftIR("testdata/canonical_include", "service/entry.thrift")
	if err != nil {
		t.Fatalf("extractThriftIR() error = %v", err)
	}

	if len(ir.Files) != 3 {
		t.Fatalf("len(Files) = %d, want 3; files = %+v", len(ir.Files), ir.Files)
	}

	paths := make(map[string]int, len(ir.Files))
	for _, file := range ir.Files {
		paths[file.Path]++
	}
	for _, path := range []string{"service/entry.thrift", "plugin.thrift", "common.thrift"} {
		if paths[path] != 1 {
			t.Fatalf("file %q count = %d, want 1; files = %+v", path, paths[path], ir.Files)
		}
	}

	entry := requireFile(t, ir, "service/entry.thrift")
	if len(entry.Includes) != 2 {
		t.Fatalf("entry includes = %+v, want 2 includes", entry.Includes)
	}
	if entry.Includes[0].ResolvedPath != "common.thrift" {
		t.Fatalf("entry common resolvedPath = %q, want common.thrift", entry.Includes[0].ResolvedPath)
	}

	plugin := requireFile(t, ir, "plugin.thrift")
	if len(plugin.Includes) != 1 {
		t.Fatalf("plugin includes = %+v, want 1 include", plugin.Includes)
	}
	if plugin.Includes[0].ResolvedPath != entry.Includes[0].ResolvedPath {
		t.Fatalf("common resolved paths = %q and %q, want same canonical path", entry.Includes[0].ResolvedPath, plugin.Includes[0].ResolvedPath)
	}
}

func TestExtractGenericHttpIR(t *testing.T) {
	ir, err := extractThriftIR("testdata", "generic_http/entry.thrift")
	if err != nil {
		t.Fatalf("extractThriftIR() error = %v", err)
	}

	if ir.IRVersion != 2 {
		t.Fatalf("IRVersion = %d, want 2", ir.IRVersion)
	}
	if ir.Source.Entry != "generic_http/entry.thrift" {
		t.Fatalf("Source.Entry = %q", ir.Source.Entry)
	}
	if len(ir.Files) != 2 {
		t.Fatalf("len(Files) = %d, want 2", len(ir.Files))
	}

	entry := requireFile(t, ir, "generic_http/entry.thrift")
	if len(entry.Includes) != 1 || entry.Includes[0].Alias != "common" || !hasPathSuffix(entry.Includes[0].ResolvedPath, "generic_http/common.thrift") {
		t.Fatalf("entry includes = %+v", entry.Includes)
	}
	if entry.Namespaces["js"] != "matrix.generic" {
		t.Fatalf("entry namespace js = %q", entry.Namespaces["js"])
	}

	common := requireFile(t, ir, "generic_http/common.thrift")
	traceID := requireTypedef(t, common, "TraceId")
	if traceID.TargetType.Kind != "builtin" || traceID.TargetType.Name != "i64" {
		t.Fatalf("TraceId target type = %+v", traceID.TargetType)
	}
	status := requireEnum(t, common, "Status")
	if len(status.Values) != 2 || status.Values[1].Name != "READY" || status.Values[1].Value != 1 {
		t.Fatalf("Status enum values = %+v", status.Values)
	}

	req := requireStruct(t, entry, "GenericReq")
	tenantID := requireField(t, req, "tenant_id")
	if tenantID.Type.Kind != "builtin" || tenantID.Type.Name != "string" {
		t.Fatalf("tenant_id type = %+v", tenantID.Type)
	}
	if len(tenantID.Annotations) != 1 || tenantID.Annotations[0].Key != "api.path" || tenantID.Annotations[0].Values[0] != "tenant_id" {
		t.Fatalf("tenant_id annotations = %+v", tenantID.Annotations)
	}
	items := requireField(t, req, "items")
	if items.Type.Kind != "list" || items.Type.ValueType == nil || items.Type.ValueType.Name != "common.CommonItem" {
		t.Fatalf("items type = %+v", items.Type)
	}
	traceByKey := requireField(t, req, "trace_by_key")
	if traceByKey.Type.Kind != "map" || traceByKey.Type.KeyType == nil || traceByKey.Type.ValueType == nil {
		t.Fatalf("trace_by_key type = %+v", traceByKey.Type)
	}
	if traceByKey.Type.KeyType.Name != "string" || traceByKey.Type.ValueType.Name != "common.TraceId" {
		t.Fatalf("trace_by_key map type = %+v", traceByKey.Type)
	}
	parentID := requireField(t, req, "parent_id")
	if !parentID.DefaultValue {
		t.Fatalf("parent_id DefaultValue = false, want true")
	}

	service := requireService(t, entry, "GenericService")
	method := requireFunction(t, service, "Create")
	if method.ReturnType == nil || method.ReturnType.Name != "GenericResp" {
		t.Fatalf("Create return type = %+v", method.ReturnType)
	}
	if len(method.Annotations) != 1 || method.Annotations[0].Key != "api.post" || method.Annotations[0].Values[0] != "/generic/:tenant_id" {
		t.Fatalf("method annotations = %+v", method.Annotations)
	}
}

func TestExtractIRCanonicalizesNestedIncludePaths(t *testing.T) {
	ir, err := extractThriftIR("testdata", "nested_include/entry.thrift")
	if err != nil {
		t.Fatalf("extractThriftIR() error = %v", err)
	}

	if len(ir.Files) != 3 {
		t.Fatalf("len(Files) = %d, want 3: %+v", len(ir.Files), ir.Files)
	}

	entry := requireFile(t, ir, "nested_include/entry.thrift")
	wrapper := requireFile(t, ir, "shared/wrapper.thrift")
	requireFile(t, ir, "shared/common.thrift")

	if got := resolvedIncludePath(entry, "common"); got != "shared/common.thrift" {
		t.Fatalf("entry common resolvedPath = %q, want shared/common.thrift", got)
	}
	if got := resolvedIncludePath(wrapper, "common"); got != "shared/common.thrift" {
		t.Fatalf("wrapper common resolvedPath = %q, want shared/common.thrift", got)
	}

	seenCommon := 0
	for _, file := range ir.Files {
		if file.Path == "shared/common.thrift" {
			seenCommon++
		}
	}
	if seenCommon != 1 {
		t.Fatalf("shared/common.thrift file count = %d, want 1", seenCommon)
	}
}

func resolvedIncludePath(file fileIR, alias string) string {
	for _, include := range file.Includes {
		if include.Alias == alias {
			return include.ResolvedPath
		}
	}
	return ""
}

func requireFile(t *testing.T, ir *thriftIR, path string) fileIR {
	t.Helper()
	for _, file := range ir.Files {
		if file.Path == path || hasPathSuffix(file.Path, path) {
			return file
		}
	}
	t.Fatalf("missing file %s in %+v", path, ir.Files)
	return fileIR{}
}

func requireStruct(t *testing.T, file fileIR, name string) structIR {
	t.Helper()
	for _, thriftStruct := range file.Structs {
		if thriftStruct.Name == name {
			return thriftStruct
		}
	}
	t.Fatalf("missing struct %s in %+v", name, file.Structs)
	return structIR{}
}

func requireField(t *testing.T, thriftStruct structIR, name string) fieldIR {
	t.Helper()
	for _, field := range thriftStruct.Fields {
		if field.Name == name {
			return field
		}
	}
	t.Fatalf("missing field %s in %+v", name, thriftStruct.Fields)
	return fieldIR{}
}

func requireTypedef(t *testing.T, file fileIR, name string) typedefIR {
	t.Helper()
	for _, typedef := range file.Typedefs {
		if typedef.Name == name {
			return typedef
		}
	}
	t.Fatalf("missing typedef %s in %+v", name, file.Typedefs)
	return typedefIR{}
}

func requireEnum(t *testing.T, file fileIR, name string) enumIR {
	t.Helper()
	for _, thriftEnum := range file.Enums {
		if thriftEnum.Name == name {
			return thriftEnum
		}
	}
	t.Fatalf("missing enum %s in %+v", name, file.Enums)
	return enumIR{}
}

func requireService(t *testing.T, file fileIR, name string) serviceIR {
	t.Helper()
	for _, service := range file.Services {
		if service.Name == name {
			return service
		}
	}
	t.Fatalf("missing service %s in %+v", name, file.Services)
	return serviceIR{}
}

func requireFunction(t *testing.T, service serviceIR, name string) functionIR {
	t.Helper()
	for _, function := range service.Functions {
		if function.Name == name {
			return function
		}
	}
	t.Fatalf("missing function %s in %+v", name, service.Functions)
	return functionIR{}
}

func hasPathSuffix(path string, suffix string) bool {
	return len(path) >= len(suffix) && filepath.ToSlash(path[len(path)-len(suffix):]) == filepath.ToSlash(suffix)
}
