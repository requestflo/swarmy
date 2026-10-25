package swarmy

import "testing"

const guardrailsJSON = `{"org_id":"org1","production_safety_mode":true,"rules":[
	{"id":"minDbReplicasProd","enabled":true,"severity":"block","params":{"n":3},"prod_only":true}]}`

func TestGuardrails(t *testing.T) {
	t.Run("Get", func(t *testing.T) {
		var out *Guardrails
		cap := roundTrip(t, 200, guardrailsJSON, func(c *Client) (err error) {
			out, err = c.Guardrails.Get(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/guardrails", "", "")
		if !out.ProductionSafetyMode || out.Rules[0].Params["n"] != 3 {
			t.Errorf("guardrails = %+v", out)
		}
	})
	t.Run("Update", func(t *testing.T) {
		cap := roundTrip(t, 200, guardrailsJSON, func(c *Client) error {
			_, err := c.Guardrails.Update(bg, UpdateGuardrailsRequest{
				ProductionSafetyMode: Ptr(false),
				Rules:                []GuardrailRuleUpdate{{ID: "requireHealthcheck", Enabled: Ptr(false), Severity: "warn"}},
			})
			return err
		})
		expectRequest(t, cap, "PATCH", "/api/v1/guardrails", "",
			`{"production_safety_mode":false,"rules":[{"id":"requireHealthcheck","enabled":false,"severity":"warn"}]}`)
	})
}
