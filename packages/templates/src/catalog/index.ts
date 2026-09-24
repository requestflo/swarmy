import type { AppTemplate } from '../types';
import { AI_TEMPLATES } from './ai';
import { ANALYTICS_TEMPLATES } from './analytics';
import { AUTOMATION_TEMPLATES } from './automation';
import { BUSINESS_TEMPLATES } from './business';
import { CMS_TEMPLATES } from './cms';
import { COMMS_TEMPLATES } from './comms';
import { DATA_TEMPLATES } from './data';
import { DEVTOOLS_TEMPLATES } from './devtools';
import { MEDIA_TEMPLATES } from './media';
import { MONITORING_TEMPLATES } from './monitoring';
import { PRODUCTIVITY_TEMPLATES } from './productivity';

/** Every curated one-click app, one file per gallery category, in gallery order. */
export const APP_TEMPLATES: readonly AppTemplate[] = [
  ...CMS_TEMPLATES,
  ...ANALYTICS_TEMPLATES,
  ...AUTOMATION_TEMPLATES,
  ...DEVTOOLS_TEMPLATES,
  ...DATA_TEMPLATES,
  ...MONITORING_TEMPLATES,
  ...COMMS_TEMPLATES,
  ...PRODUCTIVITY_TEMPLATES,
  ...AI_TEMPLATES,
  ...MEDIA_TEMPLATES,
  ...BUSINESS_TEMPLATES,
];
