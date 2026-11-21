// Command iroha-dev starts a real Iroha for a verifier: the same server
// code as cmd/iroha (with the embedded UI when it was built), a fresh data
// dir, fake upstreams for every Shape on localhost, and demo data seeded
// through the admin API. It prints one JSON object saying how to reach all
// of it and runs until Ctrl-C, POST <stop_url>, or --exit-after.
//
// It never reaches a real Provider, models.dev or a logo service: every
// outbound call Iroha makes is refused unless it goes to localhost.
// See .claude/skills/verify-iroha/SKILL.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/fakeupstream"
	"github.com/hoangvu12/iroha/internal/server"
	"github.com/hoangvu12/iroha/internal/shape"
)

const usage = `iroha-dev starts a local Iroha with fake upstreams and demo data, for verifying a change.

Usage: iroha-dev [flags]   (or: go run ./cmd/iroha-dev [flags])

It prints one JSON object on stdout once Iroha is ready (base_url, admin_token,
owner_password, gateway_keys, fakes and how to make them fail, data_dir,
stop_url, env_file), logs to <data_dir>/iroha-dev.log, and runs until Ctrl-C,
POST <stop_url> or --exit-after. Nothing leaves localhost.

Flags:
  --port N           port on 127.0.0.1 (default 0: a free one)
  --data-dir DIR     use DIR; a DIR a previous run seeded is reused as is
                     (its Endpoints are moved to this run's fakes) and never deleted
  --seed demo|none   demo (default): Providers, keys in every Key State, Model Pools,
                     Gateway Keys laptop, ci, friend and a burst of Requests;
                     none: only the Admin Token and the Owner password
  --keep             keep the temporary data dir on exit
  --exit-after D     stop by itself after D (default 2h; 0 never)
  --owner-password P the Owner password to set (default iroha-dev-password)

The UI is served only when internal/webui/dist was built before this binary:
  npm --prefix web ci && npm --prefix web run build
`

type options struct {
	port          int
	dataDir       string
	seed          string
	keep          bool
	exitAfter     time.Duration
	ownerPassword string
}

func parse(args []string, stderr io.Writer) (options, error) {
	var o options
	fs := flag.NewFlagSet("iroha-dev", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	fs.IntVar(&o.port, "port", 0, "")
	fs.StringVar(&o.dataDir, "data-dir", "", "")
	fs.StringVar(&o.seed, "seed", "demo", "")
	fs.BoolVar(&o.keep, "keep", false, "")
	fs.DurationVar(&o.exitAfter, "exit-after", 2*time.Hour, "")
	fs.StringVar(&o.ownerPassword, "owner-password", "iroha-dev-password", "")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stderr, usage)
			return o, err
		}
		return o, fmt.Errorf("%v; run with --help for the flags", err)
	}
	if fs.NArg() > 0 {
		return o, fmt.Errorf("unexpected argument %q; run with --help for the flags", fs.Arg(0))
	}
	if o.seed != "demo" && o.seed != "none" {
		return o, fmt.Errorf("--seed must be demo or none, not %q", o.seed)
	}
	if o.port < 0 || o.port > 65535 {
		return o, fmt.Errorf("--port must be from 0 (a free port) to 65535, not %d", o.port)
	}
	if len(o.ownerPassword) < 8 {
		return o, errors.New("--owner-password needs at least 8 characters")
	}
	return o, nil
}

func main() {
	opts, err := parse(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "iroha-dev:", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, opts, clock.Real{}, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "iroha-dev:", err)
		os.Exit(1)
	}
}

