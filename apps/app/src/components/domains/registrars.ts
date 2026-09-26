/**
 * "Where you bought it": short, static steps per registrar. Kept to what
 * each registrar's DNS screen really asks for; the values come from the
 * record table above them.
 */
export type RegistrarId = 'cloudflare' | 'namecheap' | 'godaddy' | 'route53' | 'other';

export const REGISTRARS: Array<{ id: RegistrarId; label: string; where: string }> = [
  { id: 'cloudflare', label: 'Cloudflare', where: 'Cloudflare' },
  { id: 'namecheap', label: 'Namecheap', where: 'Namecheap' },
  { id: 'godaddy', label: 'GoDaddy', where: 'GoDaddy' },
  { id: 'route53', label: 'Route 53', where: 'Route 53' },
  { id: 'other', label: 'Other', where: 'your registrar' },
];

export function registrarSteps(id: RegistrarId, apex: string, mode: 'registrar' | 'nameserver'): string[] {
  if (mode === 'nameserver') {
    const ns: Record<RegistrarId, string> = {
      cloudflare: 'A domain registered with Cloudflare must use Cloudflare’s nameservers, so this won’t work there. If Cloudflare only runs your DNS, change the nameservers where you registered the domain.',
      namecheap: 'Domain List → Manage → Nameservers → Custom DNS, then add the NS names. Glue records live under Advanced DNS → Personal DNS Server.',
      godaddy: 'My Products → DNS → Nameservers → Change → “I’ll use my own nameservers”. Glue records are under Host names.',
      route53: 'Registered domains → ' + apex + ' → Actions → Edit name servers. Glue records are set on the same page.',
      other: 'Find “Nameservers” (sometimes “Custom DNS”) and replace them with the NS names above. Add the glue IPs where your registrar asks for “host names” or “child nameservers”.',
    };
    return [ns[id], 'Nameserver changes take from minutes to a day to reach every resolver. swarmy keeps checking.'];
  }
  switch (id) {
    case 'cloudflare':
      return [
        'DNS → Records → Add record. Use the type, name and value exactly as shown.',
        'Set Proxy status to “DNS only” (grey cloud) while the certificate issues. With the orange cloud on, visitors reach Cloudflare, not your servers.',
        'Remove any other A or AAAA record for the same name.',
      ];
    case 'namecheap':
      return [
        'Domain List → Manage → Advanced DNS → Add new record.',
        'Delete the default parking page CNAME and URL redirect for @ first. They answer instead of your servers.',
        'TTL “Automatic” is fine. Namecheap usually publishes within a few minutes.',
      ];
    case 'godaddy':
      return [
        'My Products → your domain → DNS → Add new record. Use @ for ' + apex + '.',
        'Delete the “Parked” A record GoDaddy adds by default.',
        'Changes can take up to an hour to show outside GoDaddy.',
      ];
    case 'route53':
      return [
        'Hosted zones → ' + apex + ' → Create record.',
        'For several addresses, put them on one A record, one per line, instead of separate records.',
        'Leave Alias off. A TTL of 300 is fine.',
      ];
    case 'other':
      return [
        'Open the DNS settings for ' + apex + ' where you bought it, and add each record above.',
        'Remove any other A, AAAA or parking record for the same name. They answer instead of your servers.',
      ];
  }
}
