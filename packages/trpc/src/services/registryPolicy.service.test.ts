import { describe, expect, it } from 'bun:test';
import {
  MAX_REPORT_CVES,
  extractJsonBlock,
  isOrgRegistryImage,
  parseTrivyReport,
  refAtDigest,
  splitKeygenOutput,
  stripTag,
} from './registryPolicy.service';

function trivyDoc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    SchemaVersion: 2,
    ArtifactName: 'swarmy-registry:5000/northwind-api:2.4.0',
    Metadata: {
      RepoDigests: ['swarmy-registry:5000/northwind-api@sha256:abc123'],
    },
    Results: [
      {
        Target: 'northwind-api (alpine 3.19)',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2025-0001',
            Severity: 'CRITICAL',
            PkgName: 'openssl',
            InstalledVersion: '3.1.0',
            FixedVersion: '3.1.4',
            Title: 'openssl: buffer overflow',
          },
          {
            VulnerabilityID: 'CVE-2025-0002',
            Severity: 'HIGH',
            PkgName: 'zlib',
            InstalledVersion: '1.2.13',
            FixedVersion: '1.3',
            Title: 'zlib: heap corruption',
          },
          {
            VulnerabilityID: 'CVE-2025-0003',
            Severity: 'MEDIUM',
            PkgName: 'musl',
            InstalledVersion: '1.2.4',
          },
          {
            VulnerabilityID: 'CVE-2025-0004',
            Severity: 'LOW',
            PkgName: 'busybox',
            InstalledVersion: '1.36.1',
          },
          {
            VulnerabilityID: 'CVE-2025-0005',
            Severity: 'CRITICAL',
            PkgName: 'libcrypto3',
            InstalledVersion: '3.1.0',
            FixedVersion: '3.1.4',
          },
        ],
      },
      // A result section with no vulnerabilities (trivy emits null).
      { Target: 'app/package-lock.json', Vulnerabilities: null },
    ],
    ...overrides,
  });
}

describe('parseTrivyReport — severity counts', () => {
  it('counts each severity bucket', () => {
    const r = parseTrivyReport(trivyDoc());
    expect(r.criticalCount).toBe(2);
    expect(r.highCount).toBe(1);
    expect(r.mediumCount).toBe(1);
    expect(r.lowCount).toBe(1);
    expect(r.totalCves).toBe(5);
  });

  it('sorts CVEs worst-first (critical → low)', () => {
    const r = parseTrivyReport(trivyDoc());
    expect(r.cves.map((c) => c.severity)).toEqual(['CRITICAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    expect(r.cves[0]?.id).toBe('CVE-2025-0001'); // ties break on id
  });

  it('extracts the digest from Metadata.RepoDigests', () => {
    expect(parseTrivyReport(trivyDoc()).digest).toBe('sha256:abc123');
  });

  it('handles a clean image (no vulnerabilities at all)', () => {
    const r = parseTrivyReport(
      JSON.stringify({ Results: [{ Target: 'x' }], Metadata: { RepoDigests: [] } }),
    );
    expect(r.totalCves).toBe(0);
    expect(r.criticalCount).toBe(0);
    expect(r.cves).toEqual([]);
    expect(r.digest).toBeNull();
  });

  it('tolerates trivy log lines around the JSON (combined stdout+stderr)', () => {
    const noisy = `2026-07-02T10:00:00Z INFO Vulnerability scanning is enabled\n${trivyDoc()}\n`;
    expect(parseTrivyReport(noisy).criticalCount).toBe(2);
  });

  it('trims the stored CVE list to MAX_REPORT_CVES but keeps the full total', () => {
    const many = Array.from({ length: MAX_REPORT_CVES + 25 }, (_, i) => ({
      VulnerabilityID: `CVE-2025-${String(i).padStart(4, '0')}`,
      Severity: i % 2 === 0 ? 'LOW' : 'CRITICAL',
      PkgName: 'pkg',
      InstalledVersion: '1',
    }));
    const r = parseTrivyReport(JSON.stringify({ Results: [{ Vulnerabilities: many }] }));
    expect(r.cves.length).toBe(MAX_REPORT_CVES);
    expect(r.totalCves).toBe(MAX_REPORT_CVES + 25);
    // The kept slice is the worst end.
    expect(r.cves[0]?.severity).toBe('CRITICAL');
  });

  it('throws on non-JSON output', () => {
    expect(() => parseTrivyReport('FATAL image scan failed: not found')).toThrow();
  });

  it('throws on JSON that is not a trivy report', () => {
    expect(() => parseTrivyReport('{"hello":"world"}')).toThrow('not a trivy report');
  });
});

describe('extractJsonBlock', () => {
  it('slices from first { to last }', () => {
    expect(extractJsonBlock('noise {"a":1} trailing')).toBe('{"a":1}');
  });
  it('throws when no JSON is present', () => {
    expect(() => extractJsonBlock('nothing here')).toThrow();
  });
});

describe('ref helpers', () => {
  it('stripTag drops the tag but never the registry port', () => {
    expect(stripTag('swarmy-registry:5000/northwind-api:2.4.0')).toBe(
      'swarmy-registry:5000/northwind-api',
    );
    expect(stripTag('swarmy-registry:5000/northwind-api')).toBe(
      'swarmy-registry:5000/northwind-api',
    );
    expect(stripTag('nginx:1.27')).toBe('nginx');
  });

  it('refAtDigest pins a tagged ref to a digest', () => {
    expect(refAtDigest('swarmy-registry:5000/app:main', 'sha256:beef')).toBe(
      'swarmy-registry:5000/app@sha256:beef',
    );
  });

  it('refAtDigest replaces an existing digest', () => {
    expect(refAtDigest('swarmy-registry:5000/app@sha256:old', 'sha256:new')).toBe(
      'swarmy-registry:5000/app@sha256:new',
    );
  });

  it('isOrgRegistryImage matches only the org registry prefix', () => {
    expect(isOrgRegistryImage('swarmy-registry:5000/app:main', 'swarmy-registry:5000')).toBe(true);
    expect(isOrgRegistryImage('docker.io/library/nginx:1.27', 'swarmy-registry:5000')).toBe(false);
    expect(isOrgRegistryImage('swarmy-registry:5000x/app', 'swarmy-registry:5000')).toBe(false);
  });
});

describe('splitKeygenOutput', () => {
  const priv = '-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nabc\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----';
  const pub = '-----BEGIN PUBLIC KEY-----\ndef\n-----END PUBLIC KEY-----';

  it('splits private/public PEMs on the marker', () => {
    const out = splitKeygenOutput(`${priv}\n@@M@@\n${pub}\n`, '@@M@@');
    expect(out.privateKey).toBe(priv);
    expect(out.publicKey).toBe(pub);
  });

  it('throws when the marker is missing', () => {
    expect(() => splitKeygenOutput(`${priv}\n${pub}`, '@@M@@')).toThrow('split marker');
  });

  it('throws when either PEM is missing', () => {
    expect(() => splitKeygenOutput(`${priv}\n@@M@@\ncat: /keys/cosign.pub: No such file`, '@@M@@')).toThrow(
      'keypair',
    );
  });
});
