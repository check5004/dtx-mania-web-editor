// AI を使う準備（OpenRouter のはじめかた）の小窓。OpenRouter って？ → アカウント → クレジット → キー → 貼る → 気をつけること。
// エンジニアでない人にも分かるように、手順ごとに画面のイメージ（Stages.tsx の疑似UI と動き）と、番号つきの短い説明を並べる。
// 「貼る」の手順は本物のキーの欄で、ここでつないで確かめて終われる（ホームからでも開ける）。
import { tr, isJa } from '../../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { aiFeatures, keyFreeFeatures } from '../../ai/features';
import { formatUsd } from '../../ai/tasks';
import { checkKey, setKey, setRemember, taskCostEstimate, useAi } from '../../store/ai';
import { closeAiGuide, GUIDE_STEPS, replayGuide, setGuideStep, stepGuide, useAiGuide, type GuideStep } from '../../store/aiGuide';
import { useDevice } from '../../store/device';
import { openSettings, useEditor } from '../../store/editor';
import { Icon } from '../icons';
import { costText, JPY_PER_USD } from './KeyGate';
import { GuideStage } from './Stages';
import './aiGuide.css';

const URLS = {
  home: 'https://openrouter.ai/',
  credits: 'https://openrouter.ai/settings/credits',
  keys: 'https://openrouter.ai/settings/keys',
  activity: 'https://openrouter.ai/activity',
};

/** 手順の名前（左の一覧・上の点） */
function stepName(s: GuideStep): string {
  return {
    about: tr('OpenRouter って？', 'What is OpenRouter?'),
    account: tr('アカウントを作る', 'Create an account'),
    credits: tr('クレジットを入れる', 'Add credits'),
    key: tr('キーを作る', 'Create a key'),
    paste: tr('ここに貼る', 'Paste it here'),
    care: tr('気をつけること', 'Good to know'),
  }[s];
}

export function AiGuideHost() {
  const open = useAiGuide((s) => s.open);
  return open ? <AiGuide /> : null;
}

