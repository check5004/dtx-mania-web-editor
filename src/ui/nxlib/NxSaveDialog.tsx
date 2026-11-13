// 新しい曲を初めて保存するとき（DTXMania の曲を覚えている PC）：どこに保存するかを聞く。
// 「DTXMania の曲に入れる」は、覚えている DTXManiaNX の BOX（または BOX の外）の中にこの曲のフォルダを作る（src/nxlib/save.ts）。
// 「別のフォルダを選ぶ…」「このブラウザの中に保存」は今まで通り。Google Drive に送るかもここで決める（送らないなら印を書く）。
import { pl, tr } from '../../i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { storageQuota } from '../../drive/api';
import { tokenValid, useDriveAuth } from '../../drive/auth';
import { safeFolderName } from '../../fs/songDir';
import { lastNxBox, type NxSaveSpot } from '../../nxlib/save';
import { useNxLib } from '../../nxlib/store';
import { bytesText, saveBoxLabel, saveWhere } from '../../nxlib/view';
import { customDialog } from '../dialogs';
import { Icon } from '../icons';

export interface NxSaveAsk {
  /** 見出しに出す曲名 */
  title: string;
  /** 曲のフォルダの名前（曲名から） */
  name: string;
  /** 「曲フォルダに書き出す」から */
  toFolder: boolean;
  /** 「このブラウザの中に保存」を出す */
  local: boolean;
  /** いまはこのブラウザの中にだけある */
  inBrowser: boolean;
  /** 書くファイル（曲のフォルダからのパス） */
  files: string[];
  /** 合わせた大きさ */
  size: number;
}

export type NxSaveChoice = { where: 'lib'; spot: NxSaveSpot; drive: boolean } | { where: 'pick'; drive: boolean } | { where: 'local'; drive: boolean };

/** どこに保存するかを聞く。やめたら null */
export function nxSaveDialog(o: NxSaveAsk): Promise<NxSaveChoice | null> {
  return customDialog<NxSaveChoice>((done) => <NxSaveBody o={o} done={done} />, { className: 'nx-save' });
}

const CHART = /\.(dtx|gda|g2d|bms|bme|bml)$/i;
/** 初めて送る曲がこれより大きいと、送る前に聞く（src/app/driveActions.ts と同じ） */
const BIG = 100 * 1024 * 1024;

function few(names: string[], max = 5): string {
  const head = names.slice(0, max).join(' · ');
  return names.length > max ? tr(`${head} ほか ${names.length - max} 個`, `${head} and ${names.length - max} more`) : head;
}

interface TreeRow {
  pad: number;
  text: string;
  cls: 'g' | 'n' | 'f';
  note: string;
}

/** 書くファイルの並び（譜面・ほかのファイル・フォルダ） */
function fileRows(files: readonly string[]): TreeRow[] {
  const top: string[] = [];
  const dirs = new Map<string, number>();
  for (const f of files) {
    const i = f.indexOf('/');
    if (i > 0) dirs.set(f.slice(0, i), (dirs.get(f.slice(0, i)) ?? 0) + 1);
    else if (!f.startsWith('.') && !/\.dtxe\.json$/i.test(f)) top.push(f);
  }
  const charts = top.filter((f) => CHART.test(f) || /^set\.def$/i.test(f)).sort((a, b) => (/^set\.def$/i.test(a) ? -1 : /^set\.def$/i.test(b) ? 1 : 0));
  const n = charts.filter((f) => CHART.test(f)).length;
  const others = top.filter((f) => !charts.includes(f));
  const rows: TreeRow[] = [];
  if (charts.length) rows.push({ pad: 28, text: few(charts), cls: 'f', note: tr(`譜面 ${n}`, `${n} ${pl(n, 'chart')}`) });
  if (others.length) rows.push({ pad: 28, text: few(others), cls: 'f', note: tr('原曲・試聴・画像など', 'audio, preview, images…') });
  if (dirs.size) rows.push({ pad: 28, text: few([...dirs].map(([d, c]) => tr(`${d}/（${c}）`, `${d}/ (${c})`))), cls: 'f', note: tr('フォルダ', pl(dirs.size, 'folder')) });
  return rows;
}

