/**
 * `swarmy remove` — remove an app environment (a stack). Its data (named
 * volumes on every server + the secrets its blueprint generated) is kept
 * unless `--delete-data`, so redeploying the same name picks it back up.
 * Irreversible, so it asks for the stack name typed back (skip with --yes).
 */
import { NotFoundError, resolveStack } from '@swarmy/devkit';
import { CliError, type Ctx } from '../context';
import { targetStack } from './errors';

export async function remove(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const deleteData = ctx.flag<boolean>('delete-data') === true;
  let stack;
  try {
    stack = await resolveStack(client, await targetStack(ctx));
  } catch (e) {
    throw e instanceof NotFoundError ? new CliError(e.message) : e;
  }
  if (!ctx.flag<boolean>('yes') && !ctx.json) {
    ctx.io.err(
      deleteData
        ? `This stops and removes every service in ${stack.name} AND deletes its data: the volumes on your servers and the passwords swarmy made for it. This cannot be undone.`
        : `This stops and removes every service in ${stack.name}. Its data is kept, so deploying the same name again picks it back up.`,
    );
    if (!ctx.io.isTty) throw new CliError('not a terminal — re-run with --yes to confirm', 2);
    const answer = prompt(`Type ${stack.name} to confirm:`);
    if (answer?.trim() !== stack.name) throw new CliError('cancelled');
  }
  const r = await client.stacks.remove(stack.id, { deleteData });
  if (ctx.json) return ctx.io.out(JSON.stringify(r));
  if (r.delete_data) {
    ctx.io.out(`Removed ${stack.name} and its data.`);
    if (r.volumes_kept.length) ctx.io.err(`note: could not delete ${r.volumes_kept.join(', ')} — remove them from the server`);
  } else {
    ctx.io.out(`Removed ${stack.name}. Its data is kept${r.volumes_kept.length ? ` (${r.volumes_kept.join(', ')})` : ''}.`);
  }
}
