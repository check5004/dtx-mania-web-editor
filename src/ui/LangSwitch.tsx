// 画面の言語の切り替え（English / 日本語）。どちらの言語の画面でも、言語の名前はその言語自身で書く。
import { LANG_NAMES, setLang, type Lang } from '../i18n';
import { useLang } from '../i18n/useLang';

export function LangSwitch({ small }: { small?: boolean }) {
  const lang = useLang();
  return (
    <div className={`seg lang-switch ${small ? 'small' : ''}`} role="group" aria-label="Language / 言語" title="Language / 言語">
      {(['en', 'ja'] as Lang[]).map((l) => (
        <button key={l} className={lang === l ? 'on' : ''} aria-pressed={lang === l} onClick={() => setLang(l)} lang={l}>
          {LANG_NAMES[l]}
        </button>
      ))}
    </div>
  );
}
