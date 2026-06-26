import type { IngressDriver } from './types';
import { CaddyDriver } from './drivers/caddy';
import { TraefikDriver } from './drivers/traefik';
import { NoneDriver } from './drivers/none';
import { IngressUnknownDriverError } from './errors';

export class IngressRegistry {
  private drivers = new Map<string, IngressDriver>();

  register(driver: IngressDriver): this {
    this.drivers.set(driver.name, driver);
    return this;
  }

  get(name: string): IngressDriver {
    const driver = this.drivers.get(name);
    if (!driver) throw new IngressUnknownDriverError(name, [...this.drivers.keys()]);
    return driver;
  }

  has(name: string): boolean {
    return this.drivers.has(name);
  }

  list(): string[] {
    return [...this.drivers.keys()];
  }
}

export const defaultRegistry = new IngressRegistry()
  .register(new CaddyDriver())
  .register(new TraefikDriver())
  .register(new NoneDriver());

export function registerDriver(driver: IngressDriver): void {
  defaultRegistry.register(driver);
}

export function getDriver(name: string): IngressDriver {
  return defaultRegistry.get(name);
}
