package client

import (
	"context"
	"net/http"
	"net/url"
)

// ---- Guardrails (/guardrails) ----
//
// One per org: the production-safety switch and the deploy-admission rules.

// GuardrailRule mirrors the GuardrailRule DTO.
type GuardrailRule struct {
	ID       string           `json:"id"`
	Enabled  bool             `json:"enabled"`
	Severity string           `json:"severity"`
	Params   map[string]int64 `json:"params"`
	ProdOnly bool             `json:"prod_only"`
}

// Guardrails mirrors the Guardrails DTO (GET/PATCH /guardrails).
type Guardrails struct {
	OrgID                string          `json:"org_id"`
	ProductionSafetyMode bool            `json:"production_safety_mode"`
	Rules                []GuardrailRule `json:"rules"`
}

// Rule returns the rule with that id, or nil.
func (g *Guardrails) Rule(id string) *GuardrailRule {
	for i := range g.Rules {
		if g.Rules[i].ID == id {
			return &g.Rules[i]
		}
	}
	return nil
}

// GuardrailRuleUpdate is one rule of the PATCH body; params are merged.
type GuardrailRuleUpdate struct {
	ID       string           `json:"id"`
	Enabled  bool             `json:"enabled"`
	Severity string           `json:"severity"`
	Params   map[string]int64 `json:"params,omitempty"`
}

// GuardrailsUpdate is the PATCH /guardrails body. Rules not named keep their state.
type GuardrailsUpdate struct {
	ProductionSafetyMode bool                  `json:"production_safety_mode"`
	Rules                []GuardrailRuleUpdate `json:"rules"`
}

// GetGuardrails reads the org's guardrails (seeded with the defaults on first read).
func (c *Client) GetGuardrails(ctx context.Context) (*Guardrails, error) {
	var out Guardrails
	if err := c.get(ctx, "/guardrails", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateGuardrails writes the switch and the named rules (admins and owners)
// and returns the guardrails as they now are.
func (c *Client) UpdateGuardrails(ctx context.Context, body GuardrailsUpdate) (*Guardrails, error) {
	if body.Rules == nil {
		body.Rules = []GuardrailRuleUpdate{}
	}
	var out Guardrails
	if err := c.do(ctx, http.MethodPatch, "/guardrails", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- Access policies (/policies) ----

// Policy mirrors the Policy DTO.
type Policy struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Effect      string  `json:"effect"`
	Source      string  `json:"source"`
	Priority    int64   `json:"priority"`
	Enabled     bool    `json:"enabled"`
	IsDefault   bool    `json:"is_default"`
	Sentence    string  `json:"sentence"`
	UpdatedAt   string  `json:"updated_at"`
}

// PolicyWrite is the POST/PUT /policies body: the whole rule (a description
// left out is cleared on update).
type PolicyWrite struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	Effect      string  `json:"effect"`
	Source      string  `json:"source"`
	Priority    int64   `json:"priority"`
	Enabled     bool    `json:"enabled"`
}

// CreatePolicy adds a policy (201); the controller validates the document.
func (c *Client) CreatePolicy(ctx context.Context, body PolicyWrite) (*Policy, error) {
	var out Policy
	if err := c.post(ctx, "/policies", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPolicy reads one policy.
func (c *Client) GetPolicy(ctx context.Context, id string) (*Policy, error) {
	var out Policy
	if err := c.get(ctx, "/policies/"+url.PathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReplacePolicy rewrites a policy in place.
func (c *Client) ReplacePolicy(ctx context.Context, id string, body PolicyWrite) (*Policy, error) {
	var out Policy
	if err := c.do(ctx, http.MethodPut, "/policies/"+url.PathEscape(id), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeletePolicy removes a custom policy.
func (c *Client) DeletePolicy(ctx context.Context, id string) error {
	return c.delete(ctx, "/policies/"+url.PathEscape(id), nil)
}
