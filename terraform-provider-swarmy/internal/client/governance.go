package client

import (
	"context"
	"net/http"
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
