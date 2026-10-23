/**
 * Format samples to try the parser on — what each export looks like, with
 * placeholders, never anyone's real values. Loading one replaces the box;
 * nothing applies until "Apply as one deploy".
 */
export interface PasteSample {
  key: string;
  label: string;
  text: string;
}

export const PASTE_SAMPLES: PasteSample[] = [
  {
    key: 'sample',
    label: 'sample',
    text: ['# comments, quotes, export and multi-line values are fine', 'NODE_ENV=production', 'LOG_LEVEL=info', 'FEATURE_FLAGS="checkout,new-cart"'].join('\n'),
  },
  {
    key: 'heroku',
    label: 'heroku export',
    text: [
      '# heroku config -s --app <your-app>',
      "LOG_LEVEL='info'",
      "CART_TTL_HOURS='48'",
      "STRIPE_SECRET_KEY='replace-with-your-key'",
      "MAILGUN_API_KEY='replace-with-your-key'",
      "2FA_MODE='on'",
      '# debug while we migrate',
      "LOG_LEVEL='debug'",
    ].join('\n'),
  },
  {
    key: 'production',
    label: '.env.production',
    text: [
      '# .env.production',
      'export NODE_ENV=production',
      'CART_TTL_HOURS=24',
      'SEARCH_HOST=https://search.example.com',
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'replace-with-your-key',
      '-----END PRIVATE KEY-----"',
      'BROKEN="unterminated',
    ].join('\n'),
  },
];
