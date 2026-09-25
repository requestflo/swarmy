package certstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/certmagic"
	"go.uber.org/zap"
)

// Tiered is a certmagic.Storage that serves from node-local files and mirrors
// to a replica. Every read the TLS handshake path needs is local; the replica
// is consulted only on a local miss, and only while it answers.
//
// Rules (each one exists so no boot path waits on the replica):
//   - Load/Stat/Exists: local first. A local miss asks the replica (bounded by
//     Timeout); a replica hit is written back locally. A replica that errors
//     reads as "not found", so certmagic goes to ACME directly.
//   - Store: local, then the replica (bounded). A replica failure is not the
//     caller's failure: the key is left for the background sync.
//   - Delete: local, then the replica; a failed replica delete is remembered
//     and retried by the sync (so the sync does not pull it back).
//   - Lock: always the local lock; plus the replica lock while the replica
//     answers (mutual exclusion across edges). An unreachable replica falls
//     back to the local lock alone — at worst two edges both renew.
//   - OCSP staples stay on the node (looked up at every load, per-node,
//     cheap to re-fetch), so a dead replica never delays loading a cert.
//   - Sync (background): newer-wins by modification time, both ways. Local
//     mtimes are aligned to the replica's after every copy so the two clocks
//     never ping-pong.
//
// While the replica is failing it is skipped entirely for Backoff (a circuit
// breaker), so a dead replica costs one Timeout, not one per key.
type Tiered struct {
	Local   *certmagic.FileStorage
	Replica certmagic.Storage // nil ⇒ plain local storage

	Timeout       time.Duration // per replica call
	Backoff       time.Duration // replica skipped this long after a failure
	SyncInterval  time.Duration // full reconcile cadence while healthy
	RetryInterval time.Duration // reconcile cadence while work is pending
	Logger        *zap.Logger

	now func() time.Time

	mu             sync.Mutex
	downUntil      time.Time
	down           bool
	dirty          bool
	pendingDeletes map[string]struct{}
	replicaLocks   map[string]bool

	kick     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// Defaults for the knobs above.
const (
	DefaultTimeout       = 5 * time.Second
	DefaultBackoff       = 30 * time.Second
	DefaultSyncInterval  = 5 * time.Minute
	DefaultRetryInterval = 30 * time.Second
	// A local copy's mtime is aligned to the replica's, so any gap above this
	// means one side changed. Covers coarse (1 s) S3 LastModified resolution.
	mtimeTolerance = 2 * time.Second
	probeKey       = ".swarmy-replica-probe"
)

var _ certmagic.Storage = (*Tiered)(nil)

// NewTiered builds a Tiered store with defaults filled in. Call Start to run
// the background sync.
func NewTiered(localPath string, replica certmagic.Storage, log *zap.Logger) *Tiered {
	if log == nil {
		log = zap.NewNop()
	}
	return &Tiered{
		Local:          &certmagic.FileStorage{Path: localPath},
		Replica:        replica,
		Timeout:        DefaultTimeout,
		Backoff:        DefaultBackoff,
		SyncInterval:   DefaultSyncInterval,
		RetryInterval:  DefaultRetryInterval,
		Logger:         log,
		now:            time.Now,
		pendingDeletes: map[string]struct{}{},
		replicaLocks:   map[string]bool{},
		kick:           make(chan struct{}, 1),
		stop:           make(chan struct{}),
		done:           make(chan struct{}),
	}
}

// String names the store in Caddy's logs. Never format the replica itself:
// its struct carries the encryption key.
func (t *Tiered) String() string {
	if t.Replica == nil {
		return "swarmy:" + t.Local.Path
	}
	return fmt.Sprintf("swarmy:%s+replica(%T)", t.Local.Path, t.Replica)
}

// ─── replica health (circuit breaker) ─────────────────────────────────────

func (t *Tiered) replicaUp() bool {
	if t.Replica == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.now().Before(t.downUntil)
}

func (t *Tiered) markDown(op string, err error) {
	t.mu.Lock()
	was := t.down
	t.down = true
	t.dirty = true
	t.downUntil = t.now().Add(t.Backoff)
	t.mu.Unlock()
	if !was {
		t.Logger.Warn("certificate replica unavailable; serving node-local certificates",
			zap.String("op", op), zap.Error(err))
	}
}

func (t *Tiered) markUp() {
	t.mu.Lock()
	was := t.down
	t.down = false
	t.downUntil = time.Time{}
	t.mu.Unlock()
	if was {
		t.Logger.Info("certificate replica reachable again; syncing")
		t.Kick()
	}
}

// Kick asks the background sync to run now.
func (t *Tiered) Kick() {
	select {
	case t.kick <- struct{}{}:
	default:
	}
}

func (t *Tiered) rctx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, t.Timeout)
}

func notExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }

// replicaMiss: the replica answered "no such key". certmagic-s3 maps GetObject's
// NoSuchKey to fs.ErrNotExist but not HeadObject's bare 404 (Stat), which the
// AWS SDK surfaces as an API error "NotFound" — found in the lab: without this
// every probe read a healthy Garage as down. Duck-typed on smithy's
// APIError / HTTP response error so this module needs no AWS dependency.
func replicaMiss(err error) bool {
	if err == nil {
		return false
	}
	if notExist(err) {
		return true
	}
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		switch coded.ErrorCode() {
		case "NotFound", "NoSuchKey":
			return true
		}
	}
	var status interface{ HTTPStatusCode() int }
	return errors.As(err, &status) && status.HTTPStatusCode() == 404
}

// probe reports whether the replica answers at all (a miss is an answer).
func (t *Tiered) probe(ctx context.Context) error {
	rc, cancel := t.rctx(ctx)
	defer cancel()
	_, err := t.Replica.Stat(rc, probeKey)
	if err == nil || replicaMiss(err) {
		t.markUp()
		return nil
	}
	t.markDown("probe", err)
	return err
}

// alignMtime sets the local copy's mtime to the replica's, so the next sync
// sees the two as equal.
func (t *Tiered) alignMtime(ctx context.Context, key string) {
	rc, cancel := t.rctx(ctx)
	defer cancel()
	ri, err := t.Replica.Stat(rc, key)
	if err != nil || ri.Modified.IsZero() {
		return
	}
	_ = os.Chtimes(t.Local.Filename(key), ri.Modified, ri.Modified)
}

// ─── certmagic.Storage ────────────────────────────────────────────────────

// Load reads locally; on a local miss, from the replica (written back).
func (t *Tiered) Load(ctx context.Context, key string) ([]byte, error) {
	v, err := t.Local.Load(ctx, key)
	if err == nil || !notExist(err) || nodeLocal(key) || !t.replicaUp() {
		return v, err
	}
	rc, cancel := t.rctx(ctx)
	rv, rerr := t.Replica.Load(rc, key)
	cancel()
	switch {
	case rerr == nil:
		t.markUp()
		if serr := t.Local.Store(ctx, key, rv); serr == nil {
			t.alignMtime(ctx, key)
		}
		return rv, nil
	case replicaMiss(rerr):
		t.markUp()
		return nil, err
	default:
		t.markDown("load", rerr)
		// Not found as far as the caller is concerned: certmagic then obtains
		// the certificate itself instead of failing the handshake.
		return nil, fmt.Errorf("%w (replica unavailable: %v)", fs.ErrNotExist, rerr)
	}
}

// Store writes locally, then mirrors to the replica (best-effort).
func (t *Tiered) Store(ctx context.Context, key string, value []byte) error {
	if err := t.Local.Store(ctx, key, value); err != nil {
		return err
	}
	if t.Replica == nil || nodeLocal(key) {
		return nil
	}
	t.mu.Lock()
	delete(t.pendingDeletes, key)
	t.mu.Unlock()
	if !t.replicaUp() {
		t.setDirty()
		return nil
	}
	rc, cancel := t.rctx(ctx)
	rerr := t.Replica.Store(rc, key, value)
	cancel()
	if rerr != nil {
		t.markDown("store", rerr)
		return nil
	}
	t.markUp()
	t.alignMtime(ctx, key)
	return nil
}

