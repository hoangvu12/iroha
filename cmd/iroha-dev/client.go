package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
)

// client calls the running Iroha over HTTP, as an agent would.
type client struct {
	base  string
	token string
	http  *http.Client
}

// as returns a client sending token instead.
func (c *client) as(token string) *client {
	return &client{base: c.base, token: token, http: c.http}
}

// do sends body as JSON and decodes the answer into out (when not nil). A
// status that is not 2xx is an error quoting the answer.
func (c *client) do(ctx context.Context, method, path string, body, out any) error {
	_, err := c.send(ctx, method, path, body, out, 200, 201)
	return err
}

func (c *client) send(ctx context.Context, method, path string, body, out any, want ...int) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, err
	}
	if len(want) > 0 && !slices.Contains(want, resp.StatusCode) {
		if len(b) > 500 {
			b = append(b[:500], "..."...)
		}
		return resp.StatusCode, fmt.Errorf("%s %s answered %d: %s", method, path, resp.StatusCode, bytes.TrimSpace(b))
	}
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			return resp.StatusCode, fmt.Errorf("%s %s: %w", method, path, err)
		}
	}
	return resp.StatusCode, nil
}
