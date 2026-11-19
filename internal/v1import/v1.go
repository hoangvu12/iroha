// Package v1import reads an Iroha v1 SQLite database and recreates the
// configuration the Owner holds in v2 through the admin API only: Providers,
// their Endpoints, Upstream Keys and Gateway Keys (spec "Migration from v1").
// It never writes to the v1 file and never prints a secret.
package v1import

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	_ "modernc.org/sqlite" // registers the pure-Go "sqlite" driver
)

// V1 is the configuration read from a v1 database, secrets decrypted.
type V1 struct {
	Providers   []V1Provider
	GatewayKeys []V1GatewayKey
	// Accounts counts v1 Upstream Accounts (not imported).
	Accounts int
	// CatalogOwnerEntries counts model catalog entries carrying an Owner
	// exclusion or override (not imported).
	CatalogOwnerEntries int
}

// V1Provider is one row of v1's providers table.
type V1Provider struct {
	ID, Handle, Name, BaseURL, LogoDomain, TemplateID string
	Enabled, Archived                                 bool
	AuthHeader, AuthPrefix                            string
	RequiresKey                                       bool
	ModelDiscovery                                    string // "" when v1 inherited the template's
	StaticHeaders                                     map[string]string
	RetryMaxAttempts                                  int
	// TransportChanged is true when a v1 transport setting (timeouts,
	// redirects, idempotency header) differs from v1's default.
	TransportChanged bool
	Keys             []V1Key
}

// V1Key is one row of v1's upstream_keys table.
type V1Key struct {
	ID, BaseURL, Secret, Health string
	InAccount                   bool
	ModelLists                  bool // allowed or denied model lists set
	Rewrites                    map[string]string
}

// V1GatewayKey is one row of v1's gateway_keys table.
type V1GatewayKey struct {
	ID, Name    string
	All         bool
	Scope       []V1ScopeEntry
	Revoked     bool
	CORSOrigins int
}

// V1ScopeEntry is one Provider of a v1 Gateway Key scope; Models nil means
// every model.
type V1ScopeEntry struct {
	ProviderID string   `json:"providerId"`
	Models     []string `json:"models"`
}

// ReadMasterKey reads IROHA_MASTER_KEY from a v1 .env file.
func ReadMasterKey(envFile string) (string, error) {
	b, err := os.ReadFile(envFile)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != "IROHA_MASTER_KEY" {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		return strings.TrimSpace(v), nil
	}
	return "", fmt.Errorf("%s has no IROHA_MASTER_KEY", envFile)
}

