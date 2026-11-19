package api

import (
	"context"
	"net/http"
	"strings"
)

// Actor is who is making an admin call. Audit Entries name it.
type Actor struct {
	Kind string `json:"kind" enum:"admin_token,owner_session" doc:"How the caller authenticated."`
	ID   string `json:"id"`
	Name string `json:"name" doc:"Admin Token name, or \"Owner\" for a session."`
}

// Actor kinds.
const (
	ActorAdminToken   = "admin_token"
	ActorOwnerSession = "owner_session"
)

// Authenticator recognises one kind of admin credential. It returns
// (nil, nil) when the request carries no credential of its kind, an *Error
// when it carries one that is refused, and the Actor otherwise.
type Authenticator interface {
	Authenticate(r *http.Request) (*Actor, error)
}

// AuthenticatorFunc adapts a function to Authenticator.
type AuthenticatorFunc func(r *http.Request) (*Actor, error)

func (f AuthenticatorFunc) Authenticate(r *http.Request) (*Actor, error) { return f(r) }

type actorKey struct{}

// WithActor stores the Actor in ctx.
func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFrom returns the Actor of an authenticated admin call.
func ActorFrom(ctx context.Context) (Actor, bool) {
	a, ok := ctx.Value(actorKey{}).(Actor)
	return a, ok
}

// BearerToken returns the token of an "Authorization: Bearer" header, or "".
func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// ErrMissingCredentials is returned when no Authenticator recognised the request.
var ErrMissingCredentials = &Error{
	Status:  http.StatusUnauthorized,
	Code:    "admin_token_missing",
	Message: "This admin route needs an Admin Token.",
	Hint:    "Send the header \"Authorization: Bearer <Admin Token>\". The first start of Iroha printed a bootstrap Admin Token to its console; ask the Owner for one if you have none.",
}
