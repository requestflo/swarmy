import * as React from 'react';

/**
 * Connect mode on the canvas: parts grow a handle to drag from, and every
 * part and store becomes somewhere to drop. `from` is the part picked so far
 * (by a click, the picker or the start of a drag).
 */
export interface ConnectMode {
  on: boolean;
  from: string | null;
}

export const ConnectModeContext = React.createContext<ConnectMode>({ on: false, from: null });

export function useConnectMode(): ConnectMode {
  return React.useContext(ConnectModeContext);
}

/** A full-size, invisible drop target over a node while connecting (React Flow handle style). */
export const DROP_TARGET: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  transform: 'none',
  borderRadius: 'inherit',
  opacity: 0,
  border: 'none',
  background: 'transparent',
  minWidth: 0,
  minHeight: 0,
};
