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

// Errors inside a 2xx answer. Some Providers answer a failure with 200: an
// error event as the first event of a stream (OpenRouter, Anthropic-style
// relays, Z.ai), or an error object in a 200 body (MiniMax's base_resp).
// Before anything reaches the Caller, such an answer is a failed Attempt like
// any other: the Failure Rules read it (rules.Classify reads a 2xx failure as
// the status its error stands for) and the Request moves on. Errors after
// the first chunk reached the Caller are ticket 17's (an error event in the
// Caller's Shape).

// maxPeekEvents bounds the comment-only events (": keep-alive") read past
// while looking for a stream's first data event.
const maxPeekEvents = 16

// How an Attempt reads an upstream answer for the Failure Rules. Attempts
// and the classify route (classify.go) both go through these two, so trying
// a failure by hand reads it exactly as the Gateway does.

// failureBody reads the body of a non-2xx answer, as much as an Attempt
// keeps.
func failureBody(resp *http.Response) ([]byte, error) {
	return io.ReadAll(io.LimitReader(resp.Body, requests.MaxFailureBody))
}

// answerFailure returns what makes a 2xx answer a failure, or nil when it is
// an answer to relay (resp.Body then reads from the start): an error inside
// it (embeddedError; a stream's first data event only when the Caller asked
// to stream), a whole answer a normaliser finds is a failure sent as a
// success (normaliseBody), or, when the answer must be translated, a whole
// body that is not JSON (an HTML page sent with 200), which the Failure
// Rules read as a 502.
func answerFailure(resp *http.Response, stream bool, norm normalise.Set, translated bool) []byte {
	if body := embeddedError(resp, stream); body != nil {
		return body
	}
	if stream && isEventStream(resp.Header) {
		return nil
	}
	if body := normaliseBody(resp, norm); body != nil {
		return body
	}
	if translated {
		return notJSON(resp)
	}
	return nil
}

// embeddedError returns the error a 2xx answer carries instead of an answer,
// or nil, leaving resp.Body to read from the start either way.
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

// streamError reads a stream up to its first data event. When that event is
// an error it returns the events read; otherwise it puts them back in front
// of the body and returns nil.
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

// bufferedError reads a whole 2xx body; it returns the body when it is an
// error and otherwise puts it back.
func bufferedError(resp *http.Response) []byte {
	return bufferedFailure(resp, rules.EmbeddedError)
}

// notJSON returns a whole 2xx body that is not JSON (an HTML page from a
// broken proxy or a login wall), or nil, putting it back. Translation needs
// JSON, so on a translated path such an answer is a failed Attempt; on
// passthrough it is relayed as it came.
func notJSON(resp *http.Response) []byte {
	return bufferedFailure(resp, func(b []byte) bool { return !json.Valid(b) })
}

// bufferedFailure reads a whole 2xx body; it returns the body when failed
// says it is a failure and otherwise puts it back.
func bufferedFailure(resp *http.Response, failed func([]byte) bool) []byte {
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err == nil && failed(data) {
		return capFailure(data)
	}
	var rest io.Reader = bytes.NewReader(data)
	if err != nil {
		rest = io.MultiReader(rest, errReader{err})
	} else {
		rest = io.MultiReader(rest, resp.Body) // anything past the limit
	}
	resp.Body = readCloser{rest, resp.Body}
	return nil
}

// firstData is the payload of an event's first data line.
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
