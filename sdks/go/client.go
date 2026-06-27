// Package swarmy is the official Go client for the swarmy public REST API.
package swarmy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const apiPrefix = "/api/v1"

// APIError is returned for any non-2xx response. It carries the parsed
// RFC 9457 application/problem+json document.
type APIError struct {
	Status  int
	Problem Problem
}

// Code returns the swarmy-specific machine code, if present.
func (e *APIError) Code() string { return e.Problem.SwarmyCode }

func (e *APIError) Error() string {
	if e.Problem.Detail != "" {
		return e.Problem.Detail
	}
	if e.Problem.Title != "" {
		return e.Problem.Title
	}
	return fmt.Sprintf("swarmy API error %d", e.Status)
}

// Client is the swarmy API client.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	headers    map[string]string

	Services *ServicesService
	Stacks   *StacksService
	Nodes    *NodesService
	Ingress  *IngressService
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient overrides the underlying *http.Client.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.httpClient = hc }
}

// WithHeader adds a header sent on every request.
func WithHeader(key, value string) Option {
	return func(c *Client) { c.headers[key] = value }
}

// NewClient builds a Client. endpoint is the controller base URL
// (e.g. "https://swarm.example.com"); apiKey is the "swk_…" key.
func NewClient(endpoint, apiKey string, opts ...Option) (*Client, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("swarmy: endpoint is required")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("swarmy: apiKey is required")
	}
	trimmed := strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(trimmed, apiPrefix) {
		trimmed += apiPrefix
	}
	c := &Client{
		baseURL:    trimmed,
		apiKey:     apiKey,
		httpClient: http.DefaultClient,
		headers:    map[string]string{},
	}
	for _, o := range opts {
		o(c)
	}
	c.Services = &ServicesService{client: c}
	c.Stacks = &StacksService{client: c}
	c.Nodes = &NodesService{client: c}
	c.Ingress = &IngressService{client: c}
	return c, nil
}

// buildURL joins the base URL, path, and optional query params.
func (c *Client) buildURL(path string, query url.Values) string {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// listValues builds the standard pagination query.
func listValues(cursor string, limit int) url.Values {
	v := url.Values{}
	if cursor != "" {
		v.Set("cursor", cursor)
	}
	if limit > 0 {
		v.Set("limit", strconv.Itoa(limit))
	}
	return v
}

// do performs a request, decoding the JSON response into out (if non-nil) and
// mapping non-2xx responses to *APIError.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("swarmy: marshal body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.buildURL(path, query), reader)
	if err != nil {
		return fmt.Errorf("swarmy: new request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json, application/problem+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("swarmy: do request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("swarmy: read body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var p Problem
		if jsonErr := json.Unmarshal(data, &p); jsonErr != nil || p.Title == "" {
			p = Problem{Type: "about:blank", Title: resp.Status, Status: resp.StatusCode}
		}
		return &APIError{Status: resp.StatusCode, Problem: p}
	}

	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("swarmy: decode response: %w", err)
		}
	}
	return nil
}

func pathEscape(s string) string { return url.PathEscape(s) }
