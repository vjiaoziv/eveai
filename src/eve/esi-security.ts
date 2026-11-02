export type EsiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type EsiOperationIdentity = {
  name: string;
  method: string;
  path: string;
  toolPolicy: 'read' | 'write' | 'ui';
};

export type EsiSecurityDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 404 | 405; error: string };

const ESI_BASE_URL = process.env.ESI_BASE_URL || 'https://esi.evetech.net/latest/';

export function isEsiUrl(input: string | URL): boolean {
  try {
    const candidate = input instanceof URL ? input : new URL(input);
    const allowed = new URL(ESI_BASE_URL);
    return candidate.origin === allowed.origin;
  } catch {
    return false;
  }
}

export function evaluateEsiOperationPolicy(operation: EsiOperationIdentity): EsiSecurityDecision {
  if (operation.method !== 'GET') {
    return {
      allowed: false,
      status: 405,
      error: `Blocked non-GET ESI operation ${operation.name}: method=${operation.method}`,
    };
  }
  if (operation.toolPolicy !== 'read') {
    return {
      allowed: false,
      status: 403,
      error: `Blocked non-read ESI operation ${operation.name}: policy=${operation.toolPolicy}`,
    };
  }
  return { allowed: true };
}

export function evaluateEsiHttpDispatch(input: string | URL, method: string): EsiSecurityDecision {
  const normalized = method.toUpperCase();
  if (!isEsiUrl(input)) {
    return {
      allowed: false,
      status: 403,
      error: 'Blocked ESI gateway bypass: URL is outside the configured ESI origin.',
    };
  }
  if (normalized !== 'GET') {
    return {
      allowed: false,
      status: 405,
      error: `Blocked non-GET ESI request: method=${normalized}`,
    };
  }
  return { allowed: true };
}

export function assertEsiHttpDispatch(input: string | URL, method: string): void {
  const decision = evaluateEsiHttpDispatch(input, method);
  if (!decision.allowed) throw new Error(decision.error);
}
