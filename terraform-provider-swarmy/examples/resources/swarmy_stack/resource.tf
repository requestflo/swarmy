resource "swarmy_stack" "platform" {
  name = "platform"

  compose_source = <<-EOT
    services:
      api:
        image: ghcr.io/acme/api:1.4.0
        replicas: 2
      worker:
        image: ghcr.io/acme/worker:1.4.0
  EOT

  # A deploy waits until every service converges and fails the apply if the
  # deployment fails. Bound the wait (default 20m each):
  timeouts {
    create = "15m"
    update = "15m"
  }
}

# Or load from a file:
# resource "swarmy_stack" "platform" {
#   name           = "platform"
#   compose_source = file("${path.module}/compose.yaml")
# }

# Import an existing stack by ID:
#   terraform import swarmy_stack.platform stack-abc123
