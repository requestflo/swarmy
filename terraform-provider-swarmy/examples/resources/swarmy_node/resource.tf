# Nodes join through the agent install (a join token from the dashboard), not
# the API. swarmy_node adopts a node that already joined and manages its labels
# and availability.
data "swarmy_node" "edge" {
  name = "prod-edge-1"
}

resource "swarmy_node" "edge" {
  node_id = data.swarmy_node.edge.id

  # Only these keys are managed; other labels on the node are left alone.
  # Removing a key here blanks it (the API cannot delete a label).
  labels = {
    "swarmy.region" = "eu-west"
    tier            = "edge"
  }

  # "drain" stops new tasks and moves running ones off; "active" restores it.
  availability = "active"

  # Destroy only stops managing the node unless this is true, in which case it
  # removes the node from swarmy.
  remove_on_destroy = false
}

# Adopt an existing node by ID:
#   terraform import swarmy_node.edge node-abc123
