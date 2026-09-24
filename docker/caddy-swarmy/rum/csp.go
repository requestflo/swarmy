package swarmyrum

import (
	"strings"
)

// CSP handling for the injected RUM tag. The tag loads a SAME-ORIGIN script
// (/_swarmy/rum.js) that posts to a SAME-ORIGIN endpoint (/_swarmy/rum), so
// the most we ever need is `'self'` (or a nonce) on scripts and `'self'` on
// connections. Every change ADDS a source to a directive the page already has;
// nothing an app's policy allowed is removed, and nothing it forbade outright
// ('none') is loosened: those responses are skipped and reported instead.

// cspPlan is the outcome of planning one response's policies.
type cspPlan struct {
	// Skip is non-empty when injection must not happen (reported as the reason).
	Skip string
	// Nonce to put on the tag ("" = none needed). Reused from the page's own
	// policy when it already carries one, else freshly generated.
	Nonce string
	// Rewritten policies, index-aligned with the input headers.
	Policies []string
	// Changed reports whether any policy text differs from its input.
	Changed bool
}

type directive struct {
	name   string
	tokens []string
}

func parsePolicy(p string) []directive {
	var out []directive
	for _, part := range strings.Split(p, ";") {
		f := strings.Fields(part)
		if len(f) == 0 {
			continue
		}
		out = append(out, directive{name: strings.ToLower(f[0]), tokens: f[1:]})
	}
	return out
}

func serializePolicy(ds []directive) string {
	parts := make([]string, 0, len(ds))
	for _, d := range ds {
		if len(d.tokens) == 0 {
			parts = append(parts, d.name)
			continue
		}
		parts = append(parts, d.name+" "+strings.Join(d.tokens, " "))
	}
	return strings.Join(parts, "; ")
}

func find(ds []directive, name string) int {
	for i, d := range ds {
		if d.name == name {
			return i
		}
	}
	return -1
}

func hasToken(tokens []string, want string) bool {
	for _, t := range tokens {
		if strings.EqualFold(t, want) {
			return true
		}
	}
	return false
}

func existingNonce(tokens []string) string {
	for _, t := range tokens {
		lt := strings.ToLower(t)
		if strings.HasPrefix(lt, "'nonce-") && strings.HasSuffix(t, "'") && len(t) > len("'nonce-'") {
			return t[len("'nonce-") : len(t)-1]
		}
	}
	return ""
}

func hasHash(tokens []string) bool {
	for _, t := range tokens {
		lt := strings.ToLower(t)
		if strings.HasPrefix(lt, "'sha256-") || strings.HasPrefix(lt, "'sha384-") || strings.HasPrefix(lt, "'sha512-") {
			return true
		}
	}
	return false
}

// allowsSameOrigin: does a source list already admit a same-origin URL?
func allowsSameOrigin(tokens []string, host string) bool {
	for _, t := range tokens {
		lt := strings.ToLower(t)
		if lt == "'self'" || lt == "*" {
			return true
		}
		if host != "" {
			h := strings.ToLower(host)
			if lt == h || lt == "https://"+h || lt == "http://"+h {
				return true
			}
		}
	}
	return false
}

// effective returns the index of the directive governing a fetch type, walking
// the CSP3 fallback list (e.g. script-src-elem → script-src → default-src).
func effective(ds []directive, chain ...string) (int, string) {
	for _, n := range chain {
		if i := find(ds, n); i >= 0 {
			return i, n
		}
	}
	return -1, ""
}

// planCSP plans how to admit the RUM tag under every enforced policy on the
// response. newNonce is called at most once, only when a nonce must be added.
func planCSP(policies []string, host string, newNonce func() string) cspPlan {
	plan := cspPlan{Policies: make([]string, len(policies))}
	// Pass 1: find a nonce any policy already uses for scripts (all policies
	// must admit the tag, and one nonce attribute is all a tag can carry).
	for _, p := range policies {
		ds := parsePolicy(p)
		if i, _ := effective(ds, "script-src-elem", "script-src", "default-src"); i >= 0 {
			if n := existingNonce(ds[i].tokens); n != "" {
				plan.Nonce = n
				break
			}
		}
	}
	for idx, p := range policies {
		ds := parsePolicy(p)
		// ── scripts ────────────────────────────────────────────────
		si, sname := effective(ds, "script-src-elem", "script-src", "default-src")
		if si >= 0 {
			toks := ds[si].tokens
			if hasToken(toks, "'none'") && len(toks) == 1 {
				return cspPlan{Skip: "csp-script-none"}
			}
			needNonce := hasToken(toks, "'strict-dynamic'") || hasHash(toks) || existingNonce(toks) != ""
			var add []string
			if needNonce {
				if plan.Nonce == "" {
					plan.Nonce = newNonce()
				}
				if existingNonce(toks) != plan.Nonce {
					// Adding a nonce is safe here: the policy already carries
					// hashes/nonces/strict-dynamic, so 'unsafe-inline' is already
					// ignored and the app's own behaviour does not change.
					add = append(add, "'nonce-"+plan.Nonce+"'")
				}
			} else if !allowsSameOrigin(toks, host) {
				// A host-source list (maybe with 'unsafe-inline'): a nonce would
				// switch 'unsafe-inline' OFF and break the app's inline scripts,
				// so admit the same origin instead.
				add = append(add, "'self'")
			}
			if len(add) > 0 {
				if sname == "default-src" {
					// Never widen default-src (it governs every fetch type): give
					// scripts their own directive = default-src + our source.
					nt := append(append([]string{}, toks...), add...)
					ds = append(ds, directive{name: "script-src", tokens: nt})
				} else {
					ds[si].tokens = append(ds[si].tokens, add...)
				}
				// A separate script-src-elem earlier in the chain would win for
				// <script> elements; script-src governs too when it exists and
				// script-src-elem does not — both handled by `effective`.
			}
		}
		// ── connections (beacon + fetch to /_swarmy/rum) ────────────
		ci, cname := effective(ds, "connect-src", "default-src")
		if ci >= 0 {
			toks := ds[ci].tokens
			if hasToken(toks, "'none'") && len(toks) == 1 {
				return cspPlan{Skip: "csp-connect-none"}
			}
			if !allowsSameOrigin(toks, host) {
				if cname == "default-src" {
					nt := append(append([]string{}, toks...), "'self'")
					ds = append(ds, directive{name: "connect-src", tokens: nt})
				} else {
					ds[ci].tokens = append(ds[ci].tokens, "'self'")
				}
			}
		}
		// A replay Worker is not used by the recorder; nothing else to admit.
		if out := serializePolicy(ds); out != normalise(p) {
			plan.Policies[idx] = out
			plan.Changed = true
		} else {
			plan.Policies[idx] = p // untouched policies stay byte-identical
		}
	}
	return plan
}

// normalise renders a policy through the same parser so formatting-only
// differences (whitespace, trailing ';') never count as a change.
func normalise(p string) string { return serializePolicy(parsePolicy(p)) }
