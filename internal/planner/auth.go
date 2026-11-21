package planner

import (
	"fmt"
	"net/http"
	"net/url"
)

type AuthStyle string

// The empty style is AuthBearer.
const (
	AuthBearer  AuthStyle = "bearer"
	AuthXAPIKey AuthStyle = "x-api-key"
	AuthHeader  AuthStyle = "header"
	AuthQuery   AuthStyle = "query"
	AuthNone    AuthStyle = "none"
)

var AuthStyles = []AuthStyle{AuthBearer, AuthXAPIKey, AuthHeader, AuthQuery, AuthNone}

func (s AuthStyle) Known() bool {
	switch s {
	case "", AuthBearer, AuthXAPIKey, AuthHeader, AuthQuery, AuthNone:
		return true
	}
	return false
}

// Slot returns "" for AuthQuery and AuthNone.
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
// secret goes into u's query for AuthQuery.
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
