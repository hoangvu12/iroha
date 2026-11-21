package translate

import (
	"context"
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/types"
)

// RelayKit's media hook can only return base64 and would download URLs.
// A URL is carried through behind urlMarker instead, and the target codec
// turns it back into the Shape's own URL source.

const urlMarker = "iroha-url:"

func resolveMedia(_ context.Context, src types.FileSource, _ ...string) (string, string, error) {
	if src == nil {
		return "", "", errors.New("no media source")
	}
	if src.IsURL() {
		// Gemini's converter needs a media type; Gemini's fileData does too.
		return urlMarker + src.GetRawData(), guessMIME(src.GetRawData()), nil
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

func urlFromMarker(data string) (string, bool) {
	return strings.CutPrefix(data, urlMarker)
}
