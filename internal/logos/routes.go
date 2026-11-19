package logos

import (
	"context"
	"errors"
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
	// PoolMaker is the logo value of the Pool addressed by name or ID: its
	// maker or a website (ReadPoolLogo), "" when none is known; an
	// *api.Error when there is no Pool.
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
			Summary:     "Read a Model Pool's logo: its model maker's, or a website's",
			Description: desc + " Set it with PATCH /api/pools/{pool} {\"maker\": ...}: a maker ID (openai) or a website (chatgpt.com).",
			Response:    "", ContentType: "image/*",
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				m, err := l.PoolMaker(r.Context(), r.PathValue("pool"))
				if err != nil {
					api.WriteError(w, api.AsError(err))
					return
				}
				img, err := s.Pool(r.Context(), m)
				serve(w, img, err, "Model Pool "+r.PathValue("pool"))
			}),
		},
		{
			Method: http.MethodGet, Path: "/api/logos", Tag: "Providers",
			Summary:     "Read the logo of a domain or a Model Pool's maker value, before setting it",
			Description: desc,
			Query: []api.Param{
				{Name: "domain", Description: "A site, e.g. alibabacloud.com: its logo as a Provider would show it."},
				{Name: "maker", Description: "What a Model Pool's maker field takes: a model maker (zhipuai) or a website (chatgpt.com, or a URL read for its host); its logo as the Pool would show it."},
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
					m, err := ReadPoolLogo(q.Get("maker"))
					if err != nil {
						api.WriteError(w, PoolLogoError(q.Get("maker"), err))
						return
					}
					img, err := s.Pool(r.Context(), m)
					serve(w, img, err, m)
				default:
					api.WriteError(w, api.BadRequest("Pass domain=<site> or maker=<maker ID>.", "Name a domain or a maker."))
				}
			}),
		},
	}
}

// PoolLogoError is the 400 for a Pool logo value ReadPoolLogo refused.
func PoolLogoError(value string, err error) *api.Error {
	v := strings.TrimSpace(value)
	if errors.Is(err, ErrBadDomain) {
		return api.BadRequest("Use a website such as chatgpt.com (no IP address or port), or a maker ID such as openai.", "%q is not a website's domain.", v)
	}
	return api.BadRequest("Use a maker ID such as anthropic, openai or zhipuai (letters, digits, '_', '-'), a website such as chatgpt.com, or \"\" to guess it.", "%q is not a maker ID.", v)
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
