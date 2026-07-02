/** Flat, string-valued form state for every provider's fields. */
export interface ProviderFormFields {
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  resendKey: string;
  postmarkToken: string;
  mailgunKey: string;
  mailgunDomain: string;
  mailgunBase: string;
}

export const EMPTY_FIELDS: ProviderFormFields = {
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  resendKey: '',
  postmarkToken: '',
  mailgunKey: '',
  mailgunDomain: '',
  mailgunBase: '',
};

/** Setter signature the field components share. */
export type SetField = <K extends keyof ProviderFormFields>(
  key: K,
  value: ProviderFormFields[K],
) => void;
