// Package certstore is the `caddy.storage.swarmy` Caddy module: certificates
// live on the node first, and a replica (swarmy's Garage bucket through
// certmagic-s3) shares them between edges in the background.
//
// Why (QA-066): with the replica as THE store, rebooting the node that runs
// the mesh control plane deadlocked for good — the edge had no certificates
// until Garage answered, Garage had no quorum until the mesh was up, and the
// mesh reached its control plane through that edge. The rule now: no boot
// path depends on the replica (or anything reached over the mesh) to serve
// TLS. See Tiered for the read/write/lock/sync rules.
//
// Caddyfile (global options):
//
//	storage swarmy {
//	    path           /data/caddy        # default: Caddy's data dir
//	    sync_interval  5m                 # full reconcile while healthy
//	    timeout        5s                 # per replica call
//	    replica s3 {                      # any caddy.storage.* module
//	        endpoint http://swarmy-garage:3900
//	        bucket   swarmy-edge-certs
//	        ...
//	    }
//	}
//
// At rest: the replica copy is sealed by the replica module (certmagic-s3's
// NaCl `encryption_key`). The local copy is plain files, as Caddy's default
// file storage is: 0600 files in 0700 directories on the edge's per-node
// Docker volume (root-only under /var/lib/docker/volumes). Sealing them too
// would add nothing — the node's Caddy autosave on the same disk already holds
// the replica's key, and the edge process holds the decrypted keys anyway.
package certstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/certmagic"
)

func init() {
	caddy.RegisterModule(Module{})
}

// Module configures a Tiered store.
type Module struct {
	// Path of the node-local store. Default: Caddy's data directory
	// (/data/caddy in the official image), where file storage already lives.
	Path string `json:"path,omitempty"`
	// ReplicaRaw is the replica storage module (e.g. s3). Optional.
	ReplicaRaw json.RawMessage `json:"replica,omitempty" caddy:"namespace=caddy.storage inline_key=module"`
	// SyncInterval between full reconciles while healthy. Default 5m.
	SyncInterval caddy.Duration `json:"sync_interval,omitempty"`
	// Timeout per replica call. Default 5s.
	Timeout caddy.Duration `json:"timeout,omitempty"`

	key    string
	tiered *Tiered
}

// One Tiered per distinct config, shared across reloads: every ingress apply
// is a Caddy reload, and a fresh store (and sync loop, and breaker state) per
// reload would reset the sync clock each time.
var pool = caddy.NewUsagePool()

type pooled struct{ t *Tiered }

func (p pooled) Destruct() error {
	p.t.Stop()
	return nil
}

// CaddyModule returns the Caddy module information.
func (Module) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "caddy.storage.swarmy",
		New: func() caddy.Module { return new(Module) },
	}
}

// Provision builds (or re-uses) the Tiered store. It does no network IO: the
// replica module only builds a client here.
func (m *Module) Provision(ctx caddy.Context) error {
	if m.Path == "" {
		m.Path = caddy.AppDataDir()
	}
	sum := sha256.Sum256(append([]byte(m.Path+"\x00"), m.ReplicaRaw...))
	m.key = hex.EncodeToString(sum[:]) + fmt.Sprintf("/%d/%d", m.SyncInterval, m.Timeout)

	var replica certmagic.Storage
	if m.ReplicaRaw != nil {
		val, err := ctx.LoadModule(m, "ReplicaRaw")
		if err != nil {
			return fmt.Errorf("swarmy storage: loading replica: %w", err)
		}
		conv, ok := val.(caddy.StorageConverter)
		if !ok {
			return fmt.Errorf("swarmy storage: replica module %T is not a storage module", val)
		}
		if replica, err = conv.CertMagicStorage(); err != nil {
			return fmt.Errorf("swarmy storage: replica: %w", err)
		}
	}
	log := ctx.Logger()
	val, _, err := pool.LoadOrNew(m.key, func() (caddy.Destructor, error) {
		t := NewTiered(m.Path, replica, log)
		if m.SyncInterval > 0 {
			t.SyncInterval = time.Duration(m.SyncInterval)
		}
		if m.Timeout > 0 {
			t.Timeout = time.Duration(m.Timeout)
		}
		t.Start(10 * time.Second)
		return pooled{t}, nil
	})
	if err != nil {
		return err
	}
	m.tiered = val.(pooled).t
	return nil
}

// Cleanup releases this config's hold on the shared store.
func (m *Module) Cleanup() error {
	if m.key == "" {
		return nil
	}
	_, err := pool.Delete(m.key)
	return err
}

// CertMagicStorage returns the Tiered store.
func (m *Module) CertMagicStorage() (certmagic.Storage, error) {
	if m.tiered == nil {
		return nil, fmt.Errorf("swarmy storage: not provisioned")
	}
	return m.tiered, nil
}

// UnmarshalCaddyfile parses the block documented on the package.
func (m *Module) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next() // module name
	if d.NextArg() {
		return d.ArgErr()
	}
	for d.NextBlock(0) {
		switch d.Val() {
		case "path":
			if !d.AllArgs(&m.Path) {
				return d.ArgErr()
			}
		case "sync_interval", "timeout":
			opt := d.Val()
			var v string
			if !d.AllArgs(&v) {
				return d.ArgErr()
			}
			dur, err := caddy.ParseDuration(v)
			if err != nil || dur <= 0 {
				return d.Errf("%s: bad duration %q", opt, v)
			}
			if opt == "timeout" {
				m.Timeout = caddy.Duration(dur)
			} else {
				m.SyncInterval = caddy.Duration(dur)
			}
		case "replica":
			if !d.NextArg() {
				return d.ArgErr()
			}
			name := d.Val()
			unm, err := caddyfile.UnmarshalModule(d, "caddy.storage."+name)
			if err != nil {
				return err
			}
			if _, ok := unm.(caddy.StorageConverter); !ok {
				return d.Errf("replica %q is not a storage module", name)
			}
			m.ReplicaRaw = caddyconfig.JSONModuleObject(unm, "module", name, nil)
		default:
			return d.Errf("unknown option %q", d.Val())
		}
	}
	return nil
}

var (
	_ caddy.Provisioner      = (*Module)(nil)
	_ caddy.CleanerUpper     = (*Module)(nil)
	_ caddy.StorageConverter = (*Module)(nil)
	_ caddyfile.Unmarshaler  = (*Module)(nil)
)
