resource "swarmy_api_key" "ci" {
  name   = "ci-deployer"
  scopes = ["read", "write"]
}

# The token is returned only on creation and stored (sensitive) in state.
output "ci_token" {
  value     = swarmy_api_key.ci.token
  sensitive = true
}

# Import an existing API key by ID (the token is NOT recoverable on import):
#   terraform import swarmy_api_key.ci key-abc123
