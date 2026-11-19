// Command iroha-import-v1 recreates an Iroha v1 installation's Providers,
// Endpoints, Upstream Keys and Gateway Keys in Iroha v2 through the v2 admin
// API. It reads a copy of v1's SQLite file (never writing to it) and is a dry
// run unless --apply is given. See "Moving from v1" in /skill.md.
//
//	IROHA_ADMIN_TOKEN=... iroha-import-v1 --v1-db ./v1-copy/iroha.db --v1-env ./v1-copy/.env --url http://127.0.0.1:8080 [--apply]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/v1import"
)

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(args []string, env func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("iroha-import-v1", flag.ContinueOnError)
	fs.SetOutput(stderr)
	db := fs.String("v1-db", "", "path to a copy of v1's iroha.db (with its -wal and -shm files beside it)")
	envFile := fs.String("v1-env", "", "v1's .env file to read IROHA_MASTER_KEY from (else the IROHA_V1_MASTER_KEY variable)")
	base := fs.String("url", "http://127.0.0.1:8080", "base URL of the v2 instance")
	apply := fs.Bool("apply", false, "import; without it nothing is changed and the output says what would be")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: IROHA_ADMIN_TOKEN=<v2 Admin Token> iroha-import-v1 --v1-db FILE [--v1-env FILE] [--url URL] [--apply]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	fail := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "iroha-import-v1: "+format+"\n", a...)
		return 2
	}
	if *db == "" {
		return fail("--v1-db is required")
	}
	token := strings.TrimSpace(env("IROHA_ADMIN_TOKEN"))
	if token == "" {
		return fail("set IROHA_ADMIN_TOKEN to a v2 Admin Token (not a flag, so it stays out of shell history)")
	}
	if u, err := url.Parse(*base); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fail("--url must be an http(s) base URL such as http://127.0.0.1:8080")
	}
	key := strings.TrimSpace(env("IROHA_V1_MASTER_KEY"))
	if *envFile != "" {
		k, err := v1import.ReadMasterKey(*envFile)
		if err != nil {
			return fail("%v", err)
		}
		key = k
	}
	if key == "" {
		return fail("give v1's master key with --v1-env or IROHA_V1_MASTER_KEY")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	rep, err := v1import.Run(ctx, v1import.Options{
		V1DB: *db, MasterKey: key, URL: *base, Token: token, Apply: *apply,
		HTTP: &http.Client{Timeout: 2 * time.Minute}, Out: stdout,
	})
	if err != nil {
		fmt.Fprintln(stderr, "iroha-import-v1:", err)
		return 1
	}
	if rep.Failed() > 0 {
		return 1
	}
	return 0
}