// Delete removes locally and from the replica. A directory key (certmagic
// deletes a whole site prefix when cleaning) is expanded into its objects —
// object stores have no directories.
func (t *Tiered) Delete(ctx context.Context, key string) error {
	keys := []string{key}
	if li, err := t.Local.Stat(ctx, key); err == nil && !li.IsTerminal {
		keys = t.localTerminalKeys(ctx, key)
	}
	lerr := t.Local.Delete(ctx, key)
	if t.Replica == nil || nodeLocal(key) {
		return lerr
	}
	if t.replicaUp() {
		rc, cancel := t.rctx(ctx)
		if rk, err := t.Replica.List(rc, key, true); err == nil {
			keys = append(keys, rk...)
		}
		cancel()
	}
	for _, k := range dedupe(keys) {
		t.deleteReplica(ctx, k)
	}
	return lerr
}

func (t *Tiered) deleteReplica(ctx context.Context, key string) {
	if t.replicaUp() {
		rc, cancel := t.rctx(ctx)
		err := t.Replica.Delete(rc, key)
		cancel()
		if err == nil || replicaMiss(err) {
			return
		}
		t.markDown("delete", err)
	}
	t.mu.Lock()
	t.pendingDeletes[key] = struct{}{}
	t.dirty = true
	t.mu.Unlock()
}

// Exists is true when either tier has the key.
func (t *Tiered) Exists(ctx context.Context, key string) bool {
	if t.Local.Exists(ctx, key) {
		return true
	}
	if nodeLocal(key) || !t.replicaUp() {
		return false
	}
	rc, cancel := t.rctx(ctx)
	defer cancel()
	return t.Replica.Exists(rc, key)
}

// Stat reads locally; on a local miss, from the replica.
func (t *Tiered) Stat(ctx context.Context, key string) (certmagic.KeyInfo, error) {
	ki, err := t.Local.Stat(ctx, key)
	if err == nil || !notExist(err) || nodeLocal(key) || !t.replicaUp() {
		return ki, err
	}
	rc, cancel := t.rctx(ctx)
	rki, rerr := t.Replica.Stat(rc, key)
	cancel()
	switch {
	case rerr == nil:
		t.markUp()
		return rki, nil
	case replicaMiss(rerr):
		t.markUp()
		return ki, err
	default:
		t.markDown("stat", rerr)
		return ki, err
	}
}

// List is the union of both tiers. Replica keys are trimmed to one level
// below prefix for a non-recursive call (object stores list recursively).
func (t *Tiered) List(ctx context.Context, prefix string, recursive bool) ([]string, error) {
	keys, err := t.Local.List(ctx, prefix, recursive)
	if err != nil && !notExist(err) {
		return nil, err
	}
	if t.replicaUp() {
		rc, cancel := t.rctx(ctx)
		rk, rerr := t.Replica.List(rc, prefix, recursive)
		cancel()
		if rerr != nil {
			t.markDown("list", rerr)
		} else {
			t.markUp()
			for _, k := range rk {
				if !recursive {
					k = oneLevel(prefix, k)
				}
				keys = append(keys, k)
			}
		}
	}
	if len(keys) == 0 && err != nil {
		return nil, err
	}
	return dedupe(keys), nil
}

// Lock takes the local lock and, while the replica answers, the replica's.
func (t *Tiered) Lock(ctx context.Context, name string) error {
	if err := t.Local.Lock(ctx, name); err != nil {
		return err
	}
	if t.Replica == nil || !t.replicaUp() || t.probe(ctx) != nil {
		return nil // replica down: local exclusion only (fail open)
	}
	err := t.Replica.Lock(ctx, name)
	if err == nil {
		t.mu.Lock()
		t.replicaLocks[name] = true
		t.mu.Unlock()
		return nil
	}
	if ctx.Err() == nil && t.probe(ctx) != nil {
		t.Logger.Warn("replica lock unavailable; holding the node-local lock only",
			zap.String("lock", name), zap.Error(err))
		return nil
	}
	// The replica answers and the lock is genuinely held elsewhere.
	_ = t.Local.Unlock(ctx, name)
	return err
}

