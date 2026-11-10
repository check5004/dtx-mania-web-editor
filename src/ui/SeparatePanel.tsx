// 原曲をブラウザの中でステムに分解するカード（ステムとミックスの画面）。
// 遊ぶ用の DTX ではドラムを譜面の音で鳴らすので、BGM はドラム抜きにしたい。その元になるドラムとドラム抜きの音を作る。
import { tr, pl, isJa } from '../i18n';
import { useEffect, useState } from 'react';
import { SEP_MODELS, type SepModelId } from '../separate/models';
import { stemsInOrder } from '../separate/names';
import {
  cancelSeparation,
  checkGpu,
  clearModels,
  drumlessBgmName,
  formatSec,
  plannedFiles,
  refreshSavedModels,
  registerDrumlessBgm,
  separating,
  separationSource,
  separationSources,
  setSeparateModel,
  setSeparateOutputs,
  setSeparateReplace,
  setSeparationSource,
  startSeparation,
  useSeparate,
} from '../store/separate';
import { useEditor } from '../store/editor';
import { useSidecar } from '../store/sidecar';
import { audioReflected, fileExists, undoAudioReflect, useStems } from '../store/stems';
import { useSongBgm } from '../store/songBgm';
import { IS_IOS } from '../store/device';
import { confirmDialog } from './dialogs';
import { Icon } from './icons';

/** 画面に出すモデルの順（上がおすすめ） */
const ORDER: SepModelId[] = ['bs_roformer_sw', 'scnet_xl_wide_v5', 'scnet_small'];

const mb = (b: number) => `${Math.round(b / 2 ** 20)}${isJa() ? '' : ' '}MB`;

