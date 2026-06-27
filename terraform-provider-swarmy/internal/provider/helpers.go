package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	tfpath "github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// rootPath is a short alias for building a root attribute path.
func rootPath(name string) tfpath.Path {
	return tfpath.Root(name)
}

// clientFromProviderData extracts the configured *client.Client from the
// provider data passed to a resource/data source Configure call. It is a no-op
// when providerData is nil (Terraform calls Configure with nil during early
// graph walks).
func clientFromProviderData(providerData any) (*client.Client, error) {
	if providerData == nil {
		return nil, nil
	}
	c, ok := providerData.(*client.Client)
	if !ok {
		return nil, fmt.Errorf("expected *client.Client, got %T — this is a provider bug", providerData)
	}
	return c, nil
}

// stringPtrToValue converts an optional API string into a framework types.String.
func stringPtrToValue(s *string) types.String {
	if s == nil {
		return types.StringNull()
	}
	return types.StringValue(*s)
}

// valueToStringPtr converts a framework types.String into an optional API string.
// Null and unknown values map to nil.
func valueToStringPtr(v types.String) *string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	s := v.ValueString()
	return &s
}

// stringsToList converts a []string into a framework types.List of strings.
func stringsToList(ctx context.Context, in []string) (types.List, diag.Diagnostics) {
	return types.ListValueFrom(ctx, types.StringType, in)
}
