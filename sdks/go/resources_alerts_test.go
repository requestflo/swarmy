package swarmy

import "testing"

const alertRuleJSON = `{"id":"ar 1","name":"Disk","signal":"disk-usage","selector":{"server":"wkr-1"},"threshold":90.5,
	"for_seconds":300,"channel_ids":["ch1"],"enabled":true,"is_default":false,"muted_until":null,"created_at":"2026-10-01T00:00:00.000Z"}`

func TestAlertRules(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *AlertRuleList
		cap := roundTrip(t, 200, `{"data":[`+alertRuleJSON+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.AlertRules.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/alert-rules", "", "")
		if len(out.Data) != 1 || *out.Data[0].Threshold != 90.5 || out.Data[0].Selector.Server != "wkr-1" {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Get", func(t *testing.T) {
		cap := roundTrip(t, 200, alertRuleJSON, func(c *Client) error {
			_, err := c.AlertRules.Get(bg, "ar 1")
			return err
		})
		expectRequest(t, cap, "GET", "/api/v1/alert-rules/ar%201", "", "")
	})
	t.Run("Create", func(t *testing.T) {
		cap := roundTrip(t, 201, alertRuleJSON, func(c *Client) error {
			_, err := c.AlertRules.Create(bg, CreateAlertRuleRequest{
				Name: "Disk", Signal: "disk-usage", Selector: &AlertSelector{Server: "wkr-1"},
				Threshold: NullableValue(90.5), ForSeconds: Ptr(0), Enabled: Ptr(false),
			})
			return err
		})
		expectRequest(t, cap, "POST", "/api/v1/alert-rules", "",
			`{"name":"Disk","signal":"disk-usage","selector":{"server":"wkr-1"},"threshold":90.5,"for_seconds":0,"enabled":false}`)
	})
	t.Run("Update clears the threshold", func(t *testing.T) {
		cap := roundTrip(t, 200, alertRuleJSON, func(c *Client) error {
			_, err := c.AlertRules.Update(bg, "ar1", UpdateAlertRuleRequest{Threshold: Null[float64](), ChannelIds: []string{"ch2"}})
			return err
		})
		expectRequest(t, cap, "PATCH", "/api/v1/alert-rules/ar1", "", `{"threshold":null,"channel_ids":["ch2"]}`)
	})
	t.Run("Delete", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"ar1","removed":true}`, func(c *Client) (err error) {
			out, err = c.AlertRules.Delete(bg, "ar1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/alert-rules/ar1", "", "")
		if !out.Removed {
			t.Errorf("removed = %+v", out)
		}
	})
}

const channelJSON = `{"id":"ch1","name":"ops","kind":"slack","enabled":true,"target":"hooks.slack.com","has_secret":false,"created_at":"2026-10-01T00:00:00.000Z"}`

func TestNotificationChannels(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *NotificationChannelList
		cap := roundTrip(t, 200, `{"data":[`+channelJSON+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.NotificationChannels.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/notification-channels", "", "")
		if len(out.Data) != 1 || out.Data[0].Target != "hooks.slack.com" {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Get", func(t *testing.T) {
		cap := roundTrip(t, 200, channelJSON, func(c *Client) error {
			_, err := c.NotificationChannels.Get(bg, "ch 1")
			return err
		})
		expectRequest(t, cap, "GET", "/api/v1/notification-channels/ch%201", "", "")
	})
	t.Run("Create", func(t *testing.T) {
		cap := roundTrip(t, 201, channelJSON, func(c *Client) error {
			_, err := c.NotificationChannels.Create(bg, CreateNotificationChannelRequest{
				Name: "ops", Config: NotificationChannelConfig{Kind: "telegram", BotToken: "123:abc", ChatID: "-100"},
			})
			return err
		})
		expectRequest(t, cap, "POST", "/api/v1/notification-channels", "",
			`{"name":"ops","config":{"kind":"telegram","bot_token":"123:abc","chat_id":"-100"}}`)
	})
	t.Run("Update", func(t *testing.T) {
		cap := roundTrip(t, 200, channelJSON, func(c *Client) error {
			_, err := c.NotificationChannels.Update(bg, "ch1", UpdateNotificationChannelRequest{Enabled: Ptr(false)})
			return err
		})
		expectRequest(t, cap, "PATCH", "/api/v1/notification-channels/ch1", "", `{"enabled":false}`)
	})
	t.Run("Delete", func(t *testing.T) {
		cap := roundTrip(t, 200, `{"id":"ch1","removed":true}`, func(c *Client) error {
			_, err := c.NotificationChannels.Delete(bg, "ch1")
			return err
		})
		expectRequest(t, cap, "DELETE", "/api/v1/notification-channels/ch1", "", "")
	})
}
