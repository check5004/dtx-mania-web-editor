// タブレット版の「保存と書き出し」（横は中央のカード、縦は下からのシート）。
// iPad の Safari はフォルダに直接書き込めないので、曲フォルダの ZIP・DTX を「共有」（AirDrop・ファイル App）か「ファイルに保存」で渡す。
// 共有は押した直後に呼ばないと Safari に断られるので、選んだらすぐ作っておき、押したらそのまま渡す
import { useEffect, useState } from 'react';
import { tr } from '../../i18n';
import { buildExport, deliverExport, lastAutosaveAt, type ExportFile, type ExportWhat } from '../../app/fileActions';
import { isLocalFolder } from '../../fs/folder';
import { iosName, useDevice } from '../../store/device';
import { useEditor } from '../../store/editor';
import { localPlace, useLocalSongs } from '../../store/localSongs';
import { DriveSaveRow } from '../DriveUi';
import { abbrDiff } from '../TopBar';
import { Icon } from '../icons';
import { closeSaveSheet, useTabletUi } from './shared';

type Enc = 'shift_jis' | 'utf-8-bom';

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Option({ on, title, sub, onClick, children }: { on: boolean; title: string; sub: string; onClick: () => void; children?: React.ReactNode }) {
  return (
    <div className={`t-save-opt ${on ? 'on' : ''}`}>
      <button className="t-save-opt-main" onClick={onClick} role="radio" aria-checked={on}>
        <span className="t-radio">{on && <i />}</span>
        <span className="t-save-opt-text">
          <b>{title}</b>
          <span className="lbl">{sub}</span>
        </span>
      </button>
      {on && children}
    </div>
  );
}

export function SaveSheet() {
  const open = useTabletUi((s) => s.saveSheet);
  if (!open) return null;
  return <SaveSheetBody />;
}

