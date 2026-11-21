package gateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/hoangvu12/iroha/internal/normalise"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
)

// Some Providers answer a failure with 200: OpenRouter with an error object
// in the body or an error event in the stream, Z.ai with an error event first
// in a stream, MiniMax with base_resp in the body.

const maxPeekEvents = 16

func failureBody(resp *http.Response) ([]byte, error) {
	return io.ReadAll(io.LimitReader(resp.Body, requests.MaxFailureBody))
}

func answerFailure(resp *http.Response, stream bool, norm normalise.Set, translated bool) (body []byte, embedded bool) {
	if body := embeddedError(resp, stream); body != nil {
		return body, true
	}
	if stream && isEventStream(resp.Header) {
		return nil, false
	}
	if body := normaliserFailure(resp, norm); body != nil {
		return body, false
	}
	if translated {
		return notJSON(resp), false
	}
	return nil, false
}

func embeddedError(resp *http.Response, stream bool) []byte {
	switch {
	case isEventStream(resp.Header):
		if stream {
			return streamError(resp)
		}
		return nil
	default:
		return bufferedError(resp)
	}
}

func streamError(resp *http.Response) []byte {
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	var seen []byte
	for range maxPeekEvents {
		ev, err := readEvent(br)
		seen = append(seen, ev...)
		if payload, ok := firstData(ev); ok {
			if rules.EmbeddedError(payload) {
				return capFailure(seen)
			}
			break
		}
		if err != nil {
			break
		}
	}
	resp.Body = readCloser{io.MultiReader(bytes.NewReader(seen), br), resp.Body}
	return nil
}

func bufferedError(resp *http.Response) []byte {
	return bufferedFailure(resp, rules.EmbeddedError)
}

func notJSON(resp *http.Response) []byte {
	return bufferedFailure(resp, func(b []byte) bool { return !json.Valid(b) })
}

func bufferedFailure(resp *http.Response, failed func([]byte) bool) []byte {
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err == nil && failed(data) {
		return capFailure(data)
	}
	var rest io.Reader = bytes.NewReader(data)
	if err != nil {
		rest = io.MultiReader(rest, errReader{err})
	} else {
		rest = io.MultiReader(rest, resp.Body)
	}
	resp.Body = readCloser{rest, resp.Body}
	return nil
}

func firstData(ev []byte) ([]byte, bool) {
	for _, line := range bytes.Split(ev, []byte("\n")) {
		if p, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r"), []byte("data:")); ok {
			return bytes.TrimSpace(p), true
		}
	}
	return nil, false
}

func capFailure(b []byte) []byte {
	if len(b) > requests.MaxFailureBody {
		return b[:requests.MaxFailureBody]
	}
	return b
}

type readCloser struct {
	io.Reader
	io.Closer
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }
