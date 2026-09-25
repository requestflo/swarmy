package certstore

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caddyserver/certmagic"
)

// fakeReplica is an in-memory object store that can be broken (every call
// errors, like Garage without quorum: HTTP 503) or hung (every call blocks
// until its context ends, like a blackholed overlay address).
type fakeReplica struct {
	mu    sync.Mutex
	objs  map[string]obj
	locks map[string]bool
	down  bool
	hang  bool
	// s3Head404: Stat misses come back as the AWS SDK's HeadObject error
	// (API code "NotFound", HTTP 404), not fs.ErrNotExist — as certmagic-s3 does.
	s3Head404 bool
	calls     int
	clock     time.Time
}

type obj struct {
	v   []byte
	mod time.Time
}

var errUnavailable = errors.New("503 Service Unavailable")

func newFake() *fakeReplica {
	return &fakeReplica{objs: map[string]obj{}, locks: map[string]bool{}, clock: time.Now().Add(-time.Hour)}
}

func (f *fakeReplica) gate(ctx context.Context) error {
	f.mu.Lock()
	f.calls++
	down, hang := f.down, f.hang
	f.mu.Unlock()
	if hang {
		<-ctx.Done()
		return ctx.Err()
	}
	if down {
		return errUnavailable
	}
	return nil
}

func (f *fakeReplica) tick() time.Time {
	f.clock = f.clock.Add(10 * time.Second)
	return f.clock
}

