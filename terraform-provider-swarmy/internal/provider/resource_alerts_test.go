package provider

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/config"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func alertsConfig(endpoint, channel, rule string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_notification_channel" "ops" {
%s
}
resource "swarmy_alert_rule" "disk" {
  channel_ids = [swarmy_notification_channel.ops.id]
%s
}
`, endpoint, channel, rule)
}

const (
	slackChannel = `  name    = "ops"
  kind    = "slack"
  url     = "https://hooks.slack.com/services/T0/B0/first"
  enabled = false`
	diskRule = `  name        = "Disk on wkr-1"
  signal      = "disk-usage"
  server      = "wkr-1"
  threshold   = 92.5
  for_seconds = 300`
)

func TestAlertRuleAndChannelLifecycle(t *testing.T) {
	f, srv := newFakeAlertsAPI(t)
	lastCall := func(prefix, want string) resource.TestCheckFunc {
		return func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			for i := len(f.calls) - 1; i >= 0; i-- {
				if strings.HasPrefix(f.calls[i], prefix) {
					if f.calls[i] != prefix+" "+want {
						return fmt.Errorf("last %s = %s", prefix, f.calls[i])
					}
					return nil
				}
			}
			return fmt.Errorf("no %s call", prefix)
		}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: alertsConfig(srv.URL, slackChannel, diskRule),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_notification_channel.ops", "enabled", "false"),
					resource.TestCheckResourceAttr("swarmy_notification_channel.ops", "target", "hooks.slack.com"),
					lastCall("POST /notification-channels", `{"config":{"kind":"slack","url":"https://hooks.slack.com/services/T0/B0/first"},"name":"ops"}`),
					lastCall("PATCH /notification-channels/no-1", `{"enabled":false}`),
					resource.TestCheckResourceAttr("swarmy_alert_rule.disk", "id", "al-2"),
					resource.TestCheckResourceAttr("swarmy_alert_rule.disk", "enabled", "true"),
					resource.TestCheckResourceAttr("swarmy_alert_rule.disk", "is_default", "false"),
					lastCall("POST /alert-rules", `{"channel_ids":["no-1"],"enabled":true,"for_seconds":300,"name":"Disk on wkr-1","selector":{"server":"wkr-1"},"signal":"disk-usage","threshold":92.5}`),
				),
			},
			{Config: alertsConfig(srv.URL, slackChannel, diskRule), PlanOnly: true},
			{
				// Changed in the dashboard: the refresh sees it (the destination can't be seen).
				PreConfig: func() { f.mu.Lock(); f.rules["al-2"]["threshold"] = 80.0; f.mu.Unlock() },
				Config:    alertsConfig(srv.URL, slackChannel, diskRule), PlanOnly: true, ExpectNonEmptyPlan: true,
			},
			{
				// No threshold now: sent as null. A rename alone never resends the destination.
				Config: alertsConfig(srv.URL, strings.Replace(slackChannel, `"ops"`, `"ops-alerts"`, 1),
					strings.Replace(diskRule, "threshold   = 92.5\n", "", 1)),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckNoResourceAttr("swarmy_alert_rule.disk", "threshold"),
					lastCall("PATCH /alert-rules/al-2", `{"channel_ids":["no-1"],"enabled":true,"for_seconds":300,"name":"Disk on wkr-1","selector":{"server":"wkr-1"},"threshold":null}`),
					lastCall("PATCH /notification-channels/no-1", `{"enabled":false,"name":"ops-alerts"}`),
				),
			},
			{
				// A new destination is sent once, kind unchanged.
				Config: alertsConfig(srv.URL, strings.Replace(slackChannel, "first", "second", 1), diskRule),
				Check: lastCall("PATCH /notification-channels/no-1",
					`{"config":{"kind":"slack","url":"https://hooks.slack.com/services/T0/B0/second"},"enabled":false,"name":"ops"}`),
			},
			{ResourceName: "swarmy_alert_rule.disk", ImportState: true, ImportStateVerify: true},
			{
				ResourceName: "swarmy_notification_channel.ops", ImportState: true, ImportStateVerify: true,
				ImportStateVerifyIgnore: []string{"url"},
			},
			{
				// A new signal is a new rule.
				Config: alertsConfig(srv.URL, strings.Replace(slackChannel, "first", "second", 1),
					strings.Replace(diskRule, `"disk-usage"`, `"node-offline"`, 1)),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("swarmy_alert_rule.disk", plancheck.ResourceActionDestroyBeforeCreate),
				}},
				Check: resource.TestCheckResourceAttr("swarmy_alert_rule.disk", "signal", "node-offline"),
			},
		},
		CheckDestroy: func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.rules)+len(f.channels) != 0 {
				return fmt.Errorf("left behind: %v %v", f.rules, f.channels)
			}
			return nil
		},
	})
}

// The shipped examples plan and apply against the fake.
func TestAlertExamples(t *testing.T) {
	_, srv := newFakeAlertsAPI(t)
	var cfg string
	for _, name := range []string{"swarmy_notification_channel", "swarmy_alert_rule"} {
		b, err := os.ReadFile("../../examples/resources/" + name + "/resource.tf")
		if err != nil {
			t.Fatal(err)
		}
		cfg += string(b)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:          fmt.Sprintf(testProvider, srv.URL) + cfg,
			ConfigVariables: config.Variables{"ops_slack_webhook": config.StringVariable("https://hooks.slack.com/services/T/B/x")},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr("swarmy_alert_rule.errors", "app", "shop"),
				resource.TestCheckResourceAttrPair("swarmy_alert_rule.errors", "channel_ids.0", "swarmy_notification_channel.ops", "id"),
			),
		}},
	})
}
