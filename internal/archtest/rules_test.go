package archtest

import (
	"encoding/json"
	"go/ast"
	"maps"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const timeDoc = `see architecture.md, "Rules everyone follows", Time`

var wallClock = map[string]map[string]string{
	"time": {
		"Now":       "c.Now()",
		"Since":     "clock.Since(c, t)",
		"Until":     "t.Sub(c.Now())",
		"After":     "clock.After(c, d), or c.NewTimer(d) when it may be stopped",
		"AfterFunc": "c.AfterFunc(d, f)",
		"NewTimer":  "c.NewTimer(d)",
		"NewTicker": "c.NewTicker(d)",
		"Tick":      "c.NewTicker(d)",
		"Sleep":     "clock.Sleep(ctx, c, d)",
	},
	"context": {
		"WithTimeout":       "clock.WithTimeout(ctx, c, d)",
		"WithTimeoutCause":  "clock.WithTimeout(ctx, c, d)",
		"WithDeadline":      "clock.WithTimeout(ctx, c, deadline.Sub(c.Now()))",
		"WithDeadlineCause": "clock.WithTimeout(ctx, c, deadline.Sub(c.Now()))",
	},
}

var wallClockPackages = map[string]string{
	"internal/clock":   "it is the wall clock behind clock.Real",
	"internal/testkit": "test harness: waits in real time for the server and fake upstreams, never for behaviour under test",
}

var wallClockAllowed = map[string]string{}

func TestTimeComesFromTheInjectedClock(t *testing.T) {
	for _, s := range sources(t) {
		if _, ok := wallClockPackages[s.dir]; ok {
			continue
		}
		for pkg, calls := range wallClock {
			s.selectors(pkg, func(sel *ast.SelectorExpr) {
				fix, ok := calls[sel.Sel.Name]
				if !ok {
					return
				}
				call := pkg + "." + sel.Sel.Name
				if _, ok := wallClockAllowed[s.rel+" "+s.enclosing(sel)+" "+call]; ok {
					return
				}
				violation(t, s.pos(sel), call+" reads the wall clock, so tests on *clock.Fake cannot drive it",
					"use "+fix+" with the injected clock.Clock; "+timeDoc)
			})
		}
	}
}

var thirdParty = map[string]struct {
	dirs []string
	why  string
}{
	"github.com/QuantumNous/new-api/relaykit": {[]string{"internal/translate"},
		"ADR-0004: internal/translate is the only importer of RelayKit; other packages call translate.New"},
	"modernc.org/sqlite": {[]string{"internal/store"},
		"the driver is opened by store.Open"},
}

func TestImportsStayInTheirPackages(t *testing.T) {
	for _, s := range sources(t) {
		for p, im := range s.imports() {
			if isStd(p) || p == module || strings.HasPrefix(p, module+"/") {
				continue
			}
			var mod string
			for m := range thirdParty {
				if p == m || strings.HasPrefix(p, m+"/") {
					mod = m
				}
			}
			if mod == "" {
				violation(t, s.pos(im), "imports "+p+", a module outside the standard library nothing has agreed to",
					"Iroha serves HTTP with stdlib net/http only (no router or web framework) and keeps its dependencies few: "+
						"use the standard library; if this dependency is truly needed, add it to thirdParty in internal/archtest/rules_test.go with why")
				continue
			}
			if e := thirdParty[mod]; !slices.ContainsFunc(e.dirs, func(d string) bool { return inDir(s.dir, d) }) {
				violation(t, s.pos(im), "imports "+p+" outside "+strings.Join(e.dirs, ", "), e.why)
			}
		}
	}
}

func isStd(p string) bool {
	first, _, _ := strings.Cut(p, "/")
	return !strings.Contains(first, ".")
}

type purity int

const (
	pureThroughEverythingImported purity = iota
	pureApartFromFetching
)

var purePackages = map[string]purity{
	"internal/rules":     pureThroughEverythingImported,
	"internal/planner":   pureThroughEverythingImported,
	"internal/affinity":  pureThroughEverythingImported,
	"internal/caching":   pureThroughEverythingImported,
	"internal/normalise": pureThroughEverythingImported,
	"internal/modelmeta": pureApartFromFetching,
}

var impureImports = map[string]string{
	"database/sql":              "the database",
	"modernc.org/sqlite":        "the database",
	module + "/internal/store":  "the database",
	module + "/internal/api":    "routes",
	module + "/internal/server": "the server",
}

var strictImpureImports = map[string]string{
	"os":                       "the file system and environment",
	"log/slog":                 "logging",
	module + "/internal/logs":  "logging",
	module + "/internal/clock": "the clock (take now as an argument)",
}

var (
	httpServer   = []string{"Server", "ListenAndServe", "ListenAndServeTLS", "Serve", "ServeTLS", "Handler", "HandlerFunc", "Handle", "HandleFunc", "ResponseWriter", "ServeMux", "NewServeMux", "Request", "Flusher", "Hijacker", "ResponseController", "NewResponseController"}
	httpOutbound = []string{"Client", "DefaultClient", "Transport", "DefaultTransport", "Get", "Post", "PostForm", "Head", "NewRequest", "NewRequestWithContext"}
)

func TestPurePackagesStayPure(t *testing.T) {
	byDir := map[string][]*source{}
	for _, s := range sources(t) {
		byDir[s.dir] = append(byDir[s.dir], s)
	}
	const fix = "keep the package pure (package map: pure and table-tested): take what you need as arguments " +
		"(values, http.Header, now) and let the caller (a store-backed or route package) do the I/O"
	reported := map[string]bool{}
	report := func(where, rule, via string) {
		if !reported[where+rule] {
			reported[where+rule] = true
			violation(t, where, rule+via, fix)
		}
	}
	dirs := slices.Sorted(maps.Keys(purePackages))
	for _, dir := range dirs {
		strict := purePackages[dir] == pureThroughEverythingImported
		if len(byDir[dir]) == 0 {
			t.Errorf("%s: listed in purePackages but has no Go files; update internal/archtest/rules_test.go", dir)
			continue
		}
		seen := map[string]string{dir: dir}
		queue := []string{dir}
		for len(queue) > 0 {
			d := queue[0]
			queue = queue[1:]
			via := ""
			if d != dir {
				via = " (reached from " + seen[d] + ")"
			}
			for _, s := range byDir[d] {
				for p, im := range s.imports() {
					what, bad := impureImports[p]
					if !bad && strict {
						what, bad = strictImpureImports[p]
					}
					if bad {
						report(s.pos(im), "pure package imports "+p+" ("+what+")", via)
						continue
					}
					if strict && strings.HasPrefix(p, module+"/") {
						sub := strings.TrimPrefix(p, module+"/")
						if _, ok := seen[sub]; !ok {
							seen[sub] = seen[d] + " -> " + sub
							queue = append(queue, sub)
						}
					}
				}
				banned := httpServer
				if strict {
					banned = append(slices.Clone(httpServer), httpOutbound...)
				}
				s.selectors("net/http", func(sel *ast.SelectorExpr) {
					if slices.Contains(banned, sel.Sel.Name) {
						report(s.pos(sel), "pure package uses http."+sel.Sel.Name, via)
					}
				})
			}
		}
	}
}

var hostnameAllowed = map[string]string{
	"internal/testchat/answers.go page": "a URL the model asked the test tool to fetch, not an Endpoint; only names the page",
}

func TestEndpointHostsComeFromHostsOf(t *testing.T) {
	for _, s := range sources(t) {
		if s.dir == "internal/hosts" {
			continue
		}
		ast.Inspect(s.file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Hostname" {
				return true
			}
			if _, ok := hostnameAllowed[s.rel+" "+s.enclosing(call)]; ok {
				return true
			}
			violation(t, s.pos(call), "reads a URL's host with Hostname()",
				"use hosts.Of(url) (lowercased, no port), the one way Iroha reads an Endpoint's host, and hosts.Matches to compare; "+
					"if this URL is not an Endpoint's, add it to hostnameAllowed in internal/archtest/rules_test.go with why")
			return true
		})
	}
}

