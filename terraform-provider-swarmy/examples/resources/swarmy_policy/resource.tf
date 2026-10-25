# Access policies (ABAC) on top of the seeded defaults. A forbid wins over
# every permit; no permit means deny. Managing them needs the policy.write
# permission (owners and admins by default). The controller compiles the
# document before saving and refuses a change that would leave no owner able
# to change rules.

# Nobody but owners removes anything in production.
resource "swarmy_policy" "no_prod_deletes" {
  name        = "No production deletes"
  description = "Only owners remove production services and apps"
  effect      = "forbid"
  priority    = 100
  source = jsonencode({
    roles      = ["admin", "member"]
    actions    = ["service.remove", "stack.remove", "data.destroy"]
    conditions = [{ attr = "resource.env", op = "eq", value = "production" }]
  })
}

# Let the SSO group "platform" restart any service.
resource "swarmy_policy" "platform_restarts" {
  name   = "Platform restarts"
  effect = "permit"
  source = jsonencode({
    groups        = ["platform"]
    actions       = ["service.restart"]
    resourceTypes = ["service"]
  })
}

# Import a policy by ID (a seeded default too: it can only be switched on/off):
#   terraform import swarmy_policy.platform_restarts <policy_id>
