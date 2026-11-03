// 画面の言語（日本語・US英語）。初めて開いたときは英語。選んだ言語はこのブラウザに覚える。
//
// 書き方: 画面に出す文は tr('日本語', 'English') で両方をその場に書く（辞書ファイルは作らない）。
// 数を含む文はテンプレート文字列で両方を書き、英語の単数・複数は pl() で分ける。
// モジュールの読み込み時に決まる定数（レーン名など）は、getter や関数にして、表示するときに tr を呼ぶ。
export type Lang = 'en' | 'ja';

const KEY = 'dtxe.lang';

function initialLang(): Lang {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v === 'ja' || v === 'en') return v;
  } catch {
    // 保存できない環境（プライベートモードなど）は英語
  }
  return 'en';
}

let current: Lang = initialLang();

const listeners = new Set<() => void>();

/** 言語が変わったら呼ばれる（React では useLang()。ワーカーでも読めるよう React に依存しない） */
export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function applyDocumentLang(l: Lang) {
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}
applyDocumentLang(current);

export function getLang(): Lang {
  return current;
}

export function isJa(): boolean {
  return current === 'ja';
}

/** 言語を切り替える。保存は既定で行う（テストでは save=false） */
export function setLang(l: Lang, save = true): void {
  if (l === current) return;
  current = l;
  if (save) {
    try {
      globalThis.localStorage?.setItem(KEY, l);
    } catch {
      // 覚えられなくても切り替えは効く
    }
  }
  applyDocumentLang(l);
  for (const fn of [...listeners]) fn();
}

/** 今の言語の文を返す */
export function tr(ja: string, en: string): string {
  return current === 'ja' ? ja : en;
}

/**
 * モジュールの読み込み時に作る定数（一覧の名前・説明など）に、表示のたびに今の言語の文を返す getter を付ける。
 * 例: withTr({ id: 'all' }, { label: ['全部', 'All'] })。関数を渡すとその値を返す。
 */
export function withTr<T extends object>(o: T, texts: Record<string, readonly [string, string] | (() => string) | undefined>): T {
  for (const [k, v] of Object.entries(texts)) {
    if (!v) continue;
    Object.defineProperty(o, k, { get: typeof v === 'function' ? v : () => tr(v[0], v[1]), enumerable: true, configurable: true });
  }
  return o;
}

/** 英語の単数・複数（日本語では使わない） */
export function pl(n: number, one: string, many: string = `${one}s`): string {
  return Math.abs(n) === 1 ? one : many;
}

/** 日付・時刻の表示に使うロケール */
export function locale(): string {
  return current === 'ja' ? 'ja-JP' : 'en-US';
}

/** 言語の名前（その言語自身での表記。どちらの言語の画面でも同じ） */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ja: '日本語' };

/**
 * AI に、ユーザーが読む文をどの言語で書くかを伝える1行（システムプロンプトの末尾に足す）。
 * プロンプト本文は日本語のままでよいが、答えの文は画面の言語に合わせる。
 */
export function aiLangRule(): string {
  return current === 'ja'
    ? '【出力の言語】ユーザーが読む文（名前・理由・コメント・メモ・途中経過など）はすべて日本語で書く。'
    : '[Output language] Write every piece of text the user will read (names, reasons, comments, notes, progress lines, etc.) in natural US English, even though these instructions are in Japanese. Keep proper nouns such as song titles and artist names in their official spelling.';
}

/** AI への指示の中で「〇〇語で」と言う所に入れる語（例: `${aiLangName()}で短く`） */
export function aiLangName(): string {
  return current === 'ja' ? '日本語' : '英語（US English）';
}

/**
 * AI への字数の指示（JSON Schema の説明などに入れる）。英語は同じ内容で日本語の約2.5倍の文字数になるので、上限もそのぶん広げる。
 * 例: `短い名前（${aiTextLimit(12)}）` → 「日本語で12字以内」/「US English で30文字以内」
 */
export function aiTextLimit(jaChars: number): string {
  return current === 'ja' ? `日本語で${jaChars}字以内` : `US English で${Math.round(jaChars * 2.5)}文字以内`; // i18n-ignore
}
