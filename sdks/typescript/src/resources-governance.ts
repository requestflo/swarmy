import type { HttpTransport } from './http.js';
import type { Guardrails, UpdateGuardrailsRequest } from './models.js';

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