function SaveSheetBody() {
  const portrait = useDevice((s) => s.portrait);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const savedAt = useEditor((s) => s.savedAt);
  useLocalSongs((s) => s.ver);
  // 本体に置いた曲：保存（右上）は本体へ、ここは PC・NX へ渡すための書き出し
  const local = isLocalFolder(folder);
  const title = local ? tr('書き出し・共有', 'Export and share') : tr('保存と書き出し', 'Save and export');
  const [what, setWhat] = useState<ExportWhat>(folder ? 'folder' : 'dtx');
  const [enc, setEnc] = useState<Enc>('shift_jis');
  const [diffs, setDiffs] = useState<string[]>(() => meta.siblings.map((x) => x.file));
  const [ready, setReady] = useState<{ file: ExportFile; lost: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  // 自動保存の時刻を出し直す
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 10000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSaveSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 選んだら作っておく（共有は押した直後でないと Safari が断るため）
  const diffKey = diffs.join('|');
  useEffect(() => {
    let alive = true;
    setReady(null);
    setBusy(true);
    void buildExport(what, { encoding: enc, diffs, ask: false })
      .then((r) => {
        if (alive) setReady(r);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [what, enc, diffKey]);
  const deliver = async (how: 'share' | 'download') => {
    if (!ready) return;
    if (await deliverExport(ready.file, how)) closeSaveSheet();
  };
  const sibs = meta.siblings;
  const toggleDiff = (file: string) => setDiffs((cur) => (cur.includes(file) ? cur.filter((f) => f !== file) : [...cur, file]));
  const mb = ready ? ready.file.bytes.length / 1024 / 1024 : 0;
  const body = (
    <>
      <div className="t-save-head">
        <b>{title}</b>
        <span className="grow" />
        <button className="t-ib" onClick={closeSaveSheet} aria-label={tr('閉じる', 'Close')}>
          {Icon.close(20)}
        </button>
      </div>
      <div className="t-save-auto">
        {Icon.checkCircle(16)}
        <span>
          {local && savedAt ? tr(`${localPlace()}に保存 · ${clock(savedAt)}（音も）　`, `Saved in ${localPlace()} at ${clock(savedAt)} (with audio) · `) : ''}
          {lastAutosaveAt
            ? tr(`自動保存 · ${clock(lastAutosaveAt)} にこのブラウザへ保存済み`, `Autosaved to this browser at ${clock(lastAutosaveAt)}`)
            : tr('自動保存 · 編集するとこのブラウザへ保存します', 'Autosave · edits are kept in this browser')}
        </span>
      </div>
      <DriveSaveRow />
      <div className="t-save-opts" role="radiogroup">
        {folder && (
          <Option
            on={what === 'folder'}
            title={tr('曲フォルダの ZIP（DTX・音・画像）', 'Song folder as ZIP (DTX, sounds, images)')}
            sub={tr('AirDrop・ファイル App・ほかのアプリへ渡せます', 'Send with AirDrop, the Files app or other apps')}
            onClick={() => setWhat('folder')}
          />
        )}
        <Option on={what === 'dtx'} title={tr('この難易度の DTX だけ', "Only this difficulty's DTX")} sub={meta.fileName} onClick={() => setWhat('dtx')} />
        {folder && sibs.length > 1 && (
          <Option
            on={what === 'diffs'}
            title={tr('選んだ難易度の DTX', 'DTX for chosen difficulties')}
            sub={sibs
              .filter((x) => diffs.includes(x.file))
              .map((x) => abbrDiff(x.label))
              .join(' · ') || tr('選んでいません', 'None chosen')}
            onClick={() => setWhat('diffs')}
          >
            <div className="t-save-diffs">
              {sibs.map((x) => (
                <label key={x.file} className={`t-check-row ${diffs.includes(x.file) ? 'on' : ''}`}>
                  <input type="checkbox" checked={diffs.includes(x.file)} onChange={() => toggleDiff(x.file)} />
                  <span>{x.label}</span>
                  <span className="lbl mono">{x.file}</span>
                </label>
              ))}
            </div>
          </Option>
        )}
      </div>
      <div className="t-save-enc">
        <span className="grow">{tr('文字コード', 'Text encoding')}</span>
        <div className="seg t-seg" role="radiogroup">
          <button className={enc === 'shift_jis' ? 'on' : ''} onClick={() => setEnc('shift_jis')} aria-pressed={enc === 'shift_jis'}>
            {tr('Shift_JIS（NX）', 'Shift_JIS (NX)')}
          </button>
          <button className={enc === 'utf-8-bom' ? 'on' : ''} onClick={() => setEnc('utf-8-bom')} aria-pressed={enc === 'utf-8-bom'}>
            UTF-8
          </button>
        </div>
      </div>
      {ready && ready.lost.length > 0 && (
        <p className="t-save-warn">
          {tr(
            `Shift_JIS で表せない文字（${ready.lost.join(' ')}）は「?」になります。曲情報で別の文字にするか、UTF-8 にしてください。`,
            `Characters Shift_JIS can't write (${ready.lost.join(' ')}) become "?". Change them in Song info or choose UTF-8.`,
          )}
        </p>
      )}
      <p className="note">
        {local
          ? tr(
              `「保存」は曲フォルダごと${localPlace()}の中に書きます。PC や NX へ渡すときは、ここから ZIP で書き出します（書き出した内容は${localPlace()}にも保存します）。`,
              `"Save" writes the whole song folder inside ${localPlace()}. To hand it to a PC or NX, export a ZIP here (the exported content is also saved in ${localPlace()}).`,
            )
          : iosName(
              tr(
                'iPad ではフォルダに直接書き込めないため、ZIP にまとめて渡します。PC では今までどおりフォルダに保存できます。',
                'iPad cannot write into a folder directly, so the files go out as a ZIP. On a PC you can still save into the folder.',
              ),
            )}
      </p>
      <div className="t-save-foot">
        <span className="lbl grow">
          {busy ? tr('用意しています…', 'Preparing…') : ready ? `${ready.file.name} · ${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`}` : ''}
        </span>
        <button className="t-btn" disabled={!ready || busy} onClick={() => void deliver('share')}>
          {Icon.share(18)}
          <span>{tr('共有…', 'Share…')}</span>
        </button>
        <button className="t-btn primary" disabled={!ready || busy} onClick={() => void deliver('download')}>
          {Icon.download(18)}
          <span>{tr('ファイルに保存', 'Save to Files')}</span>
        </button>
      </div>
    </>
  );
  return (
    <div className="t-modal-back" onPointerDown={(e) => e.target === e.currentTarget && closeSaveSheet()}>
      <div className={`t-save ${portrait ? 'sheet' : 'card'}`} role="dialog" aria-label={title}>
        {portrait && <span className="t-sheet-handle" />}
        {body}
      </div>
    </div>
  );
}
