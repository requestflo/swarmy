import { emptyRuleTally, type AdmissionRuleTally, type AdmissionTallyView } from '@swarmy/core';

/**
 * Supply-chain gate receipts (board 51), from the real records swarmy keeps:
 * image scans (`registryPolicy.listScans`, newest first), the admission
 * receipts counted per check (`guardrails.tally`), and the override rows in
 * the decisions feed (`guardrails.recentDecisions`) for who went past a gate.
 *
 * - The CVE gate decides on an image's LATEST scan (`decideImageAdmission`),
 *   so "images it refuses" = images whose newest scan in the window has a
 *   critical CVE.
 * - Every admission run is recorded per check, so each gate's "stopped N" is
 *   the deploys it refused in the window (`images/critical-cves`,
 *   `images/unsigned`), and "warned" the unscanned images it let through.
 */
export const SCAN_LIMIT = 200;
export const WINDOW_DAYS = 30;

export interface ScanLike {
  imageRef: string;
  criticalCount: number;
  highCount: number;
  status: string;
  scannedAt: string;
}

export interface DecisionLike {
  at: string;
  kind: 'blocked' | 'overridden';
  stack: string | null;
  violations: Array<{ rule: string }>;
}

export interface GateReceipts {
  scans: number;
  /** A full page that is all inside the window: `scans` is "at least". */
  scansCapped: boolean;
  withCritical: number;
  withHigh: number;
  errored: number;
  /** Images whose newest scan has a critical CVE: what the CVE gate refuses. */
  criticalImages: Array<{ ref: string; critical: number }>;
  overrides: { cve: DecisionLike[]; unsigned: DecisionLike[] };
  /** Per-check counts from the admission receipts. */
  checks: { cve: AdmissionRuleTally; unscanned: AdmissionRuleTally; unsigned: AdmissionRuleTally };
  /** The receipts window held more than one read: every count is a floor. */
  checksCapped: boolean;
}

const check = (tally: AdmissionTallyView, rule: string): AdmissionRuleTally => tally.rules.find((r) => r.rule === rule) ?? emptyRuleTally(rule);

export function gateReceipts(scans: readonly ScanLike[], decisions: readonly DecisionLike[], tally: AdmissionTallyView, now: number): GateReceipts {
  const since = now - WINDOW_DAYS * 86_400_000;
  const recent = scans.filter((s) => Date.parse(s.scannedAt) >= since);
  const latest = new Map<string, ScanLike>();
  for (const s of recent) if (!latest.has(s.imageRef)) latest.set(s.imageRef, s);
  const criticalImages = [...latest.values()].filter((s) => s.criticalCount > 0).map((s) => ({ ref: s.imageRef, critical: s.criticalCount }));
  const overridden = decisions.filter((d) => d.kind === 'overridden' && Date.parse(d.at) >= since);
  const has = (d: DecisionLike, rule: string): boolean => d.violations.some((v) => v.rule === rule);
  return {
    scans: recent.length,
    scansCapped: scans.length >= SCAN_LIMIT && recent.length === scans.length,
    withCritical: recent.filter((s) => s.criticalCount > 0).length,
    withHigh: recent.filter((s) => s.highCount > 0).length,
    errored: recent.filter((s) => s.status === 'error').length,
    criticalImages,
    overrides: { cve: overridden.filter((d) => has(d, 'images/critical-cves')), unsigned: overridden.filter((d) => has(d, 'images/unsigned')) },
    checks: { cve: check(tally, 'images/critical-cves'), unscanned: check(tally, 'images/unscanned'), unsigned: check(tally, 'images/unsigned') },
    checksCapped: tally.capped,
  };
}

/** `localhost:5000/northwind-web:1.8.2` → `northwind-web:1.8.2` (the registry host is said once, elsewhere). */
export function shortRef(ref: string): string {
  return ref.replace(/^[^/]+\//, '').replace(/@sha256:([0-9a-f]{8})[0-9a-f]+$/, '@$1…');
}
