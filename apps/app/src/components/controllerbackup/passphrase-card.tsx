import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, KeyRoundIcon } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyButton,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Restore passphrase — the root of trust. Backups are encrypted with a phrase
 * only the operator holds; it's shown exactly once on a navy ink surface so the
 * "write it down now" moment is loud.
 */
export function PassphraseCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const [issued, setIssued] = React.useState<string | null>(null);
  const [stored, setStored] = React.useState(false);

  const generate = useMutation(
    trpc.controllerBackup.generatePassphrase.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.passphrase);
        setStored(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const save = useMutation(
    trpc.controllerBackup.setPassphrase.mutationOptions({
      onSuccess: () => {
        toast.success('Restore passphrase saved');
        setIssued(null);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const has = config.data?.hasPassphrase ?? false;

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" /> Restore passphrase
          </CardTitle>
          <CardDescription>
            Controller backups are encrypted with a passphrase only you hold — separate from the
            server&apos;s keys, so restore works even when the controller is gone.{' '}
            <strong>Lose it and your backups are unrecoverable.</strong>
          </CardDescription>
        </div>
        <StatusBadge
          tone={has ? 'online' : 'neutral'}
          label={has ? `captured · ${config.data?.passphraseHint ?? ''}` : 'not set'}
        />
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {!issued ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              {has ? 'Rotate passphrase' : 'Generate passphrase'}
            </Button>
          </div>
        ) : (
          <Alert className="ink-block border-0">
            <AlertTriangleIcon className="size-4" />
            <AlertTitle className="font-bold">Write this down now. It is shown once.</AlertTitle>
            <AlertDescription className="text-ink-foreground/70">
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-sm">
                  {issued}
                </code>
                <CopyButton value={issued} label="Copy" />
              </div>
              <label className="mt-4 flex items-center gap-2 text-xs">
                <Switch checked={stored} onCheckedChange={setStored} />
                I&apos;ve stored this passphrase in a password manager / recovery card.
              </label>
              <div className="mt-3">
                <Button
                  size="sm"
                  disabled={!stored || save.isPending}
                  onClick={() => save.mutate({ passphrase: issued })}
                >
                  Confirm &amp; save
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