function AiGuide() {
  const step = useAiGuide((s) => s.step);
  const play = useAiGuide((s) => s.play);
  const from = useAiGuide((s) => s.from);
  const phone = useDevice((s) => s.phone);
  const tablet = useDevice((s) => s.tablet);
  const keyOk = useAi((s) => s.keyStatus === 'ok');
  const i = GUIDE_STEPS.indexOf(step);
  const mainRef = useRef<HTMLDivElement>(null);
  const fromFeature = from ? aiFeatures().find((f) => f.id === from) : undefined;

  // Esc で閉じる・← → で手順（文字を入れているときは動かさない）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeAiGuide();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.stopPropagation();
        e.preventDefault();
        stepGuide(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // 手順を変えたら上から読む
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [step]);

  const last = i === GUIDE_STEPS.length - 1;
  return (
    <div className="modal-back aig-back" onMouseDown={(e) => e.target === e.currentTarget && closeAiGuide()}>
      <div className={`aig ${phone ? 'phone' : tablet ? 'tablet' : ''}`} role="dialog" aria-modal="true" aria-labelledby="aig-title">
        <header className="aig-head">
          <span className="aig-head-i">{Icon.sparkle(phone ? 16 : 18)}</span>
          <span className="aig-titles">
            <h2 id="aig-title">{tr('AI を使う準備', 'Set up AI')}</h2>
            <span className="lbl ellipsis">
              {fromFeature
                ? tr(`「${fromFeature.locked}」を使えるようにする · OpenRouter のはじめかた`, `To use “${fromFeature.locked}” · Getting started with OpenRouter`)
                : tr('OpenRouter のはじめかた · 約 5 分', 'Getting started with OpenRouter · about 5 min')}
            </span>
          </span>
          <button className={phone ? 'p-ib sm' : 'ib'} onClick={closeAiGuide} aria-label={tr('閉じる', 'Close')} title={tr('閉じる（Esc）', 'Close (Esc)')}>
            {Icon.close(phone ? 18 : 16)}
          </button>
        </header>
        <div className="aig-body">
          <nav className="aig-rail" aria-label={tr('手順', 'Steps')}>
            {GUIDE_STEPS.map((s, n) => (
              <button key={s} className={`aig-rail-i ${s === step ? 'on' : ''} ${s === 'paste' && keyOk ? 'done' : ''}`} onClick={() => setGuideStep(s)} aria-current={s === step ? 'step' : undefined}>
                <span className="aig-num">{s === 'paste' && keyOk ? Icon.check(12) : n + 1}</span>
                <span className="aig-rail-t">{stepName(s)}</span>
              </button>
            ))}
            <span className="grow" />
            <p className="lbl aig-rail-note">{tr('画面はイメージです。実際の OpenRouter の画面とは少し違うことがあります。', 'Screens are illustrations. The real OpenRouter site may look a little different.')}</p>
          </nav>
          <div className="aig-main scroll" ref={mainRef}>
            <div className="aig-step-head">
              <span className="aig-step-n mono">
                {i + 1} / {GUIDE_STEPS.length}
              </span>
              <h3>{stepName(step)}</h3>
            </div>
            {step !== 'care' && (
              <div className={`aig-stage-wrap ${step}`}>
                <GuideStage step={step} play={play} />
                <button className="aig-replay" onClick={replayGuide} title={tr('動きをもう一度', 'Play again')} aria-label={tr('動きをもう一度', 'Play again')}>
                  {Icon.refresh(13)}
                </button>
              </div>
            )}
            <div className="aig-text">
              {step === 'about' && <AboutText />}
              {step === 'account' && <AccountText />}
              {step === 'credits' && <CreditsText />}
              {step === 'key' && <KeyText />}
              {step === 'paste' && <PasteText />}
              {step === 'care' && <CareText />}
            </div>
          </div>
        </div>
        <footer className="aig-foot">
          <span className="aig-dots" aria-hidden="true">
            {GUIDE_STEPS.map((s) => (
              <i key={s} className={s === step ? 'on' : ''} />
            ))}
          </span>
          <span className="grow" />
          {i > 0 && (
            <button className="btn ghost" onClick={() => stepGuide(-1)}>
              {Icon.chevronLeft(14)}
              {tr('戻る', 'Back')}
            </button>
          )}
          {last ? (
            <button className="btn primary" onClick={closeAiGuide}>
              {tr('閉じる', 'Close')}
            </button>
          ) : (
            <button className="btn primary" onClick={() => stepGuide(1)}>
              {step === 'paste' && !keyOk ? tr('あとで貼る', 'Paste later') : tr(`次へ: ${stepName(GUIDE_STEPS[i + 1])}`, `Next: ${stepName(GUIDE_STEPS[i + 1])}`)}
              {Icon.chevronRight(14)}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 外のサイトを新しいタブで開くリンク */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="btn small aig-ext" href={href} target="_blank" rel="noreferrer">
      {children}
      {Icon.external(13)}
    </a>
  );
}

/** 画面のイメージの番号と同じ番号の説明 */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="aig-steps">
      {items.map((x, n) => (
        <li key={n}>
          <span className="gm-mark static">{n + 1}</span>
          <span>{x}</span>
        </li>
      ))}
    </ol>
  );
}

function AboutText() {
  return (
    <>
      <p className="aig-lead">
        {tr(
          'このアプリの AI の機能は、OpenRouter（オープンルーター）というサービスを通して、Claude や GPT などの AI に頼んでいます。使うには、OpenRouter の「キー」（合い言葉のような長い文字）をこのアプリに入れます。',
          'The AI features in this app ask AIs such as Claude and GPT through a service called OpenRouter. To use them, you put an OpenRouter “key” (a long password-like string) into this app.',
        )}
      </p>
      <ul className="aig-points">
        <li>
          <b>{tr('いろいろな会社の AI の窓口', 'One door to many AIs')}</b>
          {tr('1 つのアカウントと 1 つのキーで、いろいろな会社の AI を使えます。', 'One account and one key work with AIs from many companies.')}
        </li>
        <li>
          <b>{tr('前払いで、使った分だけ', 'Prepaid, pay as you go')}</b>
          {tr('先にクレジット（残高）を入れて、AI を使うたびに少しずつ減ります。月額の料金はありません。', 'You add credits first, and each use takes a little. There is no monthly fee.')}
        </li>
        <li>
          <b>{tr('キーはあなたのブラウザの中だけ', 'Your key stays in your browser')}</b>
          {tr('このアプリにはサーバーがありません。キーはこのブラウザから OpenRouter に直接送ります。', 'This app has no server. The key goes from this browser straight to OpenRouter.')}
        </li>
        <li>
          <b>{tr('準備は 4 ステップ・5 分ほど', '4 steps, about 5 minutes')}</b>
          {tr('メールアドレス（Google や GitHub のアカウントでも）とクレジットカードを用意してください。サイトは英語です。', "You'll need an email address (or a Google or GitHub account) and a credit card. The site is in English.")}
        </li>
      </ul>
      <FeatureLists />
    </>
  );
}