// Output is the JSON object printed once Iroha is ready.
type Output struct {
	BaseURL       string            `json:"base_url"`
	UI            bool              `json:"ui"`
	AdminToken    string            `json:"admin_token"`
	OwnerPassword string            `json:"owner_password"`
	GatewayKeys   map[string]string `json:"gateway_keys"`
	Docs          map[string]string `json:"docs"`
	Fakes         map[string]Fake   `json:"fakes"`
	MakeFail      MakeFail          `json:"make_fail"`
	Seed          string            `json:"seed"`
	Seeded        *Seeded           `json:"seeded,omitempty"`
	DataDir       string            `json:"data_dir"`
	DeletedOnExit bool              `json:"deleted_on_exit"`
	LogFile       string            `json:"log_file"`
	StopURL       string            `json:"stop_url"`
	EnvFile       string            `json:"env_file"` // the values above as sh variables: . "$env_file"
	Warnings      []string          `json:"warnings,omitempty"`
}

type Fake struct {
	URL     string `json:"url" doc:"the Endpoint URL to configure"`
	Control string `json:"control"`
}

type MakeFail struct {
	How        string            `json:"how"`
	Replies    map[string]string `json:"replies"`
	Routes     map[string]string `json:"routes"`
	KeyMarkers string            `json:"key_markers"`
}

type state struct {
	AdminToken    string            `json:"admin_token"`
	OwnerPassword string            `json:"owner_password"`
	GatewayKeys   map[string]string `json:"gateway_keys"`
	Seed          string            `json:"seed"`
	Fakes         map[string]string `json:"fakes"`
}

const stateFile = "iroha-dev.json"

func run(ctx context.Context, o options, clk clock.Clock, stdout, stderr io.Writer) (err error) {
	dir, temp := o.dataDir, o.dataDir == ""
	if temp {
		if dir, err = os.MkdirTemp("", "iroha-dev-*"); err != nil {
			return fmt.Errorf("create a temporary data dir: %w", err)
		}
	} else if dir, err = filepath.Abs(dir); err != nil {
		return err
	}
	deleteOnExit := temp && !o.keep
	defer func() {
		if deleteOnExit {
			if rmErr := os.RemoveAll(dir); rmErr != nil {
				fmt.Fprintf(stderr, "iroha-dev: could not delete %s: %v\n", dir, rmErr)
			} else {
				fmt.Fprintf(stderr, "iroha-dev: deleted %s\n", dir)
			}
		}
	}()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("data dir %s: %w", dir, err)
	}
	var prior *state
	if b, err := os.ReadFile(filepath.Join(dir, stateFile)); err == nil {
		prior = &state{}
		if err := json.Unmarshal(b, prior); err != nil {
			return fmt.Errorf("%s in %s is not valid JSON (%v): delete the data dir or pick another --data-dir", stateFile, dir, err)
		}
	}

	fakes := map[shape.Shape]*fakeupstream.Upstream{}
	for _, sh := range shape.All {
		u := fakeupstream.New(sh, clk)
		u.EnableControl()
		fakes[sh] = u
	}
	defer func() {
		for _, u := range fakes {
			u.Close()
		}
	}()

	logPath := filepath.Join(dir, "iroha-dev.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open the log file: %w", err)
	}
	defer logFile.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(o.port))
	if err != nil {
		if o.port != 0 {
			return fmt.Errorf("port %d is taken or not allowed (%v): pass another --port, or none for a free one", o.port, err)
		}
		return fmt.Errorf("listen on 127.0.0.1: %w", err)
	}
	app, err := server.New(ctx, server.Options{
		Config: config.Config{
			DataDir: dir, Addr: ln.Addr().String(), LogFormat: "json", DrainTimeout: 5 * time.Second,
		},
		Version:    "dev",
		Clock:      clk,
		Console:    logFile,
		HTTPClient: localOnly(),
	})
	if err != nil {
		ln.Close()
		return fmt.Errorf("start Iroha on %s: %w (if the data dir is from a newer Iroha, use a fresh --data-dir)", dir, err)
	}
	var serveErr error
	served := make(chan struct{})
	go func() { serveErr = app.Serve(ln); close(served) }()
	defer func() {
		sctx, cancel := clock.WithTimeout(context.Background(), clk, 5*time.Second)
		defer cancel()
		_ = app.Shutdown(sctx, "iroha-dev stop")
		<-served
	}()
	base := "http://" + ln.Addr().String()

	admin := &client{base: base, http: &http.Client{}}
	health, err := waitReady(ctx, clk, admin)
	if err != nil {
		return err
	}

	out := Output{
		BaseURL: base, UI: health.UI, OwnerPassword: o.ownerPassword, GatewayKeys: map[string]string{},
		Docs: map[string]string{
			"skill":   base + "/skill.md",
			"openapi": base + "/api/openapi.json",
		},
		Fakes: map[string]Fake{},
		MakeFail: MakeFail{
			How:        "POST <fake control>/next?reply=429 (count=N for N replies; status, message, code, ms, retry_after tune it); GET <fake control>/requests shows what the fake received; POST <fake control>/reset clears both",
			Replies:    fakeupstream.Replies,
			Routes:     fakeupstream.ControlHelp,
			KeyMarkers: "an Upstream Key whose secret holds fail<status> (sk-demo-fail401, sk-demo-fail429) always gets that status from every fake",
		},
		Seed: o.seed, DataDir: dir, DeletedOnExit: deleteOnExit, LogFile: logPath,
	}
	for sh, u := range fakes {
		out.Fakes[string(sh)] = Fake{URL: u.URL(), Control: u.ControlURL()}
	}
	if !health.UI {
		out.Warnings = append(out.Warnings, "this binary has no built UI (pages say so): run npm --prefix web ci && npm --prefix web run build, then start the launcher again")
	}

	origins := map[string]string{}
	for sh, u := range fakes {
		origins[string(sh)] = u.Origin()
	}
	boot := app.BootstrapToken().Secret
	switch {
	case boot != "":
		admin.token = boot
		out.AdminToken = boot
		if err := admin.do(ctx, "PUT", "/api/owner-password", map[string]any{"password": o.ownerPassword}, nil); err != nil {
			return fmt.Errorf("set the Owner password: %w", err)
		}
		if o.seed == "demo" {
			seeded, keys, err := seedDemo(ctx, admin, fakes)
			if err != nil {
				return fmt.Errorf("seed the demo data: %w (the log is %s)", err, logPath)
			}
			out.Seeded, out.GatewayKeys = seeded, keys
		}
	case prior != nil:
		admin.token = prior.AdminToken
		out.AdminToken, out.OwnerPassword, out.GatewayKeys, out.Seed = prior.AdminToken, prior.OwnerPassword, prior.GatewayKeys, prior.Seed
		moved, err := repoint(ctx, admin, prior.Fakes, origins)
		if err != nil {
			return fmt.Errorf("move the Endpoints of %s to this run's fakes: %w", dir, err)
		}
		if moved > 0 {
			out.Warnings = append(out.Warnings, fmt.Sprintf("reused %s: moved %d Endpoints to this run's fakes (ports change every run)", dir, moved))
		}
	default:
		return fmt.Errorf("%s already holds an Iroha that iroha-dev did not start (no %s, and the bootstrap Admin Token is shown only once): pick an empty --data-dir or omit it", dir, stateFile)
	}
	for _, u := range fakes {
		u.Reset()
		u.SetUsage(10, 5)
	}

	st := state{AdminToken: out.AdminToken, OwnerPassword: out.OwnerPassword, GatewayKeys: out.GatewayKeys, Seed: out.Seed, Fakes: origins}
	if b, err := json.MarshalIndent(st, "", "  "); err == nil {
		if err := os.WriteFile(filepath.Join(dir, stateFile), b, 0o600); err != nil {
			return fmt.Errorf("write %s: %w", stateFile, err)
		}
	}

	stopLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for the stop route: %w", err)
	}
	stopped := make(chan struct{})
	stopSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/stop" {
			http.Error(w, "POST /stop stops iroha-dev", http.StatusNotFound)
			return
		}
		fmt.Fprintln(w, "stopping")
		select {
		case <-stopped:
		default:
			close(stopped)
		}
	})}
	go func() { _ = stopSrv.Serve(stopLn) }()
	defer stopSrv.Close()
	out.StopURL = "http://" + stopLn.Addr().String() + "/stop"
	out.EnvFile = filepath.Join(dir, "iroha-dev.env")
	if err := os.WriteFile(out.EnvFile, []byte(envFile(out)), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", out.EnvFile, err)
	}

	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return err
	}

	var exit <-chan time.Time
	if o.exitAfter > 0 {
		t := clk.NewTimer(o.exitAfter)
		defer t.Stop()
		exit = t.C()
	}
	select {
	case <-ctx.Done():
		fmt.Fprintln(stderr, "iroha-dev: stopping (signal)")
	case <-stopped:
		fmt.Fprintln(stderr, "iroha-dev: stopping (stop_url)")
	case <-exit:
		fmt.Fprintf(stderr, "iroha-dev: stopping (--exit-after %s)\n", o.exitAfter)
	case <-served:
		return fmt.Errorf("Iroha stopped serving: %w", serveErr)
	}
	return nil
}

