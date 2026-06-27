package swarmy

import "context"

// ServicesService groups service operations.
type ServicesService struct{ client *Client }

// List returns a page of services.
func (s *ServicesService) List(ctx context.Context, cursor string, limit int) (*ServiceList, error) {
	var out ServiceList
	if err := s.client.do(ctx, "GET", "/services", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single service.
func (s *ServicesService) Get(ctx context.Context, id string) (*Service, error) {
	var out Service
	if err := s.client.do(ctx, "GET", "/services/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a service. Returns a deployment reference (async, 202).
func (s *ServicesService) Create(ctx context.Context, body CreateServiceRequest) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Scale scales a service. Async (202).
func (s *ServicesService) Scale(ctx context.Context, id string, replicas int) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services/"+pathEscape(id)+"/scale", nil, ScaleServiceRequest{Replicas: replicas}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Restart restarts a service. Async (202).
func (s *ServicesService) Restart(ctx context.Context, id string) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services/"+pathEscape(id)+"/restart", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deletes a service.
func (s *ServicesService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/services/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate calls fn for every service across all pages, following next_cursor.
func (s *ServicesService) Iterate(ctx context.Context, limit int, fn func(Service) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// StacksService groups stack operations.
type StacksService struct{ client *Client }

// List returns a page of stacks.
func (s *StacksService) List(ctx context.Context, cursor string, limit int) (*StackList, error) {
	var out StackList
	if err := s.client.do(ctx, "GET", "/stacks", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single stack.
func (s *StacksService) Get(ctx context.Context, id string) (*Stack, error) {
	var out Stack
	if err := s.client.do(ctx, "GET", "/stacks/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Deploy deploys a stack from a compose document. Async (202).
func (s *StacksService) Deploy(ctx context.Context, body DeployStackRequest) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/stacks", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deletes a stack.
func (s *StacksService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/stacks/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate calls fn for every stack across all pages.
func (s *StacksService) Iterate(ctx context.Context, limit int, fn func(Stack) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// NodesService groups node operations.
type NodesService struct{ client *Client }

// List returns a page of nodes.
func (s *NodesService) List(ctx context.Context, cursor string, limit int) (*NodeList, error) {
	var out NodeList
	if err := s.client.do(ctx, "GET", "/nodes", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single node.
func (s *NodesService) Get(ctx context.Context, id string) (*Node, error) {
	var out Node
	if err := s.client.do(ctx, "GET", "/nodes/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate calls fn for every node across all pages.
func (s *NodesService) Iterate(ctx context.Context, limit int, fn func(Node) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// IngressService groups ingress-domain operations.
type IngressService struct{ client *Client }

// ListDomains returns a page of ingress domains.
func (s *IngressService) ListDomains(ctx context.Context, cursor string, limit int) (*IngressDomainList, error) {
	var out IngressDomainList
	if err := s.client.do(ctx, "GET", "/ingress/domains", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddDomain adds an ingress domain (201).
func (s *IngressService) AddDomain(ctx context.Context, body AddDomainRequest) (*IngressDomain, error) {
	var out IngressDomain
	if err := s.client.do(ctx, "POST", "/ingress/domains", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveDomain deletes an ingress domain.
func (s *IngressService) RemoveDomain(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/ingress/domains/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IterateDomains calls fn for every ingress domain across all pages.
func (s *IngressService) IterateDomains(ctx context.Context, limit int, fn func(IngressDomain) error) error {
	cursor := ""
	for {
		page, err := s.ListDomains(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}
