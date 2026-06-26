import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

export interface AgentState {
  nodeId: string;
  sessionSecret: string;
  sessionVersion: number;
}

export async function loadState(): Promise<AgentState | null> {
  try {
    const raw = await readFile(env.STATE_PATH, 'utf8');
    return JSON.parse(raw) as AgentState;
  } catch {
    return null;
  }
}

export async function saveState(state: AgentState): Promise<void> {
  await mkdir(path.dirname(env.STATE_PATH), { recursive: true });
  await writeFile(env.STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}
