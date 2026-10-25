# The org's guardrails: one swarmy_guardrails per org (the API key's org;
# the key's creator must be an admin or owner). Only the rules named in
# `rules` are managed; the others keep whatever the dashboard set. Every
# change is audited exactly as when it is clicked in the dashboard.
#
# Destroying this resource does NOT change the guardrails: they keep running
# as last applied (removing Terraform never weakens a safety rule).

resource "swarmy_guardrails" "org" {
  # Every rule blocks on production stacks (swarmy.env=production).
  production_safety_mode = true

  rules = {
    noLatestTagInProd  = { enabled = true, severity = "block" }
    minDbReplicasProd  = { enabled = true, severity = "block", params = { n = 2 } }
    requireHealthcheck = { enabled = true, severity = "warn" }
  }
}

# Adopt the org's current guardrails (the ID is the org id):
#   terraform import swarmy_guardrails.org <org_id>
