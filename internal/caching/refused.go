package caching

import (
	"regexp"
	"strings"
)

// Refused is the field of added that an Endpoint's error body refuses as
// unknown; "" when the body is no such refusal.
//
// Providers answer an unknown field with: OpenAI-compatible "Unrecognized
// request argument(s) supplied: x", OpenAI "Unknown parameter: 'x'" and "Unsupported
// parameter: 'x'", Go's `json: unknown field "x"`, Google's `Unknown name
// "x"`, pydantic (FastAPI, vLLM, Mistral) "Extra inputs are not permitted"
// with x in its loc, Anthropic "x.y: Extra inputs are not permitted", and
// JSON Schema's "('x' was unexpected)".
func Refused(body []byte, added []string) string {
	if len(added) == 0 {
		return ""
	}
	t := strings.ReplaceAll(strings.ToLower(string(body)), `\"`, `"`)
	var paths []string
	for _, m := range supplied.FindAllStringSubmatch(t, -1) {
		paths = append(paths, strings.Split(m[1], ",")...)
	}
	for _, re := range []*regexp.Regexp{unknownName, unsupported, extraPath, unexpected} {
		for _, m := range re.FindAllStringSubmatch(t, -1) {
			paths = append(paths, m[1])
		}
	}
	locs := loc.FindAllStringSubmatchIndex(t, -1)
	for i, m := range locs {
		end := len(t)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		if notPermitted.MatchString(t[m[1]:end]) { // this item's msg follows its loc
			paths = append(paths, strings.Join(strings.Split(t[m[2]:m[3]], ","), "."))
		}
	}
	for _, p := range paths {
		if name := namedIn(p, added); name != "" {
			return name
		}
	}
	return ""
}

var (
	supplied     = regexp.MustCompile(`unrecognized request arguments? supplied:\s*([^"\n}\]]+)`)
	unknownName  = regexp.MustCompile("unknown (?:parameter|field|name|argument)s?:?\\s*[\"'`]?([\\w.\\[\\]-]+)")
	unsupported  = regexp.MustCompile("unsupported (?:parameter|field|argument)s?:?\\s*[\"'`]?([\\w.\\[\\]-]+)")
	extraPath    = regexp.MustCompile(`([\w.\[\]-]+)\s*:\s*extra (?:inputs|fields) (?:are )?not permitted`)
	unexpected   = regexp.MustCompile(`\(["']([\w.-]+)["'] (?:was|were) unexpected\)`)
	loc          = regexp.MustCompile(`loc["']?\s*[:=]\s*[\[(]([^\])]*)[\])]`)
	notPermitted = regexp.MustCompile(`extra (?:inputs|fields) (?:are )?not permitted`)
	pathSep      = regexp.MustCompile("[.\\[\\]'\"`()\\s]+")
)

var addedBelowTopLevel = map[string]bool{"cache_control": true}

func namedIn(p string, added []string) string {
	var segs []string
	for _, s := range pathSep.Split(p, -1) {
		if s != "" {
			segs = append(segs, s)
		}
	}
	// pydantic's loc starts with "body".
	if len(segs) > 0 && segs[0] == "body" {
		segs = segs[1:]
	}
	for _, name := range added {
		for i, s := range segs {
			if s == name && (i == 0 || addedBelowTopLevel[name]) {
				return name
			}
		}
	}
	return ""
}
