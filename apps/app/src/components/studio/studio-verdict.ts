import {
  classifyMongo,
  classifyRedis,
  classifySql,
  parseMongoInput,
  redisCommandText,
  singleStatementText,
  tokenizeRedis,
  type Classification,
} from '@swarmy/core/studio';
import { isSqlEngine } from './studio-types';

export interface Verdict {
  /** The exact text that will run (and be audited). */
  display: string;
  classification: Classification;
  action: 'data.read' | 'data.write' | 'data.destroy';
}

const ACTION = { read: 'data.read', write: 'data.write', destructive: 'data.destroy' } as const;

/**
 * The same verdict the controller reaches (same `@swarmy/core/studio` code), live
 * as the user types. The server re-classifies and is the authority.
 */
export function verdictFor(engine: string, text: string): Verdict {
  let display = text.trim();
  let classification: Classification;
  try {
    if (isSqlEngine(engine)) {
      const dialect = engine === 'postgres' ? 'postgres' : 'mysql';
      classification = classifySql(text, dialect);
      display = singleStatementText(text, dialect) ?? display;
    } else if (engine === 'mongo') {
      const doc = parseMongoInput(text).doc;
      classification = classifyMongo(doc);
      display = JSON.stringify(doc);
    } else {
      const argv = tokenizeRedis(text);
      classification = classifyRedis(argv);
      display = redisCommandText(argv);
    }
  } catch (e) {
    classification = { class: 'read', kind: '', reasons: [], blocked: e instanceof Error ? e.message : String(e) };
  }
  return { display, classification, action: ACTION[classification.class] };
}

export const CLASS_TONE: Record<string, string> = {
  read: 'bg-status-online/12 text-status-online',
  write: 'bg-status-warning/15 text-status-warning',
  destructive: 'bg-status-offline/12 text-status-offline',
};
