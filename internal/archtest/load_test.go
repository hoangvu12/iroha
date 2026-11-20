package archtest

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const module = "github.com/hoangvu12/iroha"

// source is one non-test Go file of the module.
type source struct {
	dir  string // package directory relative to the module root, slash-separated: "internal/clock"
	rel  string // file path relative to the module root: "internal/clock/clock.go"
	fset *token.FileSet
	file *ast.File
}

// pos is "file:line" of n, for failure messages.
func (s *source) pos(n ast.Node) string {
	return fmt.Sprintf("%s:%d", s.rel, s.fset.Position(n.Pos()).Line)
}

// importName is the name f uses for the import path p ("" when f does not
// import it; "_" or "." for blank and dot imports).
func (s *source) importName(p string) string {
	for _, im := range s.file.Imports {
		if v, _ := strconv.Unquote(im.Path.Value); v == p {
			if im.Name != nil {
				return im.Name.Name
			}
			return path.Base(p)
		}
	}
	return ""
}

// imports lists the import paths of the file with their positions.
func (s *source) imports() map[string]*ast.ImportSpec {
	out := map[string]*ast.ImportSpec{}
	for _, im := range s.file.Imports {
		v, _ := strconv.Unquote(im.Path.Value)
		out[v] = im
	}
	return out
}

// selectors calls fn for every pkg.Name selector in the file where pkg is
// the name the file gives the import path p.
func (s *source) selectors(p string, fn func(sel *ast.SelectorExpr)) {
	name := s.importName(p)
	if name == "" || name == "_" || name == "." {
		return
	}
	ast.Inspect(s.file, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == name {
				fn(sel)
			}
		}
		return true
	})
}

var (
	rootOnce sync.Once
	rootDir  string
	srcOnce  sync.Once
	srcs     []*source
	srcErr   error
)

// root is the module root (the directory holding go.mod).
func root(t *testing.T) string {
	t.Helper()
	rootOnce.Do(func() {
		dir, err := os.Getwd()
		if err != nil {
			return
		}
		for {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				rootDir = dir
				return
			}
			up := filepath.Dir(dir)
			if up == dir {
				return
			}
			dir = up
		}
	})
	if rootDir == "" {
		t.Fatal("go.mod not found above the working directory")
	}
	return rootDir
}

// sources parses every non-test Go file of the module, skipping the web UI,
// testdata, docs and hidden directories.
func sources(t *testing.T) []*source {
	t.Helper()
	r := root(t)
	srcOnce.Do(func() {
		srcErr = filepath.WalkDir(r, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			name := d.Name()
			if d.IsDir() {
				if p != r && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") ||
					name == "testdata" || name == "node_modules" || name == "web" || name == "docs" || name == "vendor") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				return nil
			}
			rel, err := filepath.Rel(r, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, p, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			srcs = append(srcs, &source{dir: path.Dir(rel), rel: rel, fset: fset, file: f})
			return nil
		})
		sort.Slice(srcs, func(i, j int) bool { return srcs[i].rel < srcs[j].rel })
	})
	if srcErr != nil {
		t.Fatal(srcErr)
	}
	if len(srcs) == 0 {
		t.Fatal("no Go files found")
	}
	return srcs
}

// inDir reports whether dir is d or below it.
func inDir(dir, d string) bool {
	return dir == d || strings.HasPrefix(dir, d+"/")
}

// enclosing is the name of the top-level function holding n in s ("" at
// package level), used to key allow-list entries.
func (s *source) enclosing(n ast.Node) string {
	for _, d := range s.file.Decls {
		if d.Pos() <= n.Pos() && n.End() <= d.End() {
			if fd, ok := d.(*ast.FuncDecl); ok {
				if fd.Recv != nil && len(fd.Recv.List) == 1 {
					return recvName(fd.Recv.List[0].Type) + "." + fd.Name.Name
				}
				return fd.Name.Name
			}
		}
	}
	return ""
}

func recvName(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.StarExpr:
		return recvName(x.X)
	case *ast.IndexExpr:
		return recvName(x.X)
	case *ast.IndexListExpr:
		return recvName(x.X)
	case *ast.Ident:
		return x.Name
	}
	return "?"
}

// violation formats one failure: where, which rule, what to do instead.
func violation(t *testing.T, where, rule, fix string) {
	t.Helper()
	t.Errorf("%s: %s\n\tfix: %s", where, rule, fix)
}
