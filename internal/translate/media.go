package translate

import (
	"context"
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/types"
)

// Media. RelayKit resolves every image or file part it converts to base64
// through a host hook, downloading URLs. Iroha downloads nothing on a
// Caller's behalf (no SSRF exposure, no memory spent on other people's
// files): a data URL is decoded in place, and a URL is carried through as a
// marker that the target codec turns back into the Shape's own URL source
// (Anthropic's {"type":"url"} image source).

// urlMarker prefixes a URL in RelayKit's base64 slot.
const urlMarker = "iroha-url:"

// resolveMedia is RelayKit's GetBase64Data hook: it returns base64 data and
// its MIME type.
func resolveMedia(_ context.Context, src types.FileSource, _ ...string) (string, string, error) {
	if src == nil {
		return "", "", errors.New("no media source")
	}
	if src.IsURL() {
		return urlMarker + src.GetRawData(), "", nil
	}
	raw := src.GetRawData()
	if strings.HasPrefix(raw, "data:") {
		mime, data, err := decodeDataURL(raw)
		return data, mime, err
	}
	mime := ""
	if b, ok := src.(*types.Base64Source); ok {
		mime = b.MimeType
	}
	return raw, mime, nil
}

// decodeDataURL splits "data:<mime>;base64,<data>" into the MIME type and
// the base64 data (RelayKit's DecodeBase64FileData hook). Bare base64 has
// no MIME type.
func decodeDataURL(s string) (string, string, error) {
	rest, ok := strings.CutPrefix(s, "data:")
	if !ok {
		return "", s, nil
	}
	head, data, ok := strings.Cut(rest, ",")
	if !ok {
		return "", "", errors.New("a data URL without a comma")
	}
	mime, _, _ := strings.Cut(head, ";")
	return mime, data, nil
}

// urlFromMarker returns the URL a marked base64 slot carries.
func urlFromMarker(data string) (string, bool) {
	return strings.CutPrefix(data, urlMarker)
}
