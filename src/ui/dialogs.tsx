// 確認・選択・新規作成のダイアログ。Promise で結果を返す。
import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { NewSongInfo } from '../store/editor';

export interface ChoiceOption<T> {
  label: string;
  sub?: string;
  value: T;
}

type Spec =
  | { kind: 'confirm'; title: string; body: string; ok: string; cancel?: string; danger?: boolean }
  | { kind: 'choose'; title: string; body?: string; options: ChoiceOption<unknown>[] }
  | { kind: 'prompt'; title: string; body?: string; value: string; ok: string }
  | { kind: 'newSong'; title: string; audioFiles: string[]; defaults: Partial<NewSongInfo> };

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

export const newSongDialog = (o: { title: string; audioFiles: string[]; defaults: Partial<NewSongInfo> }) =>
  open<NewSongInfo | null>({ kind: 'newSong', ...o });

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
      <div className="modal" role="dialog" aria-modal="true">
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
  const bpmNum = Number(bpm);
  const valid = Number.isFinite(bpmNum) && bpmNum > 0 && bpmNum < 1000;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) close({ title: title.trim(), artist: artist.trim(), bpm: bpmNum, bgmFile: bgm || undefined });
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
              {f}
            </option>
          ))}
        </select>
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
