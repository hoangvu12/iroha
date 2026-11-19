// Package config reads Iroha's startup configuration from flags, then
// environment variables (IROHA_<FLAG>, upper case, dashes as underscores),
// then defaults. Everything else is runtime data in the database.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/store"
)

// Config is the startup configuration.
type Config struct {
	DataDir      string        // holds iroha.db; default: the binary's directory
	Addr         string        // listen address
	LogLevel     slog.Level    // minimum level for console and stored logs
	LogFormat    string        // "json" or "text" (console only)
	DrainTimeout time.Duration // how long shutdown waits for in-flight requests
	ShowVersion  bool
	// ModelsDev are the base URLs models.dev metadata is read from, in
	// order (each serves api.json and models.json). Empty: never read; the
	// flag's default is models.dev and its repository mirror.
	ModelsDev []string
	// LogoFavicons and LogoMakers are the URL templates logos are fetched
	// from: a site's favicon ({domain}) for Providers, a model maker's mark
	// ({maker}) for Model Pools. Empty: never fetched (lettered tiles); the
	// flags' defaults are Google's favicon service and models.dev.
	LogoFavicons string
	LogoMakers   string
}

// DefaultModelsDev is the default of --models-dev.
const DefaultModelsDev = "https://models.dev,https://raw.githubusercontent.com/anomalyco/models.dev/dev"

// Defaults of --logo-favicons and --logo-makers.
const (
	DefaultLogoFavicons = "https://www.google.com/s2/favicons?domain={domain}&sz=64"
	DefaultLogoMakers   = "https://models.dev/logos/{maker}.svg"
)

// DBPath is the SQLite file.
func (c Config) DBPath() string { return filepath.Join(c.DataDir, store.FileName) }

// Default listen address.
const DefaultAddr = ":8080"

// Parse reads args (without the program name) and getenv.
func Parse(args []string, getenv func(string) string, stderr io.Writer) (Config, error) {
	fs := flag.NewFlagSet("iroha", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var c Config
	var level string
	str := func(p *string, name, def, usage string) {
		if v := getenv(envName(name)); v != "" {
			def = v
		}
		fs.StringVar(p, name, def, usage+" (env "+envName(name)+")")
	}
	str(&c.DataDir, "data-dir", "", "directory holding iroha.db; default: the directory of the binary")
	str(&c.Addr, "addr", DefaultAddr, "address to listen on")
	str(&level, "log-level", "info", "minimum log level: debug, info, warn, error")
	str(&c.LogFormat, "log-format", "json", "console log format: json or text")
	drain := "30s"
	str(&drain, "drain-timeout", drain, "how long shutdown waits for in-flight requests")
	var modelsDev string
	str(&modelsDev, "models-dev", DefaultModelsDev, "comma-separated base URLs serving models.dev's api.json and models.json, tried in order, for model metadata; none to never read it")
	str(&c.LogoFavicons, "logo-favicons", DefaultLogoFavicons, "URL template Provider logos are fetched from, {domain} replaced by the logo domain; none to never fetch them")
	str(&c.LogoMakers, "logo-makers", DefaultLogoMakers, "URL template Model Pool logos are fetched from, {maker} replaced by the model maker; none to never fetch them")
	fs.BoolVar(&c.ShowVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if fs.NArg() > 0 {
		return c, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	switch strings.ToLower(level) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn", "warning":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		return c, fmt.Errorf("log-level: unknown level %q", level)
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		return c, fmt.Errorf("log-format: want json or text, got %q", c.LogFormat)
	}
	d, err := time.ParseDuration(drain)
	if err != nil || d < 0 {
		return c, fmt.Errorf("drain-timeout: %q is not a duration", drain)
	}
	c.DrainTimeout = d
	if strings.TrimSpace(modelsDev) != "none" {
		for _, u := range strings.Split(modelsDev, ",") {
			if u = strings.TrimSpace(u); u != "" {
				if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
					return c, fmt.Errorf("models-dev: %q is not an http(s) URL", u)
				}
				c.ModelsDev = append(c.ModelsDev, u)
			}
		}
	}
	for _, t := range []struct {
		p           *string
		flag, token string
	}{{&c.LogoFavicons, "logo-favicons", "{domain}"}, {&c.LogoMakers, "logo-makers", "{maker}"}} {
		v := strings.TrimSpace(*t.p)
		if v == "none" {
			*t.p = ""
			continue
		}
		if !strings.HasPrefix(v, "https://") && !strings.HasPrefix(v, "http://") || !strings.Contains(v, t.token) {
			return c, fmt.Errorf("%s: %q is not an http(s) URL containing %s", t.flag, v, t.token)
		}
		*t.p = v
	}
	if c.DataDir == "" && !c.ShowVersion {
		exe, err := os.Executable()
		if err != nil {
			return c, errors.New("data-dir: not set and the binary's directory is unknown")
		}
		c.DataDir = filepath.Dir(exe)
	}
	return c, nil
}

func envName(flagName string) string {
	return "IROHA_" + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
}
