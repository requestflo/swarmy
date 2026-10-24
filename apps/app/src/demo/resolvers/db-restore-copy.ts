import { restoreCopyName } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * The demo's "Restore as a copy" (`dbBackups.restoreAsCopy`) and "Remove the
 * copy" (`db.remove`), over the same DB state as data.ts. Like the
 * controller: the copy is a NEW database, `<cluster>-restore-<mmdd>`, one
 * copy (`single`), no schedule of its own yet, wired into no app; creating
 * and loading it takes a few seconds so the running line shows.
 */

interface DbRow {
  stack: string;
  cluster: string;
  schedule: unknown;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSizeBytes: string | null;
}
interface TopoRow {
  stack: string;
  cluster: string;
  topology: string;
  members: Array<{ service: string; role: string; status: string; desired: number; running: number }>;
}
interface DemoDbState {
  dbClusters: DbRow[];
  dbTopologies: TopoRow[];
  dbSnapshots: Array<{ id: string; stack: string; cluster: string; sizeBytes: string | null }>;
}

const db = (s: DemoStore): DemoDbState => s.extra.data as DemoDbState;
const COPY_MS = 4_000;

interface CopyInput {
  stack: string;
  cluster: string;
  engine: string;
  snapshotId?: string;
  targetTime?: string;
  name?: string;
}

export const dbRestoreCopy: DomainResolvers = {
  handlers: {
    'dbBackups.restoreAsCopy': (i, s) => {
      const b = i as CopyInput;
      const st = db(s);
      if (!st.dbClusters.some((c) => c.stack === b.stack && c.cluster === b.cluster)) {
        throw new Error(`db cluster primary ${b.stack}/${b.cluster} not found`);
      }
      const taken = st.dbClusters.filter((c) => c.stack === b.stack).map((c) => c.cluster);
      const name = b.name ?? restoreCopyName(b.cluster, new Date(), taken);
      if (taken.includes(name)) throw new Error(`${b.stack}/${name} already exists: a copy is always a new database`);
      const snap = st.dbSnapshots.find((x) => x.id === b.snapshotId);
      const primaryService = `${b.stack}_${name}-primary`;
      return new Promise((resolve) =>
        setTimeout(() => {
          st.dbClusters = [...st.dbClusters, { stack: b.stack, cluster: name, schedule: null, lastRunAt: null, lastStatus: null, lastSizeBytes: null }];
          st.dbTopologies = [
            ...st.dbTopologies,
            { stack: b.stack, cluster: name, topology: 'single', members: [{ service: primaryService, role: 'primary', status: 'running', desired: 1, running: 1 }] },
          ];
          resolve({
            mode: b.targetTime ? 'pitr' : 'clone-to-new-cluster',
            engine: b.engine,
            bytesRestored: snap?.sizeBytes ?? '412331520',
            ...(b.targetTime ? { recoveredTo: b.targetTime } : {}),
            safetySnapshotId: null,
            copy: { stack: b.stack, cluster: name, primaryService, rwHost: primaryService },
          });
        }, COPY_MS),
      );
    },

    'db.remove': (i, s) => {
      const b = i as { stack: string; cluster: string; confirm: string; deleteData?: boolean };
      if (b.confirm.trim() !== `${b.stack}/${b.cluster}`) throw new Error(`type ${b.stack}/${b.cluster} to remove this database`);
      const st = db(s);
      const topo = st.dbTopologies.find((t) => t.stack === b.stack && t.cluster === b.cluster);
      st.dbTopologies = st.dbTopologies.filter((t) => t !== topo);
      st.dbClusters = st.dbClusters.filter((c) => !(c.stack === b.stack && c.cluster === b.cluster));
      const volumes = [`${b.stack}_${b.cluster}-primary-data`];
      return {
        cluster: b.cluster,
        removed: topo?.members.map((m) => m.service) ?? [],
        volumesDeleted: b.deleteData ? volumes : [],
        volumesKept: b.deleteData ? [] : volumes,
      };
    },
  },
};
