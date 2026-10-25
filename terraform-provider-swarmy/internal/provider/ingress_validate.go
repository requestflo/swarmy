package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ resource.ResourceWithValidateConfig = (*ingressResource)(nil)

// ValidateConfig catches at plan time what the API would refuse at apply:
// a file country database needs its path, and a path means nothing to any
// other mode (the API keeps none, so the plan could never match the read).
func (r *ingressResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var mode, file types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("geoip_mode"), &mode)...)
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("geoip_path"), &file)...)
	if resp.Diagnostics.HasError() || mode.IsUnknown() || file.IsUnknown() {
		return
	}
	isFile := mode.ValueString() == "file"
	switch {
	case isFile && file.IsNull():
		resp.Diagnostics.AddAttributeError(path.Root("geoip_path"), "Missing country database path",
			`geoip_mode = "file" needs geoip_path: an absolute path to a .mmdb inside the edge container.`)
	case !isFile && !file.IsNull():
		resp.Diagnostics.AddAttributeError(path.Root("geoip_path"), "Country database path without the file mode",
			`geoip_path is only used with geoip_mode = "file".`)
	}
}
