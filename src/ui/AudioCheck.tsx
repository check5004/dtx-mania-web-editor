// 設定の「音の出力」：音が出ないときの確認用。出力の様子、テスト音、出力の作り直し、読める音の形式。
// Safari・iPad は実機で確かめられていないので、ここで分かることを画面に出す（docs/safari.md）
import { useEffect, useState } from 'react';
import { engine, type OutputStatus } from '../audio/engine';
import { probeFormats, type FormatResult } from '../audio/formatProbe';
import { tr } from '../i18n';
import { browserLabel, IS_IOS, IS_WEBKIT, iosName } from '../platform';
import { isStandalone } from '../pwa/display';

function stateLabel(s: OutputStatus): { text: string; ok: boolean } {
  if (!s.created) return { text: tr('まだ作っていません（▶ やテスト音で作ります）', 'Not created yet (▶ or the test tone creates it)'), ok: true };
  switch (s.state) {
    case 'running':
      return { text: tr('動いています', 'Running'), ok: true };
    case 'suspended':
      return { text: tr('止まっています（画面をタップすると起こします）', 'Suspended (tap the screen to wake it)'), ok: false };
    case 'interrupted':
      return { text: tr('ほかの音に中断されています（画面をタップすると起こします）', 'Interrupted by other audio (tap the screen to wake it)'), ok: false };
    case 'closed':
      return { text: tr('閉じています（▶ で作り直します）', 'Closed (▶ creates a new one)'), ok: false };
    default:
      return { text: String(s.state), ok: false };
  }
}

const ms = (sec: number | null) => (sec === null ? '—' : `${Math.round(sec * 1000)} ms`);

export function AudioCheck() {
  const [st, setSt] = useState<OutputStatus>(() => engine.status());
  const [formats, setFormats] = useState<FormatResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [toned, setToned] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setSt(engine.status()), 500);
    return () => window.clearInterval(t);
  }, []);
  const state = stateLabel(st);
  const rows: [string, string, boolean?][] = [
    [tr('ブラウザ', 'Browser'), `${browserLabel()}${isStandalone() ? tr('・ホーム画面のアプリ', ' · Home Screen app') : ''}`],
    [tr('音の出力', 'Output'), state.text, state.ok],
    [tr('サンプリング周波数', 'Sample rate'), st.sampleRate ? `${st.sampleRate} Hz` : '—'],
    [tr('出力の遅れ', 'Output latency'), st.created ? `${ms(st.baseLatency)} + ${ms(st.outputLatency)}` : '—'],
    [
      tr('音の種類（Safari）', 'Audio session (Safari)'),
      st.session === null ? tr('このブラウザには無い', 'Not in this browser') : st.session === 'playback' ? tr('再生（消音でも鳴る）', 'Playback (plays in Silent Mode)') : st.session,
      st.session === null || st.session === 'playback' || !IS_IOS,
    ],
    [tr('音が出なかった回数', 'Times sound failed to start'), String(st.stalls), st.stalls === 0],
  ];
  return (
    <div className="settings-col">
      <h2>{tr('音の出力', 'Audio output')}</h2>
      <p className="lbl" style={{ lineHeight: 1.7 }}>
        {tr(
          '音が出ないときの確認用です。ここに出る様子を伝えてもらえると、原因を探せます。',
          "Use this when there's no sound. Sharing what this page shows helps find the cause.",
        )}
      </p>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('いまの様子', 'Current status')}
        </div>
        <div className="audio-check-grid">
          {rows.map(([k, v, ok]) => (
            <div key={k} className="audio-check-row">
              <span className="lbl">{k}</span>
              <span className={ok === false ? 'audio-check-bad' : undefined}>{v}</span>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button
            className="btn small primary"
            onClick={() => {
              engine.testTone();
              setToned(true);
              setSt(engine.status());
            }}
          >
            {tr('テスト音を鳴らす', 'Play test tone')}
          </button>
          <button
            className="btn small"
            onClick={() => {
              engine.resetOutput();
              engine.testTone();
              setToned(true);
              setSt(engine.status());
            }}
            title={tr('再生を止めて、音の出力を新しく作ります（読み込んだ音はそのまま）', 'Stops playback and creates a new audio output (loaded sounds are kept)')}
          >
            {tr('音の出力を作り直す', 'Recreate audio output')}
          </button>
        </div>
        {toned && (
          <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
            {tr(
              '「ピッポッ」と2回鳴ります。聞こえないときは、音量・消音・つないでいるイヤホンやスピーカーを確かめてください。',
              'You should hear two beeps. If you hear nothing, check the volume, Silent Mode and any connected headphones or speakers.',
            )}
          </p>
        )}
      </div>
      <div className="card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          {tr('読める音の形式', 'Readable audio formats')}
        </div>
        <p className="lbl" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
          {tr(
            'DTX の音はほとんど OGG（Vorbis）です。読めない形式の音は鳴りません（Safari は 18.4 より前は OGG を読めません）。',
            "DTX sounds are mostly OGG (Vorbis). Sounds in formats the browser can't read won't play (Safari before 18.4 can't read OGG).",
          )}
        </p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn small"
            disabled={probing}
            onClick={async () => {
              setProbing(true);
              try {
                setFormats(await probeFormats());
              } finally {
                setProbing(false);
              }
            }}
          >
            {probing ? tr('調べています…', 'Checking…') : tr('調べる', 'Check')}
          </button>
          {formats?.map((f) => (
            <span key={f.name} className={`pill ${f.ok ? 'ok' : 'warn'}`}>
              {f.ok ? '✓' : '✕'} {f.name}
            </span>
          ))}
        </div>
      </div>
      {IS_WEBKIT && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 8 }}>
            {IS_IOS ? iosName(tr('iPad で音が出ないとき', 'No sound on iPad')) : tr('Safari で音が出ないとき', 'No sound in Safari')}
          </div>
          <ul className="audio-check-tips">
            <li>{tr('もう一度 ▶ を押す（Safari はタップした瞬間にしか音を出し始められません）。', 'Press ▶ again (Safari can only start sound at the moment you tap).')}</li>
            {IS_IOS && <li>{tr('消音（コントロールセンターのベル）をオフにする。', 'Turn off Silent Mode (the bell in Control Center).')}</li>}
            <li>{tr('ほかのアプリやタブで音を鳴らしていたら止めて、この画面をタップする。', 'Stop audio playing in other apps or tabs, then tap this screen.')}</li>
            <li>{tr('上の「音の出力を作り直す」を押す。それでもだめならページを開き直す。', 'Press "Recreate audio output" above. If that fails, reload the page.')}</li>
            <li>{tr('それでもうまく動かないときは Chrome をお使いください（Chrome で確かめています）。', "If it still doesn't work well, please use Chrome (that's where it's tested).")}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
