import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Field } from './field';

type Kind = 's3' | 'node';

interface AddTargetFormProps {
  onDone: () => void;
}

/** Inline destination form — lives inside the destinations card's expander. */
export function AddTargetForm({ onDone }: AddTargetFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Kind>('s3');
  const [endpoint, setEndpoint] = React.useState('');
  const [bucket, setBucket] = React.useState('');
  const [prefix, setPrefix] = React.useState('');
  const [region, setRegion] = React.useState('');
  const [accessKeyId, setAccessKeyId] = React.useState('');
  const [secretAccessKey, setSecretAccessKey] = React.useState('');

  const add = useMutation(
    trpc.backups.addTarget.mutationOptions({
      onSuccess: () => {
        toast.success('Destination added');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const isS3 = kind === 's3';
  return (
    <div className="bg-accent/40 grid gap-3 border-t px-6 py-5 sm:grid-cols-2">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Backblaze B2" />
      </Field>
      <Field label="Kind">
        <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="s3">S3-compatible</SelectItem>
            <SelectItem value="node">Node path</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {isS3 ? (
        <Field label="Endpoint">
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://s3.us-west-002.backblazeb2.com"
          />
        </Field>
      ) : null}
      <Field label={isS3 ? 'Bucket' : 'Base path'}>
        <Input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder={isS3 ? 'my-backups' : '/srv/backups'}
        />
      </Field>
      <Field label="Prefix (optional)">
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="swarmy" />
      </Field>
      {isS3 ? (
        <>
          <Field label="Region (optional)">
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-west-002" />
          </Field>
          <Field label="Access key id">
            <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
          </Field>
          <Field label="Secret access key">
            <Input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
            />
          </Field>
        </>
      ) : null}
      <div className="flex items-end justify-end sm:col-span-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-full font-bold"
          disabled={add.isPending || !name || !bucket}
          onClick={() =>
            add.mutate({
              name,
              kind,
              endpoint: endpoint || undefined,
              bucket,
              prefix: prefix || undefined,
              region: region || undefined,
              accessKeyId: accessKeyId || undefined,
              secretAccessKey: secretAccessKey || undefined,
            })
          }
        >
          {add.isPending ? 'Adding…' : 'Add destination'}
        </Button>
      </div>
    </div>
  );
}
