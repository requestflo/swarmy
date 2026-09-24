package swarmyrum

import (
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/dustin/go-humanize"
)

func init() {
	httpcaddyfile.RegisterHandlerDirective("swarmy_rum", parseCaddyfile)
}

func parseCaddyfile(h httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	var m Handler
	err := m.UnmarshalCaddyfile(h.Dispenser)
	return &m, err
}

// UnmarshalCaddyfile parses the `swarmy_rum { … }` block.
func (h *Handler) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next() // directive name
	if d.NextArg() {
		return d.ArgErr()
	}
	for d.NextBlock(0) {
		switch d.Val() {
		case "script_src":
			if !d.NextArg() {
				return d.ArgErr()
			}
			h.ScriptSrc = d.Val()
		case "attr":
			args := d.RemainingArgs()
			if len(args) != 2 {
				return d.ArgErr()
			}
			if h.Attrs == nil {
				h.Attrs = map[string]string{}
			}
			h.Attrs[args[0]] = args[1]
		case "max_scan", "max_size":
			key := d.Val()
			if !d.NextArg() {
				return d.ArgErr()
			}
			n, err := humanize.ParseBytes(d.Val())
			if err != nil {
				return d.Errf("%s: %v", key, err)
			}
			if key == "max_scan" {
				h.MaxScan = int64(n)
			} else {
				h.MaxSize = int64(n)
			}
		case "csp":
			if !d.NextArg() {
				return d.ArgErr()
			}
			h.CSP = d.Val()
		case "server_timing":
			h.ServerTiming = true
		case "keep_encoding":
			h.KeepEncoding = true
		default:
			return d.Errf("unknown swarmy_rum option %q", d.Val())
		}
	}
	return nil
}

var _ caddyfile.Unmarshaler = (*Handler)(nil)
