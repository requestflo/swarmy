import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Fallback label while the config query loads. */
const SWARMY_IMAGE = 'ghcr.io/requestflo/caddy-swarmy:latest';

/** Plugin-less stock Caddy (mirrors @swarmy/ingress `isStockCaddyImage`). */
function isStockCaddy(image: string): boolean {
  const repo = image.split('@')[0]!.replace(/:[^/:]+$/, '');
  return repo === 'caddy' || repo === 'library/caddy' || repo === 'docker.io/library/caddy';
}

interface ControllerImageCardProps {
  /** Current image, or `null` when unset (the default swarmy build deploys). */
  image: string | null;
  /** The image deployed when none is set (`IngressConfigView.defaultControllerImage`). */
  defaultImage: string | null;
}

/**
 * The Caddy image both topologies deploy. The default is swarmy's own build
 * (`docker/caddy-swarmy`: rate limits, response caching, country rules and the
 * shared certificate store compiled in). A stock caddy image lacks all of them.
 */
export function ControllerImageCard({ image, defaultImage }: ControllerImageCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(image ?? '');

  React.useEffect(() => setDraft(image ?? ''), [image]);

  const invalidate = (): void => void qc.invalidateQueries();
  const setImage = useMutation(
    trpc.ingress.setControllerImage.mutationOptions({
      onSuccess: () => {
        toast.success('Controller image updated');
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

  const effective = image ?? defaultImage ?? SWARMY_IMAGE;
  const isStock = isStockCaddy(effective);

  return (
    <Card className="calm-card mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Controller image</CardTitle>
        <CardDescription>
          swarmy's own Caddy build is used by default. Set a custom image only if you build your own
          from <code className="mono-data">docker/caddy-swarmy</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-2">
          <Badge variant={isStock ? 'muted' : 'default'} className="mono-data">
            {effective}
          </Badge>
          {isStock ? (
            <span className="text-muted-foreground text-xs">
              stock — no rate limits, caching, country rules or shared certificates
            </span>
          ) : image ? null : (
            <span className="text-muted-foreground text-xs">default</span>
          )}
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
            <Button variant="outline" onClick={() => setImage.mutate({ image: draft.trim() || null })} disabled={setImage.isPending}>
              Save
            </Button>
            {image ? (
              <Button variant="outline" onClick={() => setImage.mutate({ image: null })} disabled={setImage.isPending}>
                Reset to default
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