export function SeparatePanel({ onClose }: { onClose?: () => void }) {
  const s = useSeparate();
  const stems = useSidecar((x) => x.stems);
  const busy = useStems((x) => x.busy);
  useStems((x) => x.reflected);
  // ほかの難易度に入れ終わったら描き直す
  useSongBgm((x) => x.version);
  const doc = useEditor((x) => x.doc);
  useEditor((x) => x.folder);
  // ドラム抜きを BGM に反映して、今もエディタの BGM になっているか（元に戻す・Ctrl+Z で外れる）
  const reflectedBgm = s.bgmSet ? audioReflected('bgm', doc) : null;
  const bgmIn = reflectedBgm && reflectedBgm.file === s.bgmSet ? reflectedBgm : null;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    void checkGpu();
    void refreshSavedModels();
  }, []);
  const running = separating();
  // 分解中は経過時間を出すので、1秒ごとに描き直す
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const src = separationSource();
  const srcErr = 'error' in src ? src.error : null;
  const sources = srcErr ? [] : separationSources();
  const model = SEP_MODELS[s.model];
  const gpuOk = s.gpu?.ok ?? true;
  const usable = (id: SepModelId) => gpuOk || !SEP_MODELS[id].webgpuOnly;
  const files = 'error' in src ? [] : plannedFiles(s.model, s.outputs, src.base);
  const fileOf = (id: SepModelId) => SEP_MODELS[id].files[s.gpu?.f16 ? 'fp16' : 'fp32'];
  const others = stems.filter((t) => !files.some((f) => `stems/${f.name}`.toLowerCase() === t.file.toLowerCase()));
  const canRun = !running && !srcErr && usable(s.model);
  const elapsed = s.runStart && running ? (now - s.runStart) / 1000 : 0;

  const toBgm = async () => {
    const name = drumlessBgmName();
    if (fileExists(name)) {
      const ok = await confirmDialog({
        title: tr(`${name} を上書きしますか？`, `Overwrite ${name}?`),
        body: tr('曲フォルダに同じ名前のファイルがあります。', 'A file with the same name is already in the song folder.'),
        ok: tr('上書き', 'Overwrite'),
        danger: true,
      });
      if (!ok) return;
    }
    await registerDrumlessBgm(name);
  };

  return (
    <section className="card sep-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="sep-ic">{Icon.layers(16)}</span>
        <b style={{ fontSize: 14 }}>{tr('原曲をステムに分解', 'Split the original into stems')}</b>
        <span className="lbl">{tr('ブラウザの中で計算します（音はどこにも送りません）', 'Runs inside your browser (the audio is never uploaded)')}</span>
        <span className="grow" />
        {onClose && !running && (
          <button className="ib" onClick={onClose} title={tr('閉じる', 'Close')} aria-label={tr('閉じる', 'Close')}>
            {Icon.close(14)}
          </button>
        )}
      </div>
      <p className="lbl" style={{ margin: '6px 0 10px', lineHeight: 1.65 }}>
        {isJa() ? (
          <>
            原曲からドラムを取り出し、<b>ドラム</b>と<b>ドラム抜き</b>のステムを作ります。NX で遊ぶときはドラムを譜面の音で鳴らすので、BGM はドラム抜きにすると叩いている感じが出ます。
            分けたあとは下の「ドラム抜きを BGM に反映」か、右の「書き出し」の <b>BGM用（ドラム抜き）</b> でエディタ（譜面）の BGM にできます。ドラムのステムは原曲の打点（採譜）にも使います。
          </>
        ) : (
          <>
            Pulls the drums out of the original and makes a <b>drums</b> stem and a <b>no-drums</b> stem. In NX the drums are played by the chart&apos;s own sounds, so a no-drums BGM makes it feel like you are the one playing.
            Afterwards, use &quot;Set no-drums as BGM&quot; below or <b>For BGM (no drums)</b> under &quot;Export&quot; on the right to make it the BGM in the editor (chart). The drums stem is also used for detecting hits in the original.
          </>
        )}
      </p>

      {'error' in src ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {Icon.warn(14)} {src.error}
        </div>
      ) : (
        <>
          <div className="row lbl" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {tr('分ける音：', 'Audio to split:')}
            {sources.length > 1 ? (
              <select
                className="field mono"
                style={{ maxWidth: 360 }}
                value={src.path}
                disabled={running}
                onChange={(e) => setSeparationSource(e.target.value)}
                aria-label={tr('分ける音', 'Audio to split')}
              >
                {sources.map((x) => (
                  <option key={x.path} value={x.path}>
                    {x.path}
                    {x.full ? tr('（完全な原曲）', ' (full original)') : x.bgm ? tr('（今の BGM）', ' (current BGM)') : ''}
                  </option>
                ))}
              </select>
            ) : (
              <b className="mono">{src.name}</b>
            )}
            {sources.length <= 1 && (src.full ? <span>{tr('（完全な原曲）', '(full original)')}</span> : src.bgm && <span>{tr('（BGM）', '(BGM)')}</span>)}
          </div>
          {src.drumless && (
            <div className="notice" style={{ marginBottom: 10 }}>
              {Icon.warn(14)}{' '}
              {tr(
                'この音はファイル名からドラム抜きのようです。ドラムの入った原曲を選んでください（分けてもドラムはほとんど出てきません）。',
                'From its file name, this audio already has no drums. Pick the original with drums (splitting this would give almost no drums).',
              )}
            </div>
          )}
        </>
      )}

      {s.gpu && !s.gpu.ok && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {Icon.warn(14)}{' '}
          {tr(
            'このブラウザでは WebGPU（GPU で計算する仕組み）が使えないので、高精度のモデルは動きません。Chrome か Edge の新しい版で開くか、「軽い」モデルを選んでください（CPU で動くので時間がかかります）。',
            "WebGPU (computing on the GPU) isn't available in this browser, so the accurate models can't run. Open this page in a recent Chrome or Edge, or pick the \"Light\" model (it runs on the CPU, so it takes longer).",
          )}
        </div>
      )}

      <div className="sep-grid">
        <div>
          <div className="sep-h">{tr('モデル', 'Model')}</div>
          <div className="mode-cards">
            {ORDER.map((id) => {
              const m = SEP_MODELS[id];
              const f = fileOf(id);
              const off = !usable(id);
              return (
                <button
                  key={id}
                  className={`mode-card ${s.model === id ? 'on' : ''}`}
                  onClick={() => setSeparateModel(id)}
                  disabled={running || off}
                  aria-pressed={s.model === id}
                  title={off ? tr('WebGPU が使えないので動きません', "Can't run without WebGPU") : undefined}
                >
                  <span className={`radio-dot ${s.model === id ? 'on' : ''}`} />
                  <span>
                    <b>{m.name}</b>
                    {IS_IOS ? (
                      <>
                        {id === 'scnet_small' && <span className="badge-ok">{tr('iPad におすすめ', 'Best on iPad')}</span>}
                        {id === 'bs_roformer_sw' && <span className="badge-warn">{tr('メモリ不足の恐れ', 'May run out of memory')}</span>}
                      </>
                    ) : (
                      id === 'bs_roformer_sw' && <span className="badge-ok">{tr('おすすめ', 'Recommended')}</span>
                    )}
                    <span className="d">
                      {isJa()
                        ? `${m.summary}・初回だけ ${mb(f.bytes)} を読み込み${m.webgpuOnly ? '・GPU が必要' : '・CPU でも動く'}・ドラムの分離 ${m.drumsSdr.toFixed(1)} dB`
                        : `${m.summaryEn} · downloads ${mb(f.bytes)} the first time · ${m.webgpuOnly ? 'needs a GPU' : 'also runs on the CPU'} · drum separation ${m.drumsSdr.toFixed(1)} dB`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {IS_IOS && (
            <div className="lbl" style={{ marginTop: 6, lineHeight: 1.6 }}>
              {tr('iPad は使えるメモリが少ないので、軽いモデルから試してください。分解中も譜面の編集はできます。', 'iPad has less memory to work with, so try the light model first. You can keep editing the chart while it runs.')}
            </div>
          )}
          <div className="lbl" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.6 }}>
            {tr(
              'ドラムの分離＝正解付きの曲（MUSDB18 の30曲）で測った SDR。大きいほど良く、3 dB 上がると残る誤差がおよそ半分です。',
              'Drum separation = SDR measured on songs with known answers (30 songs from MUSDB18). Higher is better; +3 dB roughly halves the remaining error.',
            )}
          </div>
        </div>
        <div>
          <div className="sep-h">{tr('分け方', 'Output')}</div>
          <div className="mode-cards">
            <button className={`mode-card ${s.outputs === 'two' ? 'on' : ''}`} onClick={() => setSeparateOutputs('two')} disabled={running} aria-pressed={s.outputs === 'two'}>
              <span className={`radio-dot ${s.outputs === 'two' ? 'on' : ''}`} />
              <span>
                <b>{tr('ドラムとドラム抜き（2本）', 'Drums and no-drums (2 stems)')}</b>
                <span className="badge-ok">{tr('おすすめ', 'Recommended')}</span>
                <span className="d">
                  {tr(
                    'ドラム抜き＝原曲からドラムだけを引いた音。足すと原曲にぴったり戻ります。',
                    'No-drums = the original minus the drums. Adding the two gives back the original exactly.',
                  )}
                </span>
              </span>
            </button>
            <button className={`mode-card ${s.outputs === 'all' ? 'on' : ''}`} onClick={() => setSeparateOutputs('all')} disabled={running} aria-pressed={s.outputs === 'all'}>
              <span className={`radio-dot ${s.outputs === 'all' ? 'on' : ''}`} />
              <span>
                <b>{tr(`楽器ごと（${model.stems.length}本）`, `Each instrument (${model.stems.length} stems)`)}</b>
                <span className="d">
                  {stemsInOrder(s.model)
                    .map((x) => stemLabel(x))
                    .join(tr('・', ', '))}
                  {tr(
                    '。ベースだけ聴いてバスドラムと聞き分ける、などに。その他は、原曲からほかを全部引いた残りです。',
                    '. Handy for things like soloing the bass to tell it apart from the kick. "Other" is the original minus all the rest.',
                  )}
                </span>
              </span>
            </button>
          </div>
          {files.length > 0 && (
            <div className="lbl" style={{ marginTop: 8, lineHeight: 1.6 }}>
              {isJa() ? (
                <>
                  曲フォルダの stems/ に <span className="mono">{files.map((f) => f.name).join('、')}</span>（OGG）を作ります。
                </>
              ) : (
                <>
                  Creates <span className="mono">{files.map((f) => f.name).join(', ')}</span> (OGG) in stems/ in the song folder.
                </>
              )}
            </div>
          )}
          {others.length > 0 && (
            <label className="row" style={{ gap: 6, marginTop: 8, fontSize: 12 }}>
              <input type="checkbox" checked={s.replace} onChange={(e) => setSeparateReplace(e.target.checked)} disabled={running} />
              {tr(
                `今のステム ${others.length} 本を外して置き換える（ファイルは消しません）`,
                `Replace the current ${others.length} ${pl(others.length, 'stem')} (the files are kept)`,
              )}
            </label>
          )}
        </div>
      </div>

      <div className="sep-foot">
        {running ? (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8, marginBottom: 5 }}>
                <span className="ellipsis" style={{ fontSize: 12.5 }}>
                  {s.detail}
                </span>
                <span className="grow" />
                {elapsed > 0 && <span className="lbl mono">{formatSec(elapsed)}</span>}
              </div>
              <div className="progress">
                <div style={{ width: `${Math.round(s.progress * 100)}%` }} />
              </div>
            </div>
            <button className="btn small" onClick={cancelSeparation}>
              {tr('中止', 'Cancel')}
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={!canRun} onClick={() => void startSeparation()}>
              {Icon.layers(14)} {stems.length ? tr('分解し直す', 'Split again') : tr('分解する', 'Split')}
            </button>
            <span className="lbl" style={{ lineHeight: 1.5 }}>
              {model.webgpuOnly
                ? tr('GPU の速さしだいで、1曲 1〜数分。', 'One to a few minutes per song, depending on your GPU. ')
                : tr('CPU なら曲の長さと同じくらい〜数倍かかります。', 'On the CPU it takes about the song length or several times that. ')}
              {tr(
                'モデルは初回だけ読み込み、ブラウザに保存します。分解中も譜面の編集はできます。',
                'The model is downloaded once and kept in your browser. You can keep editing the chart while it runs.',
              )}
            </span>
          </>
        )}
      </div>

      {s.phase === 'error' && s.error && (
        <div className="notice" style={{ marginTop: 10 }}>
          {Icon.warn(14)} {tr('分解できませんでした：', "Couldn't split: ")}
          {s.error}
        </div>
      )}
      {s.phase === 'done' && s.last && (
        <div className="notice info" style={{ marginTop: 10, lineHeight: 1.6 }}>
          {Icon.info(14)}
          <span style={{ flex: 1, minWidth: 0 }}>
            {isJa()
              ? `${SEP_MODELS[s.last.model].name} で ${s.last.files.length} 本に分けました（${formatSec(s.last.seconds)}・曲 ${formatSec(s.last.songSec)}・${s.last.backend === 'webgpu' ? s.last.gpu : 'CPU'}）。`
              : `Split into ${s.last.files.length} ${pl(s.last.files.length, 'stem')} with ${SEP_MODELS[s.last.model].name} (${formatSec(s.last.seconds)}, song ${formatSec(s.last.songSec)}, ${s.last.backend === 'webgpu' ? s.last.gpu : 'CPU'}). `}
            {bgmIn ? (
              // 反映したあとは、押した所に結果（✓ 反映済み）と「元に戻す」を残す
              <span className="row wrap sep-reflect">
                <b>{tr('ドラム抜きを BGM に', 'No-drums as BGM')}</b>
                <span className="reflect-chip ok">{tr('✓ 反映済み', '✓ Applied')}</span>
                <span className="mono">{bgmIn.file}</span>
                <span className="lbl">
                  {bgmIn.prev === bgmIn.file
                    ? tr('前と同じ名前のファイルを書き直しました', 'Rewrote the file with the same name')
                    : bgmIn.prev
                      ? tr(`元の ${bgmIn.prev} は消さずに残しています`, `The original ${bgmIn.prev} is kept`)
                      : tr('BGM のチップ（ch01）を001小節に置きました', 'Placed the BGM chip (ch01) in measure 001')}
                  {!!bgmIn.siblings?.labels.length &&
                    tr(`。ほかの難易度（${bgmIn.siblings.labels.join('・')}）にも反映しました`, `. Also set for the other difficulties (${bgmIn.siblings.labels.join(', ')})`)}
                </span>
                <span className="grow" />
                {bgmIn.prev !== bgmIn.file && (
                  <button className="btn small" disabled={!!busy} onClick={() => undoAudioReflect('bgm')} title={tr('BGM を反映する前のファイルに戻します（書き出したファイルは残します）', 'Sets the BGM back to the file it used before (the exported file is kept)')}>
                    {tr('元に戻す', 'Undo')}
                  </button>
                )}
              </span>
            ) : (
              <>
                {tr(
                  'NX で遊ぶ用に、ドラム抜きをエディタ（譜面）の BGM にできます（原曲と同じ音量のまま。細かく決めるなら右の「書き出し」）。',
                  'For playing in NX, you can make the no-drums mix the BGM in the editor (chart) (same volume as the original; use "Export" on the right for more control).',
                )}
                <span className="row" style={{ gap: 8, marginTop: 6 }}>
                  <button className="btn small primary" disabled={!!busy} onClick={() => void toBgm()}>
                    {Icon.download(13)} {tr('ドラム抜きを BGM に反映', 'Set no-drums as BGM')}
                  </button>
                  <span className="mono lbl">→ {drumlessBgmName()}</span>
                </span>
              </>
            )}
          </span>
        </div>
      )}
      <div className="lbl" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.6 }}>
        {isJa()
          ? `モデル：${model.credit}。ブラウザ用に書き出したもの（unblend、R. Fahey）を Hugging Face から読みます。${model.license}。`
          : `Model: ${model.creditEn}. The browser export (unblend, R. Fahey) is downloaded from Hugging Face; ${model.licenseEn}.`}
        {!!s.saved?.length && (
          <>
            {' '}
            {tr('ブラウザに保存したモデル：', 'Models saved in this browser: ')}
            {s.saved.map((x) => (isJa() ? `${SEP_MODELS[x.model].name}（${mb(x.bytes)}）` : `${SEP_MODELS[x.model].name} (${mb(x.bytes)})`)).join(tr('・', ', '))}{' '}
            <button
              className="link-btn"
              disabled={running}
              onClick={() => void clearModels()}
              title={tr('ブラウザに保存した分解のモデルを消します（次に分解するとき、また読み込みます）', 'Deletes the saved separation models from this browser (they are downloaded again next time)')}
            >
              {tr('消す', 'Delete')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

const stemLabel = (k: string): string =>
  ({
    drums: tr('ドラム', 'drums'),
    bass: tr('ベース', 'bass'),
    vocals: tr('ボーカル', 'vocals'),
    guitar: tr('ギター', 'guitar'),
    piano: tr('ピアノ', 'piano'),
    other: tr('その他', 'other'),
  })[k] ?? k;
