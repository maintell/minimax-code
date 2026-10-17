package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudwego/thriftgo/parser"
)

const (
	irVersion           = 2
	defaultEntryPath    = "matrix/desktop_service/desktop_service.thrift"
	defaultIndentPrefix = ""
	defaultIndent       = "  "
)

type thriftIR struct {
	IRVersion int      `json:"irVersion"`
	Source    sourceIR `json:"source"`
	Files     []fileIR `json:"files"`
}

type sourceIR struct {
	Entry  string `json:"entry"`
	IDLDir string `json:"idlDir"`
}

type fileIR struct {
	Path       string            `json:"path"`
	Namespaces map[string]string `json:"namespaces"`
	Includes   []includeIR       `json:"includes"`
	Typedefs   []typedefIR       `json:"typedefs"`
	Enums      []enumIR          `json:"enums"`
	Structs    []structIR        `json:"structs"`
	Services   []serviceIR       `json:"services"`
}

type includeIR struct {
	Path         string `json:"path"`
	ResolvedPath string `json:"resolvedPath"`
	Alias        string `json:"alias"`
}

type annotationIR struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

type typeIR struct {
	Kind               string         `json:"kind"`
	Name               string         `json:"name,omitempty"`
	KeyType            *typeIR        `json:"keyType,omitempty"`
	ValueType          *typeIR        `json:"valueType,omitempty"`
	Annotations        []annotationIR `json:"annotations,omitempty"`
	ParserCategoryHint string         `json:"parserCategoryHint,omitempty"`
}

