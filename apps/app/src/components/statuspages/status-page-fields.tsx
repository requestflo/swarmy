import * as React from 'react';
import { Input, Label, Switch } from '@swarmy/ui';
import { ComponentPicker } from './component-picker';
import { SLUG_RE, slugify, type PageDraft } from './page-draft';

/** The create/edit form body — fields only, no chrome or submit logic. */
export function StatusPageFields({
  draft,
  onChange,
  slugLocked,
  stack,
}: {
  draft: PageDraft;
  onChange: (next: PageDraft) => void;
  /** Editing an existing page keeps the public URL stable by default. */
  slugLocked?: boolean;
  /** Offer only this stack's components in the picker. */
  stack?: string;
}): React.JSX.Element {
  const slugInvalid = draft.slug.length > 0 && !(draft.slug.length >= 3 && SLUG_RE.test(draft.slug));
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="sp-title">Page title</Label>
        <Input
          id="sp-title"
          placeholder="RequestFlo"
          value={draft.title}
          onChange={(e) =>
            onChange({
              ...draft,
              title: e.target.value,
              slug: draft.slugTouched || slugLocked ? draft.slug : slugify(e.target.value),
            })
          }
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="sp-slug">Public URL</Label>
        <div className="flex items-center gap-1.5">
          <span className="mono-data text-muted-foreground shrink-0">/s/</span>
          <Input
            id="sp-slug"
            placeholder="requestflo-status"
            value={draft.slug}
            disabled={slugLocked}
            onChange={(e) =>
              onChange({ ...draft, slug: slugify(e.target.value), slugTouched: true })
            }
          />
        </div>
        {slugInvalid ? (
          <p className="text-status-offline text-xs">
            3+ characters — lowercase letters, digits and dashes.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Anyone with this link can see the page. The slug is unique across swarmy.
          </p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label>Components</Label>
        <ComponentPicker
          selected={draft.components}
          onChange={(components) => onChange({ ...draft, components })}
          stack={stack}
        />
        <p className="text-muted-foreground text-xs">
          {draft.components.length} picked — each gets a status row and an uptime bar.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="sp-domain">Custom domain (optional)</Label>
        <Input
          id="sp-domain"
          placeholder="status.example.com"
          value={draft.domain}
          onChange={(e) => onChange({ ...draft, domain: e.target.value.trim().toLowerCase() })}
        />
        <p className="text-muted-foreground text-xs">
          Point a CNAME at your swarmy host to serve the page on your own domain.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="sp-uptime">Show uptime bars</Label>
        <Switch
          id="sp-uptime"
          checked={draft.showUptime}
          onCheckedChange={(showUptime) => onChange({ ...draft, showUptime })}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="sp-incidents">Show incident history</Label>
        <Switch
          id="sp-incidents"
          checked={draft.showIncidents}
          onCheckedChange={(showIncidents) => onChange({ ...draft, showIncidents })}
        />
      </div>
    </div>
  );
}
