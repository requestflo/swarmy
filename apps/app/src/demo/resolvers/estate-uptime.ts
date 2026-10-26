import { estateUptimeFrom, type EstateUptimeView } from '@swarmy/core';
import type { DomainResolvers } from '../types';

/**
 * `estate.uptime` in the demo: Northwind's status pages have watched the
 * estate all month, and 12 minutes of it something wasn't answering (the
 * main-db failover yesterday among them). Judged by the same pure rule as the
 * controller, so the figure reads 99.97% up, from status checks.
 */
const MONTH_MINUTES = 30 * 24 * 60;

export const estateUptimeDemo: DomainResolvers = {
  handlers: {
    'estate.uptime': (): EstateUptimeView =>
      estateUptimeFrom({ slots: MONTH_MINUTES, downSlots: 12, slotMinutes: 1 }, { slots: 2016, downSlots: 1, slotMinutes: 5 }),
  },
};
