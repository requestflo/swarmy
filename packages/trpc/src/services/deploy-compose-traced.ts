/**
 * `stacks.deployFromCompose` with a trace: the same deploy, plus a deploy id
 * the Deploying screen follows (`deploys.events`). The agent streams each
 * service's pull/start; the tail adds the certificate and health check.
 */
import type { OrgContext } from '../context';
import { beginDeployTrace } from './deploy-trace.service';
import { followDeployTail } from './deploy-tail.service';
import { deployFromCompose, type DeployFromComposeResult } from './stack.service';

type ComposeInput = Omit<Parameters<typeof deployFromCompose>[1], 'trace' | 'mainService'>;

export async function deployComposeTraced(ctx: OrgContext, input: ComposeInput): Promise<DeployFromComposeResult> {
  const trace = beginDeployTrace(ctx, input.name);
  try {
    const res = await deployFromCompose(ctx, { ...input, trace });
    void followDeployTail(ctx, trace, res.services);
    return res;
  } catch (e) {
    trace.finish(); // nobody gets this id: the mutation reports the error itself
    throw e;
  }
}