// Read opens the v1 SQLite file read-only and returns its configuration.
// Every stored secret must decrypt with masterKey, or Read fails without
// returning a partial result.
func Read(ctx context.Context, path, masterKey string) (*V1, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(10000)")
	dsn := "file:" + (&url.URL{Path: strings.ReplaceAll(path, `\`, "/")}).EscapedPath() + "?" + q.Encode()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	r := reader{ctx: ctx, db: db, key: strings.TrimSpace(masterKey)}
	return r.read()
}

type reader struct {
	ctx      context.Context
	db       *sql.DB
	key      string
	badCount int
}

// columns lists the columns of a table (v1 databases may predate later
// migrations, so optional columns are read only when present).
func (r *reader) columns(table string) (map[string]bool, error) {
	rows, err := r.db.QueryContext(r.ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	return out, rows.Err()
}

// col is column c when present, else the SQL default expression.
func col(cols map[string]bool, c, def string) string {
	if cols[c] {
		return "coalesce(" + c + ", " + def + ")"
	}
	return def
}

func (r *reader) read() (*V1, error) {
	pc, err := r.columns("providers")
	if err != nil {
		return nil, err
	}
	if !pc["handle"] || !pc["base_url"] {
		return nil, errors.New("this file is not an Iroha v1 database with Provider handles (table providers lacks handle or base_url); upgrade v1 first")
	}
	out := &V1{}
	byID := map[string]int{}
	rows, err := r.db.QueryContext(r.ctx, `SELECT id, handle, display_name, base_url, `+
		col(pc, "logo_domain", "''")+`, `+col(pc, "template_id", "''")+`, enabled, archived_at IS NOT NULL, `+
		col(pc, "auth_header", "'authorization'")+`, `+col(pc, "auth_prefix", "'Bearer '")+`, `+
		col(pc, "requires_upstream_key", "1")+`, `+col(pc, "model_discovery", "''")+`, `+
		col(pc, "static_headers_encrypted", "'[]'")+`, `+col(pc, "retry_max_attempts", "3")+`, `+
		col(pc, "connection_timeout_ms", "10000")+` = 10000 AND `+col(pc, "first_byte_timeout_ms", "20000")+` = 20000 AND `+
		col(pc, "non_streaming_total_timeout_ms", "120000")+` = 120000 AND `+col(pc, "streaming_idle_timeout_ms", "30000")+` = 30000 AND `+
		col(pc, "total_retry_timeout_ms", "30000")+` = 30000 AND `+col(pc, "redirect_allow_same_origin", "0")+` = 0 AND `+
		col(pc, "idempotency_header", "'Idempotency-Key'")+` = 'Idempotency-Key'
		FROM providers ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("read providers: %w", err)
	}
	for rows.Next() {
		var p V1Provider
		var headers string
		var transportDefault bool
		if err := rows.Scan(&p.ID, &p.Handle, &p.Name, &p.BaseURL, &p.LogoDomain, &p.TemplateID, &p.Enabled, &p.Archived,
			&p.AuthHeader, &p.AuthPrefix, &p.RequiresKey, &p.ModelDiscovery, &headers, &p.RetryMaxAttempts, &transportDefault); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read providers: %w", err)
		}
		p.TransportChanged = !transportDefault
		if p.StaticHeaders, err = r.staticHeaders(headers); err != nil {
			rows.Close()
			return nil, fmt.Errorf("provider %s static headers: %w", p.Handle, err)
		}
		byID[p.ID] = len(out.Providers)
		out.Providers = append(out.Providers, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	kc, err := r.columns("upstream_keys")
	if err != nil {
		return nil, err
	}
	rows, err = r.db.QueryContext(r.ctx, `SELECT id, provider_id, `+col(kc, "base_url", "''")+`, encrypted_key, health, `+
		col(kc, "account_id", "''")+` != '', `+col(kc, "allowed_models", "''")+`, `+col(kc, "denied_models", "''")+`, `+
		col(kc, "model_rewrites", "''")+` FROM upstream_keys ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("read upstream keys: %w", err)
	}
	for rows.Next() {
		var k V1Key
		var providerID, enc, allowed, denied, rewrites string
		if err := rows.Scan(&k.ID, &providerID, &k.BaseURL, &enc, &k.Health, &k.InAccount, &allowed, &denied, &rewrites); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read upstream keys: %w", err)
		}
		k.Secret = r.decrypt(enc)
		k.ModelLists = nonEmptyList(allowed) || nonEmptyList(denied)
		if rewrites != "" {
			_ = decodeJSON(rewrites, &k.Rewrites)
		}
		if i, ok := byID[providerID]; ok {
			out.Providers[i].Keys = append(out.Providers[i].Keys, k)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if r.badCount > 0 {
		return nil, fmt.Errorf("%d stored secrets cannot be read with this master key; use the IROHA_MASTER_KEY of the v1 installation the database came from", r.badCount)
	}

	gc, err := r.columns("gateway_keys")
	if err != nil {
		return nil, err
	}
	rows, err = r.db.QueryContext(r.ctx, `SELECT id, name, scope, `+col(gc, "access_mode", "'selected'")+`, revoked_at IS NOT NULL, `+
		col(gc, "cors_origins", "'[]'")+` FROM gateway_keys ORDER BY created_at, rowid`)
	if err != nil {
		return nil, fmt.Errorf("read gateway keys: %w", err)
	}
	for rows.Next() {
		var g V1GatewayKey
		var scope, mode, cors string
		if err := rows.Scan(&g.ID, &g.Name, &scope, &mode, &g.Revoked, &cors); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read gateway keys: %w", err)
		}
		g.All = mode == "all"
		if err := decodeJSON(scope, &g.Scope); err != nil {
			rows.Close()
			return nil, fmt.Errorf("gateway key %s scope: %w", g.ID, err)
		}
		var origins []string
		_ = decodeJSON(cors, &origins)
		g.CORSOrigins = len(origins)
		out.GatewayKeys = append(out.GatewayKeys, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := r.db.QueryRowContext(r.ctx, `SELECT count(*) FROM upstream_accounts`).Scan(&out.Accounts); err != nil {
		out.Accounts = 0 // table absent in very old files
	}
	if err := r.db.QueryRowContext(r.ctx, `SELECT count(*) FROM model_catalog_entries WHERE excluded != 0 OR overrides IS NOT NULL OR source IN ('owner_added', 'excluded')`).Scan(&out.CatalogOwnerEntries); err != nil {
		out.CatalogOwnerEntries = 0
	}
	return out, nil
}

// staticHeaders decrypts v1's static headers: a JSON array of {name, value},
// stored encrypted, or the literal "[]" default.
func (r *reader) staticHeaders(stored string) (map[string]string, error) {
	plain := stored
	if strings.HasPrefix(stored, cipherVersion+".") {
		plain = r.decrypt(stored)
	}
	var list []struct{ Name, Value string }
	if strings.TrimSpace(plain) != "" {
		if err := decodeJSON(plain, &list); err != nil {
			return nil, errors.New("not a list of {name, value}")
		}
	}
	m := map[string]string{}
	for _, h := range list {
		m[h.Name] = h.Value
	}
	return m, nil
}

// decrypt opens a v1 secret, counting failures instead of stopping so the
// caller reports them all at once.
func (r *reader) decrypt(stored string) string {
	s, err := Decrypt(r.key, stored)
	if err != nil {
		r.badCount++
		return ""
	}
	return s
}

const cipherVersion = "v1"

// Decrypt opens one secret stored by v1's SecretCipher: AES-256-GCM with
// key SHA-256(master key), stored as "v1.<iv>.<tag||ciphertext>" in
// unpadded base64url.
func Decrypt(masterKey, stored string) (string, error) {
	parts := strings.Split(stored, ".")
	if len(parts) != 3 || parts[0] != cipherVersion {
		return "", errors.New("unrecognised stored form")
	}
	iv, err1 := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	payload, err2 := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[2], "="))
	if err1 != nil || err2 != nil || len(iv) != 12 || len(payload) < 16 {
		return "", errors.New("truncated stored form")
	}
	gcm, err := newGCM(masterKey)
	if err != nil {
		return "", err
	}
	sealed := append(append([]byte{}, payload[16:]...), payload[:16]...)
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", errors.New("cannot be read with this master key")
	}
	return string(plain), nil
}

// Encrypt stores a secret as v1 did; tests use it to build v1 fixtures.
func Encrypt(masterKey, plain string, iv []byte) string {
	gcm, err := newGCM(masterKey)
	if err != nil {
		panic(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	payload := append(append([]byte{}, tag...), ct...)
	return cipherVersion + "." + base64.RawURLEncoding.EncodeToString(iv) + "." + base64.RawURLEncoding.EncodeToString(payload)
}

func newGCM(masterKey string) (cipher.AEAD, error) {
	key := sha256.Sum256([]byte(masterKey))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// decodeJSON decodes s into v; v1 sometimes stored JSON text as a JSON
// string, so a string is decoded once more.
func decodeJSON(s string, v any) error {
	var inner string
	if err := json.Unmarshal([]byte(s), &inner); err == nil {
		s = inner
	}
	return json.Unmarshal([]byte(s), v)
}

func nonEmptyList(s string) bool {
	var l []any
	return s != "" && decodeJSON(s, &l) == nil && len(l) > 0
}
