import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { AlreadyOn, Tech } from '@/components/calm';
import { BlueprintIcon } from '@/components/blueprints/blueprint-icons';
import { memoryLabel, youGet } from '@/components/blueprints/template-words';
import { OWN_OPTIONS, type DeployChoice } from './deploy-choice';

/** The aside: what the picked choice gives you, and the one coral step onward. */
export function DeploySelection({
  choice,
  template,
}: {
  choice: DeployChoice;
  template: BlueprintMetaView | null;
}): React.JSX.Element | null {
  if (choice.kind === 'template') {
    if (!template) return null;
    const mem = memoryLabel(template);
    return (
      <section aria-label={template.name} className="calm-card flex flex-col gap-4 px-5 py-5">
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
            <BlueprintIcon id={template.id} category={template.category} className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="font-display text-[1.35rem] leading-tight font-bold tracking-[-0.02em]">{template.name}</h2>
            <p className="text-muted-foreground text-[13px]">{template.tagline}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="calm-eyebrow">You get</h3>
          <AlreadyOn bare items={youGet(template)} />
        </div>
        <Tech>{[template.version && `v${template.version}`, mem, ...template.resources].filter(Boolean).join(' · ')}</Tech>
        <Button asChild size="lg" className="pointer-coarse:min-h-11 w-full">
          <Link to="/blueprints" search={{ app: template.id }}>
            Configure {template.name} <ArrowRightIcon className="size-4" />
          </Link>
        </Button>
        <p className="text-muted-foreground text-center text-xs">Next: name and address. Nothing runs until you press Deploy.</p>
      </section>
    );
  }
  const o = OWN_OPTIONS.find((x) => x.kind === choice.kind)!;
  const say: Record<string, string> = {
    git: 'Connect GitHub, GitLab or any git host. swarmy builds each push on your servers and ships it, with previews for pull requests.',
    compose: 'Paste the compose file you already have. Every service goes up at once as one app.',
    image: 'Point swarmy at one container image and it runs it, with a web address if you want one.',
  };
  return (
    <section aria-label={o.title} className="calm-card flex flex-col gap-3 px-5 py-5">
      <h2 className="font-display text-[1.35rem] font-bold tracking-[-0.02em]">{o.title}</h2>
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">{say[o.kind]}</p>
      <Tech>{o.tech}</Tech>
      {o.kind === 'git' ? null : (
        <Button asChild size="lg" className="pointer-coarse:min-h-11 mt-1 w-full">
          <Link to={o.to}>
            {o.cta} <ArrowRightIcon className="size-4" />
          </Link>
        </Button>
      )}
    </section>
  );
}
