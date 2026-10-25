package swarmy

import "context"

// GuardrailsService groups the org's guardrails (/guardrails): the
// production-safety switch and the deploy-admission rules. One per org.
type GuardrailsService struct{ client *Client }

// Get returns the guardrails (seeded with the defaults on first read).
func (s *GuardrailsService) Get(ctx context.Context) (*Guardrails, error) {
	var out Guardrails
	if err := s.client.do(ctx, "GET", "/guardrails", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update changes the safety switch and/or the rules named in body (admins
// and owners); everything left out keeps its state.
func (s *GuardrailsService) Update(ctx context.Context, body UpdateGuardrailsRequest) (*Guardrails, error) {
	var out Guardrails
	if err := s.client.do(ctx, "PATCH", "/guardrails", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PoliciesService groups ABAC access policies (/policies). Writes need the
// policy.write permission (owners and admins by default).
type PoliciesService struct{ client *Client }

// List returns the org's policies, highest priority first (defaults seeded).
func (s *PoliciesService) List(ctx context.Context) (*PolicyList, error) {
	var out PolicyList
	if err := s.client.do(ctx, "GET", "/policies", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns one policy.
func (s *PoliciesService) Get(ctx context.Context, id string) (*Policy, error) {
	var out Policy
	if err := s.client.do(ctx, "GET", "/policies/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create adds a policy (201); its document is validated first.
func (s *PoliciesService) Create(ctx context.Context, body PolicyRequest) (*Policy, error) {
	var out Policy
	if err := s.client.do(ctx, "POST", "/policies", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Replace rewrites a policy (a seeded default may only be switched on or off).
func (s *PoliciesService) Replace(ctx context.Context, id string, body PolicyRequest) (*Policy, error) {
	var out Policy
	if err := s.client.do(ctx, "PUT", "/policies/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a custom policy (defaults cannot be deleted).
func (s *PoliciesService) Delete(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/policies/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
