resource "swarmy_service" "web" {
  name     = "web"
  image    = "nginx:1.27"
  replicas = 3

  # Optional: pin to a node (forces replacement on change).
  # node_id = "node-abc123"

  # Optional override command.
  command = ["nginx", "-g", "daemon off;"]

  # Plain variables, as a whole (secret variables set elsewhere are kept).
  env = {
    LOG_LEVEL = "info"
    PORT      = "80"
  }

  # Changing image, command or env updates the service in place
  # (PATCH /services/{id}); a guardrail can refuse it, which fails the apply.
  # Changing only replicas scales it. Create and update wait until the
  # deployment converges and fail the apply if it fails. Bound the wait
  # (default 20m each):
  timeouts {
    create = "10m"
    update = "10m"
  }
}

# Import an existing service by ID:
#   terraform import swarmy_service.web svc-abc123
