import type { AppTemplate } from '../types';
import { ANALYTICS_TEMPLATES } from './analytics';
import { CMS_TEMPLATES } from './cms';
import { MONITORING_TEMPLATES } from './monitoring';
import { PRODUCTIVITY_TEMPLATES } from './productivity';

/** Every curated one-click app, grouped by category file, in gallery order. */
export const APP_TEMPLATES: readonly AppTemplate[] = [
  ...CMS_TEMPLATES,
  ...ANALYTICS_TEMPLATES,
  ...MONITORING_TEMPLATES,
  ...PRODUCTIVITY_TEMPLATES,
];