// Unlock releases what Lock took.
func (t *Tiered) Unlock(ctx context.Context, name string) error {
	t.mu.Lock()
	held := t.replicaLocks[name]
	delete(t.replicaLocks, name)
	t.mu.Unlock()
	if held {
		rc, cancel := t.rctx(ctx)
		if err := t.Replica.Unlock(rc, name); err != nil {
			t.Logger.Warn("replica unlock failed; it expires by itself", zap.String("lock", name), zap.Error(err))
		}
		cancel()
	}
	return t.Local.Unlock(ctx, name)
}

// ─── background sync ──────────────────────────────────────────────────────

// Start runs the background sync until Stop. firstDelay lets Caddy finish
// loading before the first reconcile.
func (t *Tiered) Start(firstDelay time.Duration) {
	if t.Replica == nil {
		close(t.done)
		return
	}
	go func() {
		defer close(t.done)
		wait := firstDelay
		for {
			timer := time.NewTimer(wait)
			select {
			case <-t.stop:
				timer.Stop()
				return
			case <-t.kick:
				timer.Stop()
			case <-timer.C:
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			err := t.SyncOnce(ctx)
			cancel()
			wait = t.SyncInterval
			if err != nil || t.pending() {
				wait = t.RetryInterval
			}
		}
	}()
}

// Stop ends the background sync and waits for it.
func (t *Tiered) Stop() {
	t.stopOnce.Do(func() { close(t.stop) })
	<-t.done
}

func (t *Tiered) setDirty() {
	t.mu.Lock()
	t.dirty = true
	t.mu.Unlock()
}

func (t *Tiered) pending() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dirty || len(t.pendingDeletes) > 0
}

// nodeLocal keys never touch the replica: OCSP staples are per-node, cheap to
// re-fetch, and are looked up for every certificate at every load — asking a
// dead replica for them would put its timeout on the boot path.
func nodeLocal(key string) bool { return strings.HasPrefix(key, "ocsp/") }

// syncable: certificate material only — not locks, not in-flight ACME
// challenge tokens (those are written through synchronously and must not be
// resurrected), not per-instance files at the root (instance.uuid,
// last_clean.json) and not atomic-write temp files.
func syncable(key string) bool {
	if !strings.Contains(key, "/") {
		return false
	}
	if strings.HasPrefix(key, "locks/") || strings.HasPrefix(key, "challenge_tokens/") || nodeLocal(key) {
		return false
	}
	if strings.HasSuffix(key, ".lock") || strings.HasPrefix(path.Base(key), ".") {
		return false
	}
	return true
}

// SyncStats reports what one reconcile did (tests + logs).
type SyncStats struct{ Pulled, Pushed, Deleted int }

// SyncOnce reconciles both tiers once: newer wins, missing sides are filled,
// remembered deletes are replayed.
func (t *Tiered) SyncOnce(ctx context.Context) error {
	_, err := t.syncOnce(ctx)
	return err
}

