import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import type { TranslationWarning } from '@swarmy/core/compose';
import { useTRPC } from '@/integrations/trpc';

export interface ComposeCheck {
  status: 'idle' | 'checking' | 'ok' | 'error';
  services: string[];
  warnings: TranslationWarning[];
  parseError: string | null;
}

const IDLE: ComposeCheck = { status: 'idle', services: [], warnings: [], parseError: null };

/**
 * Debounced dry-run of the pasted compose through `builder.parseCompose` so
 * the deploy page can show "N services ready" / warnings / parse errors live,
 * before the user commits to the deploy.
 */
export function useComposeCheck(source: string): ComposeCheck {
  const trpc = useTRPC();
  const parse = useMutation(trpc.builder.parseCompose.mutationOptions());
  const parseRef = React.useRef(parse);
  parseRef.current = parse;
  const [check, setCheck] = React.useState<ComposeCheck>(IDLE);

  React.useEffect(() => {
    if (!source.trim()) {
      setCheck(IDLE);
      return;
    }
    let cancelled = false;
    setCheck((prev) => ({ ...prev, status: 'checking' }));
    const timer = setTimeout(() => {
      parseRef.current
        .mutateAsync({ source })
        .then((res) => {
          if (cancelled) return;
          if (res.parseError) {
            setCheck({ status: 'error', services: [], warnings: [], parseError: res.parseError });
          } else if (res.models.length === 0) {
            setCheck({
              status: 'error',
              services: [],
              warnings: [],
              parseError: 'No services found — add a `services:` block.',
            });
          } else {
            setCheck({
              status: 'ok',
              services: res.models.map((m) => m.name),
              warnings: res.warnings,
              parseError: null,
            });
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setCheck({
            status: 'error',
            services: [],
            warnings: [],
            parseError: e instanceof Error ? e.message : 'Parse failed',
          });
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source]);

  return check;
}
