package testkit

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/api"
)

// Client sends HTTP requests to the test server. Every method fails the
// test on a transport error, so tests only deal with responses.
type Client struct {
	t     testing.TB
	srv   *Server
	Token string      // sent as a Bearer token when not empty
	Hdr   http.Header // extra headers on every request
}

// WithHeader returns a copy of the client that also sends key: value
// (e.g. x-api-key for Caller auth).
func (c *Client) WithHeader(key, value string) *Client {
	cp := *c
	cp.Hdr = c.Hdr.Clone()
	if cp.Hdr == nil {
		cp.Hdr = http.Header{}
	}
	cp.Hdr.Set(key, value)
	return &cp
}

func (c *Client) Get(path string) *Response            { return c.Do(http.MethodGet, path, nil) }
func (c *Client) Delete(path string) *Response         { return c.Do(http.MethodDelete, path, nil) }
func (c *Client) Post(path string, body any) *Response { return c.Do(http.MethodPost, path, body) }
func (c *Client) Put(path string, body any) *Response  { return c.Do(http.MethodPut, path, body) }
func (c *Client) Patch(path string, body any) *Response {
	return c.Do(http.MethodPatch, path, body)
}

// Do sends a request and reads the whole response. body may be nil, a
// string or []byte (sent as is), or anything else (sent as JSON). path is
// relative to the server URL unless it starts with http.
func (c *Client) Do(method, path string, body any) *Response {
	c.t.Helper()
	resp := c.Open(method, path, body)
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatalf("%s %s: reading body: %v", method, path, err)
	}
	return &Response{t: c.t, Method: method, Path: path, Status: resp.StatusCode, Header: resp.Header, Body: b}
}

// Open sends a request and returns the live response, for reading a stream
// as it arrives. The caller closes the body.
func (c *Client) Open(method, path string, body any) *http.Response {
	c.t.Helper()
	var r io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	case []byte:
		r = bytes.NewReader(b)
	default:
		j, err := json.Marshal(b)
		if err != nil {
			c.t.Fatalf("encode request body: %v", err)
		}
		r = bytes.NewReader(j)
		contentType = "application/json"
	}
	url := path
	if !strings.HasPrefix(path, "http") {
		url = c.srv.URL + path
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	for k, vs := range c.Hdr {
		req.Header[k] = vs
	}
	resp, err := c.srv.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

// Response is a fully read response.
type Response struct {
	t      testing.TB
	Method string
	Path   string
	Status int
	Header http.Header
	Body   []byte
}

// Expect fails the test unless the status is want. It returns r for chaining.
func (r *Response) Expect(want int) *Response {
	r.t.Helper()
	if r.Status != want {
		r.t.Fatalf("%s %s: status %d, want %d; body:\n%s", r.Method, r.Path, r.Status, want, r.Body)
	}
	return r
}

// OK fails the test unless the status is 2xx.
func (r *Response) OK() *Response {
	r.t.Helper()
	if r.Status < 200 || r.Status > 299 {
		r.t.Fatalf("%s %s: status %d, want 2xx; body:\n%s", r.Method, r.Path, r.Status, r.Body)
	}
	return r
}

// JSON decodes the body into v.
func (r *Response) JSON(v any) *Response {
	r.t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		r.t.Fatalf("%s %s: body is not the expected JSON: %v\n%s", r.Method, r.Path, err, r.Body)
	}
	return r
}

// Map decodes the body as a JSON object.
func (r *Response) Map() map[string]any {
	r.t.Helper()
	var m map[string]any
	r.JSON(&m)
	return m
}

// Text is the body as a string.
func (r *Response) Text() string { return string(r.Body) }

// Err decodes the admin API error envelope, failing if there is none.
func (r *Response) Err() api.Error {
	r.t.Helper()
	var b struct {
		Error *api.Error `json:"error"`
	}
	r.JSON(&b)
	if b.Error == nil {
		r.t.Fatalf("%s %s: no error envelope in body:\n%s", r.Method, r.Path, r.Body)
	}
	return *b.Error
}

// Event is one server-sent event.
type Event struct {
	Event string // the "event:" field, empty if none
	Data  string // "data:" lines joined by \n
}

// Events parses the body as server-sent events. Comment lines (keep-alives)
// are skipped.
func (r *Response) Events() []Event { return ParseSSE(r.Body) }

// ParseSSE parses server-sent events.
func ParseSSE(body []byte) []Event {
	var out []Event
	var cur Event
	var data []string
	has := false
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	flush := func() {
		if has {
			cur.Data = strings.Join(data, "\n")
			out = append(out, cur)
		}
		cur, data, has = Event{}, nil, false
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "event:"):
			cur.Event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			has = true
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			has = true
		}
	}
	flush()
	return out
}
