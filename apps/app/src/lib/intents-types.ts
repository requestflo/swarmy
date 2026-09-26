/** The ⌘K intent shapes (lib/intents.ts parses; the palette's preview runs them). */

export interface IntentApp {
  name: string;
  /** Every address the app answers on ("shop.northwind.dev"), so "shop" finds it. */
  hosts: string[];
}

export interface IntentPart {
  id: string;
  /** The part's own name ("checkout"), without the app prefix. */
  name: string;
  app: string | null;
  desired: number;
}

export interface IntentTemplate {
  id: string;
  name: string;
}

export interface IntentWorld {
  apps: IntentApp[];
  parts: IntentPart[];
  /** Deployable templates (`blueprints.list`, doc-only ones left out). */
  templates: IntentTemplate[];
  /** Server names, for "deploy … to <server>". */
  servers: string[];
}

export type IntentAction =
  | { kind: 'go'; to: string; params?: Record<string, string>; search?: Record<string, string> }
  | { kind: 'rollback'; app: string }
  | { kind: 'restart'; part: IntentPart }
  | { kind: 'scale'; part: IntentPart; to: number }
  /** `to` is what was typed after "to"; `server` the server it names, if any. Not pinned yet. */
  | { kind: 'deploy'; template: string; name: string; to: string | null; server: string | null };

export type GoAction = Extract<IntentAction, { kind: 'go' }>;

export interface Intent {
  id: string;
  /** The board's intent label: "Intent · Put back". */
  verb: string;
  group: 'Do it' | 'Jump to';
  title: string;
  sub: string;
  action: IntentAction;
  /** ⇥ "edit": the page where this is done by hand, with the details filled in. */
  edit?: GoAction;
}