var globalDeps = map[string]map[string]string{
	"log/slog": {
		"Default": "take a *slog.Logger", "SetDefault": "take a *slog.Logger",
		"Debug": "log on the injected *slog.Logger", "Info": "log on the injected *slog.Logger",
		"Warn": "log on the injected *slog.Logger", "Error": "log on the injected *slog.Logger",
		"Log": "log on the injected *slog.Logger", "LogAttrs": "log on the injected *slog.Logger",
		"DebugContext": "log on the injected *slog.Logger", "InfoContext": "log on the injected *slog.Logger",
		"WarnContext": "log on the injected *slog.Logger", "ErrorContext": "log on the injected *slog.Logger",
	},
	"log": {
		"Print": "log on the injected *slog.Logger", "Printf": "log on the injected *slog.Logger",
		"Println": "log on the injected *slog.Logger", "Fatal": "return an error", "Fatalf": "return an error",
		"Fatalln": "return an error", "Panic": "return an error", "Panicf": "return an error", "Default": "take a *slog.Logger",
	},
	"net/http": {
		"DefaultClient": "take a *http.Client", "Get": "use the injected *http.Client",
		"Post": "use the injected *http.Client", "PostForm": "use the injected *http.Client",
		"Head": "use the injected *http.Client",
	},
}

var globalDepsPackages = map[string]string{
	"internal/testkit": "test harness: builds the dependencies it hands to the server",
}

var globalDepTypes = map[string]map[string]bool{
	"database/sql":             {"DB": true},
	module + "/internal/store": {"DB": true},
	"log/slog":                 {"Logger": true},
	"net/http":                 {"Client": true},
	module + "/internal/clock": {"Clock": true, "Real": true, "Fake": true},
}

