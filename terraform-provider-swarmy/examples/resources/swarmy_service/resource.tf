resource "swarmy_service" "web" {
  name     = "web"
  image    = "nginx:1.27"
  replicas = 3

  # Optional: pin to a node (forces replacement on change).
  # node_id = "node-abc123"

  # Optional override command (set at create time).
  command = ["nginx", "-g", "daemon off;"]

  env = {
    LOG_LEVEL = "info"
    PORT      = "80"
  }

  # Create/scale/redeploy wait until the deployment converges and fail the
  # apply if it fails. Bound the wait (default 20m each):
  timeouts {
    create = "10m"
    update = "10m"
  }
}

# Import an existing service by ID:
#   terraform import swarmy_service.web svc-abc123
