import * as React from 'react';
import type { ServiceChip } from '../fleet/fleet-model';

/**
 * Board 9's moment, shared by the map, the inspector and the aside: which
 * service is being placed (dragged, or picked with "Move…"), the server it
 * hovers or was dropped on, and the move that's running. Esc backs out.
 */

export type MoveStage = 'idle' | 'drag' | 'pick' | 'confirm';

export interface MoveDraft {
  chip: ServiceChip;
  fromId: string;
}

export interface MoveRun extends MoveDraft {
  toId: string;
  startedAt: number;
  /** An Undo: back onto the old copy a move kept on `toId`. */
  undo?: boolean;
}

interface Placing {
  stage: MoveStage;
  draft: MoveDraft | null;
  /** The hovered server while dragging; the chosen one at confirm. */
  target: string | null;
}

type Action =
  | { t: 'drag' | 'pick'; d: MoveDraft }
  | { t: 'hover' | 'choose'; id: string | null }
  | { t: 'end' }
  | { t: 'cancel' };

const IDLE: Placing = { stage: 'idle', draft: null, target: null };

function reduce(s: Placing, a: Action): Placing {
  switch (a.t) {
    case 'drag':
    case 'pick':
      return { stage: a.t, draft: a.d, target: null };
    case 'hover':
      return s.stage === 'drag' && s.target !== a.id ? { ...s, target: a.id } : s;
    case 'choose':
      return s.draft && a.id ? { ...s, stage: 'confirm', target: a.id } : s;
    case 'end':
      // dragend fires after drop: only a drag that landed nowhere backs out.
      return s.stage === 'drag' ? IDLE : s;
    case 'cancel':
      return IDLE;
  }
}

export interface MoveState extends Placing {
  admin: boolean;
  run: MoveRun | null;
  startDrag: (d: MoveDraft) => void;
  hover: (nodeId: string | null) => void;
  /** Dropped on a server, or (from the picker) chose one. */
  choose: (nodeId: string) => void;
  endDrag: () => void;
  /** The keyboard path: "Move…" opens the server picker. */
  pick: (d: MoveDraft) => void;
  cancel: () => void;
  started: (run: MoveRun) => void;
  dismiss: () => void;
}

const Ctx = React.createContext<MoveState | null>(null);

export function MoveProvider({ admin, children }: { admin: boolean; children: React.ReactNode }): React.JSX.Element {
  const [placing, dispatch] = React.useReducer(reduce, IDLE);
  const [run, setRun] = React.useState<MoveRun | null>(null);
  const { stage } = placing;

  React.useEffect(() => {
    if (stage !== 'pick' && stage !== 'confirm') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dispatch({ t: 'cancel' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  const value = React.useMemo<MoveState>(
    () => ({
      ...placing,
      admin,
      run,
      startDrag: (d) => dispatch({ t: 'drag', d }),
      hover: (id) => dispatch({ t: 'hover', id }),
      choose: (id) => dispatch({ t: 'choose', id }),
      endDrag: () => dispatch({ t: 'end' }),
      pick: (d) => dispatch({ t: 'pick', d }),
      cancel: () => dispatch({ t: 'cancel' }),
      started: (r) => {
        setRun(r);
        dispatch({ t: 'cancel' });
      },
      dismiss: () => setRun(null),
    }),
    [placing, admin, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMove(): MoveState {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useMove needs a MoveProvider');
  return v;
}

/** The drag payload type, so a drop of anything else is ignored. */
export const DRAG_TYPE = 'application/x-swarmy-service';

/**
 * A second payload type naming the source server: `dragover` can read the
 * types (not the data), so a tile knows it is the source without waiting
 * for a re-render.
 */
export function dragFromType(nodeId: string): string {
  return `application/x-swarmy-from-${nodeId.toLowerCase()}`;
}