/** キーで増えること・キーが無くてもできること */
function FeatureLists() {
  return (
    <div className="aig-two">
      <section className="aig-box ai">
        <h4>
          <span className="ai-spark">{Icon.sparkle(12)}</span>
          {tr('キーを入れると増えること', 'What a key adds')}
        </h4>
        <ul>
          {aiFeatures().map((f) => (
            <li key={f.id}>
              <b>{f.name}</b>
              <span>{f.withKey}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="aig-box free">
        <h4>
          {Icon.check(13)}
          {tr('キーが無くても使えること', 'Works without a key')}
        </h4>
        <p>{tr('AI 以外の機能は、すべてキー無しで使えます。AI の機能も、キーが無いときはルールで作る・写すなどの形で動きます。', 'Everything except the AI works without a key. The AI features also work without one, by rules or by copying.')}</p>
        <ul className="aig-chips">
          {keyFreeFeatures().map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="lbl">{tr('これらはあなたのブラウザの中で動くので、キーも料金も要りません。', 'These run inside your browser, so they need no key and cost nothing.')}</p>
      </section>
    </div>
  );
}

function AccountText() {
  return (
    <>
      <Steps
        items={[
          tr('openrouter.ai を開き、右上の「Sign up」を押します。', 'Open openrouter.ai and press “Sign up” at the top right.'),
          tr('Google か GitHub のアカウント、またはメールアドレスで登録します。アカウントを作るのは無料です。', 'Sign up with a Google or GitHub account, or with an email address. Creating an account is free.'),
        ]}
      />
      <div className="aig-row">
        <Ext href={URLS.home}>{tr('openrouter.ai を開く', 'Open openrouter.ai')}</Ext>
        <span className="lbl">{tr('新しいタブで開きます。この案内は開いたままにしておけます。', 'Opens in a new tab. You can keep this guide open.')}</span>
      </div>
    </>
  );
}

function CreditsText() {
  const tasks = useAi((s) => s.tasks);
  void tasks;
  const rows: { name: string; usd: number | null; per?: string }[] = [
    { name: tr('小節の AI 案', 'AI measure ideas'), usd: taskCostEstimate('measure') },
    { name: tr('TAB補完の「AIに聞く」・フレーズ候補', 'Ask AI in Tab completion, phrase ideas'), usd: taskCostEstimate('phrase') },
    { name: tr('AI のレベル判定', 'AI level rating'), usd: taskCostEstimate('level') },
    { name: tr('曲情報を Web 検索で調べる', 'Song info web lookup'), usd: taskCostEstimate('songinfo') },
    { name: tr('AI難易度生成（1 つの難易度）', 'AI difficulty plan (one difficulty)'), usd: taskCostEstimate('difficulty') },
  ];
  return (
    <>
      <Steps
        items={[
          tr('「Credits」のページを開きます（右上のメニューから。下のボタンでも開けます）。', 'Open the “Credits” page (from the menu at the top right, or with the button below).'),
          tr('「Add Credits」を押し、金額を入れます。はじめは $5（いちばん少ない額）で十分です。', 'Press “Add Credits” and enter an amount. $5 (the smallest amount) is plenty to start.'),
          tr(
            'カードで「Purchase」。手数料 5.5%（最低 $0.80）が足されるので、$5 なら $5.80 の支払いです。',
            'Pay by card with “Purchase”. A 5.5% fee (at least $0.80) is added, so $5 costs $5.80.',
          ),
        ]}
      />
      <div className="aig-row">
        <Ext href={URLS.credits}>{tr('Credits のページを開く', 'Open the Credits page')}</Ext>
      </div>
      <section className="aig-box">
        <h4>{tr('$5 でどのくらい使える？（1 回の目安）', 'How far does $5 go? (per use)')}</h4>
        <table className="aig-cost">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="mono-num">{costText(r.usd)}</td>
                <td className="mono-num lbl">{r.usd ? tr(`$5 で約 ${Math.floor(5 / r.usd).toLocaleString()} 回`, `~${Math.floor(5 / r.usd).toLocaleString()} uses per $5`) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="lbl">
          {isJa()
            ? `いまのモデルの料金からの多めの見積もりです（円は 1 ドル ${JPY_PER_USD} 円で計算）。モデルは「設定 › AI」で変えられます。`
            : 'Generous estimates from the current models’ prices. You can change the models in Settings › AI.'}
        </p>
      </section>
      <ul className="aig-notes">
        <li>{tr('自動チャージ（Auto Top-Up）は入れなくて大丈夫です。', 'You don’t need to turn on Auto Top-Up.')}</li>
        <li>{tr('使わなかったクレジットは、買ってから 1 年たつと消えることがあります。買ってから 24 時間以内なら、Credits のページから返金できます。', 'Unused credits can expire one year after purchase. Within 24 hours of buying, you can get a refund from the Credits page.')}</li>
      </ul>
    </>
  );
}

function KeyText() {
  return (
    <>
      <Steps
        items={[
          tr('「Keys」のページを開き（右上のメニューから。下のボタンでも開けます）、「Create」（Create API Key）を押します。', 'Open the “Keys” page (from the menu at the top right, or with the button below) and press “Create” (Create API Key).'),
          tr(
            '名前（Name）は何でもかまいません（例: DTX Web Editor）。「Credit limit」（このキーで使える上限）に $5 などを入れておくと、使いすぎを防げます。',
            'Any name is fine (e.g. DTX Web Editor). Put something like $5 in “Credit limit” (the most this key can spend) to avoid overspending.',
          ),
          tr(
            '「Create」を押すと、sk-or-v1- で始まる長いキーが出ます。この画面を閉じると二度と見られないので、すぐに「Copy」してください。',
            'Press “Create” and a long key starting with sk-or-v1- appears. It is shown only once, so press “Copy” right away.',
          ),
        ]}
      />
      <div className="aig-row">
        <Ext href={URLS.keys}>{tr('Keys のページを開く', 'Open the Keys page')}</Ext>
      </div>
      <ul className="aig-notes">
        <li>{tr('キーをなくしても大丈夫です。新しいキーを作って、古いキーは消してください。', 'If you lose the key, that’s fine: make a new one and delete the old one.')}</li>
        <li>{tr('キーはパスワードと同じです。メモに残すなら、人に見られない所に。', 'Treat the key like a password. If you write it down, keep it where no one else can see it.')}</li>
      </ul>
    </>
  );
}

function PasteText() {
  const status = useAi((s) => s.keyStatus);
  return (
    <>
      <Steps
        items={[
          tr('コピーしたキーを、下の欄に貼り付けます（Ctrl+V、Mac は ⌘V、スマホは長押しで「ペースト」）。', 'Paste the key into the box below (Ctrl+V, ⌘V on a Mac, or long-press and Paste on a phone).'),
          tr('「つないで確かめる」を押します。「つながりました」と出れば準備はおしまいです。', 'Press “Connect and check”. When it says “Connected”, you’re all set.'),
        ]}
      />
      <KeyForm />
      {status === 'ok' && <Ready />}
    </>
  );
}

/** 本物のキーの欄（設定 › AI と同じ所に保存する） */
function KeyForm() {
  const key = useAi((s) => s.key);
  const remember = useAi((s) => s.remember);
  const [draft, setDraft] = useState(key);
  const [show, setShow] = useState(false);
  useEffect(() => setDraft(key), [key]);
  // 入っているキーは開いたときに確かめ直す
  useEffect(() => {
    const s = useAi.getState();
    if (s.key && s.keyStatus !== 'ok') void checkKey();
  }, []);
  const d = draft.trim();
  const submit = () => (d !== key ? setKey(d) : void checkKey());
  return (
    <section className="aig-form">
      <label className="aig-form-l" htmlFor="aig-key">
        {tr('OpenRouter のキー', 'OpenRouter key')}
      </label>
      <div className="aig-key-row">
        <input
          id="aig-key"
          className="field mono"
          type={show ? 'text' : 'password'}
          value={draft}
          placeholder="sk-or-v1-…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            // 貼ったらすぐ確かめる
            const t = e.clipboardData.getData('text').trim();
            if (!t) return;
            e.preventDefault();
            setDraft(t);
            setKey(t);
          }}
          onKeyDown={(e) => e.key === 'Enter' && d && submit()}
        />
        <button className="btn small ghost" onClick={() => setShow(!show)} title={tr('キーを表示する・隠す', 'Show or hide the key')}>
          {show ? tr('隠す', 'Hide') : tr('表示', 'Show')}
        </button>
        <button className="btn small primary" onClick={submit} disabled={!d}>
          {tr('つないで確かめる', 'Connect and check')}
        </button>
      </div>
      {d && !/^sk-or-/i.test(d) && <p className="aig-warn">{tr('OpenRouter のキーは「sk-or-」で始まります。別の物を貼っていないか確かめてください。', 'OpenRouter keys start with “sk-or-”. Check that you pasted the right thing.')}</p>}
      <KeyStatus />
      <div className="aig-radios">
        <label>
          <input type="radio" checked={remember} onChange={() => setRemember(true)} />
          {tr('このブラウザに保存する', 'Save in this browser')}
        </label>
        <label>
          <input type="radio" checked={!remember} onChange={() => setRemember(false)} />
          {tr('保存しない（タブを閉じたら消す）', "Don't save (cleared when the tab closes)")}
        </label>
      </div>
      <p className="lbl">{tr('共用の PC では「保存しない」を選んでください。キーは暗号化されずにこのブラウザに置かれます。', 'On a shared PC, choose “Don’t save”. The key is kept in this browser without encryption.')}</p>
    </section>
  );
}

function KeyStatus() {
  const status = useAi((s) => s.keyStatus);
  const err = useAi((s) => s.keyError);
  const code = useAi((s) => s.keyErrorCode);
  const info = useAi((s) => s.keyInfo);
  if (status === 'none') return null;
  if (status === 'checking')
    return (
      <p className="aig-status">
        <span className="spin" style={{ width: 12, height: 12 }} />
        {tr('確かめています…', 'Checking…')}
      </p>
    );
  if (status === 'error') {
    const hint =
      code === 401
        ? tr('sk-or-v1- から最後までコピーできているか確かめて、もう一度貼ってください。消したキーは使えません。', 'Check that you copied everything from sk-or-v1- to the end, and paste it again. Deleted keys don’t work.')
        : code === 402
          ? tr('クレジットが足りません。「3. クレジットを入れる」を見てください。', 'Not enough credits. See “3. Add credits”.')
          : code === 0
            ? tr('ネットにつながっているか確かめてください。', 'Check your internet connection.')
            : '';
    return (
      <div className="aig-status err">
        <b>{tr('つながりませんでした', "Couldn't connect")}</b>
        {err && <span>{err}</span>}
        {hint && <span>{hint}</span>}
      </div>
    );
  }
  return (
    <div className="aig-status ok">
      <b>{tr('● つながりました', '● Connected')}</b>
      {info && (
        <span className="mono-num">
          {info.limit === null ? tr('このキーの上限: なし', 'Key limit: none') : tr(`このキーの残り上限: ${formatUsd(info.limitRemaining)}`, `Key limit left: ${formatUsd(info.limitRemaining)}`)}
        </span>
      )}
      {info?.isFree && (
        <span className="aig-warn">
          {tr(
            'まだクレジットを買っていないようです。おすすめのモデルは有料なので、「3. クレジットを入れる」で $5 ほど入れてください。',
            'It looks like you haven’t bought credits yet. The recommended models are paid, so add about $5 in “3. Add credits”.',
          )}
        </span>
      )}
    </div>
  );
}

/** つながったあと：使えるようになったこと */
function Ready() {
  const inEditor = useEditor((s) => s.screen === 'editor');
  return (
    <section className="aig-ready">
      <span className="aig-ready-i">{Icon.checkCircle(26)}</span>
      <div className="grow">
        <b>{tr('準備ができました', 'You’re all set')}</b>
        <p>{tr('これで AI の機能が使えます。ボタンの鍵の印は消えています。', 'The AI features are ready. The key marks on the buttons are gone.')}</p>
        <ul className="aig-chips on">
          {aiFeatures().map((f) => (
            <li key={f.id}>
              {Icon.sparkle(11)}
              {f.name}
            </li>
          ))}
        </ul>
        {inEditor && (
          <button
            className="link-btn"
            onClick={() => {
              closeAiGuide();
              openSettings('ai');
            }}
          >
            {tr('モデルや使いすぎの上限を見る（設定 › AI）', 'See models and spending limits (Settings › AI)')}
          </button>
        )}
      </div>
    </section>
  );
}

function CareText() {
  const confirmOver = useAi((s) => s.confirmOver);
  const cap = useAi((s) => s.monthlyCap);
  return (
    <div className="aig-cards">
      <section className="aig-card">
        <h4>
          <span className="aig-card-i money">$</span>
          {tr('料金の守り', 'Keeping costs safe')}
        </h4>
        <ul>
          <li>{tr('AI を使うたびに、クレジットが少しずつ減ります。1 回の目安は「3. クレジットを入れる」の表と「設定 › AI」で見られます。', 'Each use takes a little from your credits. See the estimates per use in “3. Add credits” and in Settings › AI.')}</li>
          <li>
            {tr(
              `このアプリは、1 回の目安が ${formatUsd(confirmOver)} を超えると先に聞き、今月 ${formatUsd(cap)} 使ったら止めます（設定 › AI で変えられます）。`,
              `This app asks first when a use is estimated above ${formatUsd(confirmOver)}, and stops after ${formatUsd(cap)} this month (change it in Settings › AI).`,
            )}
          </li>
          <li>{tr('キーの「Credit limit」を入れておけば、OpenRouter の側でも止まります（二重の守り）。', 'A “Credit limit” on the key stops it on OpenRouter’s side too (a second safety net).')}</li>
        </ul>
      </section>
      <section className="aig-card">
        <h4>
          <span className="aig-card-i key">{Icon.key(14)}</span>
          {tr('キーはパスワードと同じ', 'Treat the key like a password')}
        </h4>
        <ul>
          <li>{tr('人に見せない。SNS や画面写真に写さない。', 'Don’t show it to anyone, or let it appear in posts or screenshots.')}</li>
          <li>{tr('キーは暗号化されずにこのブラウザに保存されます。共用の PC では「保存しない」を選んでください。', 'The key is saved in this browser without encryption. On a shared PC, choose “Don’t save”.')}</li>
          <li>{tr('漏れたかもしれないときは、OpenRouter の Keys でそのキーを消して（Delete）、新しく作り直します。', 'If it may have leaked, delete it in OpenRouter’s Keys and make a new one.')}</li>
        </ul>
      </section>
      <section className="aig-card">
        <h4>
          <span className="aig-card-i send">{Icon.shield(14)}</span>
          {tr('AI に送るもの', 'What is sent to the AI')}
        </h4>
        <ul>
          <li>{tr('音そのものは送りません。譜面の特徴・チップの並び・原曲の打点の数値・曲名などだけです。', 'Audio is never sent. Only chart features, chip lists, hit-strength numbers from the original, song titles and the like.')}</li>
          <li>{tr('OpenRouter は、送った中身（質問と答え）を、初めの設定のままなら記録しません。', 'With its default settings, OpenRouter does not log what you send (the questions and answers).')}</li>
        </ul>
      </section>
      <section className="aig-card">
        <h4>
          <span className="aig-card-i free">0</span>
          {tr('無料のモデルについて', 'About free models')}
        </h4>
        <ul>
          <li>{tr('OpenRouter には無料のモデルもありますが、1 日 50 回までなどの制限があり、このアプリの処理には合わないことがあります。おすすめのモデルのままが安心です。', 'OpenRouter has free models too, but they have limits such as 50 uses a day and may not suit this app’s tasks. The recommended models are the safe choice.')}</li>
        </ul>
      </section>
      <section className="aig-card wide">
        <h4>
          <span className="aig-card-i">{Icon.chart(14)}</span>
          {tr('使った額を見る', 'See what you spent')}
        </h4>
        <ul>
          <li>{tr('このアプリで使った額は「設定 › AI」、キーごとの細かい記録は OpenRouter の Activity で見られます。', 'This app’s spending is in Settings › AI; detailed records per key are in OpenRouter’s Activity.')}</li>
        </ul>
        <div className="aig-row">
          <Ext href={URLS.activity}>{tr('Activity を開く', 'Open Activity')}</Ext>
        </div>
      </section>
    </div>
  );
}