func TestDependenciesArePassedExplicitly(t *testing.T) {
	const doc = `modules take *store.DB, *slog.Logger, clock.Clock and *http.Client explicitly; see architecture.md, "Rules everyone follows"`
	for _, s := range sources(t) {
		if _, ok := globalDepsPackages[s.dir]; ok {
			continue
		}
		for pkg, names := range globalDeps {
			s.selectors(pkg, func(sel *ast.SelectorExpr) {
				if fix, ok := names[sel.Sel.Name]; ok {
					violation(t, s.pos(sel), path.Base(pkg)+"."+sel.Sel.Name+" is a global dependency", fix+"; "+doc)
				}
			})
		}
		for _, d := range s.file.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok {
				continue
			}
			for _, sp := range gd.Specs {
				vs, ok := sp.(*ast.ValueSpec)
				if !ok || vs.Type == nil {
					continue
				}
				ast.Inspect(vs.Type, func(n ast.Node) bool {
					sel, ok := n.(*ast.SelectorExpr)
					if !ok {
						return true
					}
					id, ok := sel.X.(*ast.Ident)
					if !ok {
						return true
					}
					for p, types := range globalDepTypes {
						if s.importName(p) == id.Name && types[sel.Sel.Name] {
							violation(t, s.pos(vs), "package-level var holds a "+id.Name+"."+sel.Sel.Name,
								"pass it to the constructor or Routes function that needs it; "+doc)
						}
					}
					return true
				})
			}
		}
	}
}

var (
	sqlComment = regexp.MustCompile(`--[^\n]*`)
	timeColumn = regexp.MustCompile(`(?i)(?:^|[,(]|\bADD\s+COLUMN)\s*(\w+_at)\s+(\w+)`)
	sqlType    = regexp.MustCompile(`(?i)^(TEXT|REAL|BLOB|NUMERIC|INT|INTEGER|BIGINT|DATETIME|TIMESTAMP|DATE|TIME|VARCHAR|CHAR|FLOAT|DOUBLE|DECIMAL|BOOLEAN)$`)
)

func TestStoredTimesAreIntegerMillis(t *testing.T) {
	dir := filepath.Join(root(t), "internal", "store", "migrations")
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations in %s: %v", dir, err)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			line = sqlComment.ReplaceAllString(line, "")
			for _, m := range timeColumn.FindAllStringSubmatch(line, -1) {
				if sqlType.MatchString(m[2]) && !strings.EqualFold(m[2], "INTEGER") {
					violation(t, "internal/store/migrations/"+filepath.Base(f)+":"+strconv.Itoa(i+1),
						"stored time "+m[1]+" is "+strings.ToUpper(m[2]),
						"store times as INTEGER unix milliseconds UTC named *_at, written with store.Millis and read with store.FromMillis / store.NullMillis; "+
							`see architecture.md, "Rules everyone follows"`)
				}
			}
		}
	}
}

var pathParam = regexp.MustCompile(`\{(\w+)(?:\.\.\.)?\}`)

func TestAPIJSONIsSnakeCase(t *testing.T) {
	// The JSON Iroha itself defines: every route but the Caller routes, which
	// speak the wire format of their Shape (Gemini's bodies are camelCase).
	srv := testkit.Start(t)
	var routes []api.Route
	for _, r := range srv.App.Routes() {
		if r.Auth != api.AuthCaller {
			routes = append(routes, r)
		}
	}
	const fix = `name it in snake_case (a json:"snake_case" tag on every field of a body type; query and path parameters too); ` +
		`see architecture.md, "Rules everyone follows", JSON`
	for _, r := range routes {
		for _, p := range r.Query {
			if !snake.MatchString(p.Name) {
				t.Errorf("%s %s: query parameter %q is not snake_case\n\tfix: %s", r.Method, r.Path, p.Name, fix)
			}
		}
		for _, m := range pathParam.FindAllStringSubmatch(r.Path, -1) {
			if !snake.MatchString(m[1]) {
				t.Errorf("%s %s: path parameter %q is not snake_case\n\tfix: %s", r.Method, r.Path, m[1], fix)
			}
		}
	}
	var walk func(at string, v any)
	walk = func(at string, v any) {
		switch x := v.(type) {
		case map[string]any:
			if props, ok := x["properties"].(map[string]any); ok {
				for k := range props {
					if !snake.MatchString(k) {
						t.Errorf("openapi %s: field %q is not snake_case\n\tfix: %s", at, k, fix)
					}
				}
			}
			for k, c := range x {
				walk(at+"/"+k, c)
			}
		case []any:
			for _, c := range x {
				walk(at, c)
			}
		}
	}
	b, err := json.Marshal(api.OpenAPI(routes, "test"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	walk("", doc)
}
