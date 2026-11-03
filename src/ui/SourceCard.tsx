// 原曲（音声ファイル）：読み込む場所。BGM（#WAV と ch01）に登録し、波形と原曲の打点はこの音から作る。
import { useState } from 'react';
import { importBgmFile, pickBgmFile } from '../app/fileActions';
import { engine } from '../audio/engine';
import { toMeasure } from '../dtx/base36';
import { findFile } from '../fs/folder';
import { useAssist } from '../store/assist';
import { bgmSource, wavPath } from '../store/derived';
import { openPage, openTempo, useEditor } from '../store/editor';
import { readyStems, useStems } from '../store/stems';
import { useSidecar } from '../store/sidecar';
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
  const bgm = bgmSource(doc);
  const path = bgm ? (wavPath(doc, bgm.wav) ?? '') : '';
  const name = path.split(/[\\/]/).pop() ?? '';
  const has = !!bgm && !!findFile(folder, path, doc.fields['PATH_WAV'] ?? '');
  const stems = readyStems();
  const lost = !!bgm && !has && missing.includes(bgm.wav);
  const len = duration || (bgm ? engine.duration(bgm.wav) : 0);

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
    status === 'loading' ? `解析中… ${Math.round(progress * 100)}%` : status === 'ready' ? `波形・打点: ${srcName ?? name}` : status === 'error' ? '解析できませんでした' : null;

  return (
    <div className={`card source-card ${over ? 'over' : ''}`} {...drop}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="section-title">原曲（音声ファイル）</span>
        <span className="grow" />
        {bgm && (
          <button className="btn small ghost" style={{ height: 24 }} onClick={openTempo} title="原曲に合わせてBPMと曲の始まりを決める">
            テンポ合わせ
          </button>
        )}
      </div>
      {bgm && (has || stems.length > 0) && !lost ? (
        <>
          <div className="source-file">
            <span className="source-ic">{Icon.wave(15)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ellipsis" title={path} style={{ fontWeight: 600 }}>
                {has ? name : `ステム ${stems.length} 本`}
              </div>
              <div className="lbl mono">
                {len > 0 ? formatTime(len, false) : '—'} · {toMeasure(bgmMeasure(doc))}小節から
              </div>
            </div>
            <button className="btn small" onClick={pickBgmFile} title="別の音声ファイルに差し替える（Ctrl+Z で戻せます）">
              差し替え
            </button>
          </div>
          {analysis && <div className="lbl" style={{ marginTop: 6 }}>{analysis}</div>}
          {stems.length > 0 && (
            <div className="lbl" style={{ marginTop: 6, lineHeight: 1.6 }}>
              ステム {stems.length} 本を鳴らしています（原曲と鳴らし分けるのは下のトラックで）。
              <button className="link-btn" onClick={() => openPage('stems')}>
                ステムとミックス
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {lost && (
            <div className="notice" style={{ marginBottom: 8 }}>
              原曲のファイル「{name}」が曲フォルダに見つかりません。音声ファイルを選び直してください。
            </div>
          )}
          <button className={`source-drop ${over ? 'over' : ''}`} onClick={pickBgmFile}>
            <b>{Icon.folder(15)} 原曲の音声ファイルを読み込む</b>
            <span>ここにドロップするか、クリックして選ぶ（WAV・OGG・MP3）</span>
          </button>
          <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
            曲フォルダにコピーしてBGM（#WAV と ch01）に登録します。譜面の右の波形と原曲の打点はこの音から作ります。楽器ごとに分けた音は
            <button className="link-btn" onClick={() => openPage('stems')}>
              ステム
            </button>
            から読み込めます。
          </p>
        </>
      )}
    </div>
  );
}

function bgmMeasure(doc: ReturnType<typeof useEditor.getState>['doc']): number {
  const b = bgmSource(doc);
  if (!b) return 0;
  const c = doc.chips.find((x) => x.id === b.chipId);
  return c?.m ?? 0;
}