func (f *fakeReplica) Store(ctx context.Context, k string, v []byte) error {
	if err := f.gate(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objs[k] = obj{append([]byte(nil), v...), f.tick()}
	return nil
}

func (f *fakeReplica) Load(ctx context.Context, k string) ([]byte, error) {
	if err := f.gate(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objs[k]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return o.v, nil
}

func (f *fakeReplica) Delete(ctx context.Context, k string) error {
	if err := f.gate(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objs, k)
	return nil
}

func (f *fakeReplica) Exists(ctx context.Context, k string) bool {
	if f.gate(ctx) != nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objs[k]
	return ok
}

func (f *fakeReplica) List(ctx context.Context, p string, _ bool) ([]string, error) {
	if err := f.gate(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.objs {
		if p == "" || strings.HasPrefix(k, strings.TrimSuffix(p, "/")+"/") {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (f *fakeReplica) Stat(ctx context.Context, k string) (certmagic.KeyInfo, error) {
	if err := f.gate(ctx); err != nil {
		return certmagic.KeyInfo{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objs[k]
	if !ok {
		if f.s3Head404 {
			return certmagic.KeyInfo{}, fmt.Errorf("operation error S3: HeadObject: %w", headNotFound{})
		}
		return certmagic.KeyInfo{}, fs.ErrNotExist
	}
	return certmagic.KeyInfo{Key: k, Modified: o.mod, Size: int64(len(o.v)), IsTerminal: true}, nil
}

func (f *fakeReplica) Lock(ctx context.Context, n string) error {
	if err := f.gate(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.locks[n] {
		return errors.New("acquiring lock failed")
	}
	f.locks[n] = true
	return nil
}

func (f *fakeReplica) Unlock(ctx context.Context, n string) error {
	if err := f.gate(ctx); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.locks, n)
	return nil
}

func (f *fakeReplica) set(down, hang bool) {
	f.mu.Lock()
	f.down, f.hang = down, hang
	f.mu.Unlock()
}

func (f *fakeReplica) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeReplica) has(k string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objs[k]
	return ok
}

const certKey = "certificates/acme-v02.api.letsencrypt.org-directory/mesh.example.com/mesh.example.com.crt"

func newStore(t *testing.T, r *fakeReplica) *Tiered {
	t.Helper()
	s := NewTiered(t.TempDir(), r, nil)
	s.Timeout = 200 * time.Millisecond
	s.Backoff = time.Hour // tests reset the breaker explicitly
	return s
}

func resetBreaker(s *Tiered) {
	s.mu.Lock()
	s.downUntil = time.Time{}
	s.mu.Unlock()
}

var ctx = context.Background()

// QA-066: the reboot. Certificates on the node, replica broken → every TLS
// read is served locally without touching the replica.
func TestLocalCertServesWhileReplicaDown(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	if err := s.Store(ctx, certKey, []byte("CERT")); err != nil {
		t.Fatal(err)
	}
	r.set(true, false)
	before := r.callCount()
	v, err := s.Load(ctx, certKey)
	if err != nil || string(v) != "CERT" {
		t.Fatalf("Load = %q, %v", v, err)
	}
	if _, err := s.Stat(ctx, certKey); err != nil {
		t.Fatal(err)
	}
	if !s.Exists(ctx, certKey) {
		t.Fatal("Exists = false")
	}
	if n := r.callCount() - before; n != 0 {
		t.Fatalf("local hits made %d replica calls", n)
	}
}

func TestHungReplicaIsBoundedAndThenSkipped(t *testing.T) {
	r := newFake()
	r.set(false, true)
	s := newStore(t, r)
	start := time.Now()
	_, err := s.Load(ctx, certKey)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("want not-exist (so certmagic goes to ACME), got %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Load took %v with a hung replica", d)
	}
	// Breaker open: the next miss does not wait at all.
	start = time.Now()
	calls := r.callCount()
	_, _ = s.Load(ctx, "certificates/x/y/y.key")
	if time.Since(start) > 50*time.Millisecond || r.callCount() != calls {
		t.Fatal("breaker did not skip the replica")
	}
}

func TestLocalMissReadsReplicaAndWritesBack(t *testing.T) {
	r := newFake()
	_ = r.Store(ctx, certKey, []byte("FROM-GARAGE"))
	s := newStore(t, r)
	v, err := s.Load(ctx, certKey)
	if err != nil || string(v) != "FROM-GARAGE" {
		t.Fatalf("Load = %q, %v", v, err)
	}
	r.set(true, false)
	v, err = s.Load(ctx, certKey) // now local
	if err != nil || string(v) != "FROM-GARAGE" {
		t.Fatalf("write-back missing: %q, %v", v, err)
	}
}

func TestStoreWhileDownIsLocalThenPushedBySync(t *testing.T) {
	r := newFake()
	r.set(true, false)
	s := newStore(t, r)
	if err := s.Store(ctx, certKey, []byte("NEW")); err != nil {
		t.Fatalf("Store must not fail with the replica down: %v", err)
	}
	if !s.pending() {
		t.Fatal("expected pending work")
	}
	if err := s.SyncOnce(ctx); err == nil {
		t.Fatal("sync should fail while down")
	}
	r.set(false, false)
	resetBreaker(s)
	st, err := s.syncOnce(ctx)
	if err != nil || st.Pushed != 1 || !r.has(certKey) {
		t.Fatalf("sync = %+v, %v", st, err)
	}
	if s.pending() {
		t.Fatal("still pending after a clean sync")
	}
}

func TestSyncNewerWinsBothWaysAndSettles(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	// Only-remote (another edge issued it) and a local-only key.
	remoteOnly := "certificates/ca/a.example.com/a.example.com.crt"
	localOnly := "certificates/ca/b.example.com/b.example.com.crt"
	_ = r.Store(ctx, remoteOnly, []byte("A"))
	_ = s.Local.Store(ctx, localOnly, []byte("B"))
	st, err := s.syncOnce(ctx)
	if err != nil || st.Pulled != 1 || st.Pushed != 1 {
		t.Fatalf("first sync = %+v, %v", st, err)
	}
	// Another edge renews A → the replica copy is newer → pulled.
	_ = r.Store(ctx, remoteOnly, []byte("A2"))
	st, err = s.syncOnce(ctx)
	if err != nil || st.Pulled != 1 || st.Pushed != 0 {
		t.Fatalf("renewal sync = %+v, %v", st, err)
	}
	if v, _ := s.Local.Load(ctx, remoteOnly); string(v) != "A2" {
		t.Fatalf("local A = %q", v)
	}
	// Nothing changed → nothing moves (no ping-pong between the clocks).
	st, err = s.syncOnce(ctx)
	if err != nil || st != (SyncStats{}) {
		t.Fatalf("idle sync = %+v, %v", st, err)
	}
	// This edge renews B locally (mtime ahead of the replica's) → pushed.
	_ = s.Local.Store(ctx, localOnly, []byte("B2"))
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(s.Local.Filename(localOnly), future, future)
	st, err = s.syncOnce(ctx)
	if err != nil || st.Pushed != 1 {
		t.Fatalf("local renewal sync = %+v, %v", st, err)
	}
	if v, _ := r.Load(ctx, localOnly); string(v) != "B2" {
		t.Fatalf("replica B = %q", v)
	}
}

func TestDeleteWhileDownIsReplayedNotResurrected(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	_ = s.Store(ctx, certKey, []byte("OLD"))
	r.set(true, false)
	if err := s.Delete(ctx, certKey); err != nil {
		t.Fatal(err)
	}
	r.set(false, false)
	resetBreaker(s)
	st, err := s.syncOnce(ctx)
	if err != nil || st.Deleted != 1 || st.Pulled != 0 {
		t.Fatalf("sync = %+v, %v", st, err)
	}
	if r.has(certKey) || s.Local.Exists(ctx, certKey) {
		t.Fatal("deleted key came back")
	}
}

func TestDeleteDirectoryExpandsOnReplica(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	dir := "certificates/ca/old.example.com"
	_ = s.Store(ctx, dir+"/old.example.com.crt", []byte("c"))
	_ = s.Store(ctx, dir+"/old.example.com.key", []byte("k"))
	if err := s.Delete(ctx, dir); err != nil {
		t.Fatal(err)
	}
	if r.has(dir+"/old.example.com.crt") || r.has(dir+"/old.example.com.key") {
		t.Fatal("site prefix left on the replica")
	}
}

func TestLockFailsOpenToLocalWhenReplicaDown(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	r.set(true, false)
	if err := s.Lock(ctx, "issue_cert_mesh.example.com"); err != nil {
		t.Fatalf("Lock with replica down: %v", err)
	}
	if err := s.Unlock(ctx, "issue_cert_mesh.example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestLockUsesReplicaWhenUpAndRespectsAHolder(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	if err := s.Lock(ctx, "issue_cert_a"); err != nil {
		t.Fatal(err)
	}
	if !r.locks["issue_cert_a"] {
		t.Fatal("replica lock not taken")
	}
	_ = s.Unlock(ctx, "issue_cert_a")
	if r.locks["issue_cert_a"] {
		t.Fatal("replica lock not released")
	}
	r.locks["issue_cert_b"] = true // another edge holds it
	if err := s.Lock(ctx, "issue_cert_b"); err == nil {
		t.Fatal("took a lock another edge holds")
	}
	// Local lock was released on that failure: a second attempt is not stuck.
	delete(r.locks, "issue_cert_b")
	if err := s.Lock(ctx, "issue_cert_b"); err != nil {
		t.Fatal(err)
	}
	_ = s.Unlock(ctx, "issue_cert_b")
}

func TestListUnionsAndTrimsNonRecursive(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	_ = r.Store(ctx, "certificates/ca/a.example.com/a.crt", []byte("x"))
	_ = s.Local.Store(ctx, "certificates/ca/b.example.com/b.crt", []byte("y"))
	got, err := s.List(ctx, "certificates/ca", false)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	want := []string{"certificates/ca/a.example.com", "certificates/ca/b.example.com"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("List = %v, want %v", got, want)
	}
}

func TestSyncableFilter(t *testing.T) {
	for k, want := range map[string]bool{
		certKey:                                     true,
		"acme/ca/users/x@y/x.json":                  true,
		"ocsp/mesh.example.com-abc":                 false,
		"locks/issue_cert_x.lock":                   false,
		"challenge_tokens/ca/mesh.example.com.json": false,
		"instance.uuid":                             false,
		"last_clean.json":                           false,
		"certificates/ca/a/.a.crt.tmp123":           false,
		"certificates/ca/a/a.crt.lock":              false,
	} {
		if syncable(k) != want {
			t.Errorf("syncable(%q) = %v, want %v", k, !want, want)
		}
	}
}

func TestNoReplicaIsPlainLocal(t *testing.T) {
	s := NewTiered(t.TempDir(), nil, nil)
	if err := s.Store(ctx, certKey, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if v, err := s.Load(ctx, certKey); err != nil || string(v) != "x" {
		t.Fatal(v, err)
	}
	if err := s.Lock(ctx, "l"); err != nil {
		t.Fatal(err)
	}
	_ = s.Unlock(ctx, "l")
	s.Start(0)
	s.Stop()
}

func TestBackgroundSyncRunsAndStops(t *testing.T) {
	r := newFake()
	s := newStore(t, r)
	s.RetryInterval = 20 * time.Millisecond
	_ = r.Store(ctx, certKey, []byte("Z"))
	s.Start(0)
	deadline := time.Now().Add(2 * time.Second)
	for !s.Local.Exists(ctx, certKey) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	s.Stop()
	if !s.Local.Exists(ctx, certKey) {
		t.Fatal("background sync never pulled")
	}
}

func TestStringNeverFormatsTheReplica(t *testing.T) {
	s := NewTiered("/data/caddy", &secretReplica{fakeReplica: newFake(), key: "0123456789abcdefghijklmnopqrstuv"}, nil)
	if strings.Contains(s.String(), "0123456789") {
		t.Fatalf("String() leaks the replica: %s", s)
	}
}

type secretReplica struct {
	*fakeReplica
	key string
}

// headNotFound mimics smithy-go's API error for a HeadObject miss.
type headNotFound struct{}

func (headNotFound) Error() string       { return "NotFound: Not Found" }
func (headNotFound) ErrorCode() string   { return "NotFound" }
func (headNotFound) HTTPStatusCode() int { return 404 }

// Found in the lab: Garage answered the probe's HeadObject with a 404 and the
// store read that as "replica down", so nothing ever synced.
func TestHeadObject404IsAMissNotAnOutage(t *testing.T) {
	r := newFake()
	r.s3Head404 = true
	s := newStore(t, r)
	_ = s.Local.Store(ctx, certKey, []byte("C"))
	st, err := s.syncOnce(ctx)
	if err != nil || st.Pushed != 1 {
		t.Fatalf("sync = %+v, %v", st, err)
	}
	if _, err := s.Stat(ctx, "certificates/ca/none/none.crt"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Stat miss = %v", err)
	}
	if !s.replicaUp() {
		t.Fatal("a 404 opened the breaker")
	}
	if replicaMiss(errors.New("503 Service Unavailable")) {
		t.Fatal("a 503 is not a miss")
	}
}

// OCSP staples are looked up for every certificate at every load: with a dead
// (hung) replica that lookup must not wait — it never leaves the node.
func TestOCSPNeverTouchesTheReplica(t *testing.T) {
	r := newFake()
	r.set(false, true) // hung
	s := newStore(t, r)
	start := time.Now()
	if _, err := s.Load(ctx, "ocsp/mesh.example.com-abc"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if err := s.Store(ctx, "ocsp/mesh.example.com-abc", []byte("staple")); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 50*time.Millisecond || r.callCount() != 0 {
		t.Fatalf("ocsp reached the replica (%d calls, %v)", r.callCount(), time.Since(start))
	}
}
