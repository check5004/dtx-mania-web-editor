// AI を使う準備の「画面のイメージ」（疑似UI）。600×340 の舞台に描き、枠の幅に合わせて縮める。
// 動きは aiGuide.css のキーフレーム（手順ごとに 1 周の長さ --T）。キーフレームを外した見た目（動きを減らす設定）は、
// 番号の付いた説明の場面になるように作る。押す所の番号（①②③）は下の説明の番号と同じ。
// OpenRouter の画面は形だけをまねた絵で、ボタンの名前だけ本物と同じ英語にする（ロゴや画像は使わない）。
import { tr } from '../../i18n';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GuideStep } from '../../store/aiGuide';
import { Icon } from '../icons';

const W = 600;
const H = 340;

/** 枠の幅に合わせて舞台を縮める */
function Fit({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const put = () => setK(el.clientWidth / W || 1);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="aig-fit" role="img" aria-label={label}>
      <div className="aig-stage" style={{ width: W, height: H, transform: `scale(${k})` }} aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

/** 押す所の番号（下の説明の ① ② と同じ）。押す物の左上に付ける */
const Mark = ({ n }: { n: number }) => <span className="gm-mark">{n}</span>;

/** 押したときの輪。at は 1 周のうち押す時（0〜1） */
const Click = ({ at }: { at: number }) => <span className="gm-click" style={{ animationDelay: `calc(var(--T) * ${at})` }} />;

/** マウスの矢印（舞台の座標で動く） */
function Cursor() {
  return (
    <span className="gm-cur">
      <svg width="22" height="22" viewBox="0 0 22 22">
        <path d="M4 2.5 4 17.5 8.2 13.6 11 19.6 13.6 18.4 10.9 12.6 16.6 12.4Z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** ブラウザの枠（上の URL の欄つき） */
function Browser({ url, children }: { url: string; children: ReactNode }) {
  return (
    <div className="gm-win">
      <div className="gm-bar">
        <i />
        <i />
        <i />
        <span className="gm-url">
          <svg width="9" height="10" viewBox="0 0 9 10">
            <rect x="1" y="4.2" width="7" height="5" rx="1" fill="currentColor" />
            <path d="M2.6 4.4V3a1.9 1.9 0 0 1 3.8 0v1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
          {url}
        </span>
      </div>
      <div className="gm-page">{children}</div>
    </div>
  );
}

/** OpenRouter のサイトの左のメニュー（設定のページ） */
function SideNav({ on, mark }: { on: 'credits' | 'keys'; mark?: ReactNode }) {
  return (
    <div className="gm-side">
      <span className="gm-brand">
        <i />
        OpenRouter
      </span>
      {(['Credits', 'Keys', 'Activity', 'Preferences', 'Privacy'] as const).map((x) => (
        <span key={x} className={`gm-side-i ${x.toLowerCase() === on ? 'on' : ''}`}>
          {x}
          {x.toLowerCase() === on && mark}
        </span>
      ))}
    </div>
  );
}

/** 1. OpenRouter って？：このアプリ → OpenRouter → いろいろな会社の AI */
function AboutStage() {
  return (
    <div className="gm-st gm-st-about">
      <svg className="ao-lines" width={W} height={H}>
        <path d="M178 170 H232" />
        <path className="ao-fan m0" d="M368 170 C400 170 400 62 432 62" />
        <path className="ao-fan" d="M368 170 C400 170 400 122 432 122" />
        <path className="ao-fan" d="M368 170 C400 170 400 182 432 182" />
        <path className="ao-fan" d="M368 170 C400 170 400 242 432 242" />
      </svg>
      <div className="ao-app">
        <span className="ao-app-i">{Icon.sparkle(20)}</span>
        <b>DTX Web Editor</b>
        <span className="ao-sub">{tr('あなたのブラウザ', 'Your browser')}</span>
        <span className="ao-key">
          {Icon.key(12)}
          {tr('キー', 'Key')}
        </span>
      </div>
      <div className="ao-hub">
        <b>OpenRouter</b>
        <span className="ao-sub">{tr('AI の窓口', 'One door to many AIs')}</span>
        <span className="ao-bal">
          {tr('残り', 'Credits')}
          <span className="ao-bal-n">
            <span className="ao-bal-a">$5.00</span>
            <span className="ao-bal-b">$4.99</span>
          </span>
        </span>
        <span className="ao-coin">−$0.01</span>
      </div>
      {[
        ['Claude', 'Anthropic'],
        ['GPT', 'OpenAI'],
        ['Gemini', 'Google'],
        [tr('ほか 300 以上', '300+ more'), ''],
      ].map(([n, c], i) => (
        <div key={i} className={`ao-model m${i}`}>
          <b>{n}</b>
          {c && <span>{c}</span>}
        </div>
      ))}
      <span className="ao-dot ao-q">{tr('質問', 'Ask')}</span>
      <span className="ao-dot ao-a">{tr('答え', 'Answer')}</span>
    </div>
  );
}

/** 2. アカウントを作る：右上の Sign up → Google・GitHub・メール */
function AccountStage() {
  return (
    <div className="gm-st gm-st-account">
      <Browser url="openrouter.ai">
        <span className="gm-brand gm-brand-top">
          <i />
          OpenRouter
        </span>
        <span className="gm-nav">
          <span>Models</span>
          <span>Chat</span>
          <span>Rankings</span>
        </span>
        <span className="gm-btn dark ac-signup">
          Sign up
          <Mark n={1} />
          <Click at={0.17} />
        </span>
        <div className="gm-hero">
          <i className="gm-sk w70" />
          <i className="gm-sk w50" />
          <i className="gm-sk w60 thin" />
          <span className="gm-search">
            <i className="gm-sk w40 thin" />
          </span>
        </div>
        <div className="gm-modal ac-modal">
          <b className="gm-h">Sign up</b>
          <span className="gm-btn line ac-google">
            <span className="g">G</span>Continue with Google
            <Mark n={2} />
            <Click at={0.45} />
          </span>
          <span className="gm-btn line ac-github">
            <span className="g gh" />Continue with GitHub
          </span>
          <span className="gm-or">or</span>
          <span className="gm-field ac-email">Email address</span>
        </div>
        <div className="gm-modal ac-done">
          <span className="gm-ok">{Icon.check(22)}</span>
          <b className="gm-h">Welcome!</b>
          <i className="gm-sk w60 thin" />
        </div>
      </Browser>
      <Cursor />
    </div>
  );
}

/** 3. クレジットを入れる：Credits → Add Credits → $5 → Purchase → 残高 $5 */
function CreditsStage() {
  return (
    <div className="gm-st gm-st-credits">
      <Browser url="openrouter.ai/settings/credits">
        <SideNav on="credits" mark={<><Mark n={1} /><Click at={0.1} /></>} />
        <b className="gm-title">Credits</b>
        <div className="gm-card cr-bal">
          <span className="gm-lbl">Balance</span>
          <span className="cr-amt">
            <span className="cr-a">$0.00</span>
            <span className="cr-b">$5.00</span>
          </span>
        </div>
        <span className="gm-btn dark cr-add">
          Add Credits
          <Mark n={2} />
          <Click at={0.25} />
        </span>
        <div className="gm-card cr-auto">
          <span className="gm-lbl">Auto Top-Up</span>
          <span className="gm-toggle" />
        </div>
        <div className="gm-modal cr-modal">
          <b className="gm-h">Add credits</b>
          <span className="gm-lbl cr-l-amt">Amount</span>
          <span className="gm-field val cr-f-amt">
            $<span className="cr-type">5</span>
          </span>
          <span className="gm-row cr-fee">
            <span>Fee</span>
            <span>$0.80</span>
          </span>
          <span className="gm-row cr-total">
            <b>Total</b>
            <b>$5.80</b>
          </span>
          <span className="gm-field cr-card">VISA •••• 4242</span>
          <span className="gm-btn dark cr-buy">
            Purchase
            <Mark n={3} />
            <Click at={0.55} />
          </span>
        </div>
      </Browser>
      <Cursor />
    </div>
  );
}

/** 4. キーを作る：Keys → Create → 名前・上限 → Create → Copy */
function KeyStage() {
  return (
    <div className="gm-st gm-st-key">
      <Browser url="openrouter.ai/settings/keys">
        <SideNav on="keys" />
        <b className="gm-title">API Keys</b>
        <span className="gm-btn dark ky-create">
          Create
          <Mark n={1} />
          <Click at={0.1} />
        </span>
        <div className="gm-table">
          <span className="gm-th">
            <span>Name</span>
            <span>Key</span>
            <span>Limit</span>
          </span>
          <span className="gm-tr ky-row">
            <span>DTX Web Editor</span>
            <span className="mono">sk-or-v1-•••3f2a</span>
            <span>$5</span>
          </span>
        </div>
        <div className="gm-modal ky-modal">
          <b className="gm-h">Create API Key</b>
          <span className="gm-lbl ky-l-name">Name</span>
          <span className="gm-field val ky-f-name">
            <span className="ky-type-name">DTX Web Editor</span>
          </span>
          <span className="gm-lbl ky-l-limit">Credit limit (optional)</span>
          <span className="gm-field val ky-f-limit">
            $<span className="ky-type-limit">5</span>
            <Mark n={2} />
          </span>
          <span className="gm-btn dark ky-ok">
            Create
            <Click at={0.47} />
          </span>
        </div>
        <div className="gm-modal ky-reveal">
          <b className="gm-h">Your new API key</b>
          <span className="ky-keybox">
            <span className="mono">sk-or-v1-••••••••••••••••3f2a</span>
            <span className="gm-btn line ky-copy">
              Copy
              <Mark n={3} />
              <Click at={0.64} />
            </span>
          </span>
          <span className="ky-warn">⚠ You won’t be able to see this key again</span>
          <span className="ky-copied">✓ Copied</span>
        </div>
      </Browser>
      <Cursor />
    </div>
  );
}

/** 5. このアプリに貼る：貼る → つないで確かめる → つながった・AI の機能が使えるように */
function PasteStage() {
  return (
    <div className="gm-st gm-st-paste">
      <div className="pa-card">
        <span className="pa-h">
          <span className="ai-spark">{Icon.sparkle(13)}</span>
          {tr('AI を使う準備', 'Set up AI')}
        </span>
        <span className="pa-lbl">{tr('OpenRouter のキー', 'OpenRouter key')}</span>
        <span className="pa-field">
          <span className="pa-ph">sk-or-v1-…</span>
          <span className="pa-dots">••••••••••••••••••••••••••••</span>
          <Mark n={1} />
          <Click at={0.12} />
        </span>
        <span className="pa-kbd">
          <kbd>Ctrl</kbd>+<kbd>V</kbd>
        </span>
        <span className="pa-btn">
          {tr('つないで確かめる', 'Connect and check')}
          <Mark n={2} />
          <Click at={0.42} />
        </span>
        <span className="pa-st pa-wait">{tr('確かめています…', 'Checking…')}</span>
        <span className="pa-st pa-ok">{tr('● つながりました', '● Connected')}</span>
      </div>
      <div className="pa-feats">
        {[tr('小節の AI 案', 'AI measure ideas'), tr('AIに聞く', 'Ask AI'), tr('AI のレベル判定', 'AI level rating'), tr('曲情報の Web 検索', 'Web song lookup')].map((x, i) => (
          <span key={i} className={`pa-feat f${i}`}>
            <span className="pa-lock">{Icon.key(11)}</span>
            <span className="pa-spark">{Icon.sparkle(11)}</span>
            {x}
          </span>
        ))}
      </div>
      <Cursor />
    </div>
  );
}

/** 手順ごとの画面のイメージ。play が変わると頭から流し直す */
export function GuideStage({ step, play }: { step: GuideStep; play: number }) {
  if (step === 'care') return null;
  const label = {
    about: tr('このアプリから OpenRouter を通して、いろいろな会社の AI に質問が届き、答えが返る図', 'Diagram: questions go from this app through OpenRouter to AIs from many companies, and answers come back'),
    account: tr('OpenRouter のサイトの右上の Sign up を押し、Google で登録する画面のイメージ', 'Illustration: pressing Sign up at the top right of the OpenRouter site and signing up with Google'),
    credits: tr('Credits のページで Add Credits を押し、$5 を入れて Purchase を押すと、残高が $5 になる画面のイメージ', 'Illustration: on the Credits page, Add Credits, enter $5, Purchase, and the balance becomes $5'),
    key: tr('Keys のページで Create を押し、名前と上限を入れて作り、出てきたキーを Copy する画面のイメージ', 'Illustration: on the Keys page, Create, enter a name and limit, then Copy the key that appears'),
    paste: tr('このアプリにキーを貼り、つないで確かめると、AI の機能が使えるようになるイメージ', 'Illustration: paste the key into this app, connect, and the AI features become available'),
  }[step];
  const inner = step === 'about' ? <AboutStage /> : step === 'account' ? <AccountStage /> : step === 'credits' ? <CreditsStage /> : step === 'key' ? <KeyStage /> : <PasteStage />;
  return (
    <Fit key={`${step}-${play}`} label={label}>
      {inner}
    </Fit>
  );
}
