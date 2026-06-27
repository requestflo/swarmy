import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangleIcon, InfoIcon } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
  cn,
  toast,
} from '@swarmy/ui';
import type { ServiceModelOut, TranslationWarning } from '@swarmy/core/compose';
import { useTRPC } from '@/integrations/trpc';

interface ImportComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (model: ServiceModelOut) => void;
}

const EXAMPLE = `services:
  web:
    image: nginx:1.27
    deploy:
      replicas: 2
    ports:
      - "8080:80"
    environment:
      - TZ=UTC
`;

/** Paste compose -> live parse -> diff/warnings -> import the first service. */
export function ImportComposeDialog({
  open,
  onOpenChange,
  onImport,
}: ImportComposeDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const [source, setSource] = React.useState(EXAMPLE);
  const [models, setModels] = React.useState<ServiceModelOut[]>([]);
  const [warnings, setWarnings] = React.useState<TranslationWarning[]>([]);

  const parse = useMutation(
    trpc.builder.parseCompose.mutationOptions({
      onSuccess: (res) => {
        if (res.parseError) {
          toast.error(`Couldn't parse: ${res.parseError}`);
          setModels([]);
          setWarnings([]);
          return;
        }
        setModels(res.models);
        setWarnings(res.warnings);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from compose</DialogTitle>
          <DialogDescription>
            Paste a docker-compose file. We map what Swarm supports and preserve the rest.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Textarea
            className="h-56 font-mono text-xs"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => parse.mutate({ source })}
            disabled={parse.isPending}
          >
            Preview
          </Button>
          {models.length > 0 && (
            <div className="grid gap-2">
              <p className="mono-label">
                {models.length} service{models.length === 1 ? '' : 's'} found — importing{' '}
                <span className="font-mono">{models[0]?.name}</span>
              </p>
              {warnings.length > 0 && (
                <ul className="grid gap-1">
                  {warnings.map((w, i) => (
                    <li
                      key={i}
                      className={cn(
                        'flex items-start gap-2 text-sm',
                        w.level === 'warn' ? 'text-status-warning' : 'text-muted-foreground',
                      )}
                    >
                      {w.level === 'warn' ? (
                        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                      ) : (
                        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                      )}
                      <span>
                        <span className="font-mono">{w.path}</span> — {w.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={models.length === 0}
            onClick={() => {
              const first = models[0];
              if (first) {
                onImport(first);
                onOpenChange(false);
                toast.success(`Imported ${first.name}`);
              }
            }}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
