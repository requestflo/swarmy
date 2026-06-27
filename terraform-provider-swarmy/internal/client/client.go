// Package client is a small typed HTTP client for the swarmy public REST API.
//
// It targets the "/api/v1" base path, authenticates with a bearer API key
// (Authorization: Bearer swk_…), encodes/decodes JSON request and response
// bodies, and maps RFC 9457 problem+json error responses onto APIError.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// userAgent identifies the provider in outbound requests.
const userAgent = "terraform-provider-swarmy"

// apiBasePath is the versioned base path all endpoints hang off.
const apiBasePath = "/api/v1"

// Client is a typed swarmy REST API client. It is safe for concurrent use.
type Client struct {
	// baseURL is the endpoint joined with the API base path, no trailing slash.
	baseURL string
	apiKey  string
	http    *http.Client
}

// Option customises a Client.
type Option func(*Client)

// WithHTTPClient overrides the underlying *http.Client (used in tests).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.http = h }
}

// New builds a Client for the given endpoint (e.g. "https://controller.example.com")
// and API key. The endpoint may include or omit the "/api/v1" base path and any
// trailing slash; both are normalised.
func New(endpoint, apiKey string, opts ...Option) (*Client, error) {
	base, err := normalizeBaseURL(endpoint)
	if err != nil {
		return nil, err
	}
	c := &Client{
		baseURL: base,
		apiKey:  apiKey,
		http:    http.DefaultClient,
	}
	for _, o := range opts {
		o(c)
	}
	return c, nil
}

// normalizeBaseURL strips a trailing slash, validates the URL, and appends the
// "/api/v1" base path unless it is already present.
func normalizeBaseURL(endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", fmt.Errorf("endpoint must not be empty")
	}
	endpoint = strings.TrimRight(endpoint, "/")
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("invalid endpoint %q: %w", endpoint, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid endpoint %q: must be an absolute URL with scheme and host", endpoint)
	}
	if !strings.HasSuffix(u.Path, apiBasePath) {
		u.Path = strings.TrimRight(u.Path, "/") + apiBasePath
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// resolve joins the API base URL with a path (which must start with "/").
func (c *Client) resolve(path string) string {
	return c.baseURL + path
}

// do performs an HTTP request. If body is non-nil it is JSON-encoded. On a 2xx
// response with out non-nil, the response body is JSON-decoded into out. Non-2xx
// responses are mapped onto *APIError.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.resolve(path), reqBody)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("performing request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseError(resp.StatusCode, raw)
	}

	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decoding response body: %w", err)
		}
	}
	return nil
}

// parseError turns a non-2xx response into an *APIError, decoding the
// problem+json body when present.
func parseError(status int, raw []byte) error {
	apiErr := &APIError{StatusCode: status, RawBody: string(raw)}
	if len(raw) > 0 {
		var p Problem
		if err := json.Unmarshal(raw, &p); err == nil && (p.Title != "" || p.Status != 0 || p.Type != "") {
			apiErr.Problem = &p
		}
	}
	return apiErr
}

// get performs a GET request and decodes the response into out.
func (c *Client) get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

// post performs a POST request with a JSON body and decodes the response into out.
func (c *Client) post(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

// delete performs a DELETE request and decodes the response into out (out may be nil).
func (c *Client) delete(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodDelete, path, nil, out)
}
