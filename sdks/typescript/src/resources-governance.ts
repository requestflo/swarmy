import type { HttpTransport } from './http.js';
import type { Guardrails, Policy, PolicyList, PolicyRequest, Removed, UpdateGuardrailsRequest } from './models.js';

/** The org's guardrails (`/guardrails`): production safety mode + the deploy rules. One per org. */
export class GuardrailsResource {
  constructor(private readonly http: HttpTransport) {}

  /** The guardrails (seeded with the defaults on first read). */
  get(): Promise<Guardrails> {
    return this.http.request<Guardrails>('GET', '/guardrails');
  }

  /** Change the switch and/or the rules named (admins and owners); the rest keep their state. */
  update(body: UpdateGuardrailsRequest): Promise<Guardrails> {
    return this.http.request<Guardrails>('PATCH', '/guardrails', { body });
  }
}

/** ABAC access policies (`/policies`). Writes need `policy.write` (owners and admins by default). */
export class PoliciesResource {
  constructor(private readonly http: HttpTransport) {}

  /** Every policy, highest priority first (the defaults are seeded). */
  list(): Promise<PolicyList> {
    return this.http.request<PolicyList>('GET', '/policies');
  }

  get(id: string): Promise<Policy> {
    return this.http.request<Policy>('GET', `/policies/${encodeURIComponent(id)}`);
  }

  /** Add a policy (201); `source` (the JSON document) is validated first. */
  create(body: PolicyRequest): Promise<Policy> {
    return this.http.request<Policy>('POST', '/policies', { body });
  }

  /** Replace a policy; a seeded default may only be switched on or off. */
  replace(id: string, body: PolicyRequest): Promise<Policy> {
    return this.http.request<Policy>('PUT', `/policies/${encodeURIComponent(id)}`, { body });
  }

  /** Delete a custom policy (defaults cannot be deleted). */
  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/policies/${encodeURIComponent(id)}`);
  }
}
