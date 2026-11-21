package api

import (
	"context"
	"net/http"
	"strings"
)

type Actor struct {
	Kind string `json:"kind" enum:"admin_token,owner_session" doc:"How the caller authenticated."`
	ID   string `json:"id"`
	Name string `json:"name" doc:"Admin Token name, or \"Owner\" for a session."`
}

const (
	ActorAdminToken   = "admin_token"
	ActorOwnerSession = "owner_session"
)

type Authenticator interface {
	Authenticate(r *http.Request) (*Actor, error)
}

type AuthenticatorFunc func(r *http.Request) (*Actor, error)

func (f AuthenticatorFunc) Authenticate(r *http.Request) (*Actor, error) { return f(r) }

type actorKey struct{}

func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

func ActorFrom(ctx context.Context) (Actor, bool) {
	a, ok := ctx.Value(actorKey{}).(Actor)
	return a, ok
}

func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

var ErrMissingCredentials = &Error{
	Status:  http.StatusUnauthorized,
	Code:    "admin_token_missing",
	Message: "This admin route needs an Admin Token (or the Owner's browser session).",
	Hint:    "Send the header \"Authorization: Bearer <Admin Token>\". The first start of Iroha printed a bootstrap Admin Token to its console; ask the Owner for one if you have none.",
}
