package logos

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
)

// Lookups find what to draw for a record the UI names.
type Lookups struct {
	// ProviderDomain is the logo domain of the Provider addressed by handle
	// or ID ("" when it has none); an *api.Error when there is no Provider.
	ProviderDomain func(ctx context.Context, ref string) (string, error)
	// PoolMaker is the maker of the Pool addressed by name or ID ("" when
	// none is known); an *api.Error when there is no Pool.
	PoolMaker func(ctx context.Context, ref string) (string, error)
}

// Routes serves logos: a Provider's, a Pool's, and any domain's or maker's
// (to preview a change before saving it).
func Routes(s *Service, l Lookups) []api.Route {
	const desc = "Answers the image (PNG, ICO, SVG...) fetched by Iroha and cached for a day, or 404 logo_unavailable when there is none; draw the first letter of the name then. Iroha serves every logo itself, so the browser never loads a third-party image."
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/providers/{provider}/logo", Tag: "Providers",
			Summary:     "Read a Provider's logo, found from its logo domain",
			Description: desc + " Set the domain with PATCH /api/providers/{provider} {\"logo_domain\": ...}.",
			Response:    "", ContentType: "image/*",
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				d, err := l.ProviderDomain(r.Context(), r.PathValue("provider"))
				if err != nil {
					api.WriteError(w, api.AsError(err))
					return
				}
				img, err := s.Domain(r.Context(), d)
				serve(w, img, err, "Provider "+r.PathValue("provider"))
			}),
		},
		{
			Method: http.MethodGet, Path: "/api/pools/{pool}/logo", Tag: "Model Pools",
			Summary:     "Read a Model Pool's logo: its model maker's",
			Description: desc + " Set the maker with PATCH /api/pools/{pool} {\"maker\": ...}.",
			Response:    "", ContentType: "image/*",
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				m, err := l.PoolMaker(r.Context(), r.PathValue("pool"))
				if err != nil {
					api.WriteError(w, api.AsError(err))
					return
				}
				img, err := s.Maker(r.Context(), m)
				serve(w, img, err, "Model Pool "+r.PathValue("pool"))
			}),
		},
		{
			Method: http.MethodGet, Path: "/api/logos", Tag: "Providers",
			Summary:     "Read the logo of a domain or a model maker, before setting it",
			Description: desc,
			Query: []api.Param{
				{Name: "domain", Description: "A site, e.g. alibabacloud.com: its logo as a Provider would show it."},
				{Name: "maker", Description: "A model maker, e.g. zhipuai: its logo as a Model Pool would show it."},
			},
			Response: "", ContentType: "image/*",
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				switch {
				case q.Get("domain") != "":
					d, err := NormalizeDomain(q.Get("domain"))
					if err != nil {
						api.WriteError(w, api.BadRequest("Use a site's domain such as alibabacloud.com.", "domain %q is not a domain.", q.Get("domain")))
						return
					}
					img, err := s.Domain(r.Context(), d)
					serve(w, img, err, d)
				case q.Get("maker") != "":
					m := strings.ToLower(strings.TrimSpace(q.Get("maker")))
					if !CheckMaker(m) {
						api.WriteError(w, api.BadRequest("Use a maker ID such as anthropic, openai or zhipuai.", "maker %q is not valid.", m))
						return
					}
					img, err := s.Maker(r.Context(), m)
					serve(w, img, err, m)
				default:
					api.WriteError(w, api.BadRequest("Pass domain=<site> or maker=<maker ID>.", "Name a domain or a maker."))
				}
			}),
		},
	}
}

func serve(w http.ResponseWriter, img *Image, err error, what string) {
	if err != nil || img == nil {
		w.Header().Set("Cache-Control", "private, max-age=60")
		api.WriteError(w, api.Errorf(http.StatusNotFound, "logo_unavailable",
			"Draw the first letter of the name instead; set another logo domain (Providers) or maker (Model Pools) to try a different logo.",
			"No logo was found for %s.", what))
		return
	}
	h := w.Header()
	h.Set("Content-Type", img.Type)
	h.Set("Content-Length", strconv.Itoa(len(img.Body)))
	h.Set("Cache-Control", "private, max-age=3600")
	h.Set("X-Content-Type-Options", "nosniff")
	// An SVG opened on its own must not run anything.
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(img.Body)
}
