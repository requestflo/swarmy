/**
 * One Heroku app, whichever way it came in, as the importer's conversion
 * plus the raw config vars (the controller needs their values to seal the
 * secrets and to copy the data; they never go back to the browser).
 */
import { TRPCError } from '@trpc/server';
import {
  fromHeroku,
  herokuApiInput,
  readHerokuConfig,
  readHerokuDomains,
  type HerokuConversion,
  type HerokuGap,
  type HerokuInput,
} from '@swarmy/app-config';
import type { HerokuImportSource } from '@swarmy/core';
import { readHerokuApp } from './heroku-api';

export interface ResolvedHeroku {
  conv: HerokuConversion;
  /** Config var → value, as Heroku has it. Server-side only. */
  config: Record<string, string>;
  /** The Heroku app's name (the API's, or app.json's). */
  herokuApp: string;
  /** What the source itself couldn't say (a slug-less release). */
  gaps: HerokuGap[];
}

type ReadApp = typeof readHerokuApp;

/** Pure: a pasted app.json + Procfile + config (+ domains) → the importer's input. */
export function pastedInput(src: Extract<HerokuImportSource, { kind: 'paste' }>, name?: string): HerokuInput {
  return {
    appJson: src.appJson,
    procfile: src.procfile,
    config: src.config,
    domains: readHerokuDomains(src.domains),
    ...(name ? { app: name } : {}),
  };
}

export async function resolveHeroku(src: HerokuImportSource, name?: string, read: ReadApp = readHerokuApp): Promise<ResolvedHeroku> {
  let input: HerokuInput;
  let gaps: HerokuGap[] = [];
  if (src.kind === 'api') {
    const api = herokuApiInput(await read(src.token, src.app));
    input = { ...api.input, ...(name ? { app: name } : {}) };
    gaps = api.gaps;
  } else {
    input = pastedInput(src, name);
  }
  const conv = fromHeroku(input);
  if (!conv.yaml) throw new TRPCError({ code: 'BAD_REQUEST', message: conv.notes.at(-1) ?? 'There is nothing to import.' });
  const herokuApp = src.kind === 'api' ? src.app : (conv.app ?? 'my-app');
  if (gaps.length) {
    conv.untranslated.push(...gaps);
    conv.notes.push(...gaps.map((g) => `${g.key} isn't carried over — ${g.reason}.`));
  }
  return { conv, config: readHerokuConfig(input.config ?? ''), herokuApp, gaps };
}
