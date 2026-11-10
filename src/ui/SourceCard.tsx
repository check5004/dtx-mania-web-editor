// 原曲（音声ファイル）：読み込む場所。譜面の BGM（#WAV と ch01）に反映し、波形と原曲の打点はこの音から作る。
import { tr, pl } from '../i18n';
import { useState } from 'react';
import { importBgmFile, pickBgmFile } from '../app/fileActions';
import { engine } from '../audio/engine';
import { toMeasure } from '../dtx/base36';
import { findFile } from '../fs/folder';
import { useAssist } from '../store/assist';
import { bgmSource, wavPath } from '../store/derived';
import { useDevice } from '../store/device';
import { openPage, openTempo, useEditor } from '../store/editor';
import { readyStems, useStems } from '../store/stems';
import { useSidecar } from '../store/sidecar';
import { openSeparation, separating, useSeparate } from '../store/separate';
import { alignBgm, useBgmSplit, type BgmGroup } from '../store/songBgm';
import { formatTime } from './format';
import { useSoundsVersion } from './hooks';
import { Icon } from './icons';

export function SourceCard() {
  const doc = useEditor((s) => s.doc);
  const folder = useEditor((s) => s.folder);
  const missing = useEditor((s) => s.missingWavs);
  const status = useAssist((s) => s.status);
  const progress = useAssist((s) => s.progress);
  const srcName = useAssist((s) => s.src?.name);
  const duration = useAssist((s) => s.data?.duration ?? 0);
  useSidecar((s) => s.stems);
  useStems((s) => s.version);
  useSoundsVersion();
  const [over, setOver] = useState(false);
  useSeparate((s) => s.phase);
  const sepBusy = separating();
  // スマホではステムの分解をしない（メモリが足りない）。PC・iPad で分けたステムを足すのはできる
  const phone = useDevice((s) => s.phone);
  const bgm = bgmSource(doc);
  const path = bgm ? (wavPath(doc, bgm.wav) ?? '') : '';
  const name = path.split(/[\\/]/).pop() ?? '';
  const has = !!bgm && !!findFile(folder, path, doc.fields['PATH_WAV'] ?? '');
  const stems = readyStems();
  const lost = !!bgm && !has && missing.includes(bgm.wav);
  const len = duration || (bgm ? engine.duration(bgm.wav) : 0);
  // 難易度によって原曲のファイルが違う（開いている難易度だけで差し替えた古いデータなど）
  const split = useBgmSplit();

  const drop = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const f = [...e.dataTransfer.files].find((x) => /\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(x.name));
      if (f) void importBgmFile(f);
    },
  };

  const analysis =
    status === 'loading'
      ? tr(`解析中… ${Math.round(progress * 100)}%`, `Analyzing… ${Math.round(progress * 100)}%`)
      : status === 'ready'
        ? tr(`波形・打点: ${srcName ?? name}`, `Waveform and hits: ${srcName ?? name}`)
        : status === 'error'
          ? tr('解析できませんでした', "Couldn't analyze")
          : null;

  return (
    <div className={`card source-card ${over ? 'over' : ''}`} {...drop}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="section-title">{tr('原曲（音声ファイル）', 'Original (audio file)')}</span>
        <span className="grow" />
        {bgm && (
          <button className="btn small ghost" style={{ height: 24 }} onClick={openTempo} title={tr('原曲に合わせてBPMと曲の始まりを決める', 'Set the BPM and song start to match the original')}>
            {tr('テンポ合わせ', 'Tempo')}
          </button>
        )}
      </div>
      {bgm && (has || stems.length > 0) && !lost ? (
        <>
          <div className="source-file">
            <span className="source-ic">{Icon.wave(15)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ellipsis" title={path} style={{ fontWeight: 600 }}>
                {has ? name : tr(`ステム ${stems.length} 本`, `${stems.length} ${pl(stems.length, 'stem')}`)}
              </div>
              <div className="lbl mono">
                {len > 0 ? formatTime(len, false) : '—'} · {tr(`${toMeasure(bgmMeasure(doc))}小節から`, `from measure ${toMeasure(bgmMeasure(doc))}`)}
              </div>
            </div>
            <button className="btn small" onClick={pickBgmFile} title={tr('別の音声ファイルに差し替える（Ctrl+Z で戻せます）', 'Replace with another audio file (undo with Ctrl+Z)')}>
              {tr('差し替え', 'Replace')}
            </button>
          </div>
          {analysis && <div className="lbl" style={{ marginTop: 6 }}>{analysis}</div>}
          {has && stems.length === 0 && !phone && (
            <div className="lbl" style={{ marginTop: 6, lineHeight: 1.6 }}>
              {sepBusy ? (
                <>
                  {tr('ステムに分解しています…', 'Splitting into stems…')}{' '}
                  <button className="link-btn" onClick={openSeparation}>
                    {tr('ようす', 'Progress')}
                  </button>
                </>
              ) : (
                <>
                  {tr('ドラム抜きの BGM を作るには', 'To make a no-drums BGM:')}{' '}
                  <button className="link-btn" onClick={openSeparation} title={tr('原曲をブラウザの中でドラムとドラム抜きに分ける', 'Split the original into drums and no-drums in your browser')}>
                    {tr('ステムに分解', 'Split into stems')}
                  </button>
                </>
              )}
            </div>
          )}
          {stems.length > 0 && (
            <div className="lbl" style={{ marginTop: 6, lineHeight: 1.6 }}>
              {tr(
                `ステム ${stems.length} 本を鳴らしています（原曲と鳴らし分けるのは下のトラックで）。`,
                `Playing ${stems.length} ${pl(stems.length, 'stem')} (switch between them and the original in the tracks below). `,
              )}
              <button className="link-btn" onClick={() => openPage('stems')}>
                {tr('ステムとミックス', 'Stems & mix')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {lost && (
            <div className="notice" style={{ marginBottom: 8 }}>
              {tr(`原曲のファイル「${name}」が曲フォルダに見つかりません。音声ファイルを選び直してください。`, `The original file "${name}" isn't in the song folder. Pick the audio file again.`)}
            </div>
          )}
          <button className={`source-drop ${over ? 'over' : ''}`} onClick={pickBgmFile}>
            <b>
              {Icon.folder(15)} {tr('原曲の音声ファイルを読み込む', 'Load the original audio file')}
            </b>
            <span>{tr('ここにドロップするか、クリックして選ぶ（WAV・OGG・MP3）', 'Drop it here or click to choose (WAV, OGG, MP3)')}</span>
          </button>
          <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
            {tr(
              '曲フォルダにコピーして、譜面の BGM（#WAV と ch01）に反映します。譜面の右の波形と原曲の打点はこの音から作ります。楽器ごとに分けた音は',
              'It is copied into the song folder and set as the chart’s BGM (#WAV and ch01). The waveform and detected hits next to the chart come from it. Separate instrument tracks can be loaded from ',
            )}
            <button className="link-btn" onClick={() => openPage('stems')}>
              {tr('ステム', 'Stems')}
            </button>
            {tr('から読み込めます。', '.')}
          </p>
        </>
      )}
      {split && <BgmSplitNotice groups={split} />}
    </div>
  );
}

/** 難易度によって原曲が違うことと、そろえるボタン */
function BgmSplitNotice({ groups }: { groups: BgmGroup[] }) {
  const sep = tr('・', ', ');
  const others = groups.filter((g) => !g.current);
  return (
    <div className="notice bgm-split" style={{ marginTop: 8 }}>
      <span style={{ flex: 'none' }}>{Icon.warn(14)}</span>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
        <b>{tr('難易度によって原曲が違います', 'The original differs between difficulties')}</b>
        <ul className="bgm-split-list">
          {others.map((g) => (
            <li key={g.key ?? ''}>
              <span>{g.labels.join(sep)}</span>
              {g.key === null ? (
                <span className="lbl">{tr('原曲なし', 'no original')}</span>
              ) : (
                <span className="mono ellipsis" title={g.target?.path}>
                  {g.name}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => void alignBgm()} title={tr('どの原曲にそろえるかを選び、すべての難易度の BGM を同じファイルにします（Ctrl+Z で戻せます）', 'Choose one original and make it the BGM of every difficulty (undo with Ctrl+Z)')}>
            {tr('そろえる…', 'Align…')}
          </button>
          <span className="lbl">{tr('NX でも難易度で BGM が変わり、切り替えるたびに原曲を読み直します', 'NX plays a different BGM per difficulty too, and switching reloads the original')}</span>
        </div>
      </div>
    </div>
  );
}

function bgmMeasure(doc: ReturnType<typeof useEditor.getState>['doc']): number {
  const b = bgmSource(doc);
  if (!b) return 0;
  const c = doc.chips.find((x) => x.id === b.chipId);
  return c?.m ?? 0;
}