function NxSaveBody({ o, done }: { o: NxSaveAsk; done: (v: NxSaveChoice | null) => void }) {
  const place = useNxLib((s) => s.place)!;
  const boxes = useNxLib((s) => s.boxes);
  const songs = useNxLib((s) => s.songs);
  const perm = useNxLib((s) => s.perm);
  const driveOn = useDriveAuth((a) => a.connected && a.onSave);
  const [where, setWhere] = useState<NxSaveChoice['where']>('lib');
  const [box, setBox] = useState(() => {
    const last = lastNxBox();
    return last && boxes.some((b) => b.key === last) ? last : '';
  });
  const [adding, setAdding] = useState(false);
  const [newBox, setNewBox] = useState('');
  const [name, setName] = useState(o.name);
  const [drive, setDrive] = useState(true);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    if (!driveOn || !tokenValid()) return;
    let live = true;
    storageQuota()
      .then((q) => live && q.limit !== null && setFree(Math.max(0, q.limit - q.usage)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [driveOn]);

  const folder = safeFolderName(name);
  const boxName = adding ? newBox.trim() : '';
  // 新しい BOX の名前が、もうある BOX と同じならそれを使う
  const same = boxName ? boxes.find((b) => b.depth === 0 && b.title.toLowerCase() === boxName.toLowerCase()) : undefined;
  const useBox = same ? same.key : adding ? '' : box;
  const makeBox = adding && !same ? boxName : '';
  const segs = useMemo(() => saveWhere(place, songs, boxes, useBox, makeBox || undefined), [place, songs, boxes, useBox, makeBox]);
  const valid = where !== 'lib' || (!!folder && (!adding || !!safeFolderName(boxName)));
  // 木の頭：ゲームのフォルダの名前は外す（DTXFiles / BOX /）
  const head = place.kind === 'game' && segs.length > 1 ? segs.slice(1) : segs;
  const rows: TreeRow[] = [
    { pad: 0, text: `${head.join(' / ')} /`, cls: 'g', note: useBox ? tr('BOX（もうある）', 'BOX (already there)') : makeBox ? tr('BOX（新しく作る）', 'BOX (new)') : tr('BOX の外', 'outside any BOX') },
    { pad: 14, text: `${folder || '…'} /`, cls: 'n', note: tr('新しく作るフォルダ', 'new folder') },
    ...fileRows(o.files),
  ];

  const submit = () => {
    if (!valid) return;
    if (where === 'lib') done({ where, spot: { box: useBox, ...(makeBox ? { newBox: makeBox } : {}), name: folder }, drive });
    else done({ where, drive });
  };

  const opt = (k: NxSaveChoice['where'], label: string, sub: string, badge?: ReactNode, body?: ReactNode) => (
    <div className={`nx-opt ${where === k ? 'on' : ''}`} onClick={() => setWhere(k)}>
      <button type="button" className="nx-radio" role="radio" aria-checked={where === k} aria-label={label} onClick={() => setWhere(k)} />
      <div className="ob">
        <b>
          {label}
          {badge}
        </b>
        <span className="s">{sub}</span>
        {where === k && body}
      </div>
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>{o.toFolder ? tr(`「${o.title}」をどこに書き出しますか？`, `Where do you want to export "${o.title}"?`) : tr(`「${o.title}」をどこに保存しますか？`, `Where do you want to save "${o.title}"?`)}</h2>
      <p>
        {o.inBrowser
          ? tr('この曲は、まだこのブラウザの中にだけあります。DTXMania で遊ぶには、ゲームの曲のフォルダに保存します。', 'This song is only inside this browser so far. To play it in DTXMania, save it into a song folder in the game.')
          : tr('DTXMania で遊ぶには、ゲームの曲のフォルダに保存します。', 'To play it in DTXMania, save it into a song folder in the game.')}
      </p>
      <div role="radiogroup" aria-label={tr('保存する場所', 'Where to save')}>
        {opt(
          'lib',
          tr('DTXMania の曲に入れる（おすすめ）', 'Put it in your DTXMania songs (recommended)'),
          tr(`覚えている「${place.name}」の中に、この曲のフォルダを作って保存します。フォルダを選び直す画面は出ません。`, `A folder for this song is made inside "${place.name}", which this app remembers. No folder picker opens.`),
          <span className="nx-new">{tr('新しく', 'New')}</span>,
          <div className="nx-sv" onClick={(e) => e.stopPropagation()}>
            <div className="nx-sv-fl">
              <span className="k">BOX</span>
              <div className="nx-sv-boxes" role="group" aria-label="BOX">
                {boxes.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    className={`nx-bx ${!adding && box === b.key ? 'on' : ''}`}
                    aria-pressed={!adding && box === b.key}
                    onClick={() => {
                      setAdding(false);
                      setBox(b.key);
                    }}
                  >
                    {saveBoxLabel(b, boxes)}
                  </button>
                ))}
                <button
                  type="button"
                  className={`nx-bx ${!adding && box === '' ? 'on' : ''}`}
                  aria-pressed={!adding && box === ''}
                  onClick={() => {
                    setAdding(false);
                    setBox('');
                  }}
                >
                  {tr('BOX の外', 'Outside any BOX')}
                </button>
                <button type="button" className={`nx-bx add ${adding ? 'on' : ''}`} aria-pressed={adding} onClick={() => setAdding(true)}>
                  {tr('＋ 新しい BOX…', '+ New BOX…')}
                </button>
              </div>
            </div>
            {adding && (
              <div className="nx-sv-fl">
                <span className="k">{tr('新しい BOX', 'New BOX')}</span>
                <div className="nx-sv-field">
                  <input value={newBox} onChange={(e) => setNewBox(e.target.value)} placeholder={tr('BOX の名前（DTXMania の曲選びに出ます）', 'BOX name (shown in DTXMania song select)')} aria-label={tr('新しい BOX の名前', 'New BOX name')} autoFocus />
                  {same && <span className="lbl">{tr('もうある BOX に入れます', 'Uses the BOX already there')}</span>}
                </div>
              </div>
            )}
            <div className="nx-sv-fl">
              <span className="k">{tr('フォルダの名前', 'Folder name')}</span>
              <div className="nx-sv-field">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label={tr('曲のフォルダの名前', 'Song folder name')} spellCheck={false} />
                {name === o.name && <span className="lbl">{tr('曲名から', 'from the title')}</span>}
              </div>
            </div>
            <div className="nx-sv-tree mono" aria-label={tr('書くフォルダとファイル', 'Folders and files to write')}>
              {rows.map((r, i) => (
                <div key={i} className="r" style={{ paddingLeft: r.pad }}>
                  <span className={r.cls}>{r.text}</span>
                  <span className="c">{r.note}</span>
                </div>
              ))}
            </div>
            <div className="nx-sv-note">
              {Icon.shield(14)}
              <span>
                {tr(`DTXFiles や BOX の直下には書きません。書くのは「${folder || '…'}」フォルダの中だけです。`, `Nothing is written directly in DTXFiles or a BOX. Only the "${folder || '…'}" folder is written to.`)}
                {makeBox && tr(`（新しい BOX は「${makeBox}」フォルダと box.def を作ります）`, ` (A new BOX makes a "${makeBox}" folder and a box.def.)`)}
                {perm !== 'granted' && tr(' 保存するときに、Chrome が読み書きの許可を 1 回聞きます。', ' Chrome asks once for permission to read and write when you save.')}
              </span>
            </div>
          </div>,
        )}
        {opt('pick', tr('別のフォルダを選ぶ…', 'Choose another folder…'), tr('今まで通りです。選んだフォルダの中に、この曲のフォルダを作ります。', 'As before. A folder for this song is made inside the folder you choose.'))}
        {o.local && opt('local', tr('このブラウザの中に保存', 'Save inside this browser'), tr('DTXMania の曲には入りません。あとで「ファイル › 曲フォルダに書き出す」で移せます。', "It isn't added to the DTXMania songs. Move it later with File › Export to a song folder."))}
      </div>
      {driveOn && (
        <label className="nx-sv-drv">
          <input type="checkbox" checked={drive} onChange={(e) => setDrive(e.target.checked)} />
          <span className="ob">
            <b>{tr('保存したら、この曲のフォルダだけ Google Drive にも送る', 'After saving, also send just this song folder to Google Drive')}</b>
            <span className="s">
              {tr(`約 ${bytesText(o.size)}`, `About ${bytesText(o.size)}`)}
              {free !== null && tr(` · Drive の空き ${bytesText(free)}`, ` · ${bytesText(free)} free on Drive`)}
              {tr('。ほかの曲や DTXFiles・BOX は送りません。', '. Other songs, DTXFiles and BOXes are not sent.')}
              {o.size > BIG && tr('100 MB をこえるので、送る前にもう一度聞きます。', ' It is over 100 MB, so you are asked again before sending.')}
            </span>
          </span>
        </label>
      )}
      <div className="modal-actions nx-sv-acts">
        {where === 'lib' && <span className="lbl nx-sv-where">{tr(`書く所：${[...segs, folder || '…'].join(' › ')}`, `Writes to: ${[...segs, folder || '…'].join(' › ')}`)}</span>}
        <button type="button" className="btn ghost" onClick={() => done(null)}>
          {tr('やめる', 'Cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={!valid} autoFocus>
          {where === 'pick' ? tr('場所を選ぶ…', 'Choose a place…') : o.toFolder ? tr('書き出す', 'Export') : tr('保存する', 'Save')}
        </button>
      </div>
    </form>
  );
}
