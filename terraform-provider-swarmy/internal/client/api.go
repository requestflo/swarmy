package client

import (
	"context"
	"fmt"
	"net/url"
)

// ---- Services ----

// CreateService dispatches an async service create (202). The returned ref's ID
// is the new service ID.
func (c *Client) CreateService(ctx context.Context, body CreateServiceRequest) (*DeploymentRef, error) {
	var ref DeploymentRef
	if err := c.post(ctx, "/services", body, &ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// GetService reads a single service by ID.
func (c *Client) GetService(ctx context.Context, id string) (*Service, error) {
	var s Service
	if err := c.get(ctx, "/services/"+url.PathEscape(id), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// ScaleService dispatches an async scale (202).
func (c *Client) ScaleService(ctx context.Context, id string, replicas int64) (*DeploymentRef, error) {
	var ref DeploymentRef
	if err := c.post(ctx, "/services/"+url.PathEscape(id)+"/scale", ScaleServiceRequest{Replicas: replicas}, &ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// RestartService dispatches an async restart/redeploy (202).
func (c *Client) RestartService(ctx context.Context, id string) (*DeploymentRef, error) {
	var ref DeploymentRef
	if err := c.post(ctx, "/services/"+url.PathEscape(id)+"/restart", nil, &ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// DeleteService removes a service.
func (c *Client) DeleteService(ctx context.Context, id string) error {
	return c.delete(ctx, "/services/"+url.PathEscape(id), nil)
}

// ---- Stacks ----

// DeployStack dispatches an async stack deploy (202).
func (c *Client) DeployStack(ctx context.Context, body DeployStackRequest) (*DeploymentRef, error) {
	var ref DeploymentRef
	if err := c.post(ctx, "/stacks", body, &ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// GetStack reads a single stack by ID.
func (c *Client) GetStack(ctx context.Context, id string) (*Stack, error) {
	var s Stack
	if err := c.get(ctx, "/stacks/"+url.PathEscape(id), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// DeleteStack removes a stack.
func (c *Client) DeleteStack(ctx context.Context, id string) error {
	return c.delete(ctx, "/stacks/"+url.PathEscape(id), nil)
}

// ---- Ingress domains ----

// AddDomain creates an ingress domain (plain CRUD).
func (c *Client) AddDomain(ctx context.Context, body AddDomainRequest) (*Domain, error) {
	var d Domain
	if err := c.post(ctx, "/ingress/domains", body, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// GetDomain reads a single ingress domain by ID. The list endpoint is the only
// read path exposed, so this filters the list client-side.
func (c *Client) GetDomain(ctx context.Context, id string) (*Domain, error) {
	domains, err := c.ListDomains(ctx)
	if err != nil {
		return nil, err
	}
	for i := range domains {
		if domains[i].ID == id {
			return &domains[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, RawBody: fmt.Sprintf("ingress domain %q not found", id)}
}

// ListDomains returns all ingress domains (single page; the API caps the set).
func (c *Client) ListDomains(ctx context.Context) ([]Domain, error) {
	var env listEnvelope[Domain]
	if err := c.get(ctx, "/ingress/domains", &env); err != nil {
		return nil, err
	}
	return env.Data, nil
}

// DeleteDomain removes an ingress domain.
func (c *Client) DeleteDomain(ctx context.Context, id string) error {
	return c.delete(ctx, "/ingress/domains/"+url.PathEscape(id), nil)
}

// ---- Nodes ----

// GetNode reads a single node by ID.
func (c *Client) GetNode(ctx context.Context, id string) (*Node, error) {
	var n Node
	if err := c.get(ctx, "/nodes/"+url.PathEscape(id), &n); err != nil {
		return nil, err
	}
	return &n, nil
}

// ListNodes returns all nodes.
func (c *Client) ListNodes(ctx context.Context) ([]Node, error) {
	var env listEnvelope[Node]
	if err := c.get(ctx, "/nodes", &env); err != nil {
		return nil, err
	}
	return env.Data, nil
}

// FindNodeByName returns the node with the given name, or a 404 APIError.
func (c *Client) FindNodeByName(ctx context.Context, name string) (*Node, error) {
	nodes, err := c.ListNodes(ctx)
	if err != nil {
		return nil, err
	}
	for i := range nodes {
		if nodes[i].Name == name {
			return &nodes[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, RawBody: fmt.Sprintf("node named %q not found", name)}
}

// ---- API keys ----
//
// The public REST spec does not yet ship an /api-keys endpoint; these methods
// follow the documented convention so the resource is usable once it lands.

// CreateAPIKey mints a new API key. The token is returned only on creation.
func (c *Client) CreateAPIKey(ctx context.Context, body CreateAPIKeyRequest) (*APIKey, error) {
	var k APIKey
	if err := c.post(ctx, "/api-keys", body, &k); err != nil {
		return nil, err
	}
	return &k, nil
}

// GetAPIKey reads an API key's metadata by ID (token is not returned again).
func (c *Client) GetAPIKey(ctx context.Context, id string) (*APIKey, error) {
	var k APIKey
	if err := c.get(ctx, "/api-keys/"+url.PathEscape(id), &k); err != nil {
		return nil, err
	}
	return &k, nil
}

// DeleteAPIKey revokes an API key.
func (c *Client) DeleteAPIKey(ctx context.Context, id string) error {
	return c.delete(ctx, "/api-keys/"+url.PathEscape(id), nil)
}
