# Minting a join token needs an admin's API key with the write scope.
resource "swarmy_join_token" "workers" {
  label       = "autoscaling workers"
  ttl_seconds = 86400 # 1 day (default 1 h, at most 7 days)
  max_uses    = 10    # forced to 1 while the org runs a mesh
  profile     = "edge"
}

# Feed the install one-liner to new servers, e.g. as cloud-init user data.
# token (and mesh_setup_key, when the org runs a mesh) are sensitive and only
# known in the state of the apply that created them.
locals {
  swarmy_install = join(" ", compact([
    "curl -fsSL ${swarmy_join_token.workers.install_url}/install/loader.sh |",
    "SWARMY_JOIN_TOKEN=${swarmy_join_token.workers.token}",
    swarmy_join_token.workers.mesh_setup_key != null ? "SWARMY_MESH_SETUP_KEY=${swarmy_join_token.workers.mesh_setup_key}" : "",
    "sh -s -- --controller ${swarmy_join_token.workers.install_url}",
  ]))
}

output "install_command" {
  value     = local.swarmy_install
  sensitive = true
}

# A token stops enrolling once it expires or is used up (see `status`); mint a
# fresh one with `terraform apply -replace=swarmy_join_token.workers`.
# Destroying the resource revokes the token.
#
# Import an existing token by ID (its plaintext is NOT recoverable):
#   terraform import swarmy_join_token.workers jt_abc123
