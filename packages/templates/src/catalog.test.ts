import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { BLUEPRINT_CATEGORIES } from '@swarmy/core';
import {
  APP_TEMPLATES,
  loadTemplate,
  primaryService,
  referencedSecrets,
  renderTemplateYaml,
  templateMeta,
} from './index';

const CATEGORY_IDS = BLUEPRINT_CATEGORIES.map((c) => c.id as string);

describe('app template catalogue', () => {
  it('ids are unique slugs', () => {
    const ids = APP_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });

  for (const t of APP_TEMPLATES) {
    describe(t.id, () => {
      const loaded = loadTemplate(t, { stack: 'demo' });
      const raw = parseYaml(renderTemplateYaml(t, { stack: 'demo' })) as {
        services: Record<string, Record<string, unknown>>;
      };

      it('parses and validates as swarmy.yaml v1 with no errors', () => {
        const errors = loaded.issues.filter((i) => i.severity === 'error');
        expect(errors.map((e) => `${e.path.join('.')}: ${e.message}`)).toEqual([]);
        expect(loaded.desired).toBeDefined();
      });

      it('metadata is complete', () => {
        expect(CATEGORY_IDS).toContain(t.category);
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.tagline.length).toBeGreaterThan(10);
        expect(t.tagline.endsWith('.')).toBe(false);
        expect(t.website).toMatch(/^https:\/\//);
        expect(t.icon.length).toBeGreaterThan(0);
        expect(t.version).toMatch(/\d/);
        expect(t.postDeploy.length).toBeGreaterThan(0);
        expect(() => templateMeta(t)).not.toThrow();
      });

      it('every image is pinned to a release (never latest / untagged)', () => {
        for (const [name, svc] of Object.entries(raw.services)) {
          const image = String(svc.image ?? '');
          expect(image, `${name} has an image`).not.toBe('');
          const tag = image.split('@')[0]!.split('/').pop()!.split(':')[1];
          expect(tag, `${name}: ${image} carries a tag`).toBeDefined();
          expect(tag).not.toMatch(/^(latest|main|master|stable|nightly|edge|dev)$/);
          expect(tag, `${name}: ${image} tag names a version`).toMatch(/\d/);
        }
      });

      it('image-only, no domains in the yaml, no release step', () => {
        for (const svc of Object.values(raw.services)) {
          expect(svc.build).toBeUndefined();
          expect(svc.domains).toBeUndefined();
          expect(svc.release).toBeUndefined();
        }
      });

      it('every service sets a memory limit and has a healthcheck (own or the image’s)', () => {
        for (const s of loaded.desired?.services ?? []) {
          expect(s.memoryMb, `${s.name} memory`).toBeGreaterThan(0);
          const own = s.healthcheck !== undefined;
          const image = (t.imageHealthcheck ?? []).includes(s.name);
          expect(own || image, `${s.name} healthcheck`).toBe(true);
          expect(own && image, `${s.name}: yaml healthcheck AND imageHealthcheck`).toBe(false);
        }
      });

      it('generated secrets are exactly the referenced ones', () => {
        const desired = loaded.desired!;
        expect([...referencedSecrets(desired)].sort()).toEqual(Object.keys(t.generate ?? {}).sort());
        for (const g of Object.values(t.generate ?? {})) expect(g.length).toBeGreaterThanOrEqual(16);
      });

      it('mounted secrets are wired through a *_FILE-style env path', () => {
        for (const s of loaded.desired?.services ?? []) {
          for (const name of s.secrets) {
            expect(Object.values(s.env), `${s.name} env points at /run/secrets/${name}`).toContain(
              `/run/secrets/${name}`,
            );
          }
        }
      });

      it('declares every option placeholder it uses', () => {
        const used = [...t.yaml.matchAll(/\[\[opt\.([A-Za-z0-9_]+)\]\]/g)].map((m) => m[1]!);
        const declared = (t.options ?? []).map((o) => o.key);
        for (const k of used) expect(declared).toContain(k);
      });

      it('has a routable HTTP service (or explicitly none)', () => {
        const p = primaryService(t, loaded.desired!);
        if (t.primary) expect(p?.name).toBe(t.primary);
        expect(p).not.toBeNull();
      });

      it('reveals only resolve generated secrets', () => {
        for (const note of t.reveal ?? []) {
          for (const m of note.matchAll(/\$\{\{\s*secrets\.([a-z0-9-]+)\s*\}\}/g)) {
            expect(Object.keys(t.generate ?? {})).toContain(m[1]!);
          }
        }
      });
    });
  }
});

describe('ghost (QA-069)', () => {
  it('its MySQL 8.4 runs with mysql_native_password enabled, keeping the image entrypoint', () => {
    const ghost = APP_TEMPLATES.find((t) => t.id === 'ghost')!;
    const raw = parseYaml(renderTemplateYaml(ghost, { stack: 'demo' })) as {
      services: Record<string, { image?: string; command?: string[] }>;
    };
    expect(raw.services.mysql?.image).toMatch(/^mysql:8\.4\./);
    // CMD (args), not an entrypoint override: docker-entrypoint.sh still inits the db.
    expect(raw.services.mysql?.command).toEqual(['mysqld', '--mysql-native-password=ON']);
    const loaded = loadTemplate(ghost, { stack: 'demo' });
    expect(loaded.desired?.services.find((s) => s.name === 'mysql')?.command).toEqual(['mysqld', '--mysql-native-password=ON']);
  });
});

describe('renderTemplateYaml', () => {
  it('replaces app: with the stack and JSON-escapes option values', () => {
    const t = {
      ...APP_TEMPLATES[0]!,
      options: [{ key: 'x', label: 'X', kind: 'string' as const, defaultValue: 'd' }],
      yaml: 'version: 1\napp: orig\nservices:\n  a:\n    image: a:1\n    env:\n      X: "[[opt.x]]"\n',
    };
    expect(renderTemplateYaml(t, { stack: 'mine' })).toContain('app: mine');
    expect(renderTemplateYaml(t, { stack: 'mine' })).toContain('X: "d"');
    const tricky = renderTemplateYaml(t, { stack: 'mine', options: { x: 'a"b\\c' } });
    expect((parseYaml(tricky) as { services: { a: { env: { X: string } } } }).services.a.env.X).toBe(
      'a"b\\c',
    );
  });
});
