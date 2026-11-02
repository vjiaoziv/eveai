import { loadEsiCatalog } from '../src/eve/esi-catalog.js';
import { evaluateEsiOperationPolicy } from '../src/eve/esi-security.js';

const catalog = await loadEsiCatalog();
const rows = [...catalog.values()].map((operation) => {
  const decision = evaluateEsiOperationPolicy(operation);
  return {
    operationId: operation.name,
    method: operation.method,
    path: operation.path,
    toolPolicy: operation.toolPolicy,
    requiresAuth: operation.requiresAuth,
    requiredScopes: operation.requiredScopes,
    allowStatus: decision.allowed ? 'allow' : 'blocked',
    error: decision.allowed ? null : decision.error,
  };
});

const summary = {
  totalCatalogOperations: rows.length,
  allowedGetOperations: rows.filter((row) => row.allowStatus === 'allow').length,
  blockedNonGetOperations: rows.filter((row) => row.method !== 'GET').length,
  blockedNonReadGetOperations: rows.filter((row) => row.method === 'GET' && row.allowStatus === 'blocked').length,
  blockedUiOperations: rows.filter((row) => row.toolPolicy === 'ui').length,
};

process.stdout.write(JSON.stringify({ summary, rows }, null, 2));
