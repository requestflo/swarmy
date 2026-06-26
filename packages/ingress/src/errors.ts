export class IngressValidationError extends Error {
  constructor(public errors: { path: string; message: string }[]) {
    super(`ingress config invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'IngressValidationError';
  }
}

export class IngressUnknownDriverError extends Error {
  constructor(name: string, known: string[]) {
    super(`unknown ingress driver "${name}". registered: ${known.join(', ')}`);
    this.name = 'IngressUnknownDriverError';
  }
}

export class IngressApplyError extends Error {
  constructor(
    public nodeId: string,
    message: string,
  ) {
    super(`ingress apply failed on node ${nodeId}: ${message}`);
    this.name = 'IngressApplyError';
  }
}
