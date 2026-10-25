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

const policyJSON = `{"id":"p 1","name":"Members restart","description":null,"effect":"permit","source":"{\"roles\":[\"member\"]}",
	"priority":0,"enabled":true,"is_default":false,"sentence":"Members can restart","updated_at":"2026-10-01T00:00:00.000Z"}`

func TestPolicies(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *PolicyList
		cap := roundTrip(t, 200, `{"data":[`+policyJSON+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Policies.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/policies", "", "")
		if len(out.Data) != 1 || out.Data[0].Description != nil || out.Data[0].Source != `{"roles":["member"]}` {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Get", func(t *testing.T) {
		cap := roundTrip(t, 200, policyJSON, func(c *Client) error {
			_, err := c.Policies.Get(bg, "p 1")
			return err
		})
		expectRequest(t, cap, "GET", "/api/v1/policies/p%201", "", "")
	})
	body := PolicyRequest{Name: "Members restart", Effect: "permit", Source: `{"roles":["member"]}`, Priority: Ptr(0), Enabled: Ptr(false)}
	want := `{"name":"Members restart","effect":"permit","source":"{\"roles\":[\"member\"]}","priority":0,"enabled":false}`
	t.Run("Create", func(t *testing.T) {
		cap := roundTrip(t, 201, policyJSON, func(c *Client) error {
			_, err := c.Policies.Create(bg, body)
			return err
		})
		expectRequest(t, cap, "POST", "/api/v1/policies", "", want)
	})
	t.Run("Replace", func(t *testing.T) {
		cap := roundTrip(t, 200, policyJSON, func(c *Client) error {
			_, err := c.Policies.Replace(bg, "p1", body)
			return err
		})
		expectRequest(t, cap, "PUT", "/api/v1/policies/p1", "", want)
	})
	t.Run("Delete", func(t *testing.T) {
		cap := roundTrip(t, 200, `{"id":"p1","removed":true}`, func(c *Client) error {
			_, err := c.Policies.Delete(bg, "p1")
			return err
		})
		expectRequest(t, cap, "DELETE", "/api/v1/policies/p1", "", "")
	})
}
