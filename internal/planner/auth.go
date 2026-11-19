package planner

import (
	"fmt"
	"net/http"
	"net/url"
)

// AuthStyle is how an Endpoint sends an Upstream Key's secret.
type AuthStyle string

// Auth styles of an Endpoint. The empty style is AuthBearer.
const (
	AuthBearer  AuthStyle = "bearer"    // Authorization: Bearer <secret>
	AuthXAPIKey AuthStyle = "x-api-key" // x-api-key: <secret>
	AuthHeader  AuthStyle = "header"    // <AuthParam>: <secret>
	AuthQuery   AuthStyle = "query"     // ?<AuthParam>=<secret>
	AuthNone    AuthStyle = "none"      // nothing, whatever the key holds
)

// AuthStyles lists every auth style.
var AuthStyles = []AuthStyle{AuthBearer, AuthXAPIKey, AuthHeader, AuthQuery, AuthNone}

// Known reports whether s is an auth style this version of Iroha applies.
func (s AuthStyle) Known() bool {
	switch s {
	case "", AuthBearer, AuthXAPIKey, AuthHeader, AuthQuery, AuthNone:
		return true
	}
	return false
}

// Slot is the header style s writes the secret into, named param for
// AuthHeader, and the text before the secret; "" for AuthQuery and AuthNone.
func (s AuthStyle) Slot(param string) (header, prefix string) {
	switch s {
	case "", AuthBearer:
		return "Authorization", "Bearer "
	case AuthXAPIKey:
		return "X-Api-Key", ""
	case AuthHeader:
		return param, ""
	}
	return "", ""
}

// CheckAuth reports an Endpoint whose auth style cannot be applied.
func (e *Endpoint) CheckAuth() error {
	if !e.AuthStyle.Known() {
		return fmt.Errorf("Endpoint %s uses auth style %q, which this version of Iroha cannot apply", e.Name, e.AuthStyle)
	}
	if (e.AuthStyle == AuthHeader || e.AuthStyle == AuthQuery) && e.AuthParam == "" {
		return fmt.Errorf("Endpoint %s uses auth style %s without auth_param", e.Name, e.AuthStyle)
	}
	return nil
}

// Authorize prepares an outbound request to e for key k: the Endpoint's
// static headers over h (an empty value sends no such header), then k's
// secret per e's auth style, over anything already in that slot. A keyless
// key (Key.Keyless) sends no credential, and its slot header is removed. The
// secret goes into u's query for AuthQuery. Every outbound call (Attempts,
// key tests, discovery) uses it, so they send a key the same way.
func (e *Endpoint) Authorize(h http.Header, u *url.URL, k *Key) {
	for name, v := range e.StaticHeaders {
		if v == "" {
			h.Del(name)
		} else {
			h.Set(name, v)
		}
	}
	slot, prefix := e.AuthStyle.Slot(e.AuthParam)
	if k.Keyless(e) {
		if slot != "" {
			h.Del(slot)
		}
		return
	}
	if e.AuthStyle == AuthQuery {
		q := u.Query()
		q.Set(e.AuthParam, k.Secret)
		u.RawQuery = q.Encode()
		return
	}
	if slot != "" {
		h.Set(slot, prefix+k.Secret)
	}
}
