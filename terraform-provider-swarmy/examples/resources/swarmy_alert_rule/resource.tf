# Page ops when the shop's error rate stays above 5% for five minutes.
# Several rules may watch one signal, each narrowed to its own app/part or
# server; the seeded per-signal defaults keep covering everything else.
resource "swarmy_alert_rule" "errors" {
  name        = "Shop errors"
  signal      = "error-rate"
  app         = "shop"
  threshold   = 5
  for_seconds = 300
  channel_ids = [swarmy_notification_channel.ops.id]
}

# A server signal takes a server name instead:
# resource "swarmy_alert_rule" "disk" {
#   name      = "Disk on the database box"
#   signal    = "disk-usage"
#   server    = "db-1"
#   threshold = 90
# }

# Import a rule (a seeded default too) by ID; destroying an imported default
# opts the org out of it:
#   terraform import swarmy_alert_rule.errors <rule_id>
