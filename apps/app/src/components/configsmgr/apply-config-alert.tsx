import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  type ButtonProps,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ApplyConfigAlertProps {
  family: ConfigFamilyView;
  /** The version consumers move onto (older than current = rollback). */
  version: number;
  /** Trigger button label, e.g. "Apply v4" / "Roll back". */
  trigger: string;
  variant?: ButtonProps['variant'];
}

/**
 * Apply/rollback confirm (AlertDialog — it redeploys consumers) with the LIVE
 * restart preview inside: exactly which services restart before you commit.
 */
export function ApplyConfigAlert({
  family,
  version,
  trigger,
  variant = 'outline',
}: ApplyConfigAlertProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const rollback = version < family.currentVersion;

  const preview = useQuery({
    ...trpc.configs.restartPreview.queryOptions({ family: family.family, version }),
    enabled: open,
  });

  const apply = useMutation(
    trpc.configs.applyVersion.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.redeployed.length > 0
            ? `${r.family} ${r.rollback ? 'rolled back' : 'applied'} to v${r.version} — ${r.redeployed.length} service(s) restarting`
            : `${r.family} is already on v${r.version} everywhere`,
        );
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const restarting = preview.data?.restarting ?? [];
  const upToDate = preview.data?.upToDate ?? [];

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={variant}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {rollback ? 'Roll back' : 'Apply'} {family.family} → v{version}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Consumers are redeployed onto <span className="mono-data">v{version}</span> — the mount
            path {family.mountPath} stays the same, only the content changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {preview.isLoading ? (
          <div className="shimmer-line h-16 rounded-xl" />
        ) : preview.isError ? (
          <p className="text-status-offline text-sm">{preview.error.message}</p>
        ) : restarting.length > 0 ? (
          <div className="bg-status-warning/10 text-status-warning flex gap-2.5 rounded-xl p-3 text-xs">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-semibold">
                {restarting.length} service{restarting.length === 1 ? '' : 's'} will restart:
              </p>
              <p className="mono-data mt-1 break-words">
                {restarting.map((c) => c.serviceName).join(', ')}
              </p>
              {upToDate.length > 0 ? (
                <p className="mt-1">
                  {upToDate.length} already on v{version} — untouched.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            {family.usedByCount === 0
              ? 'No services use this config yet — nothing will restart.'
              : `Every consumer is already on v${version} — nothing will restart.`}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={preview.isLoading || apply.isPending}
            onClick={(e) => {
              e.preventDefault();
              apply.mutate({ family: family.family, version });
            }}
          >
            {apply.isPending
              ? rollback
                ? 'Rolling back…'
                : 'Applying…'
              : restarting.length > 0
                ? `Restart ${restarting.length} service${restarting.length === 1 ? '' : 's'}`
                : `${rollback ? 'Roll back to' : 'Apply'} v${version}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
