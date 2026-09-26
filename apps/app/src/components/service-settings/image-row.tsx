import * as React from 'react';
import { Tech } from '@/components/calm';
import { shortImage } from '@/components/apps/app-words';
import { relTime } from '@/lib/format';
import type { ServiceSettingsData } from './use-service-settings';
import { SettingRow } from './settings-row';

/** "pinned by digest" / "tag v118" and the latest scan — only from data that exists. */
function imageFacts(image: string, scan: ServiceSettingsData['scan']): string[] {
  const facts: string[] = [];
  if (scan) {
    const crit = scan.criticalCount;
    facts.push(`${crit} critical CVE${crit === 1 ? '' : 's'}${scan.highCount ? ` · ${scan.highCount} high` : ''} · scanned ${relTime(scan.scannedAt)}`);
  }
  if (image.includes('@sha256:')) facts.push('pinned by digest, never a tag');
  else {
    const tag = shortImage(image).split(':')[1];
    facts.push(tag ? `tag ${tag}, not pinned by digest` : 'no tag: runs latest');
  }
  return facts;
}

export function ImageRow({ image, scan }: { image: string; scan: ServiceSettingsData['scan'] }): React.JSX.Element {
  return (
    <SettingRow title="Image">
      <p className="text-[13.5px]">
        Runs <span className="font-mono text-[12.5px]">{shortImage(image)}</span>
      </p>
      <Tech className="break-all">{image}</Tech>
      <Tech>{imageFacts(image, scan).join(' · ')}</Tech>
    </SettingRow>
  );
}
