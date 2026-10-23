import * as React from 'react';
import { CheckCircle2Icon, GlobeIcon, KeyRoundIcon } from 'lucide-react';
import { Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { resolutionSentence, type ImageResolution } from './registry-credentials-resolve';
import type { RegistryCredential } from './registry-credential-row';

interface RegistryCredentialsMatcherProps {
  value: string;
  onChange: (value: string) => void;
  resolution: ImageResolution<RegistryCredential> | null;
}

/** "Which credentials will this image use?" — type a ref, see the login that wins. */
export function RegistryCredentialsMatcher({ value, onChange, resolution }: RegistryCredentialsMatcherProps): React.JSX.Element {
  const Icon = !resolution ? null : resolution.kind === 'builtin' ? CheckCircle2Icon : resolution.kind === 'login' ? KeyRoundIcon : GlobeIcon;
  return (
    <div className="border-border grid gap-2 border-t pt-3">
      <div>
        <p className="font-display text-sm font-semibold">Which credentials will this image use?</p>
        <p className="text-muted-foreground text-xs">
          Longest matching prefix wins · used for every deploy, pull and build (private FROM)
        </p>
      </div>
      <Input
        aria-label="Image to check"
        className="font-mono"
        placeholder="ghcr.io/you/app:1.2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {resolution && Icon ? (
        <div className="grid gap-0.5" aria-live="polite">
          <p className="flex items-start gap-2 text-sm">
            <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            {resolutionSentence(resolution)}
          </p>
          <Tech className="pl-6">resolves to {resolution.ref}</Tech>
        </div>
      ) : null}
    </div>
  );
}
