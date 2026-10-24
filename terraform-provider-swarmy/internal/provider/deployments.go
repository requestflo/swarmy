package provider

import (
	"context"
	"errors"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/diag"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// defaultDeployTimeout bounds a create/update's deployment wait when the
// resource's timeouts block leaves it unset.
const defaultDeployTimeout = 20 * time.Minute

// deployWaitOptions is the poll cadence resources use; unit tests shorten it.
var deployWaitOptions = client.WaitOptions{}

// waitForDeployment blocks until the async deploy behind ref reaches a
// terminal phase or the deadline passes. A failed, vanished or timed-out
// deployment comes back as an error diagnostic carrying the controller's
// reason. The returned status is the last one seen (nil if none); it names
// the live service id even when the wait failed.
func waitForDeployment(ctx context.Context, c *client.Client, ref *client.DeploymentRef, deadline time.Time, what string) (*client.DeploymentStatus, diag.Diagnostics) {
	var diags diag.Diagnostics
	wctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	st, err := c.WaitForDeployment(wctx, *ref, deployWaitOptions)
	if err == nil {
		return st, diags
	}
	var de *client.DeploymentError
	switch {
	case errors.As(err, &de) && de.TimedOut:
		diags.AddError(
			"Timed out waiting for "+what,
			err.Error()+"\n\nThe deploy may still converge. Raise the resource's timeouts block (create/update) if it needs longer, then apply again.",
		)
	case errors.As(err, &de):
		diags.AddError("Deployment failed for "+what, err.Error())
	default:
		diags.AddError("Error waiting for "+what, err.Error())
	}
	return st, diags
}

// liveServiceID prefers the service id a deployment status reports (the
// create answers the name until the live inventory catches up).
func liveServiceID(ref *client.DeploymentRef, st *client.DeploymentStatus) string {
	if st != nil && st.ServiceID != nil && *st.ServiceID != "" {
		return *st.ServiceID
	}
	return ref.ID
}
