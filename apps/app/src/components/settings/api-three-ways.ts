import { API_BASE, type CodeTab } from '@/components/calm';

/**
 * One real action — take down an app environment, keeping its data — as
 * curl, the swarmy CLI and Terraform. Every line is real: the REST route is
 * `DELETE /stacks/{id}` in packages/api-rest/openapi.json, the CLI command is
 * `swarmy remove` (apps/cli), and the provider's `swarmy_stack` resource
 * calls the same route when it's destroyed (terraform-provider-swarmy).
 */
export const THREE_WAYS_ROUTE = 'DELETE /api/v1/stacks/{id}';

const CURL = `# Take down my-app-staging. Its data is kept.
# ($STACK_ID is its id from GET /api/v1/stacks.)
curl -X DELETE "${API_BASE}/stacks/$STACK_ID?delete_data=false" \\
  -H "Authorization: Bearer $SWARMY_TOKEN"

# 200 OK
# {
#   "id": "…",
#   "removed": true,
#   "delete_data": false,
#   "volumes_deleted": [],
#   "volumes_kept": ["…"]
# }`;

const CLI = `swarmy remove --app my-app-staging

# asks you to type the name back (--yes skips it)
# its data is kept unless you add --delete-data`;

const TERRAFORM = `terraform {
  required_providers {
    swarmy = {
      source  = "registry.terraform.io/requestflo/swarmy"
      version = "~> 0.1"
    }
  }
}

resource "swarmy_stack" "staging" {
  name           = "my-app-staging"
  compose_source = file("\${path.module}/compose.yaml")
}

# Delete the block and run terraform apply (or
# terraform destroy -target=swarmy_stack.staging).
# The provider calls ${THREE_WAYS_ROUTE}; data is kept.`;

export const THREE_WAYS: CodeTab[] = [
  { label: 'curl', code: CURL },
  { label: 'swarmy CLI', code: CLI },
  { label: 'Terraform', code: TERRAFORM },
];