func (t *Tiered) syncOnce(ctx context.Context) (SyncStats, error) {
	var st SyncStats
	if t.Replica == nil {
		return st, nil
	}
	if err := t.probe(ctx); err != nil {
		return st, err
	}

	t.mu.Lock()
	deletes := make([]string, 0, len(t.pendingDeletes))
	for k := range t.pendingDeletes {
		deletes = append(deletes, k)
	}
	t.mu.Unlock()
	for _, k := range deletes {
		rc, cancel := t.rctx(ctx)
		err := t.Replica.Delete(rc, k)
		cancel()
		if err != nil && !replicaMiss(err) {
			t.markDown("sync delete", err)
			return st, err
		}
		t.mu.Lock()
		delete(t.pendingDeletes, k)
		t.mu.Unlock()
		st.Deleted++
	}

	local := map[string]time.Time{}
	for _, k := range t.localTerminalKeys(ctx, "") {
		if !syncable(k) {
			continue
		}
		if ki, err := t.Local.Stat(ctx, k); err == nil {
			local[k] = ki.Modified
		}
	}
	rc, cancel := t.rctx(ctx)
	rkeys, err := t.Replica.List(rc, "", true)
	cancel()
	if err != nil {
		t.markDown("sync list", err)
		return st, err
	}
	remote := map[string]time.Time{}
	for _, k := range rkeys {
		if !syncable(k) {
			continue
		}
		rc, cancel := t.rctx(ctx)
		ki, err := t.Replica.Stat(rc, k)
		cancel()
		if err != nil {
			if replicaMiss(err) {
				continue
			}
			t.markDown("sync stat", err)
			return st, err
		}
		remote[k] = ki.Modified
	}

	t.mu.Lock()
	skip := make(map[string]struct{}, len(t.pendingDeletes))
	for k := range t.pendingDeletes {
		skip[k] = struct{}{}
	}
	t.mu.Unlock()

	all := make([]string, 0, len(local)+len(remote))
	for k := range local {
		all = append(all, k)
	}
	for k := range remote {
		if _, ok := local[k]; !ok {
			all = append(all, k)
		}
	}
	sort.Strings(all)

	for _, k := range all {
		if ctx.Err() != nil {
			return st, ctx.Err()
		}
		lm, inLocal := local[k]
		rm, inRemote := remote[k]
		switch {
		case inLocal && (!inRemote || lm.Sub(rm) > mtimeTolerance):
			if err := t.push(ctx, k); err != nil {
				return st, err
			}
			st.Pushed++
		case inRemote && (!inLocal || rm.Sub(lm) > mtimeTolerance):
			if _, gone := skip[k]; gone {
				continue
			}
			changed, err := t.pull(ctx, k, rm)
			if err != nil {
				return st, err
			}
			if changed {
				st.Pulled++
			}
		}
	}

	t.mu.Lock()
	t.dirty = false
	t.mu.Unlock()
	if st.Pulled+st.Pushed+st.Deleted > 0 {
		t.Logger.Info("certificate replica synced",
			zap.Int("pulled", st.Pulled), zap.Int("pushed", st.Pushed), zap.Int("deleted", st.Deleted))
	}
	return st, nil
}

func (t *Tiered) push(ctx context.Context, key string) error {
	v, err := t.Local.Load(ctx, key)
	if err != nil {
		if notExist(err) {
			return nil
		}
		return err
	}
	rc, cancel := t.rctx(ctx)
	err = t.Replica.Store(rc, key, v)
	cancel()
	if err != nil {
		t.markDown("sync push", err)
		return err
	}
	t.alignMtime(ctx, key)
	return nil
}

func (t *Tiered) pull(ctx context.Context, key string, modified time.Time) (bool, error) {
	rc, cancel := t.rctx(ctx)
	v, err := t.Replica.Load(rc, key)
	cancel()
	if err != nil {
		if replicaMiss(err) {
			return false, nil
		}
		t.markDown("sync pull", err)
		return false, err
	}
	changed := true
	if cur, lerr := t.Local.Load(ctx, key); lerr == nil && bytes.Equal(cur, v) {
		changed = false
	} else if err := t.Local.Store(ctx, key, v); err != nil {
		return false, err
	}
	if !modified.IsZero() {
		_ = os.Chtimes(t.Local.Filename(key), modified, modified)
	}
	return changed, nil
}

// localTerminalKeys lists the files (not directories) under prefix.
func (t *Tiered) localTerminalKeys(ctx context.Context, prefix string) []string {
	keys, err := t.Local.List(ctx, prefix, true)
	if err != nil {
		return nil
	}
	out := keys[:0]
	for _, k := range keys {
		if ki, err := t.Local.Stat(ctx, k); err == nil && ki.IsTerminal {
			out = append(out, k)
		}
	}
	return out
}

func oneLevel(prefix, key string) string {
	p := strings.Trim(prefix, "/")
	rel := strings.TrimPrefix(strings.TrimPrefix(key, p), "/")
	if i := strings.Index(rel, "/"); i >= 0 {
		rel = rel[:i]
	}
	if p == "" {
		return rel
	}
	return p + "/" + rel
}

func dedupe(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		if _, ok := seen[k]; ok || k == "" {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	return out
}
