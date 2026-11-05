import { readStoredLocale, type TranslationKey } from './i18n-dictionary';

/**
 * Kept React-free: callers inject the translator and the locale so this module
 * stays a pure helper instead of reaching for a context it cannot see.
 */
export type P93Freshness = {
  status: 'CURRENT' | 'STALE' | 'NEVER_CALCULATED';
  latestCalculationAt: string | null;
  latestLedgerFactAt: string | null;
  latestFailedCalculationAt: string | null;
  message: string;
};

export function freshnessPresentation(
  value: unknown,
  t: (key: TranslationKey) => string,
): {
  status: P93Freshness['status'] | 'UNKNOWN';
  warning: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: 'UNKNOWN',
      warning: t('p93FreshnessUnknown'),
    };
  }
  const record = value as Record<string, unknown>;
  const status = record.status === 'CURRENT' || record.status === 'STALE' || record.status === 'NEVER_CALCULATED'
    ? record.status
    : 'UNKNOWN';
  if (status === 'CURRENT') return { status, warning: null };
  return {
    status,
    warning: typeof record.message === 'string' && record.message.trim()
      ? record.message
      : t('p93FreshnessUnknown'),
  };
}

export function formatP93Number(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(
      readStoredLocale() === 'zh' ? 'zh-CN' : readStoredLocale() === 'ru' ? 'ru-RU' : 'en-US',
      { maximumFractionDigits: digits },
    )
    : 'N/A';
}
