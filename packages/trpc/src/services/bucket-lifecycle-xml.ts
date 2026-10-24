/**
 * S3 `LifecycleConfiguration` documents for Garage — build
 * (PutBucketLifecycleConfiguration) and parse (GetBucketLifecycleConfiguration).
 * Only the elements Garage reads: ID, Status, Filter (Prefix / object size,
 * wrapped in `<And>` when more than one), Expiration (Days | Date) and
 * AbortIncompleteMultipartUpload. Elements in Garage's struct order. Pure.
 */
import type { LifecycleRuleView } from '@swarmy/core';
import { S3_XMLNS } from './bucket-cors-xml';
import { el, xmlAll, xmlInt, xmlOne, xmlTexts } from './s3-xml';

function filterXml(r: LifecycleRuleView): string {
  const conditions = [
    r.prefix ? el('Prefix', r.prefix) : '',
    r.sizeGreaterThan !== null ? el('ObjectSizeGreaterThan', r.sizeGreaterThan) : '',
    r.sizeLessThan !== null ? el('ObjectSizeLessThan', r.sizeLessThan) : '',
  ].filter(Boolean);
  if (conditions.length === 0) return ''; // no Filter = the whole bucket
  const inner = conditions.join('');
  return conditions.length > 1 ? `<Filter><And>${inner}</And></Filter>` : `<Filter>${inner}</Filter>`;
}

function ruleXml(r: LifecycleRuleView): string {
  const expiration =
    r.expireAfterDays !== null
      ? `<Expiration>${el('Days', r.expireAfterDays)}</Expiration>`
      : r.expireOnDate !== null
        ? `<Expiration>${el('Date', r.expireOnDate)}</Expiration>`
        : '';
  const abort =
    r.abortUploadsAfterDays !== null
      ? `<AbortIncompleteMultipartUpload>${el('DaysAfterInitiation', r.abortUploadsAfterDays)}</AbortIncompleteMultipartUpload>`
      : '';
  return [
    '<Rule>',
    r.id !== null ? el('ID', r.id) : '',
    el('Status', r.enabled ? 'Enabled' : 'Disabled'),
    filterXml(r),
    expiration,
    abort,
    '</Rule>',
  ].join('');
}

export function buildLifecycleXml(rules: readonly LifecycleRuleView[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="${S3_XMLNS}">${rules.map(ruleXml).join('')}</LifecycleConfiguration>`;
}

/** GetBucketLifecycleConfiguration body → rules (empty body / none ⇒ []). */
export function parseLifecycleXml(xml: string): LifecycleRuleView[] {
  return xmlAll(xml, 'Rule').map((r) => {
    const filter = xmlOne(r, 'Filter') ?? '';
    const conditions = xmlOne(filter, 'And') ?? filter;
    const expiration = xmlOne(r, 'Expiration') ?? '';
    const abort = xmlOne(r, 'AbortIncompleteMultipartUpload') ?? '';
    return {
      id: xmlTexts(r, 'ID')[0] ?? null,
      enabled: (xmlTexts(r, 'Status')[0] ?? 'Enabled') === 'Enabled',
      prefix: xmlTexts(conditions, 'Prefix')[0] ?? '',
      expireAfterDays: xmlInt(expiration, 'Days'),
      abortUploadsAfterDays: xmlInt(abort, 'DaysAfterInitiation'),
      expireOnDate: xmlTexts(expiration, 'Date')[0] ?? null,
      sizeGreaterThan: xmlInt(conditions, 'ObjectSizeGreaterThan'),
      sizeLessThan: xmlInt(conditions, 'ObjectSizeLessThan'),
    };
  });
}
