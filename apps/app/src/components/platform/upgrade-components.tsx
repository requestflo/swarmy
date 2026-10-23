import * as React from 'react';
import { shortDigest, type PlatformAvailable } from './use-platform';

type Component = PlatformAvailable['components'][number];

/**
 * A component's version change. swarmy's own images ship with the platform
 * (untagged, or tagged with the release version), so theirs moves with it:
 * `1.2.4 → 1.3.0`. A third-party image's new tag is in the release; its
 * current tag is not in the release view, so only the target shows.
 */
export function componentVersion(c: Component, fromVersion: string, toVersion: string): { from: string | null; to: string } {
  if (!c.tag || c.tag === toVersion) return { from: fromVersion, to: toVersion };
  return { from: null, to: c.tag };
}

/** The images the release changes, each with its version going from → to and the digest it lands on. */
export function UpgradeComponents({ av, fromVersion }: { av: PlatformAvailable; fromVersion: string }): React.JSX.Element | null {
  const changed = av.components.filter((c) => c.changed);
  if (changed.length === 0) return null;
  return (
    <table className="w-full font-mono text-[11.5px]">
      <caption className="calm-eyebrow pb-1 text-left">What changes</caption>
      <thead className="sr-only">
        <tr>
          <th>Component</th>
          <th>Version</th>
          <th>Image</th>
        </tr>
      </thead>
      <tbody>
        {changed.map((c) => {
          const v = componentVersion(c, fromVersion, av.version);
          return (
            <tr key={c.key} className="border-border border-t align-baseline">
              <td className="w-28 py-1 pr-3 font-semibold">{c.key}</td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {v.from ? <span className="text-muted-foreground">{v.from} → </span> : <span className="text-muted-foreground">→ </span>}
                {v.to}
              </td>
              <td className="text-muted-foreground py-1 break-all">
                {c.image} {c.digest ? `@${shortDigest(c.digest)}` : '(unresolved)'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
