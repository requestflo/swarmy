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
