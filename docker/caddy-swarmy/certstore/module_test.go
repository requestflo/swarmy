package certstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2/caddyconfig"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	_ "github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	_ "github.com/techknowlogick/certmagic-s3"
)

// The exact shape packages/ingress renders (render/caddyfile.ts), with the
// encryption key imported from a Docker-secret file.
func TestCaddyfileAdaptsTheRenderedBlock(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "swarmy-edge-certs-enc")
	if err := os.WriteFile(keyFile, []byte("encryption_key 0123456789abcdefghijklmnopqrstuv\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	src := `{
  storage swarmy {
    replica s3 {
      endpoint http://swarmy-garage:3900
      bucket swarmy-edge-certs
      region garage
      prefix caddy-enc/org_1
      import ` + keyFile + `
      use_path_style true
    }
  }
}

mesh.example.com {
  respond ok
}
`
	adapter := caddyconfig.GetAdapter("caddyfile")
	out, warns, err := adapter.Adapt([]byte(src), map[string]any{"filename": filepath.Join(dir, "Caddyfile")})
	if err != nil {
		t.Fatalf("adapt: %v", err)
	}
	for _, w := range warns {
		t.Logf("warning: %v", w)
	}
	var cfg struct {
		Storage struct {
			Module  string          `json:"module"`
			Replica json.RawMessage `json:"replica"`
		} `json:"storage"`
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Storage.Module != "swarmy" {
		t.Fatalf("storage module = %q (%s)", cfg.Storage.Module, out)
	}
	var rep map[string]any
	_ = json.Unmarshal(cfg.Storage.Replica, &rep)
	if rep["module"] != "s3" || rep["bucket"] != "swarmy-edge-certs" || rep["prefix"] != "caddy-enc/org_1" ||
		rep["encryption_key"] != "0123456789abcdefghijklmnopqrstuv" || rep["use_path_style"] != true {
		t.Fatalf("replica = %s", cfg.Storage.Replica)
	}
	for _, secret := range []string{"access_key", "secret_key"} {
		if v, ok := rep[secret]; ok && v != "" {
			t.Fatalf("credential %s rendered into config", secret)
		}
	}
}

func TestCaddyfileOptions(t *testing.T) {
	d := caddyfile.NewTestDispenser(`swarmy {
		path /data/caddy
		sync_interval 1m
		timeout 3s
	}`)
	var m Module
	if err := m.UnmarshalCaddyfile(d); err != nil {
		t.Fatal(err)
	}
	if m.Path != "/data/caddy" || m.SyncInterval == 0 || m.ReplicaRaw != nil {
		t.Fatalf("%+v", m)
	}
	bad := caddyfile.NewTestDispenser(`swarmy {
		nope 1
	}`)
	if err := new(Module).UnmarshalCaddyfile(bad); err == nil || !strings.Contains(err.Error(), "unknown option") {
		t.Fatalf("want unknown option, got %v", err)
	}
}
