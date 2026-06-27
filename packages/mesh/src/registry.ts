import type { MeshDriver } from './types';
import { NetbirdDriver } from './drivers/netbird';
import { NoneDriver } from './drivers/none';
import { MeshUnknownDriverError } from './errors';

export class MeshRegistry {
  private drivers = new Map<string, MeshDriver>();

  register(driver: MeshDriver): this {
    this.drivers.set(driver.name, driver);
    return this;
  }

  get(name: string): MeshDriver {
    const driver = this.drivers.get(name);
    if (!driver) throw new MeshUnknownDriverError(name, [...this.drivers.keys()]);
    return driver;
  }

  has(name: string): boolean {
    return this.drivers.has(name);
  }

  list(): string[] {
    return [...this.drivers.keys()];
  }
}

/** `none` stays the default; NetBird is the default once mesh is enabled. */
export const defaultRegistry = new MeshRegistry()
  .register(new NoneDriver())
  .register(new NetbirdDriver());

export function registerDriver(driver: MeshDriver): void {
  defaultRegistry.register(driver);
}

export function getDriver(name: string): MeshDriver {
  return defaultRegistry.get(name);
}
