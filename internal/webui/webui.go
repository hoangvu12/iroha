// Package webui serves the Owner's UI embedded in the binary: the React app
// built from web/ into dist/, and the Iroha brand art in brand/.
package webui

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
)

//go:embed all:dist
var dist embed.FS

//go:embed brand
var brand embed.FS

// Built reports whether the real UI build is embedded.
func Built() bool {
	_, err := fs.Stat(dist, "dist/index.html")
	return err == nil
}

// Handler serves the UI. Files that exist are served as they are; any other
// path asked for by a browser page load (Accept: text/html) gets index.html,
// so the app's own routes (/providers, /requests/...) work on reload. Other
// misses get the API's JSON 404.
func Handler() http.Handler {
	app, _ := fs.Sub(dist, "dist")
	art, _ := fs.Sub(brand, "brand")
	index, err := fs.ReadFile(app, "index.html")
	if err != nil {
		index = []byte(placeholder)
	}
	indexTag := etag(index)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if rest, ok := strings.CutPrefix(p, "brand/"); ok {
			if serveFile(w, r, art, "brand", rest, "public, max-age=86400") {
				return
			}
		} else if p != "" && p != "index.html" {
			cache := "no-cache"
			if strings.HasPrefix(p, "assets/") {
				cache = "public, max-age=31536000, immutable" // file names carry a content hash
			}
			if serveFile(w, r, app, "dist", p, cache) {
				return
			}
		}
		if p == "" || p == "index.html" || wantsPage(r, p) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("ETag", indexTag)
			w.Header().Set("X-Frame-Options", "DENY")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
			return
		}
		// A missing file (an old tab asking for a chunk a deploy removed) is
		// never kept: Cloudflare caches a .js 404 for minutes otherwise.
		w.Header().Set("Cache-Control", "no-store")
		api.NotFoundHandler(w, r)
	})
}

func etag(b []byte) string {
	h := sha256.Sum256(b)
	return `"` + hex.EncodeToString(h[:10]) + `"`
}

var tags sync.Map

func tagOf(key string, b []byte) string {
	if t, ok := tags.Load(key); ok {
		return t.(string)
	}
	t := etag(b)
	tags.Store(key, t)
	return t
}

func wantsPage(r *http.Request, p string) bool {
	return path.Ext(p) == "" && strings.Contains(r.Header.Get("Accept"), "text/html")
}

func serveFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, root, name, cache string) bool {
	if !fs.ValidPath(name) {
		return false
	}
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		return false
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("ETag", tagOf(root+"/"+name, b))
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
	return true
}

const placeholder = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iroha</title><link rel="icon" href="/brand/iroha-avatar.png">
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;color:#171717;background:#fff}
code{background:#f2f2f2;padding:2px 4px;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#0e0e10;color:#ededed}code{background:#232326}}</style>
</head><body><img src="/brand/iroha-avatar.png" width="56" height="56" alt="" style="border-radius:50%">
<h1>Iroha is running</h1>
<p>This binary was built without its UI. The admin API works (<a href="/skill.md">/skill.md</a>).</p>
<p>To include the UI, run <code>npm --prefix web ci</code> and <code>npm --prefix web run build</code>, then build Iroha again.</p>
</body></html>
`
