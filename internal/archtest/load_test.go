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

type source struct {
	dir  string
	rel  string
	fset *token.FileSet
	file *ast.File
}

func (s *source) pos(n ast.Node) string {
	return fmt.Sprintf("%s:%d", s.rel, s.fset.Position(n.Pos()).Line)
}

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

func (s *source) imports() map[string]*ast.ImportSpec {
	out := map[string]*ast.ImportSpec{}
	for _, im := range s.file.Imports {
		v, _ := strconv.Unquote(im.Path.Value)
		out[v] = im
	}
	return out
}

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

func inDir(dir, d string) bool {
	return dir == d || strings.HasPrefix(dir, d+"/")
}

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

func violation(t *testing.T, where, rule, fix string) {
	t.Helper()
	t.Errorf("%s: %s\n\tfix: %s", where, rule, fix)
}
