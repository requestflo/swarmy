/**
 * The agent's one-shot backup/restore sidecars at the running release's
 * digests. The hub dispatch decorator calls {@link pinHelperImages} on every
 * backup/restore/dump command with `effectiveImagesFor` (the same BOM lookup
 * that pins system services), so each sidecar pulls `<ref>@<digest>` instead
 * of a tag. It fills only fields the caller left empty: an operator's image
 * (`SWARMY_PGBACKREST_IMAGE`, a custom restic) is never replaced, and a helper
 * the release pins no digest for stays absent so the agent uses its own
 * default (`helperImage`, @swarmy/core/protocol). `pinHelperImages` is pure.
 */
import { pinnedHelperRefs, type HelperImage } from '@swarmy/core/protocol';
import { SYSTEM_IMAGES, type SystemImage } from '@swarmy/core/system-images';
import type { DB } from '@swarmy/db';
import type { CommandName } from '../hub/types';
import { effectiveImagesFor } from './platform-images';
import { HELPER_FIELDS } from './helper-images-mirror';

type Fields = Partial<Record<'image' | 'resticImage' | 'clientImage' | 'engineImage', HelperImage>>;

/** Which payload field runs which helper, per command (wal-g only for the wal-g engine). */
function fieldsFor(cmd: CommandName, payload: { engine?: unknown }): Fields | null {
  switch (cmd) {
    case 'backup.run':
    case 'backup.restore':
    case 'backup.list':
      return { image: 'restic' };
    case 'appdb.backup':
    case 'appdb.restore':
    case 'appdb.verify':
      return { resticImage: 'restic' };
    case 'db.backup':
    case 'db.restore':
      return { resticImage: 'restic', clientImage: 'pgClient', ...(payload.engine === 'wal-g' ? { engineImage: 'walg' } : {}) };
    case 'db.pitrWindow':
    case 'db.walVerify':
    case 'db.walgCopy':
      return { engineImage: 'walg' };
    default:
      return null;
  }
}

/** Every backup/restore/dump command (the field table lives in helper-images-mirror.ts). */
export const HELPER_IMAGE_COMMANDS: ReadonlySet<CommandName> = new Set(Object.keys(HELPER_FIELDS) as CommandName[]);

/** Fill a backup/restore payload's empty helper-image fields with digest-pinned refs. Same reference when nothing changes. */
export function pinHelperImages<P>(cmd: CommandName, payload: P, images: readonly SystemImage[] = SYSTEM_IMAGES): P {
  const p = payload as (Record<string, unknown> & { engine?: unknown }) | null | undefined;
  if (!p || typeof p !== 'object') return payload;
  const fields = fieldsFor(cmd, p);
  if (!fields) return payload;
  const pins = pinnedHelperRefs(images);
  const add: Record<string, string> = {};
  for (const [field, kind] of Object.entries(fields)) {
    const ref = pins[kind];
    const cur = p[field];
    if (ref && (typeof cur !== 'string' || cur.trim() === '')) add[field] = ref;
  }
  return Object.keys(add).length ? ({ ...p, ...add } as P) : payload;
}

/** The decorator's step: {@link pinHelperImages} with this org's release BOM. Never throws. */
export async function pinHelperImagesFor<P>(db: DB, orgId: string, cmd: CommandName, payload: P): Promise<P> {
  if (!HELPER_IMAGE_COMMANDS.has(cmd)) return payload;
  try {
    return pinHelperImages(cmd, payload, await effectiveImagesFor(db, orgId));
  } catch {
    return payload;
  }
}
