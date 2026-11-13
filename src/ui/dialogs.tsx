// 確認・選択・新規作成のダイアログ。Promise で結果を返す。
import { tr } from '../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { NewSongInfo } from '../store/editor';
import { audioNameFor, isVideoName, NX_MOVIE_EXT } from '../audio/videoAudio';

export interface ChoiceOption<T> {
  label: string;
  sub?: string;
  value: T;
}

type Spec =
  | { kind: 'confirm'; title: string; body: string; ok: string; cancel?: string; danger?: boolean }
  | { kind: 'choose'; title: string; body?: string; options: ChoiceOption<unknown>[] }
  | { kind: 'prompt'; title: string; body?: string; value: string; ok: string }
  | { kind: 'newSong'; title: string; audioFiles: string[]; movies?: string[]; defaults: Partial<NewSongInfo> }
  | { kind: 'custom'; render: (done: (v: unknown) => void) => ReactNode; className?: string };

interface DialogState {
  spec: Spec | null;
  resolve: ((v: unknown) => void) | null;
}

const useDialog = create<DialogState>(() => ({ spec: null, resolve: null }));

function open<T>(spec: Spec): Promise<T> {
  const prev = useDialog.getState().resolve;
  prev?.(null);
  return new Promise<T>((resolve) => useDialog.setState({ spec, resolve: resolve as (v: unknown) => void }));
}

function close(v: unknown) {
  const { resolve } = useDialog.getState();
  useDialog.setState({ spec: null, resolve: null });
  resolve?.(v);
}

export const confirmDialog = (o: { title: string; body: string; ok: string; cancel?: string; danger?: boolean }) =>
  open<boolean>({ kind: 'confirm', ...o }).then((v) => v === true);

export const chooseDialog = <T,>(o: { title: string; body?: string; options: ChoiceOption<T>[] }) =>
  open<T | null>({ kind: 'choose', ...o });

export const promptDialog = (o: { title: string; body?: string; value: string; ok: string }) =>
  open<string | null>({ kind: 'prompt', ...o });

/** 新しい譜面の情報を聞く。audioFiles は原曲の候補（動画なら、作るときに音を取り出す）、movies は背景動画にできる動画 */
export const newSongDialog = (o: { title: string; audioFiles: string[]; movies?: string[]; defaults: Partial<NewSongInfo> }) =>
  open<NewSongInfo | null>({ kind: 'newSong', ...o });

/**
 * 中身を自分で描くダイアログ（DTXMania の曲に保存する・Drive に初めて送る など）。done(値) で閉じる。
 * Esc・外を押したら null。render は描くたびに呼ぶので、状態は返す部品の中に持つ
 */
export const customDialog = <T,>(render: (done: (v: T | null) => void) => ReactNode, o: { className?: string } = {}) =>
  open<T | null>({ kind: 'custom', render: render as (done: (v: unknown) => void) => ReactNode, ...o });

