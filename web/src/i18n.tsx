import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LOCALE_STORAGE_KEY, translateOutOfReact, type Locale, type TranslationKey } from './i18n-dictionary';

export type { Locale, TranslationKey };

/**
 * `t` подставляет `{placeholder}` из params. Раньше каждая строка с подстановкой
 * склеивалась на месте вызова, и один и тот же плейсхолдер жил в двух локалях
 * и в трёх компонентах — карта добавила достаточно таких строк, чтобы это
 * перестало быть терпимым.
 */
type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
};
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY) as Locale | null;
    if (saved && (saved === 'zh' || saved === 'en' || saved === 'ru')) return saved;
    return 'zh';
  });
  useEffect(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
    document.title = translateOutOfReact('appTitle', locale);
  }, [locale]);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, params) => translateOutOfReact(key, locale, params),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is missing');
  return value;
}

const LOCALE_OPTIONS: Array<{ id: Locale; label: string; aria: string }> = [
  { id: 'zh', label: '中文', aria: '切换至简体中文' },
  { id: 'en', label: 'EN', aria: 'Switch to English' },
  { id: 'ru', label: 'RU', aria: 'Переключить на русский' },
];

/** Дорожка 999px с солнечным активным сегментом — обе локали видны сразу,
 *  вместо одной кнопки-тумблера, по которой не понять текущий язык. */
export function LocaleSwitch() {
  const { locale, setLocale } = useI18n();
  return <div className="locale-switch" role="group" aria-label="Language">
    {LOCALE_OPTIONS.map(({ id, label, aria }) => <button
      className={`locale-switch__option${locale === id ? ' locale-switch__option--active' : ''}`}
      type="button"
      key={id}
      aria-label={aria}
      aria-pressed={locale === id}
      onClick={() => setLocale(id)}
    >{label}</button>)}
  </div>;
}
