// 原曲をブラウザの中でステムに分解するカード（ステムとミックスの画面）。
// 遊ぶ用の DTX ではドラムを譜面の音で鳴らすので、BGM はドラム抜きにしたい。その元になるドラムとドラム抜きの音を作る。
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
import { fileExists, useStems } from '../store/stems';
import { confirmDialog } from './dialogs';
import { Icon } from './icons';

/** 画面に出すモデルの順（上がおすすめ） */
const ORDER: SepModelId[] = ['bs_roformer_sw', 'scnet_xl_wide_v5', 'scnet_small'];

const mb = (b: number) => `${Math.round(b / 2 ** 20)}MB`;

export function SeparatePanel({ onClose }: { onClose?: () => void }) {
  const s = useSeparate();
  const stems = useSidecar((x) => x.stems);
  const busy = useStems((x) => x.busy);
  useEditor((x) => x.doc);
  useEditor((x) => x.folder);
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
      const ok = await confirmDialog({ title: `${name} を上書きしますか？`, body: '曲フォルダに同じ名前のファイルがあります。', ok: '上書き', danger: true });
      if (!ok) return;
    }
    await registerDrumlessBgm(name);
  };

  return (
    <section className="card sep-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="sep-ic">{Icon.layers(16)}</span>
        <b style={{ fontSize: 14 }}>原曲をステムに分解</b>
        <span className="lbl">ブラウザの中で計算します（音はどこにも送りません）</span>
        <span className="grow" />
        {onClose && !running && (
          <button className="ib" onClick={onClose} title="閉じる" aria-label="閉じる">
            {Icon.close(14)}
          </button>
        )}
      </div>
      <p className="lbl" style={{ margin: '6px 0 10px', lineHeight: 1.65 }}>
        原曲からドラムを取り出し、<b>ドラム</b>と<b>ドラム抜き</b>のステムを作ります。NX で遊ぶときはドラムを譜面の音で鳴らすので、BGM はドラム抜きにすると叩いている感じが出ます。
        分けたあとは右の「書き出し」の <b>BGM用（ドラム抜き）</b> で DTX の BGM に登録できます。ドラムのステムは原曲の打点（採譜）にも使います。
      </p>

      {'error' in src ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {Icon.warn(14)} {src.error}
        </div>
      ) : (
        <>
          <div className="row lbl" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            分ける音：
            {sources.length > 1 ? (
              <select
                className="field mono"
                style={{ maxWidth: 360 }}
                value={src.path}
                disabled={running}
                onChange={(e) => setSeparationSource(e.target.value)}
                aria-label="分ける音"
              >
                {sources.map((x) => (
                  <option key={x.path} value={x.path}>
                    {x.path}
                    {x.bgm ? '（今の BGM）' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <b className="mono">{src.name}</b>
            )}
            {sources.length <= 1 && src.bgm && <span>（BGM）</span>}
          </div>
          {src.drumless && (
            <div className="notice" style={{ marginBottom: 10 }}>
              {Icon.warn(14)} この音はファイル名からドラム抜きのようです。ドラムの入った原曲を選んでください（分けてもドラムはほとんど出てきません）。
            </div>
          )}
        </>
      )}

      {s.gpu && !s.gpu.ok && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {Icon.warn(14)} このブラウザでは WebGPU（GPU で計算する仕組み）が使えないので、高精度のモデルは動きません。Chrome か Edge の新しい版で開くか、「軽い」モデルを選んでください（CPU で動くので時間がかかります）。
        </div>
      )}

      <div className="sep-grid">
        <div>
          <div className="sep-h">モデル</div>
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
                  title={off ? 'WebGPU が使えないので動きません' : undefined}
                >
                  <span className={`radio-dot ${s.model === id ? 'on' : ''}`} />
                  <span>
                    <b>{m.name}</b>
                    {id === 'bs_roformer_sw' && <span className="badge-ok">おすすめ</span>}
                    <span className="d">
                      {m.summary}・初回だけ {mb(f.bytes)} を読み込み{m.webgpuOnly ? '・GPU が必要' : '・CPU でも動く'}
                      ・ドラムの分離 {m.drumsSdr.toFixed(1)} dB
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="lbl" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.6 }}>
            ドラムの分離＝正解付きの曲（MUSDB18 の30曲）で測った SDR。大きいほど良く、3 dB 上がると残る誤差がおよそ半分です。
          </div>
        </div>
        <div>
          <div className="sep-h">分け方</div>
          <div className="mode-cards">
            <button className={`mode-card ${s.outputs === 'two' ? 'on' : ''}`} onClick={() => setSeparateOutputs('two')} disabled={running} aria-pressed={s.outputs === 'two'}>
              <span className={`radio-dot ${s.outputs === 'two' ? 'on' : ''}`} />
              <span>
                <b>ドラムとドラム抜き（2本）</b>
                <span className="badge-ok">おすすめ</span>
                <span className="d">ドラム抜き＝原曲からドラムだけを引いた音。足すと原曲にぴったり戻ります。</span>
              </span>
            </button>
            <button className={`mode-card ${s.outputs === 'all' ? 'on' : ''}`} onClick={() => setSeparateOutputs('all')} disabled={running} aria-pressed={s.outputs === 'all'}>
              <span className={`radio-dot ${s.outputs === 'all' ? 'on' : ''}`} />
              <span>
                <b>楽器ごと（{model.stems.length}本）</b>
                <span className="d">
                  {stemsInOrder(s.model)
                    .map((x) => STEM_LABEL[x])
                    .join('・')}
                  。ベースだけ聴いてバスドラムと聞き分ける、などに。その他は、原曲からほかを全部引いた残りです。
                </span>
              </span>
            </button>
          </div>
          {files.length > 0 && (
            <div className="lbl" style={{ marginTop: 8, lineHeight: 1.6 }}>
              曲フォルダの stems/ に <span className="mono">{files.map((f) => f.name).join('、')}</span>（OGG）を作ります。
            </div>
          )}
          {others.length > 0 && (
            <label className="row" style={{ gap: 6, marginTop: 8, fontSize: 12 }}>
              <input type="checkbox" checked={s.replace} onChange={(e) => setSeparateReplace(e.target.checked)} disabled={running} />
              今のステム {others.length} 本を外して置き換える（ファイルは消しません）
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
              中止
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={!canRun} onClick={() => void startSeparation()}>
              {Icon.layers(14)} {stems.length ? '分解し直す' : '分解する'}
            </button>
            <span className="lbl" style={{ lineHeight: 1.5 }}>
              {model.webgpuOnly ? 'GPU の速さしだいで、1曲 1〜数分。' : 'CPU なら曲の長さと同じくらい〜数倍かかります。'}モデルは初回だけ読み込み、ブラウザに保存します。分解中も譜面の編集はできます。
            </span>
          </>
        )}
      </div>

      {s.phase === 'error' && s.error && (
        <div className="notice" style={{ marginTop: 10 }}>
          {Icon.warn(14)} 分解できませんでした：{s.error}
        </div>
      )}
      {s.phase === 'done' && s.last && (
        <div className="notice info" style={{ marginTop: 10, lineHeight: 1.6 }}>
          {Icon.info(14)}
          <span style={{ flex: 1, minWidth: 0 }}>
            {SEP_MODELS[s.last.model].name} で {s.last.files.length} 本に分けました（{formatSec(s.last.seconds)}・曲 {formatSec(s.last.songSec)}・{s.last.backend === 'webgpu' ? s.last.gpu : 'CPU'}）。
            {s.bgmSet ? (
              <>
                ドラム抜きを <b className="mono">{s.bgmSet}</b> に書き出し、DTX の BGM に登録しました（元の原曲のファイルは残しています）。
              </>
            ) : (
              <>
                NX で遊ぶ用に、ドラム抜きを BGM にできます（原曲と同じ音量のまま。細かく決めるなら右の「書き出し」）。
                <span className="row" style={{ gap: 8, marginTop: 6 }}>
                  <button className="btn small primary" disabled={!!busy} onClick={() => void toBgm()}>
                    {Icon.download(13)} ドラム抜きを BGM にする
                  </button>
                  <span className="mono lbl">→ {drumlessBgmName()}</span>
                </span>
              </>
            )}
          </span>
        </div>
      )}
      <div className="lbl" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.6 }}>
        モデル：{model.credit}。ブラウザ用に書き出したもの（unblend、R. Fahey）を Hugging Face から読みます。{model.license}。
        {!!s.saved?.length && (
          <>
            {' '}
            ブラウザに保存したモデル：{s.saved.map((x) => `${SEP_MODELS[x.model].name}（${mb(x.bytes)}）`).join('・')}{' '}
            <button className="link-btn" disabled={running} onClick={() => void clearModels()} title="ブラウザに保存した分解のモデルを消します（次に分解するとき、また読み込みます）">
              消す
            </button>
          </>
        )}
      </div>
    </section>
  );
}

const STEM_LABEL: Record<string, string> = { drums: 'ドラム', bass: 'ベース', vocals: 'ボーカル', guitar: 'ギター', piano: 'ピアノ', other: 'その他' };
