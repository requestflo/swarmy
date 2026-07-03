import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const STOCK_IMAGE = 'caddy:2-alpine';

interface ControllerImageCardProps {
  /** Current image, or `null` when unset (stock caddy:2-alpine deploys). */
  image: string | null;
}

/**
 * The Caddy controller's deployed image. The stock image has no rate-limit
 * support — a swarmy build off `docker/caddy-swarmy` (xcaddy + caddy-ratelimit)
 * is required the moment any route carries a rate limit (see `ingress.validate`).
 */
export function ControllerImageCard({ image }: ControllerImageCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(image ?? '');

  React.useEffect(() => setDraft(image ?? ''), [image]);

  const invalidate = (): void => void qc.invalidateQueries();
  const setImage = useMutation(
    trpc.ingress.setControllerImage.mutationOptions({
      onSuccess: () => {
        toast.success('Controller image updated — redeploy to apply');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const deploy = useMutation(
    trpc.ingress.ensureController.mutationOptions({
      onSuccess: () => {
        toast.success('Ingress controller converging');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const effective = image ?? STOCK_IMAGE;
  const isStock = effective === STOCK_IMAGE;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Controller image</CardTitle>
        <CardDescription>
          Build <code className="mono-data">docker/caddy-swarmy</code> (xcaddy +{' '}
          <code className="mono-data">caddy-ratelimit</code>) and set it here — required the moment
          any route carries a rate limit.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-2">
          <Badge variant={isStock ? 'muted' : 'default'} className="mono-data">
            {effective}
          </Badge>
          {isStock ? <span className="text-muted-foreground text-xs">stock — no rate limiting</span> : null}
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Image</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="registry.example.com/swarmy-caddy:latest"
              className="mono-data min-w-0 flex-1"
            />
            <Button onClick={() => setImage.mutate({ image: draft.trim() || null })} disabled={setImage.isPending}>
              Save
            </Button>
            {image ? (
              <Button variant="outline" onClick={() => setImage.mutate({ image: null })} disabled={setImage.isPending}>
                Reset to stock
              </Button>
            ) : null}
          </div>
        </div>
        <Button variant="outline" onClick={() => deploy.mutate()} disabled={deploy.isPending} className="justify-self-start">
          {deploy.isPending ? 'Deploying…' : 'Deploy / converge controller'}
        </Button>
      </CardContent>
    </Card>
  );
}
