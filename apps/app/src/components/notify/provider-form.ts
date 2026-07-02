import type { NotifyConfigView, NotifyProviderView, SetNotifyConfigInput } from '@swarmy/core';
import { EMPTY_FIELDS, type ProviderFormFields } from './form-state';

/**
 * Pure helpers between the flat form state and the wire types — hydrating the
 * form from the redacted `NotifyConfigView.summary` (secrets never round-trip)
 * and assembling a `SetNotifyConfigInput` (null while the form is incomplete).
 */

/** Pre-fill non-secret fields from the redacted config summary. */
export function hydrateFields(config: NotifyConfigView): ProviderFormFields {
  const s = config.summary;
  return {
    ...EMPTY_FIELDS,
    smtpHost: s.host ?? '',
    smtpPort: s.port ?? '587',
    smtpSecure: s.secure === 'tls',
    smtpUser: s.user ?? '',
    mailgunDomain: s.domain ?? '',
    mailgunBase: s.baseUrl ?? '',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Assemble the mutation input, or null while required fields are missing.
 * `configured` = creds for this provider are already stored, so secret fields
 * may stay blank (the server keeps the saved values).
 */
export function buildSetConfigInput(
  provider: NotifyProviderView,
  fromAddress: string,
  f: ProviderFormFields,
  configured: boolean,
): SetNotifyConfigInput | null {
  const from = fromAddress.trim();
  if (!EMAIL_RE.test(from)) return null;

  if (provider === 'smtp') {
    const host = f.smtpHost.trim();
    const port = Number.parseInt(f.smtpPort, 10);
    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null;
    if (!configured && !f.smtpPass.trim() && f.smtpUser.trim()) return null;
    return {
      provider,
      fromAddress: from,
      smtp: {
        host,
        port,
        secure: f.smtpSecure,
        ...(f.smtpUser.trim() ? { user: f.smtpUser.trim() } : {}),
        ...(f.smtpPass ? { pass: f.smtpPass } : {}),
      },
    };
  }
  if (provider === 'resend') {
    const apiKey = f.resendKey.trim();
    if (!apiKey && !configured) return null;
    return { provider, fromAddress: from, resend: apiKey ? { apiKey } : {} };
  }
  if (provider === 'postmark') {
    const serverToken = f.postmarkToken.trim();
    if (!serverToken && !configured) return null;
    return { provider, fromAddress: from, postmark: serverToken ? { serverToken } : {} };
  }
  const domain = f.mailgunDomain.trim();
  const apiKey = f.mailgunKey.trim();
  if (!domain) return null;
  if (!apiKey && !configured) return null;
  return {
    provider,
    fromAddress: from,
    mailgun: {
      domain,
      ...(apiKey ? { apiKey } : {}),
      ...(f.mailgunBase.trim() ? { baseUrl: f.mailgunBase.trim() } : {}),
    },
  };
}
