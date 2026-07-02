import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** The waiting-approval decision surface: prompt + note + approve/reject. */
export function ApprovalCard({ runId, prompt }: { runId: string; prompt: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [note, setNote] = React.useState('');
  const invalidate = (): void => void qc.invalidateQueries();

  const approve = useMutation(
    trpc.workflows.approve.mutationOptions({
      onSuccess: () => {
        toast.success('Approved — the run resumes');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const reject = useMutation(
    trpc.workflows.reject.mutationOptions({
      onSuccess: () => {
        toast.success('Rejected — the run stopped');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const pending = approve.isPending || reject.isPending;
  const payload = { runId, ...(note.trim() ? { note: note.trim() } : {}) };

  return (
    <Card className="card-pop border-status-warning/40 border">
      <CardContent className="grid gap-3 py-5">
        <div>
          <p className="mono-label text-status-warning !mb-1">Approval needed</p>
          <p className="text-sm font-medium">{prompt}</p>
        </div>
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (kept in the step output and the audit log)"
        />
        <div className="flex gap-2">
          <Button disabled={pending} onClick={() => approve.mutate(payload)}>
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            variant="outline"
            className="text-status-offline border-status-offline/40"
            disabled={pending}
            onClick={() => reject.mutate(payload)}
          >
            {reject.isPending ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