export function DialogHost() {
  const spec = useDialog((s) => s.spec);
  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(spec.kind === 'confirm' ? false : null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [spec]);
  if (!spec) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close(spec.kind === 'confirm' ? false : null)}>
      <div className={`modal ${spec.kind === 'custom' ? (spec.className ?? '') : ''}`} role="dialog" aria-modal="true">
        {spec.kind === 'confirm' && (
          <>
            <h2>{spec.title}</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{spec.body}</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => close(false)}>
                {spec.cancel ?? tr('やめる', 'Cancel')}
              </button>
              <button className={`btn ${spec.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}>
                {spec.ok}
              </button>
            </div>
          </>
        )}
        {spec.kind === 'choose' && (
          <>
            <h2>{spec.title}</h2>
            {spec.body && <p style={{ whiteSpace: 'pre-wrap' }}>{spec.body}</p>}
            {spec.options.map((o, i) => (
              <button key={i} className="choice" onClick={() => close(o.value)} autoFocus={i === 0}>
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: 600 }}>{o.label}</span>
                  {o.sub && <span className="lbl">{o.sub}</span>}
                </span>
              </button>
            ))}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => close(null)}>
                {tr('やめる', 'Cancel')}
              </button>
            </div>
          </>
        )}
        {spec.kind === 'prompt' && <PromptBody spec={spec} />}
        {spec.kind === 'newSong' && <NewSongBody spec={spec} />}
        {spec.kind === 'custom' && spec.render(close)}
      </div>
    </div>
  );
}

function PromptBody({ spec }: { spec: Extract<Spec, { kind: 'prompt' }> }) {
  const [v, setV] = useState(spec.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = spec.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : spec.value.length);
  }, [spec.value]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) close(v.trim());
      }}
    >
      <h2>{spec.title}</h2>
      {spec.body && <p>{spec.body}</p>}
      <input ref={ref} className="field" value={v} onChange={(e) => setV(e.target.value)} />
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={() => close(null)}>
          {tr('やめる', 'Cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={!v.trim()}>
          {spec.ok}
        </button>
      </div>
    </form>
  );
}

function NewSongBody({ spec }: { spec: Extract<Spec, { kind: 'newSong' }> }) {
  const d = spec.defaults;
  const [title, setTitle] = useState(d.title ?? '');
  const [artist, setArtist] = useState(d.artist ?? '');
  const [bpm, setBpm] = useState(String(d.bpm ?? 120));
  const [bgm, setBgm] = useState(d.bgmFile ?? spec.audioFiles[0] ?? '');
  // 背景動画にするか（触るまでは、NX で流れる形式ならオン）
  const [movieOn, setMovieOn] = useState<boolean | null>(null);
  const bpmNum = Number(bpm);
  const valid = Number.isFinite(bpmNum) && bpmNum > 0 && bpmNum < 1000;
  // 背景動画にできる動画：原曲に選んだ動画、無ければ最初の動画
  const movie = bgm && isVideoName(bgm) ? bgm : spec.movies?.[0];
  const nxMovie = !!movie && NX_MOVIE_EXT.test(movie);
  const useMovie = movieOn ?? nxMovie;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) close({ title: title.trim(), artist: artist.trim(), bpm: bpmNum, bgmFile: bgm || undefined, movieFile: movie && useMovie ? movie : undefined });
      }}
    >
      <h2>{spec.title}</h2>
      <p>
        {tr(
          'あとで「曲情報」タブからいつでも変えられます。BPMは原曲に合わせておくとグリッドが曲にそろいます。',
          'You can change these any time later in the "Song info" tab. Setting the BPM to match the song lines the grid up with it.',
        )}
      </p>
      <div className="form-grid">
        <span className="lbl">{tr('曲名', 'Title')}</span>
        <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <span className="lbl">{tr('アーティスト', 'Artist')}</span>
        <input className="field" value={artist} onChange={(e) => setArtist(e.target.value)} />
        <span className="lbl">BPM</span>
        <input className="field mono" value={bpm} onChange={(e) => setBpm(e.target.value)} inputMode="decimal" />
        <span className="lbl">{tr('原曲（BGM）', 'Original (BGM)')}</span>
        <select className="field" value={bgm} onChange={(e) => setBgm(e.target.value)}>
          <option value="">{tr('なし', 'None')}</option>
          {spec.audioFiles.map((f) => (
            <option key={f} value={f}>
              {isVideoName(f) ? tr(`${f}（動画の音）`, `${f} (audio of the video)`) : f}
            </option>
          ))}
        </select>
        {isVideoName(bgm) && (
          <span className="lbl" style={{ gridColumn: 2, lineHeight: 1.5 }}>
            {tr(
              `作ると、動画から音だけを取り出して「${audioNameFor(bgm)}」（OGG）にし、原曲にします。ステム分解・スペクトル・耳コピにも使えます`,
              `Creating takes the audio out of the video as "${audioNameFor(bgm)}" (OGG) and uses it as the original. Stem separation, the spectrum and transcription use it too`,
            )}
          </span>
        )}
        {movie && (
          <>
            <span className="lbl">{tr('背景動画', 'Background video')}</span>
            <label className="row lbl" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={useMovie} onChange={(e) => setMovieOn(e.target.checked)} />
              {tr(`「${movie}」を BGA の動画（#AVI01）にする`, `Use "${movie}" as the BGA movie (#AVI01)`)}
            </label>
            <span className="lbl" style={{ gridColumn: 2, lineHeight: 1.5 }}>
              {nxMovie
                ? tr('DTXMania で譜面の後ろに流れます。原曲と同じ所（001 小節の頭）から始めます', 'DTXMania plays it behind the chart, starting together with the original (top of measure 001)')
                : tr('この形式が DTXMania で流れるかは確かめていません（DTXMania の曲データの動画は MP4・AVI）', 'Not checked whether DTXMania plays this format (DTXMania song data uses MP4 or AVI movies)')}
            </span>
          </>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={() => close(null)}>
          {tr('やめる', 'Cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={!valid}>
          {tr('作成', 'Create')}
        </button>
      </div>
    </form>
  );
}
