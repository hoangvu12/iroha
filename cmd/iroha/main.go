// Command iroha runs the Iroha Gateway. Usage: iroha --data-dir DIR [--addr :8080].
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/server"
)

// version is set at build time: -ldflags "-X main.version=..."
var version = "dev"

func main() {
	cfg, err := config.Parse(os.Args[1:], os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		for _, line := range strings.Split(err.Error(), "\n") { // one line per bad value
			fmt.Fprintln(os.Stderr, "iroha:", line)
		}
		os.Exit(2)
	}
	if cfg.ShowVersion {
		fmt.Println(version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx, server.Options{Config: cfg, Version: version}); err != nil {
		fmt.Fprintln(os.Stderr, "iroha:", err)
		os.Exit(1)
	}
}