type typedefIR struct {
	Name        string         `json:"name"`
	TargetType  typeIR         `json:"targetType"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

type enumValueIR struct {
	Name        string         `json:"name"`
	Value       int64          `json:"value"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

type enumIR struct {
	Name        string         `json:"name"`
	Values      []enumValueIR  `json:"values"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

type fieldIR struct {
	ID           int32          `json:"id"`
	Name         string         `json:"name"`
	Requiredness string         `json:"requiredness"`
	Type         typeIR         `json:"type"`
	Annotations  []annotationIR `json:"annotations,omitempty"`
	DefaultValue bool           `json:"defaultValue,omitempty"`
}

type structIR struct {
	Name        string         `json:"name"`
	Fields      []fieldIR      `json:"fields"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

type functionIR struct {
	Name        string         `json:"name"`
	Oneway      bool           `json:"oneway"`
	Void        bool           `json:"void"`
	ReturnType  *typeIR        `json:"returnType,omitempty"`
	Arguments   []fieldIR      `json:"arguments"`
	Throws      []fieldIR      `json:"throws,omitempty"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

type serviceIR struct {
	Name        string         `json:"name"`
	Extends     string         `json:"extends,omitempty"`
	Functions   []functionIR   `json:"functions"`
	Annotations []annotationIR `json:"annotations,omitempty"`
}

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "thrift-ast: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var idlDir string
	var entry string
	flag.StringVar(&idlDir, "idl-dir", "", "weaver/idl checkout root")
	flag.StringVar(&entry, "entry", defaultEntryPath, "entry thrift path relative to --idl-dir")
	flag.Parse()

	if idlDir == "" {
		return errors.New("--idl-dir is required")
	}

	ir, err := extractThriftIR(idlDir, entry)
	if err != nil {
		return err
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent(defaultIndentPrefix, defaultIndent)
	return encoder.Encode(ir)
}

func extractThriftIR(idlDir string, entry string) (*thriftIR, error) {
	absIDLDir, err := filepath.Abs(idlDir)
	if err != nil {
		return nil, fmt.Errorf("resolve idl dir: %w", err)
	}

	entry = filepath.Clean(entry)
	if filepath.IsAbs(entry) {
		return nil, fmt.Errorf("entry path must be relative to --idl-dir, got %s", entry)
	}

	entryPath := filepath.Join(absIDLDir, entry)
	ast, err := parser.ParseFile(entryPath, []string{absIDLDir}, true)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", entry, err)
	}

	source := sourceIR{Entry: slashClean(entry), IDLDir: absIDLDir}
	files, err := collectFiles(absIDLDir, ast, source.Entry)
	if err != nil {
		return nil, err
	}

	return &thriftIR{IRVersion: irVersion, Source: source, Files: files}, nil
}

func collectFiles(idlDir string, entryAST *parser.Thrift, entryPath string) ([]fileIR, error) {
	if entryAST == nil {
		return nil, errors.New("parser returned nil AST")
	}

	files := make([]fileIR, 0)
	visited := map[string]bool{}
	var visit func(ast *parser.Thrift, fallbackPath string) error
	visit = func(ast *parser.Thrift, fallbackPath string) error {
		if ast == nil {
			return errors.New("include reference has nil AST")
		}
		filePath := relativeASTPath(idlDir, ast, fallbackPath)
		if visited[filePath] {
			return nil
		}
		visited[filePath] = true

		converted, err := convertFile(idlDir, ast, filePath)
		if err != nil {
			return err
		}
		files = append(files, converted)

		for _, include := range ast.Includes {
			if include == nil || include.Reference == nil {
				continue
			}
			resolvedPath := resolveIncludePath(idlDir, filePath, include)
			if err := visit(include.Reference, resolvedPath); err != nil {
				return err
			}
		}
		return nil
	}

	if err := visit(entryAST, entryPath); err != nil {
		return nil, err
	}
	return files, nil
}

func convertFile(idlDir string, ast *parser.Thrift, path string) (fileIR, error) {
	if ast == nil {
		return fileIR{}, errors.New("parser returned nil AST")
	}

	typedefs, err := convertTypedefs(ast.Typedefs)
	if err != nil {
		return fileIR{}, fmt.Errorf("file %s typedefs: %w", path, err)
	}
	enums := convertEnums(ast.Enums)
	structs, err := convertStructs(ast.Structs)
	if err != nil {
		return fileIR{}, fmt.Errorf("file %s structs: %w", path, err)
	}
	services, err := convertServices(ast.Services)
	if err != nil {
		return fileIR{}, fmt.Errorf("file %s services: %w", path, err)
	}

	return fileIR{
		Path:       path,
		Namespaces: convertNamespaces(ast.Namespaces),
		Includes:   convertIncludes(idlDir, path, ast.Includes),
		Typedefs:   typedefs,
		Enums:      enums,
		Structs:    structs,
		Services:   services,
	}, nil
}

func convertNamespaces(namespaces []*parser.Namespace) map[string]string {
	out := make(map[string]string, len(namespaces))
	for _, namespace := range namespaces {
		if namespace == nil {
			continue
		}
		out[namespace.Language] = namespace.Name
	}
	return out
}

func convertIncludes(idlDir string, currentFile string, includes []*parser.Include) []includeIR {
	out := make([]includeIR, 0, len(includes))
	for _, include := range includes {
		if include == nil {
			continue
		}
		path := slashClean(include.Path)
		out = append(out, includeIR{
			Path:         path,
			ResolvedPath: resolveIncludePath(idlDir, currentFile, include),
			Alias:        includeAlias(path),
		})
	}
	return out
}

func convertTypedefs(typedefs []*parser.Typedef) ([]typedefIR, error) {
	out := make([]typedefIR, 0, len(typedefs))
	for _, typedef := range typedefs {
		if typedef == nil {
			continue
		}
		if typedef.Type == nil {
			return nil, fmt.Errorf("typedef %s has nil target type", typedef.Alias)
		}
		targetType, err := convertType(typedef.Type)
		if err != nil {
			return nil, fmt.Errorf("typedef %s target type: %w", typedef.Alias, err)
		}
		out = append(out, typedefIR{
			Name:        typedef.Alias,
			TargetType:  targetType,
			Annotations: convertAnnotations(typedef.Annotations),
		})
	}
	return out, nil
}

func convertEnums(enums []*parser.Enum) []enumIR {
	out := make([]enumIR, 0, len(enums))
	for _, enum := range enums {
		if enum == nil {
			continue
		}
		values := make([]enumValueIR, 0, len(enum.Values))
		for _, value := range enum.Values {
			if value == nil {
				continue
			}
			values = append(values, enumValueIR{
				Name:        value.Name,
				Value:       value.Value,
				Annotations: convertAnnotations(value.Annotations),
			})
		}
		out = append(out, enumIR{
			Name:        enum.Name,
			Values:      values,
			Annotations: convertAnnotations(enum.Annotations),
		})
	}
	return out
}

func convertStructs(structs []*parser.StructLike) ([]structIR, error) {
	out := make([]structIR, 0, len(structs))
	for _, thriftStruct := range structs {
		if thriftStruct == nil {
			continue
		}
		fields, err := convertFields(thriftStruct.Fields)
		if err != nil {
			return nil, fmt.Errorf("struct %s: %w", thriftStruct.Name, err)
		}
		out = append(out, structIR{
			Name:        thriftStruct.Name,
			Fields:      fields,
			Annotations: convertAnnotations(thriftStruct.Annotations),
		})
	}
	return out, nil
}

func convertServices(services []*parser.Service) ([]serviceIR, error) {
	out := make([]serviceIR, 0, len(services))
	for _, service := range services {
		if service == nil {
			continue
		}
		functions, err := convertFunctions(service.Functions)
		if err != nil {
			return nil, fmt.Errorf("service %s: %w", service.Name, err)
		}
		out = append(out, serviceIR{
			Name:        service.Name,
			Extends:     service.Extends,
			Functions:   functions,
			Annotations: convertAnnotations(service.Annotations),
		})
	}
	return out, nil
}

func convertFunctions(functions []*parser.Function) ([]functionIR, error) {
	out := make([]functionIR, 0, len(functions))
	for _, function := range functions {
		if function == nil {
			continue
		}

		arguments, err := convertFields(function.Arguments)
		if err != nil {
			return nil, fmt.Errorf("function %s arguments: %w", function.Name, err)
		}

		throwsFields, err := convertFields(function.Throws)
		if err != nil {
			return nil, fmt.Errorf("function %s throws: %w", function.Name, err)
		}

		var returnType *typeIR
		if function.FunctionType != nil {
			convertedReturnType, err := convertType(function.FunctionType)
			if err != nil {
				return nil, fmt.Errorf("function %s return type: %w", function.Name, err)
			}
			returnType = &convertedReturnType
		}

		out = append(out, functionIR{
			Name:        function.Name,
			Oneway:      function.Oneway,
			Void:        function.Void,
			ReturnType:  returnType,
			Arguments:   arguments,
			Throws:      throwsFields,
			Annotations: convertAnnotations(function.Annotations),
		})
	}
	return out, nil
}

func convertFields(fields []*parser.Field) ([]fieldIR, error) {
	out := make([]fieldIR, 0, len(fields))
	for _, field := range fields {
		if field == nil {
			continue
		}
		if field.Type == nil {
			return nil, fmt.Errorf("field %s has nil type", field.Name)
		}
		fieldType, err := convertType(field.Type)
		if err != nil {
			return nil, fmt.Errorf("field %s type: %w", field.Name, err)
		}
		out = append(out, fieldIR{
			ID:           field.ID,
			Name:         field.Name,
			Requiredness: convertRequiredness(field.Requiredness),
			Type:         fieldType,
			Annotations:  convertAnnotations(field.Annotations),
			DefaultValue: field.Default != nil,
		})
	}
	return out, nil
}

func convertType(thriftType *parser.Type) (typeIR, error) {
	if thriftType == nil {
		return typeIR{}, errors.New("nil type")
	}

	annotations := convertAnnotations(thriftType.Annotations)
	switch thriftType.Name {
	case "bool", "byte", "i8", "i16", "i32", "i64", "double", "string", "binary":
		return typeIR{Kind: "builtin", Name: thriftType.Name, Annotations: annotations}, nil
	case "list", "set":
		if thriftType.ValueType == nil {
			return typeIR{}, fmt.Errorf("%s type missing value type", thriftType.Name)
		}
		valueType, err := convertType(thriftType.ValueType)
		if err != nil {
			return typeIR{}, fmt.Errorf("value type: %w", err)
		}
		return typeIR{Kind: thriftType.Name, ValueType: &valueType, Annotations: annotations}, nil
	case "map":
		if thriftType.KeyType == nil || thriftType.ValueType == nil {
			return typeIR{}, errors.New("map type missing key or value type")
		}
		keyType, err := convertType(thriftType.KeyType)
		if err != nil {
			return typeIR{}, fmt.Errorf("key type: %w", err)
		}
		valueType, err := convertType(thriftType.ValueType)
		if err != nil {
			return typeIR{}, fmt.Errorf("value type: %w", err)
		}
		return typeIR{Kind: "map", KeyType: &keyType, ValueType: &valueType, Annotations: annotations}, nil
	default:
		return typeIR{
			Kind:               "identifier",
			Name:               thriftType.Name,
			Annotations:        annotations,
			ParserCategoryHint: thriftType.Category.String(),
		}, nil
	}
}

func convertRequiredness(requiredness parser.FieldType) string {
	switch requiredness {
	case parser.FieldType_Required:
		return "required"
	case parser.FieldType_Optional:
		return "optional"
	default:
		return "default"
	}
}

func convertAnnotations(annotations parser.Annotations) []annotationIR {
	out := make([]annotationIR, 0, len(annotations))
	for _, annotation := range annotations {
		if annotation == nil {
			continue
		}
		out = append(out, annotationIR{Key: annotation.Key, Values: annotation.Values})
	}
	return out
}

func resolveIncludePath(idlDir string, currentFile string, include *parser.Include) string {
	if include == nil {
		return ""
	}

	currentRelative := filepath.FromSlash(currentFile)
	candidates := []string{
		filepath.Join(filepath.Dir(currentRelative), filepath.FromSlash(include.Path)),
		filepath.FromSlash(include.Path),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(idlDir, candidate)); err == nil {
			return slashClean(candidate)
		}
	}
	if include.Reference != nil {
		return relativeASTPath(idlDir, include.Reference, include.Path)
	}
	return slashClean(candidates[0])
}

func relativeASTPath(idlDir string, ast *parser.Thrift, fallbackPath string) string {
	// thriftgo preserves the literal include spelling in Filename for nested
	// references (for example "skill.thrift"). Treating that value as relative
	// to the IDL root gives one physical file multiple IR identities. The
	// traversal fallback is already resolved relative to the including file, so
	// only an absolute parser filename is authoritative here.
	if ast != nil && filepath.IsAbs(ast.Filename) {
		filename := ast.Filename
		candidates := []string{filename}
		if filepath.IsAbs(filename) {
			candidates = []string{filename}
		} else {
			candidates = append(candidates, filepath.Join(idlDir, filename))
		}
		for _, candidate := range candidates {
			if _, err := os.Stat(candidate); err != nil {
				continue
			}
			if rel, err := filepath.Rel(idlDir, candidate); err == nil && !strings.HasPrefix(rel, "..") {
				return slashClean(rel)
			}
		}
	}
	return slashClean(fallbackPath)
}

func includeAlias(path string) string {
	base := filepath.Base(filepath.FromSlash(path))
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func slashClean(path string) string {
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))
}
