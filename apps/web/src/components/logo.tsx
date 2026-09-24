import { ContainerIcon } from 'lucide-react';

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-xl">
        <ContainerIcon className="size-5" aria-hidden />
      </span>
      <span className="text-lg font-bold tracking-tight">
        swarm<span className="text-primary">y</span>
      </span>
    </span>
  );
}
