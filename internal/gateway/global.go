package gateway

import (
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Global routes (ticket 12): the provider-scoped routes without the
// /providers/{handle} prefix, where the body names the model as
// <handle>/<model>. Everything else (auth, planning, Attempts, answers) is
// the provider-scoped route's.

const scopedPrefix = "/providers/{handle}"

const globalNote = "Global route: name the model as <provider handle>/<model ID>, e.g. acme/gpt-4o. It is split at the first slash and everything after it is the Provider's model ID, " +
	"slashes included (openrouter/meta-llama/llama-3.3-70b sends meta-llama/llama-3.3-70b to Provider openrouter). The answer's model field reads the name you sent. " +
	"A name without a slash is a Model Pool: the Pool's members are tried in order (each with its own model), sharing one Request budget; the answer names the Pool. " +
	"A model that is neither (or a Pool outside the key's scope) gets 400 invalid_model_id; GET /v1/models lists every Pool and model this Gateway Key may use. Otherwise this is " +
	"the provider-scoped route, as follows. "

// globalRoute is the global variant of a provider-scoped inference route
// whose Caller speaks sh. Mounting a Shape's global route is one line in
// Routes: `scoped, g.globalRoute(sh, scoped)`.
func (g *Gateway) globalRoute(sh shape.Shape, scoped api.Route) api.Route {
	if !strings.HasPrefix(scoped.Path, scopedPrefix+"/") {
		panic("gateway: global variant of a route outside " + scopedPrefix + ": " + scoped.Path)
	}
	r := scoped
	r.Path = strings.TrimPrefix(scoped.Path, scopedPrefix)
	r.Summary = strings.TrimSuffix(scoped.Summary, " to one Provider") + ", naming the model as <provider>/<model>"
	r.Description = globalNote + scoped.Description
	r.Raw = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { g.serve(w, req, sh, (*exchange).global) })
	return r
}

// splitModel splits a global model name at its first slash into a Provider
// handle and the Provider's model ID. ok is false when either part is empty.
func splitModel(name string) (handle, model string, ok bool) {
	handle, model, ok = strings.Cut(name, "/")
	return handle, model, ok && handle != "" && model != ""
}

// global resolves the model of a global route. Model addressing lives here
// and only here: a name without a slash is a Model Pool (pool.go), anything
// else <handle>/<model>.
func (x *exchange) global(caller gatewaykeys.Caller, name string) (route, *api.Error) {
	if !strings.Contains(name, "/") {
		return x.poolRoute(caller, name)
	}
	handle, model, ok := splitModel(name)
	if !ok {
		return route{}, errNotQualified(name)
	}
	return x.single(caller, handle, model, "Check the Provider handle before the slash in model")
}

// errNotQualified refuses a global model name that names no Provider and no
// Pool the Caller may use; an unknown Pool and one outside the Gateway Key's
// scope get exactly this answer.
func errNotQualified(name string) *api.Error {
	return api.Errorf(http.StatusBadRequest, "invalid_model_id",
		"Name the model as <provider handle>/<model ID>, e.g. acme/gpt-4o, or as a Model Pool this Gateway Key may use (GET /v1/models lists both), "+
			"or send the bare model ID to /providers/<handle>/v1/... instead.",
		"The model %q is neither <provider>/<model> nor a Model Pool this Gateway Key may use.", name)
}
