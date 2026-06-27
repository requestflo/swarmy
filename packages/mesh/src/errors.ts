/** Driver requested that the registry doesn't know about. */
export class MeshUnknownDriverError extends Error {
  constructor(name: string, known: string[]) {
    super(`unknown mesh driver "${name}" (known: ${known.join(', ') || 'none'})`);
    this.name = 'MeshUnknownDriverError';
  }
}

/** Driver `validate()` rejected the org config. */
export class MeshValidationError extends Error {
  constructor(public readonly errors: { path: string; message: string }[]) {
    super(`mesh config invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'MeshValidationError';
  }
}

/** A provider control-plane (Admin API) call failed or was misconfigured. */
export class MeshControlPlaneError extends Error {
  constructor(
    public readonly driver: string,
    message: string,
  ) {
    super(`mesh control plane (${driver}): ${message}`);
    this.name = 'MeshControlPlaneError';
  }
}
