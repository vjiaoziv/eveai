import type {
  ChatMessage,
  ShowcaseExample,
  Conversation,
  MarketAiSearchResult,
  MarketAlert,
  MarketAlertEvent,
  MarketGroupTreeRow,
  MarketGroupTypeRow,
  MarketHistoryResponse,
  MarketOrderRow,
  MarketOrderSide,
  MarketOverview,
  MarketRegion,
  MarketRegionComparisonRow,
  MarketSnapshotMeta,
  MarketTypeInfo,
  MarketTypeSearchRow,
  MarketWatchlistItem,
  MapBubble,
  MapKillEvent,
  MapRouteResponse,
  MapStatus,
  ModelSettingsPayload,
  PerimeterMessage,
  MyTransparency,
  PilotProfile,
  ProfileAccessResponse,
  ProfileAssetItemsResponse,
  ProfileAssetsResponse,
  ProfileClonesResponse,
  ProfileDatasetId,
  ProfileOrdersResponse,
  ProfileSkillsResponse,
  ProfileSyncStatus,
  ProfileWalletResponse,
  SessionPayload,
  TransparencyPayload,
  WebAgentRequest,
  UniverseActivity,
  UniverseStatic,
  UniverseWormholes,
  InspectedSystem,
} from './types';
import { LOCALE_STORAGE_KEY, readStoredLocale, translateOutOfReact, type Locale, type TranslationKey } from './i18n-dictionary';
import { apiErrorKey } from './api-error-keys';

/**
 * Localize an error value that arrives inside a successful payload (for
 * example the agent-request DTO). Snake_case codes go through
 * API_ERROR_KEYS; anything else is legacy server text shown as-is.
 */
export function translateApiErrorValue(value: string | null | undefined, fallbackKey: TranslationKey): string {
  if (!value) return translateOutOfReact(fallbackKey, currentLocale());
  const key = apiErrorKey(value);
  return key ? translateOutOfReact(key, currentLocale()) : value;
}

type ErrorPayload = { error?: string };

/**
 * Transport errors are built before any React tree exists, so they read the
 * persisted locale directly instead of useI18n(). Same storage key as the
 * provider keeps both sides in sync; without storage we fall back to zh, the
 * provider's own default.
 */
function currentLocale(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en' || saved === 'ru') return saved;
  } catch {
    // Storage unavailable (private mode, tests): fall through to the default.
  }
  return 'zh';
}

export class AmbiguousApiRequestError extends Error {
  readonly ambiguous = true;
}

export class ApiRequestError extends Error {
  readonly status: number;
  /** Machine-readable error code when the server sent one (e.g. settings routes). */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isAmbiguousApiRequestError(error: unknown): error is AmbiguousApiRequestError {
  return error instanceof AmbiguousApiRequestError;
}

function httpErrorMessage(status: number, serverMessage?: string): string {
  if (status === 401 || status === 403) {
    return serverMessage || translateOutOfReact('errorSessionExpired', currentLocale());
  }
  if (status === 429) {
    return serverMessage || translateOutOfReact('requestTooMany', currentLocale());
  }
  if (status >= 500) {
    return serverMessage || translateOutOfReact('errorServerUnavailable', currentLocale());
  }
  return serverMessage || translateOutOfReact('requestFailed', currentLocale());
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new AmbiguousApiRequestError(translateOutOfReact('errorNetworkInterrupted', currentLocale()));
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ErrorPayload;
    // A snake_case token is a machine-readable error code, not a user-facing
    // sentence — localized screens map it themselves; anything else stays a
    // server-provided message.
    const code = typeof payload.error === 'string' && /^[a-z][a-z0-9_]*$/.test(payload.error)
      ? payload.error
      : undefined;
    // A code is translated once, here, so every screen gets localized text
    // without repeating a code->key table. Unknown codes fall back to the
    // generic status message rather than leaking a raw token.
    const message = code
      ? translateOutOfReact(apiErrorKey(code) ?? 'requestFailed', currentLocale())
      : httpErrorMessage(response.status, payload.error);
    throw new ApiRequestError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new AmbiguousApiRequestError(translateOutOfReact('errorUnreadableResponse', currentLocale()));
  }
}

