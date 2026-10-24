package swarmy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// roundTrip serves one canned response, runs call against it and returns
// what the client sent.
func roundTrip(t *testing.T, status int, resp string, call func(*Client) error) capturedRequest {
	t.Helper()
	var cap capturedRequest
	srv := testServer(t, status, resp, &cap)
	defer srv.Close()
	if err := call(newTestClient(t, srv)); err != nil {
		t.Fatalf("call: %v", err)
	}
	return cap
}

// expectRequest checks method, escaped path, raw query and body ("" = none).
func expectRequest(t *testing.T, got capturedRequest, method, path, query, body string) {
	t.Helper()
	if got.method != method || got.path != path || got.rawQ != query || got.body != body {
		t.Errorf("request = %s %s?%s %s\nwant      %s %s?%s %s", got.method, got.path, got.rawQ, got.body, method, path, query, body)
	}
}

var bg = context.Background()

func TestClientMeAndNotify(t *testing.T) {
	t.Run("Me", func(t *testing.T) {
		var out *Principal
		cap := roundTrip(t, 200, `{"org_id":"org1","user":null,"role":"admin","credential":{"kind":"apikey"}}`, func(c *Client) (err error) {
			out, err = c.Me(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/me", "", "")
		if out.OrgID != "org1" || out.Role != "admin" {
			t.Errorf("principal = %+v", out)
		}
	})
	t.Run("Notify", func(t *testing.T) {
		var out *NotifyQueued
		cap := roundTrip(t, 202, `{"queued":true,"to":"ops@example.com"}`, func(c *Client) (err error) {
			out, err = c.Notify(bg, NotifyBody{To: "ops@example.com", Subject: "Deploy", Body: "done"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/notify", "", `{"to":"ops@example.com","subject":"Deploy","body":"done"}`)
		if !out.Queued {
			t.Errorf("queued = %+v", out)
		}
	})
}

func TestServicesEnvLogs(t *testing.T) {
	t.Run("Env", func(t *testing.T) {
		var out *ServiceEnv
		cap := roundTrip(t, 200, `{"service_id":"s1","service":"web","vars":[{"key":"A","value":null,"secret":true,"delivery":"env","withheld":true,"error":null}],"secrets_readable":false}`, func(c *Client) (err error) {
			out, err = c.Services.Env(bg, "s 1", true)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/services/s%201/env", "reveal_secrets=true", "")
		if len(out.Vars) != 1 || !out.Vars[0].Withheld || out.Vars[0].Value != nil {
			t.Errorf("env = %+v", out)
		}
		cap = roundTrip(t, 200, `{"service_id":"s1","service":"web","vars":[],"secrets_readable":false}`, func(c *Client) error {
			_, err := c.Services.Env(bg, "s1", false)
			return err
		})
		expectRequest(t, cap, "GET", "/api/v1/services/s1/env", "", "")
	})
	t.Run("PatchEnv", func(t *testing.T) {
		var out *PatchServiceEnvResult
		cap := roundTrip(t, 202, `{"id":"s1","deployment_id":"d1","changed":["A","B"]}`, func(c *Client) (err error) {
			out, err = c.Services.PatchEnv(bg, "s1", PatchServiceEnvBody{Set: map[string]string{"A": "1"}, Unset: []string{"B"}})
			return
		})
		expectRequest(t, cap, "PATCH", "/api/v1/services/s1/env", "", `{"set":{"A":"1"},"unset":["B"]}`)
		if out.DeploymentID != "d1" || len(out.Changed) != 2 {
			t.Errorf("result = %+v", out)
		}
	})
	t.Run("Logs", func(t *testing.T) {
		var out *LogLineList
		cap := roundTrip(t, 200, `{"data":[{"seq":1,"stream":"stdout","ts":1700000000,"message":"up"}],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Services.Logs(bg, "s1", LogOptions{Tail: 50, Since: 1700000000})
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/services/s1/logs", "since=1700000000&tail=50", "")
		if len(out.Data) != 1 || out.Data[0].Message != "up" {
			t.Errorf("logs = %+v", out)
		}
	})
}

func TestServicesFollowLogs(t *testing.T) {
	var gotPath, gotQuery, gotAccept, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.EscapedPath(), r.URL.RawQuery
		gotAccept, gotAuth = r.Header.Get("Accept"), r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": keep-alive\n\n"+
			"data: {\"seq\":1,\"stream\":\"stdout\",\"ts\":null,\"message\":\"one\"}\n\n"+
			"data: not json\n\n"+
			"data: {\"seq\":2,\"stream\":\"stderr\",\"ts\":null,\"message\":\"two\"}\r\n\r\n")
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	var lines []string
	err := c.Services.FollowLogs(bg, "s/1", LogOptions{Tail: 10}, func(l LogLine) error {
		lines = append(lines, l.Message)
		return nil
	})
	if err != nil {
		t.Fatalf("FollowLogs: %v", err)
	}
	if gotPath != "/api/v1/services/s%2F1/logs/stream" || gotQuery != "tail=10" || gotAccept != "text/event-stream" || gotAuth != "Bearer swk_test" {
		t.Errorf("request = %s?%s accept=%q auth=%q", gotPath, gotQuery, gotAccept, gotAuth)
	}
	if strings.Join(lines, ",") != "one,two" {
		t.Errorf("lines = %v (the malformed event is skipped)", lines)
	}

	stop := errors.New("stop")
	if err := c.Services.FollowLogs(bg, "s1", LogOptions{}, func(LogLine) error { return stop }); !errors.Is(err, stop) {
		t.Errorf("fn error = %v, want stop", err)
	}

	problem := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(404)
		_, _ = io.WriteString(w, `{"type":"about:blank","title":"Not Found","status":404,"detail":"no such service"}`)
	}))
	defer problem.Close()
	var apiErr *APIError
	if err := newTestClient(t, problem).Services.FollowLogs(bg, "x", LogOptions{}, func(LogLine) error { return nil }); !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Errorf("error = %v, want *APIError 404", err)
	}
}

func TestServicesFollowLogsStopsOnCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"seq\":1,\"stream\":\"stdout\",\"ts\":null,\"message\":\"one\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done() // stay open until the client goes away
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(bg)
	err := newTestClient(t, srv).Services.FollowLogs(ctx, "s1", LogOptions{}, func(LogLine) error {
		cancel()
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
}

func TestStacksTelemetryErrors(t *testing.T) {
	t.Run("Telemetry", func(t *testing.T) {
		var out *StackTelemetry
		cap := roundTrip(t, 200, `{"stack":"shop","enabled":true}`, func(c *Client) (err error) {
			out, err = c.Stacks.Telemetry(bg, "shop")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/stacks/shop/telemetry", "", "")
		if !out.Enabled {
			t.Errorf("telemetry = %+v", out)
		}
	})
	t.Run("SetTelemetry", func(t *testing.T) {
		var out *StackTelemetry
		cap := roundTrip(t, 200, `{"stack":"shop","enabled":false}`, func(c *Client) (err error) {
			out, err = c.Stacks.SetTelemetry(bg, "shop", false)
			return
		})
		expectRequest(t, cap, "PUT", "/api/v1/stacks/shop/telemetry", "", `{"enabled":false}`)
		if out.Enabled {
			t.Errorf("telemetry = %+v", out)
		}
	})
	t.Run("Errors", func(t *testing.T) {
		var out *StackErrorsStatus
		cap := roundTrip(t, 200, `{"stack":"shop","enabled":true,"store_enabled":true,"project":null,"pending_redeploy":["shop_web"]}`, func(c *Client) (err error) {
			out, err = c.Stacks.Errors(bg, "shop")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/stacks/shop/errors", "", "")
		if out.Project != nil || len(out.PendingRedeploy) != 1 {
			t.Errorf("errors = %+v", out)
		}
	})
	t.Run("RotateErrorsKey", func(t *testing.T) {
		var out *ErrorProject
		cap := roundTrip(t, 200, `{"stack":"shop","project_id":7,"dsn":"https://k@x/7","rate_limit_per_minute":600,"created_at":"t","rotated_at":"t2"}`, func(c *Client) (err error) {
			out, err = c.Stacks.RotateErrorsKey(bg, "shop")
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/stacks/shop/errors/rotate-key", "", "")
		if out.ProjectID != 7 || out.Dsn != "https://k@x/7" {
			t.Errorf("project = %+v", out)
		}
	})
}

func TestNodesActions(t *testing.T) {
	t.Run("Remove", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"n1","removed":true}`, func(c *Client) (err error) {
			out, err = c.Nodes.Remove(bg, "n 1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/nodes/n%201", "", "")
		if !out.Removed {
			t.Errorf("removed = %+v", out)
		}
	})
	t.Run("Drain", func(t *testing.T) {
		var out *NodeAvailability
		cap := roundTrip(t, 200, `{"id":"n1","availability":"drain"}`, func(c *Client) (err error) {
			out, err = c.Nodes.Drain(bg, "n1")
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/nodes/n1/drain", "", "")
		if out.Availability != "drain" {
			t.Errorf("availability = %+v", out)
		}
	})
	t.Run("Uncordon", func(t *testing.T) {
		var out *NodeAvailability
		cap := roundTrip(t, 200, `{"id":"n1","availability":"active"}`, func(c *Client) (err error) {
			out, err = c.Nodes.Uncordon(bg, "n1")
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/nodes/n1/uncordon", "", "")
		if out.Availability != "active" {
			t.Errorf("availability = %+v", out)
		}
	})
	t.Run("SetLabels", func(t *testing.T) {
		var out *NodeLabels
		cap := roundTrip(t, 200, `{"id":"n1","labels":{"zone":"eu"}}`, func(c *Client) (err error) {
			out, err = c.Nodes.SetLabels(bg, "n1", map[string]string{"zone": "eu"})
			return
		})
		expectRequest(t, cap, "PUT", "/api/v1/nodes/n1/labels", "", `{"labels":{"zone":"eu"}}`)
		if out.Labels["zone"] != "eu" {
			t.Errorf("labels = %+v", out)
		}
	})
}

const domainDetail = `{"host":"shop.example.com","state":"live","reason":"ok","warnings":[],"gated":false,"verified_at":"t","verified_manually":false,
	"last_checked_at":null,"next_check_at":null,"dns":{},"certificate":{},
	"guidance":{"mode":"records","summary":"Point it at the edge","records":[{"type":"A","name":"shop.example.com","label":"shop","value":"203.0.113.7"}],"alternatives":[]},
	"companion":null}`

func TestIngressDomainsAndSettings(t *testing.T) {
	t.Run("UpdateDomain", func(t *testing.T) {
		var out *IngressDomain
		cap := roundTrip(t, 200, `{"id":"d1","host":"example.com","service_id":"s1","service_name":"web","target_port":80,"tls":"auto","path_prefix":null,"www":"serve-both","companion_host":"www.example.com","status":null,"companion_status":null}`, func(c *Client) (err error) {
			out, err = c.Ingress.UpdateDomain(bg, "d1", UpdateDomainRequest{Www: Ptr("serve-both")})
			return
		})
		expectRequest(t, cap, "PATCH", "/api/v1/ingress/domains/d1", "", `{"www":"serve-both"}`)
		if out.Www != "serve-both" {
			t.Errorf("domain = %+v", out)
		}
		cap = roundTrip(t, 200, `{"id":"d1","host":"example.com","service_id":"s1","service_name":"web","target_port":80,"tls":"auto","path_prefix":null,"companion_host":null,"status":null,"companion_status":null}`, func(c *Client) error {
			_, err := c.Ingress.UpdateDomain(bg, "d1", UpdateDomainRequest{})
			return err
		})
		expectRequest(t, cap, "PATCH", "/api/v1/ingress/domains/d1", "", `{"www":null}`)
	})
	t.Run("DomainStatus", func(t *testing.T) {
		var out *IngressDomainDetail
		cap := roundTrip(t, 200, domainDetail, func(c *Client) (err error) {
			out, err = c.Ingress.DomainStatus(bg, "d 1")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/ingress/domains/d%201/status", "", "")
		if out.Host != "shop.example.com" || out.Guidance.Mode != "records" || len(out.Guidance.Records) != 1 || out.Companion != nil {
			t.Errorf("detail = %+v", out)
		}
	})
	t.Run("VerifyDomain", func(t *testing.T) {
		var out *IngressDomainDetail
		cap := roundTrip(t, 200, domainDetail, func(c *Client) (err error) {
			out, err = c.Ingress.VerifyDomain(bg, "d1")
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/ingress/domains/d1/verify", "", "")
		if out.State != "live" {
			t.Errorf("detail = %+v", out)
		}
	})

	const settings = `{"org_id":"org1","driver":"caddy","enabled":false,"topology":"controller","controller_image":null,"default_controller_image":"caddy:2",
		"target_nodes":[],"tls":{"acme_email":null,"on_demand":false,"ask_url":null},"tunnel":null,"dns_provider":null,"updated_at":"t"}`
	t.Run("Settings", func(t *testing.T) {
		var out *IngressSettings
		cap := roundTrip(t, 200, settings, func(c *Client) (err error) {
			out, err = c.Ingress.Settings(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/ingress/settings", "", "")
		if out.Driver != "caddy" || out.DefaultControllerImage != "caddy:2" || out.Tunnel != nil {
			t.Errorf("settings = %+v", out)
		}
	})
	t.Run("UpdateSettings", func(t *testing.T) {
		var out *IngressSettings
		cap := roundTrip(t, 200, settings, func(c *Client) (err error) {
			out, err = c.Ingress.UpdateSettings(bg, UpdateIngressSettingsRequest{Enabled: Ptr(false)})
			return
		})
		// false is sent, and nothing else: the tunnel and DNS provider are kept.
		expectRequest(t, cap, "PUT", "/api/v1/ingress/settings", "", `{"enabled":false}`)
		if out.Enabled {
			t.Errorf("settings = %+v", out)
		}
		cap = roundTrip(t, 200, settings, func(c *Client) error {
			_, err := c.Ingress.UpdateSettings(bg, UpdateIngressSettingsRequest{Tunnel: Null[IngressTunnelInput](), TLS: &IngressTlsInput{OnDemand: Ptr(true)}})
			return err
		})
		expectRequest(t, cap, "PUT", "/api/v1/ingress/settings", "", `{"tls":{"on_demand":true},"tunnel":null}`)
	})
}

func TestAppsPreview(t *testing.T) {
	var out *PreviewResult
	cap := roundTrip(t, 202, `{"action":"deployed","stack":"shop-pr-7","url":"https://pr-7.example.com","reason":null}`, func(c *Client) (err error) {
		out, err = c.Apps.Preview(bg, "gr 1", "feat/x")
		return
	})
	expectRequest(t, cap, "POST", "/api/v1/apps/gr%201/previews", "", `{"branch":"feat/x"}`)
	if out.Stack == nil || *out.Stack != "shop-pr-7" {
		t.Errorf("preview = %+v", out)
	}
}

const apiKey = `"id":"k1","name":"ci","prefix":"ab12","scopes":["read","deploy"],"preset":"deploy","stack_names":null,"last_used_at":null,
	"expires_at":null,"created_at":"t","created_by_id":"u1","revoked_at":null,"status":"active"`

func TestAPIKeys(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *ApiKeyList
		cap := roundTrip(t, 200, `{"data":[{`+apiKey+`}],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.APIKeys.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/api-keys", "", "")
		if len(out.Data) != 1 || out.Data[0].Prefix != "ab12" {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Create", func(t *testing.T) {
		var out *ApiKeyIssued
		cap := roundTrip(t, 201, `{`+apiKey+`,"key":"swk_ab12_secret"}`, func(c *Client) (err error) {
			out, err = c.APIKeys.Create(bg, CreateApiKeyRequest{Name: "ci", Preset: "deploy", StackNames: NullableValue([]string{"shop"})})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/api-keys", "", `{"name":"ci","preset":"deploy","stack_names":["shop"]}`)
		if out.Key != "swk_ab12_secret" || out.ID != "k1" || len(out.Scopes) != 2 {
			t.Errorf("issued = %+v", out)
		}
	})
	t.Run("Revoke", func(t *testing.T) {
		var out *Revoked
		cap := roundTrip(t, 200, `{"id":"k1","revoked":true}`, func(c *Client) (err error) {
			out, err = c.APIKeys.Revoke(bg, "k1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/api-keys/k1", "", "")
		if !out.Revoked {
			t.Errorf("revoked = %+v", out)
		}
	})
}

const dnsZone = `{"id":"z1","zone":"example.com","mode":"authoritative","enabled":true,"ttl":300,"serial":1,"apex_to_edge":true,"auto_www":false,"nameservers":[]}`
const dnsRecord = `{"id":"r1","zone_id":"z1","name":"@","type":"MX","value":"mx.example.com","ttl":null,"priority":0}`

func TestDNS(t *testing.T) {
	t.Run("ListZones", func(t *testing.T) {
		var out *DnsZoneList
		cap := roundTrip(t, 200, `{"data":[`+dnsZone+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.DNS.ListZones(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/dns/zones", "", "")
		if len(out.Data) != 1 || out.Data[0].Zone != "example.com" {
			t.Errorf("zones = %+v", out)
		}
	})
	t.Run("CreateZone", func(t *testing.T) {
		var out *DnsZone
		cap := roundTrip(t, 200, dnsZone, func(c *Client) (err error) {
			out, err = c.DNS.CreateZone(bg, CreateDnsZoneRequest{Zone: "example.com"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/dns/zones", "", `{"zone":"example.com"}`)
		if out.ID != "z1" {
			t.Errorf("zone = %+v", out)
		}
	})
	t.Run("RemoveZone", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"z1","removed":true}`, func(c *Client) (err error) {
			out, err = c.DNS.RemoveZone(bg, "z1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/dns/zones/z1", "", "")
		if !out.Removed {
			t.Errorf("removed = %+v", out)
		}
	})
	t.Run("Delegation", func(t *testing.T) {
		var out *DnsDelegationCheck
		cap := roundTrip(t, 200, `{"zone":"example.com","delegated":true,"public_ns":["ns1.example.net"],"nameservers":[]}`, func(c *Client) (err error) {
			out, err = c.DNS.Delegation(bg, "z1")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/dns/zones/z1/delegation", "", "")
		if !out.Delegated || len(out.PublicNs) != 1 {
			t.Errorf("delegation = %+v", out)
		}
	})
	t.Run("ListRecords", func(t *testing.T) {
		var out *DnsRecordList
		cap := roundTrip(t, 200, `{"data":[`+dnsRecord+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.DNS.ListRecords(bg, "z1")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/dns/zones/z1/records", "", "")
		if len(out.Data) != 1 || out.Data[0].Type != "MX" {
			t.Errorf("records = %+v", out)
		}
	})
	t.Run("UpsertRecord", func(t *testing.T) {
		var out *DnsRecord
		cap := roundTrip(t, 200, dnsRecord, func(c *Client) (err error) {
			out, err = c.DNS.UpsertRecord(bg, "z1", UpsertDnsRecordRequest{Name: "@", Type: "MX", Value: "mx.example.com", Priority: Ptr(0)})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/dns/zones/z1/records", "", `{"name":"@","type":"MX","value":"mx.example.com","priority":0}`)
		if out.Priority == nil || *out.Priority != 0 {
			t.Errorf("record = %+v", out)
		}
	})
	t.Run("RemoveRecord", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"r1","removed":true}`, func(c *Client) (err error) {
			out, err = c.DNS.RemoveRecord(bg, "r1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/dns/records/r1", "", "")
		if out.ID != "r1" {
			t.Errorf("removed = %+v", out)
		}
	})
}

const backupTarget = `{"id":"bt1","name":"offsite","kind":"s3","endpoint":null,"bucket":"backups","prefix":null,"region":"eu-west-1","has_credentials":true,"enabled":true,"created_at":"t"}`

func TestBackups(t *testing.T) {
	t.Run("ListTargets", func(t *testing.T) {
		var out *BackupTargetList
		cap := roundTrip(t, 200, `{"data":[`+backupTarget+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Backups.ListTargets(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/backup-targets", "", "")
		if len(out.Data) != 1 || out.Data[0].Bucket != "backups" {
			t.Errorf("targets = %+v", out)
		}
	})
	t.Run("AddTarget", func(t *testing.T) {
		var out *BackupTarget
		cap := roundTrip(t, 201, backupTarget, func(c *Client) (err error) {
			out, err = c.Backups.AddTarget(bg, AddBackupTargetRequest{Name: "offsite", Kind: "s3", Bucket: "backups"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/backup-targets", "", `{"name":"offsite","kind":"s3","bucket":"backups"}`)
		if !out.HasCredentials {
			t.Errorf("target = %+v", out)
		}
	})
	t.Run("RemoveTarget", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"bt1","removed":true}`, func(c *Client) (err error) {
			out, err = c.Backups.RemoveTarget(bg, "bt1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/backup-targets/bt1", "", "")
		if !out.Removed {
			t.Errorf("removed = %+v", out)
		}
	})
	t.Run("ListSnapshots", func(t *testing.T) {
		var out *SnapshotList
		cap := roundTrip(t, 200, `{"data":[{"id":"sn1","volume":"shop_data","target_id":"bt1","target_name":"offsite","status":"ok","restic_id":"abc","size_bytes":"1024","error":null,"started_at":"t","finished_at":"t2"}],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Backups.ListSnapshots(bg, SnapshotFilter{Volume: "shop_data", TargetID: "bt1"})
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/snapshots", "target_id=bt1&volume=shop_data", "")
		if len(out.Data) != 1 || out.Data[0].Volume != "shop_data" {
			t.Errorf("snapshots = %+v", out)
		}
	})
	t.Run("BackupVolume", func(t *testing.T) {
		var out *BackupRun
		cap := roundTrip(t, 201, `{"snapshot_id":"sn1","restic_id":"abc","size_bytes":"1024"}`, func(c *Client) (err error) {
			out, err = c.Backups.BackupVolume(bg, BackupVolumeRequest{TargetID: "bt1", Volume: "shop_data"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/snapshots", "", `{"target_id":"bt1","volume":"shop_data"}`)
		if out.SnapshotID != "sn1" {
			t.Errorf("run = %+v", out)
		}
	})
	t.Run("RestoreSnapshot", func(t *testing.T) {
		var out *RestoreResult
		cap := roundTrip(t, 200, `{"target_volume":"shop_data_restore","bytes_restored":"1024"}`, func(c *Client) (err error) {
			out, err = c.Backups.RestoreSnapshot(bg, RestoreSnapshotRequest{SnapshotID: "sn1", TargetVolume: "shop_data_restore"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/snapshots/restore", "", `{"snapshot_id":"sn1","target_volume":"shop_data_restore"}`)
		if out.TargetVolume != "shop_data_restore" {
			t.Errorf("restore = %+v", out)
		}
	})
}

const clusterVolume = `{"id":"v1","name":"pgdata","csi_driver":"rbd.csi.ceph.com","access_mode":"single-writer","capacity_bytes":"0","status":"ready","service_id":null,"created_at":"t"}`

func TestVolumes(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *ClusterVolumeList
		cap := roundTrip(t, 200, `{"data":[`+clusterVolume+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.Volumes.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/volumes", "", "")
		if len(out.Data) != 1 || out.Data[0].Name != "pgdata" {
			t.Errorf("volumes = %+v", out)
		}
	})
	t.Run("Register", func(t *testing.T) {
		var out *ClusterVolume
		cap := roundTrip(t, 201, clusterVolume, func(c *Client) (err error) {
			out, err = c.Volumes.Register(bg, RegisterVolumeRequest{Name: "pgdata", CsiDriver: "rbd.csi.ceph.com", CapacityBytes: Ptr(0)})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/volumes", "", `{"name":"pgdata","csi_driver":"rbd.csi.ceph.com","capacity_bytes":0}`)
		if out.Status != "ready" {
			t.Errorf("volume = %+v", out)
		}
	})
	t.Run("Remove", func(t *testing.T) {
		var out *Removed
		cap := roundTrip(t, 200, `{"id":"v1","removed":true}`, func(c *Client) (err error) {
			out, err = c.Volumes.Remove(bg, "v1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/volumes/v1", "", "")
		if !out.Removed {
			t.Errorf("removed = %+v", out)
		}
	})
}

func TestAuditExport(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.EscapedPath(), r.URL.RawQuery
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("X-Swarmy-Row-Count", "2")
		w.Header().Set("X-Swarmy-Truncated", "true")
		_, _ = io.WriteString(w, "at,action\nt1,secrets.read\nt2,secrets.write\n")
	}))
	defer srv.Close()

	out, err := newTestClient(t, srv).Audit.Export(bg, AuditExportOptions{Action: "secrets.", ActorType: "apikey", Format: "csv"})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if gotPath != "/api/v1/audit/export" || gotQuery != "action=secrets.&actor_type=apikey&format=csv" {
		t.Errorf("request = %s?%s", gotPath, gotQuery)
	}
	if !strings.HasPrefix(string(out.Content), "at,action\n") || out.RowCount != 2 || !out.Truncated || !strings.HasPrefix(out.ContentType, "text/csv") {
		t.Errorf("export = %+v", out)
	}
}

const registryCredential = `{"id":"rc1","prefix":"ghcr.io/acme","provider":"ghcr","label":"ci","username":"bot","has_secret":true,"last_tested_at":null,
	"last_test_ok":null,"last_test_message":null,"created_at":"t","updated_at":"t"}`

func TestRegistryCredentials(t *testing.T) {
	t.Run("List", func(t *testing.T) {
		var out *RegistryCredentialList
		cap := roundTrip(t, 200, `{"data":[`+registryCredential+`],"next_cursor":null}`, func(c *Client) (err error) {
			out, err = c.RegistryCredentials.List(bg)
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/registry-credentials", "", "")
		if len(out.Data) != 1 || out.Data[0].Prefix != "ghcr.io/acme" {
			t.Errorf("list = %+v", out)
		}
	})
	t.Run("Create", func(t *testing.T) {
		var out *RegistryCredential
		cap := roundTrip(t, 201, registryCredential, func(c *Client) (err error) {
			out, err = c.RegistryCredentials.Create(bg, CreateRegistryCredentialBody{Prefix: "ghcr.io/acme", Username: "bot", Secret: "s3cret", Label: NullableValue("ci")})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/registry-credentials", "", `{"prefix":"ghcr.io/acme","username":"bot","secret":"s3cret","label":"ci"}`)
		if !out.HasSecret {
			t.Errorf("credential = %+v", out)
		}
	})
	t.Run("Update", func(t *testing.T) {
		var out *RegistryCredential
		cap := roundTrip(t, 200, registryCredential, func(c *Client) (err error) {
			out, err = c.RegistryCredentials.Update(bg, "rc 1", UpdateRegistryCredentialBody{Label: Null[string]()})
			return
		})
		expectRequest(t, cap, "PATCH", "/api/v1/registry-credentials/rc%201", "", `{"label":null}`)
		if out.Username != "bot" {
			t.Errorf("credential = %+v", out)
		}
	})
	t.Run("Remove", func(t *testing.T) {
		var out *RegistryCredentialDeleted
		cap := roundTrip(t, 200, `{"ok":true}`, func(c *Client) (err error) {
			out, err = c.RegistryCredentials.Remove(bg, "rc1")
			return
		})
		expectRequest(t, cap, "DELETE", "/api/v1/registry-credentials/rc1", "", "")
		if !out.Ok {
			t.Errorf("deleted = %+v", out)
		}
	})
	t.Run("Test", func(t *testing.T) {
		var out *RegistryTestResult
		cap := roundTrip(t, 200, `{"ok":true,"status":"ok","message":"login ok","checked_manifest":true}`, func(c *Client) (err error) {
			out, err = c.RegistryCredentials.Test(bg, "rc1", TestRegistryCredentialBody{Image: "ghcr.io/acme/web:1"})
			return
		})
		expectRequest(t, cap, "POST", "/api/v1/registry-credentials/rc1/test", "", `{"image":"ghcr.io/acme/web:1"}`)
		if !out.CheckedManifest {
			t.Errorf("result = %+v", out)
		}
	})
}

func TestDeployments(t *testing.T) {
	t.Run("Get", func(t *testing.T) {
		var out *DeploymentStatus
		cap := roundTrip(t, 200, `{"deployment_id":"d1","service_id":"s1","kind":"update","phase":"converged","desired":2,"ready":2,"message":null,"started_at":"t","finished_at":"t2"}`, func(c *Client) (err error) {
			out, err = c.Deployments.Get(bg, "d1")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/deployments/d1", "", "")
		if out.Phase != "converged" || out.Ready == nil || *out.Ready != 2 {
			t.Errorf("status = %+v", out)
		}
	})
	t.Run("Events", func(t *testing.T) {
		var out *DeployEvents
		cap := roundTrip(t, 200, `{"deploy_id":"dep 1","stack":"shop","started_at":1700000000,"done":true,"data":[{"seq":1,"at":1700000001,"stage":"pull","status":"ok","node":"n1","service":null,"message":"pulled","detail":{}}]}`, func(c *Client) (err error) {
			out, err = c.Deployments.Events(bg, "dep 1")
			return
		})
		expectRequest(t, cap, "GET", "/api/v1/deploys/dep%201/events", "", "")
		if !out.Done || len(out.Data) != 1 || out.Data[0].Stage != "pull" {
			t.Errorf("events = %+v", out)
		}
	})
}
