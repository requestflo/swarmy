package swarmy

import "testing"

const incidentJSON = `{"id":"inc 1","title":"Shop is down","status":"open","severity":"critical","summary":null,
	"opened_at":"2026-10-01T00:00:00.000Z","resolved_at":null,"duration_sec":60,"event_count":1,"last_event_at":null`

const alertEventJSON = `{"id":"ae1","rule_id":"ar1","rule_name":"Shop down","signal":"service-down","severity":"critical",
	"resource":"shop","message":"down","status":"resolved","notify":"sent","fired_at":"2026-10-01T00:00:00.000Z","resolved_at":"2026-10-01T00:05:00.000Z"}`

func TestIncidents(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *IncidentList
		cap := roundTrip(t, 200, `{"data":[`+incidentJSON+`}],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Incidents.List(bg, "open", 10)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/incidents", "limit=10&status=open", "")
		if len(out.Data) != 1 || out.Data[0].Severity != "critical" || out.Data[0].Summary != nil {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Get", func(t *testing.T) {
		var out *IncidentDetail
		cap := roundTrip(t, 200, incidentJSON+`,"events":[{"id":"e1","at":"2026-10-01T00:00:00.000Z","kind":"opened","message":"m","meta":{"x":1}}]}`,
			func(c *Client) (err error) {
				out, err = c.Incidents.Get(bg, "inc 1")
				return
			})
		expectRequest(t, cap, "GET", "/api/v1/incidents/inc%201", "", "")
		if len(out.Events) != 1 || out.Events[0].Meta["x"] != float64(1) {
			t.Errorf("detail = %+v", out)
		}
	})
	t.Run("Resolve", func(t *testing.T) {
		cap := roundTrip(t, 200, incidentJSON+`,"events":[]}`, func(c *Client) error {
			_, err := c.Incidents.Resolve(bg, "inc1", "Rolled back")
			return err
		})
		expectRequest(t, cap, "POST", "/api/v1/incidents/inc1/resolve", "", `{"message":"Rolled back"}`)
	})
}

func TestAlertEvents(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *AlertEventList
		cap := roundTrip(t, 200, `{"data":[`+alertEventJSON+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.AlertEvents.List(bg, "", 0)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/alert-events", "", "")
		if len(out.Data) != 1 || *out.Data[0].RuleName != "Shop down" {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Acknowledge", func(t *testing.T) {
		var out *AlertEvent
		cap := roundTrip(t, 200, alertEventJSON, func(c *Client) (err error) {
			out, err = c.AlertEvents.Acknowledge(bg, "ae1")
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/alert-events/ae1/acknowledge", "", "")
		if out.Status != "resolved" {
			t.Errorf("event = %+v", out)
		}
	})
}