export const webApi = {
  getSession: () => request<SessionPayload>('/api/web/session'),
  createSession: (turnstileToken?: string) => request<SessionPayload>('/api/web/session', {
    method: 'POST',
    body: JSON.stringify({ turnstileToken }),
  }),
  logout: (csrfToken: string) => request<void>('/api/web/session', { method: 'DELETE' }, csrfToken),
  startEveLogin: (csrfToken: string, locale: Locale) => request<{ url: string }>(
    '/api/web/eve/login',
    { method: 'POST', body: JSON.stringify({ language: locale }) },
    csrfToken,
  ),
  activateCharacter: (characterId: number, csrfToken: string) => request<SessionPayload>(
    `/api/web/characters/${encodeURIComponent(characterId)}/activate`,
    { method: 'POST' },
    csrfToken,
  ),
  unlinkCharacter: (characterId: number, csrfToken: string) => request<void>(
    `/api/web/characters/${encodeURIComponent(characterId)}/unlink`,
    { method: 'POST' },
    csrfToken,
  ),
  listConversations: () => request<{ conversations: Conversation[] }>('/api/web/conversations'),
  createConversation: (csrfToken: string) => request<{ threadId: string }>(
    '/api/web/conversations',
    { method: 'POST' },
    csrfToken,
  ),
  deleteConversation: (threadId: string, csrfToken: string) => request<void>(
    `/api/web/conversations/${encodeURIComponent(threadId)}`,
    { method: 'DELETE' },
    csrfToken,
  ),
  getMessages: (threadId: string) => request<{ messages: ChatMessage[] }>(
    `/api/web/conversations/${encodeURIComponent(threadId)}/messages`,
  ),
  sendMessage: (
    message: string,
    threadId: string | null,
    idempotencyKey: string,
    csrfToken: string,
  ) => request<{
    request: WebAgentRequest;
    existing: boolean;
    pollUrl: string;
    cancelUrl: string;
    eventsUrl: string;
  }>('/api/web/chat', {
    method: 'POST',
    body: JSON.stringify({ message, threadId, idempotencyKey, locale: readStoredLocale() }),
  }, csrfToken),
  getAgentRequest: (requestId: string) => request<{ request: WebAgentRequest }>(
    `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
  ),
  getActiveAgentRequest: (threadId?: string | null) => request<{ request: WebAgentRequest | null }>(
    `/api/web/chat/requests/active${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`,
  ),
  cancelAgentRequest: (requestId: string, csrfToken: string) => request<{ request: WebAgentRequest }>(
    `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
    { method: 'DELETE' },
    csrfToken,
  ),
  getProfile: () => request<{ profile: PilotProfile | null }>('/api/web/profile'),
  profile: {
    assets: (offset?: number, limit?: number) => request<ProfileAssetsResponse>(
      `/api/web/profile/assets${offset === undefined ? '' : `?offset=${offset}`}${limit === undefined ? '' : `${offset === undefined ? '?' : '&'}limit=${limit}`}`,
    ),
    assetItems: (locationId: number, offset?: number, limit?: number) => request<ProfileAssetItemsResponse>(
      `/api/web/profile/assets/items?location_id=${encodeURIComponent(locationId)}${offset === undefined ? '' : `&offset=${offset}`}${limit === undefined ? '' : `&limit=${limit}`}`,
    ),
    orders: (offset?: number, limit?: number) => request<ProfileOrdersResponse>(
      `/api/web/profile/orders${offset === undefined ? '' : `?offset=${offset}`}${limit === undefined ? '' : `${offset === undefined ? '?' : '&'}limit=${limit}`}`,
    ),
    wallet: () => request<ProfileWalletResponse>('/api/web/profile/wallet'),
    clones: () => request<ProfileClonesResponse>('/api/web/profile/clones'),
    skills: () => request<ProfileSkillsResponse>('/api/web/profile/skills'),
    access: () => request<ProfileAccessResponse>('/api/web/profile/access'),
    sync: (datasets: ProfileDatasetId[] | undefined, csrfToken: string) => request<{ statuses: ProfileSyncStatus[] }>(
      '/api/web/profile/sync',
      { method: 'POST', body: JSON.stringify(datasets === undefined ? {} : { datasets }) },
      csrfToken,
    ),
  },
  assets: {
    overview: () => request<unknown>('/api/web/assets/overview'),
    characters: () => request<unknown>('/api/web/assets/characters'),
    sync: (characterId: number, csrfToken: string) => request<unknown>(
      '/api/web/assets/sync',
      { method: 'POST', body: JSON.stringify({ characterId }) },
      csrfToken,
    ),
    syncJobs: (characterId: number, limit = 50) =>
      request<unknown>(`/api/web/assets/sync/jobs?characterId=${characterId}&limit=${limit}`),
    snapshots: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/assets/snapshots?${search.toString()}`);
    },
    snapshot: (snapshotId: string, params: { limit?: number; offset?: number } = {}) => {
      const search = new URLSearchParams();
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.offset !== undefined) search.set('offset', String(params.offset));
      const suffix = search.toString();
      return request<unknown>(`/api/web/assets/snapshots/${encodeURIComponent(snapshotId)}${suffix ? `?${suffix}` : ''}`);
    },
    changes: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/assets/changes?${search.toString()}`);
    },
    historyTotals: (characterId: number, limit = 100) =>
      request<unknown>(`/api/web/assets/history/totals?characterId=${characterId}&limit=${limit}`),
    itemHistory: (itemId: number) =>
      request<unknown>(`/api/web/assets/history/item/${itemId}`),
    compareSnapshots: (fromSnapshotId: string, toSnapshotId: string) =>
      request<unknown>(`/api/web/assets/history/compare/${encodeURIComponent(fromSnapshotId)}/${encodeURIComponent(toSnapshotId)}`),
    inventory: (params: Record<string, string | number | boolean | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/assets/inventory?${search.toString()}`);
    },
    item: (itemId: number) => request<unknown>(`/api/web/assets/inventory/${itemId}`),
    setTag: (itemId: number, tag: string | null, csrfToken: string) => request<unknown>(
      `/api/web/assets/tags/${itemId}`,
      { method: 'PUT', body: JSON.stringify({ tag }) },
      csrfToken,
    ),
    valuations: (characterId: number, limit = 20) =>
      request<unknown>(`/api/web/assets/valuations?characterId=${characterId}&limit=${limit}`),
    valuation: (valuationId: string) =>
      request<unknown>(`/api/web/assets/valuations/${encodeURIComponent(valuationId)}`),
    runValuation: (body: Record<string, unknown>, csrfToken: string) => request<unknown>(
      '/api/web/assets/valuations',
      { method: 'POST', body: JSON.stringify(body) },
      csrfToken,
    ),
    opportunityMatches: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/assets/opportunity-matches?${search.toString()}`);
    },
    recomputeMatches: (characterId: number, csrfToken: string) => request<unknown>(
      '/api/web/assets/opportunity-matches/recompute',
      { method: 'POST', body: JSON.stringify({ characterId }) },
      csrfToken,
    ),
  },  market: {
    status: () => request<{ snapshot: MarketSnapshotMeta }>('/api/web/market/status'),
    regions: () => request<{ regions: MarketRegion[] }>('/api/web/market/regions'),
    search: (q: string, limit?: number) => request<{ results: MarketTypeSearchRow[] }>(
      `/api/web/market/search?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`,
    ),
    groups: (parent?: number | null) => request<{ groups: MarketGroupTreeRow[] }>(
      `/api/web/market/groups${parent === undefined || parent === null ? '' : `?parent=${parent}`}`,
    ),
    groupTypes: (groupId: number, limit?: number) => request<{ types: MarketGroupTypeRow[] }>(
      `/api/web/market/groups/${encodeURIComponent(groupId)}/types${limit === undefined ? '' : `?limit=${limit}`}`,
    ),
    overview: (typeId: number, regionId: number) => request<{ overview: MarketOverview }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/overview?region_id=${regionId}`,
    ),
    orders: (typeId: number, regionId: number, side: MarketOrderSide, offset?: number, limit?: number) => request<{ orders: MarketOrderRow[] }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/orders?region_id=${regionId}&side=${side}${offset === undefined ? '' : `&offset=${offset}`}${limit === undefined ? '' : `&limit=${limit}`}`,
    ),
    regionComparison: (typeId: number) => request<{ regions: MarketRegionComparisonRow[] }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/regions`,
    ),
    info: (typeId: number, lang: Locale) => request<{ info: MarketTypeInfo }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/info?lang=${lang}`,
    ),
    aiSearch: (query: string, regionId: number | null, csrfToken: string) => request<{ results: MarketAiSearchResult[] }>(
      '/api/web/market/ai-search',
      { method: 'POST', body: JSON.stringify({ query, region_id: regionId ?? undefined }) },
      csrfToken,
    ),
    history: (typeId: number, regionId: number, days?: number) => request<{ history: MarketHistoryResponse }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/history?region_id=${regionId}${days === undefined ? '' : `&days=${days}`}`,
    ),
    watchlist: {
      list: () => request<{ items: MarketWatchlistItem[] }>('/api/web/market/watchlist'),
      add: (typeId: number, regionId: number | undefined, csrfToken: string) => request<{ created: boolean; item: MarketWatchlistItem }>(
        '/api/web/market/watchlist',
        { method: 'POST', body: JSON.stringify({ type_id: typeId, region_id: regionId }) },
        csrfToken,
      ),
      remove: (typeId: number, regionId: number | undefined, csrfToken: string) => request<{ ok: true }>(
        `/api/web/market/watchlist/${encodeURIComponent(typeId)}${regionId === undefined ? '' : `?region_id=${regionId}`}`,
        { method: 'DELETE' },
        csrfToken,
      ),
    },
    alerts: {
      list: () => request<{ alerts: MarketAlert[] }>('/api/web/market/alerts'),
      create: (
        params: { typeId: number; regionId: number; side: MarketOrderSide; comparator: 'above' | 'below'; thresholdPrice: number },
        csrfToken: string,
      ) => request<{ alert: MarketAlert }>(
        '/api/web/market/alerts',
        {
          method: 'POST',
          body: JSON.stringify({
            type_id: params.typeId,
            region_id: params.regionId,
            side: params.side,
            comparator: params.comparator,
            threshold_price: params.thresholdPrice,
          }),
        },
        csrfToken,
      ),
      remove: (alertId: number, csrfToken: string) => request<{ ok: true }>(
        `/api/web/market/alerts/${encodeURIComponent(alertId)}`,
        { method: 'DELETE' },
        csrfToken,
      ),
      events: () => request<{ events: MarketAlertEvent[] }>('/api/web/market/alerts/events'),
    },
  },
  // Периметр. Живой поток идёт отдельным EventSource (см. use-map-live.ts):
  // fetch тут только для снимков, маршрута и истории треда.
  map: {
    status: () => request<MapStatus>('/api/web/map/status'),
    // Static geometry for all of New Eden. Immutable between SDE builds, so the
    // browser is allowed to cache it hard; buildId is the cache key.
    universe: () => request<UniverseStatic>('/api/web/map/universe'),
    universeIntel: () => request<UniverseActivity>('/api/web/map/universe/intel'),
    bubble: (systemId?: number, radius?: number) => {
      const params = new URLSearchParams();
      if (systemId !== undefined) params.set('system_id', String(systemId));
      if (radius !== undefined) params.set('radius', String(radius));
      const query = params.toString();
      return request<{ bubble: MapBubble; origin: { systemId: number; source: string } }>(
        `/api/web/map/bubble${query ? `?${query}` : ''}`,
      );
    },
    universeWormholes: () => request<UniverseWormholes>('/api/web/map/universe/wormholes'),
    // fromSystemId is where the pilot is, so the panel can say how far away this
    // system is. Omitted when nobody knows — the answer is then "unknown", never 0.
    system: (systemId: number, fromSystemId?: number | null) => {
      const params = new URLSearchParams({ system_id: String(systemId) });
      if (fromSystemId !== undefined && fromSystemId !== null) {
        params.set('from_system_id', String(fromSystemId));
      }
      return request<{ system: InspectedSystem; kills: MapKillEvent[] }>(
        `/api/web/map/system?${params.toString()}`,
      );
    },
    route: (
      params: {
        origin: number;
        destination: number;
        mode: 'shortest' | 'secure' | 'insecure';
        risk: number;
        avoid?: number[];
        useWormholes?: boolean;
      },
      csrfToken: string,
    ) => request<MapRouteResponse>('/api/web/map/route', {
      method: 'POST',
      body: JSON.stringify(params),
    }, csrfToken),
    // Takes the drawn line off the map. Deliberately does not touch the in-game
    // autopilot: erasing a drawing and erasing waypoints are different acts.
    clearRoute: (csrfToken: string) => request<{ cleared: boolean }>(
      '/api/web/map/route',
      { method: 'DELETE' },
      csrfToken,
    ),
    // Renews the live session's idle lease. Without it a pilot parked in one
    // system is stopped after the idle window even with the map open. The
    // caller only pings while the tab is visible, so a forgotten tab still
    // times out. 404 means no live session exists (the stream is reconnecting).
    touchLive: (csrfToken: string) => request<void>(
      '/api/web/map/live/touch',
      { method: 'POST' },
      csrfToken,
    ),
    chat: () => request<{ threadId: string; messages: PerimeterMessage[] }>('/api/web/map/chat'),
    resetChat: (csrfToken: string) => request<{ threadId: string; messages: PerimeterMessage[] }>(
      '/api/web/map/chat/reset',
      { method: 'POST' },
      csrfToken,
    ),
    ask: (
      message: string,
      csrfToken: string,
      context?: {
        systemId: number | null;
        selectedSystemId: number | null;
        shipTypeId: number | null;
        radius: number | null;
        band: string | null;
      },
    ) => request<{ threadId: string; request: WebAgentRequest; pollUrl: string; eventsUrl: string }>(
      '/api/web/map/ask',
      { method: 'POST', body: JSON.stringify({ message, context }) },
      csrfToken,
    ),
  },
  p9: {
    overview: () => request<unknown>('/api/web/trading/p9/overview'),
    settings: () => request<unknown>('/api/web/trading/p9/settings'),
    saveSettings: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/settings', { method: 'PUT', body: JSON.stringify(body) }, csrfToken),
    scan: (csrfToken: string, typeIds: number[] = []) => request<unknown>('/api/web/trading/p9/scan', { method: 'POST', body: JSON.stringify({ typeIds }) }, csrfToken),
    opportunities: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/trading/p9/opportunities?${search.toString()}`);
    },
    opportunity: (id: string) => request<unknown>(`/api/web/trading/p9/opportunities/${encodeURIComponent(id)}`),
    transitionOpportunity: (id: string, state: string, csrfToken: string) => request<unknown>(`/api/web/trading/p9/opportunities/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ state }) }, csrfToken),
    plans: (status?: string) => request<unknown>(`/api/web/trading/p9/plans${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    createPlan: (opportunityId: string, csrfToken: string) => request<unknown>('/api/web/trading/p9/plans', { method: 'POST', body: JSON.stringify({ opportunityId }) }, csrfToken),
    transitionPlan: (planId: string, status: string, csrfToken: string) => request<unknown>(`/api/web/trading/p9/plans/${encodeURIComponent(planId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }, csrfToken),
    inventory: () => request<unknown>('/api/web/trading/p9/inventory'),
    createLot: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/inventory/lots', { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    realTrades: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/trading/p9/real-trades?${search.toString()}`);
    },
    recordTrade: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/real-trades', { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    updateTrade: (tradeId: string, body: unknown, csrfToken: string) => request<unknown>(`/api/web/trading/p9/real-trades/${encodeURIComponent(tradeId)}`, { method: 'PUT', body: JSON.stringify(body) }, csrfToken),
    syncEsiTrades: (csrfToken: string) => request<unknown>('/api/web/trading/p9/real-trades/esi-sync', { method: 'POST', body: '{}' }, csrfToken),
    rebuildLedger: (csrfToken: string) => request<unknown>('/api/web/trading/p9/rebuild-ledger', { method: 'POST', body: '{}' }, csrfToken),
    risk: () => request<unknown>('/api/web/trading/p9/risk'),
    jobs: () => request<unknown>('/api/web/trading/p9/jobs'),
    analyze: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/analyze', { method: 'POST', body: JSON.stringify(body) }, csrfToken),
  },
  p93: {
    overview: () => request<unknown>('/api/web/trading/p9/real-ledger/overview'),
    records: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/trading/p9/real-ledger/records?${search.toString()}`);
    },
    record: (recordId: string) => request<unknown>(`/api/web/trading/p9/real-ledger/records/${encodeURIComponent(recordId)}`),
    createRecord: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/real-ledger/records', { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    updateRecord: (recordId: string, body: unknown, csrfToken: string) => request<unknown>(`/api/web/trading/p9/real-ledger/records/${encodeURIComponent(recordId)}`, { method: 'PUT', body: JSON.stringify(body) }, csrfToken),
    recordAction: (recordId: string, action: 'submit' | 'verify' | 'reject' | 'reverse', csrfToken: string, reason?: string) => request<unknown>(`/api/web/trading/p9/real-ledger/records/${encodeURIComponent(recordId)}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) }, csrfToken),
    correctRecord: (recordId: string, body: unknown, csrfToken: string) => request<unknown>(`/api/web/trading/p9/real-ledger/records/${encodeURIComponent(recordId)}/correct`, { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    evidenceList: () => request<unknown>('/api/web/trading/p9/real-ledger/evidence'),
    evidence: (body: unknown, csrfToken: string) => request<unknown>('/api/web/trading/p9/real-ledger/evidence', { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    evidenceStatus: (evidenceId: string, status: string, csrfToken: string, reason?: string) => request<unknown>(`/api/web/trading/p9/real-ledger/evidence/${encodeURIComponent(evidenceId)}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }, csrfToken),
    linkEvidence: (recordId: string, body: unknown, csrfToken: string) => request<unknown>(`/api/web/trading/p9/real-ledger/records/${encodeURIComponent(recordId)}/evidence-links`, { method: 'POST', body: JSON.stringify(body) }, csrfToken),
    costs: () => request<unknown>('/api/web/trading/p9/real-ledger/costs'),
    syncEsiWallet: (csrfToken: string) => request<unknown>('/api/web/trading/p9/real-ledger/esi-wallet-sync', { method: 'POST', body: '{}' }, csrfToken),
    recalculate: (csrfToken: string) => request<unknown>('/api/web/trading/p9/real-ledger/recalculate', { method: 'POST', body: '{}' }, csrfToken),
    performance: () => request<unknown>('/api/web/trading/p9/real-ledger/performance'),
    reconciliation: (params: Record<string, string | number | undefined> = {}) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
      return request<unknown>(`/api/web/trading/p9/real-ledger/reconciliation?${search.toString()}`);
    },    runReconciliation: (csrfToken: string) => request<unknown>('/api/web/trading/p9/real-ledger/reconciliation/run', { method: 'POST', body: '{}' }, csrfToken),
    audit: () => request<unknown>('/api/web/trading/p9/real-ledger/audit'),
  },
  trading: {
    overview: () => request<unknown>('/api/web/trading/paper/overview'),
    orders: (status?: string, limit = 100) => request<unknown>(
      `/api/web/trading/paper/orders?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
    opportunities: (limit = 100) => request<unknown>(`/api/web/trading/paper/opportunities?limit=${limit}`),
    fills: (limit = 200) => request<unknown>(`/api/web/trading/paper/fills?limit=${limit}`),
    performance: () => request<unknown>('/api/web/trading/paper/performance'),
    runtimeValidation: () => request<unknown>('/api/web/trading/paper/runtime-validation'),
    risk: () => request<unknown>('/api/web/trading/paper/risk'),
  },
  getExamples: () => request<{ examples: ShowcaseExample[] }>('/api/web/examples'),
  getTransparency: () => request<TransparencyPayload>('/api/web/transparency'),
  getMyTransparency: () => request<MyTransparency>('/api/web/transparency/me'),
  getModelSettings: () => request<ModelSettingsPayload>('/api/web/settings/model'),
  saveModelSettings: (
    body: { model: string; reasoning_effort: string; verbosity: string },
    csrfToken: string,
  ) => request<ModelSettingsPayload>('/api/web/settings/model', {
    method: 'PUT',
    body: JSON.stringify(body),
  }, csrfToken),
  resetModelSettings: (csrfToken: string) => request<ModelSettingsPayload>('/api/web/settings/model', {
    method: 'DELETE',
  }, csrfToken),
};
