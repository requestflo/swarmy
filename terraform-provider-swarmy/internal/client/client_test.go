package client

import (
	"net/http"
	"testing"
)

func TestNormalizeBaseURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "bare host gets base path", in: "https://controller.example.com", want: "https://controller.example.com/api/v1"},
		{name: "trailing slash trimmed", in: "https://controller.example.com/", want: "https://controller.example.com/api/v1"},
		{name: "already has base path", in: "https://controller.example.com/api/v1", want: "https://controller.example.com/api/v1"},
		{name: "base path with trailing slash", in: "https://controller.example.com/api/v1/", want: "https://controller.example.com/api/v1"},
		{name: "subpath gets base path appended", in: "https://example.com/swarmy", want: "https://example.com/swarmy/api/v1"},
		{name: "empty is error", in: "", wantErr: true},
		{name: "scheme-less is error", in: "controller.example.com", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeBaseURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeBaseURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestResolve(t *testing.T) {
	c, err := New("https://controller.example.com", "swk_test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got := c.resolve("/services/svc-123")
	want := "https://controller.example.com/api/v1/services/svc-123"
	if got != want {
		t.Fatalf("resolve = %q, want %q", got, want)
	}
}

func TestParseErrorProblemJSON(t *testing.T) {
	body := []byte(`{"type":"about:blank","title":"Not Found","status":404,"detail":"service svc-x not found","swarmy_code":"NOT_FOUND"}`)
	err := parseError(http.StatusNotFound, body)

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusNotFound {
		t.Fatalf("StatusCode = %d, want 404", apiErr.StatusCode)
	}
	if apiErr.Problem == nil {
		t.Fatal("expected Problem to be decoded")
	}
	if apiErr.Problem.SwarmyCode != "NOT_FOUND" {
		t.Fatalf("SwarmyCode = %q, want NOT_FOUND", apiErr.Problem.SwarmyCode)
	}
	if !IsNotFound(err) {
		t.Fatal("IsNotFound should be true for a 404")
	}
	wantMsg := "swarmy API error 404 (NOT_FOUND): Not Found: service svc-x not found"
	if apiErr.Error() != wantMsg {
		t.Fatalf("Error() = %q, want %q", apiErr.Error(), wantMsg)
	}
}

func TestParseErrorNonJSON(t *testing.T) {
	err := parseError(http.StatusBadGateway, []byte("upstream is down"))
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.Problem != nil {
		t.Fatal("expected no Problem for non-JSON body")
	}
	if IsNotFound(err) {
		t.Fatal("IsNotFound should be false for a 502")
	}
	if apiErr.Error() != "swarmy API error 502: upstream is down" {
		t.Fatalf("unexpected Error(): %q", apiErr.Error())
	}
}
