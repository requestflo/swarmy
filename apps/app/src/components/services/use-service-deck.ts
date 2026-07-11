import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvServiceStatus } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface DeckEntry {
  id: string;
  name: string;
  status: InvServiceStatus;
}

interface ServiceDeck {
  deck: DeckEntry[];
  index: number;
  prev: DeckEntry | null;
  next: DeckEntry | null;
}

/**
 * The coverflow deck behind the service overlay: the active service's stack
 * siblings in stable name order, so ←/→ walks the whole stack and the peek
 * cards always show real neighbours.
 */
export function useServiceDeck(activeId: string): ServiceDeck {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });

  return React.useMemo(() => {
    const services = inventory.data?.services ?? [];
    const active = services.find((s) => s.id === activeId);
    const deck = (active ? services.filter((s) => s.stack === active.stack) : [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, name: s.name, status: s.status }));
    const index = deck.findIndex((s) => s.id === activeId);
    return {
      deck,
      index,
      prev: (index > 0 ? deck[index - 1] : null) ?? null,
      next: (index >= 0 && index < deck.length - 1 ? deck[index + 1] : null) ?? null,
    };
  }, [inventory.data, activeId]);
}
