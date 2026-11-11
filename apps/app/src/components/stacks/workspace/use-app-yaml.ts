import { useQuery } from '@tanstack/react-query';
import { useDepth } from '@/components/calm';
import { findStackApp } from '@/components/gitops/gitops-types';
import { useTRPC } from '@/integrations/trpc';
import { useConfigFile, type ConfigFileView } from '../source/use-config-file';

/**
 * The swarmy.yaml a git app deploys from, for the Overview's Code view
 * (`apps.configFile`, the file Source edits). Read only at Code depth: a
 * cache miss runs on a Builder. Undefined while unread or for an app with
 * no repo.
 */
export function useAppYaml(stack: string): ConfigFileView | undefined {
  const trpc = useTRPC();
  const atCode = useDepth().atLeast('code');
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), enabled: atCode });
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  const file = useConfigFile(stack, atCode && Boolean(match));
  return file.data?.text != null ? file.data : undefined;
}