func envFile(o Output) string {
	var b strings.Builder
	set := func(name, value string) {
		fmt.Fprintf(&b, "%s='%s'\n", name, strings.ReplaceAll(value, "'", `'\''`))
	}
	set("IROHA_BASE", o.BaseURL)
	set("IROHA_ADMIN_TOKEN", o.AdminToken)
	set("IROHA_OWNER_PASSWORD", o.OwnerPassword)
	set("IROHA_STOP_URL", o.StopURL)
	set("IROHA_DATA_DIR", o.DataDir)
	for _, name := range sortedKeys(o.GatewayKeys) {
		set("IROHA_KEY_"+strings.ToUpper(name), o.GatewayKeys[name])
	}
	for _, sh := range sortedKeys(o.Fakes) {
		v := strings.ToUpper(strings.ReplaceAll(sh, "-", "_"))
		set("FAKE_"+v+"_URL", o.Fakes[sh].URL)
		set("FAKE_"+v+"_CONTROL", o.Fakes[sh].Control)
	}
	return b.String()
}

type healthz struct {
	UI bool `json:"ui"`
}

func waitReady(ctx context.Context, clk clock.Clock, c *client) (healthz, error) {
	var h healthz
	for i := 0; i < 200; i++ {
		if err := c.do(ctx, "GET", "/readyz", nil, &h); err == nil {
			return h, nil
		}
		if err := clock.Sleep(ctx, clk, 50*time.Millisecond); err != nil {
			return h, err
		}
	}
	return h, errors.New("Iroha did not become ready within 10 s; see the log file in the data dir")
}

func localOnly() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return nil, fmt.Errorf("iroha-dev refuses the outbound call to %s: only the localhost fakes are reachable", addr)
		}
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	return &http.Client{Transport: tr}
}

func repoint(ctx context.Context, c *client, old, now map[string]string) (int, error) {
	var provs struct {
		Providers []struct {
			Handle string `json:"handle"`
		} `json:"providers"`
	}
	if err := c.do(ctx, "GET", "/api/providers?limit=1000", nil, &provs); err != nil {
		return 0, err
	}
	moved := 0
	for _, p := range provs.Providers {
		var eps struct {
			Endpoints []struct {
				Name string `json:"name"`
				URL  string `json:"url"`
			} `json:"endpoints"`
		}
		if err := c.do(ctx, "GET", "/api/providers/"+p.Handle+"/endpoints", nil, &eps); err != nil {
			return moved, err
		}
		for _, e := range eps.Endpoints {
			for sh, origin := range old {
				if origin == "" || now[sh] == "" || !strings.HasPrefix(e.URL, origin+"/") {
					continue
				}
				url := now[sh] + strings.TrimPrefix(e.URL, origin)
				if err := c.do(ctx, "PATCH", "/api/providers/"+p.Handle+"/endpoints/"+e.Name, map[string]any{"url": url}, nil); err != nil {
					return moved, err
				}
				moved++
			}
		}
	}
	return moved, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
