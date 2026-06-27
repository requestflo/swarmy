# Look up a node by name...
data "swarmy_node" "by_name" {
  name = "prod-worker-1"
}

# ...or by ID. Set exactly one of name or id.
data "swarmy_node" "by_id" {
  id = "node-abc123"
}

output "node_status" {
  value = data.swarmy_node.by_name.status
}
