# Where alert rules send. The destination (here the Slack webhook URL) is
# write-only: the controller stores it encrypted and never returns it, so
# Terraform keeps it from state and resends it only when it changes.

variable "ops_slack_webhook" {
  type      = string
  sensitive = true
}

resource "swarmy_notification_channel" "ops" {
  name = "ops"
  kind = "slack"
  url  = var.ops_slack_webhook
}

# A self-hosted ntfy topic, with an access token:
# resource "swarmy_notification_channel" "phone" {
#   name   = "on-call phone"
#   kind   = "ntfy"
#   server = "https://ntfy.example.com"
#   topic  = "swarmy-oncall"
#   token  = var.ntfy_token
# }

# Import an existing channel by ID (its destination is not recoverable):
#   terraform import swarmy_notification_channel.ops <channel_id>
