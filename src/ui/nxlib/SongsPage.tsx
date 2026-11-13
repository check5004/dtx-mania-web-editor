// 「DTXMania の曲」の画面（PC の Chrome・Edge）。左に BOX としぼりこみ、まんなかに曲の一覧、右に選んだ曲。
// 一覧は src/nxlib/store.ts、見せ方は src/nxlib/view.ts、することは src/nxlib/actions.ts。
import { tr, pl, locale } from '../../i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { storageQuota } from '../../drive/api';
import { tokenValid, useDriveAuth } from '../../drive/auth';
import { openNxGen, openNxSong, nxPreviewLoader } from '../../nxlib/actions';
import type { LibSong } from '../../nxlib/scan';
import { ensureNxPerm, forgetNxPlace, laterNxExtra, pickNxExtra, pickNxPlace, refreshDrafts, rescanNx, setNxView, stopNxScan, useNxLib, type NxState } from '../../nxlib/store';
import { boxCounts, bpmText, bytesText, chartCount, chartIn, filterCounts, NX_FILTERS, viewSongs, type NxFilter, type NxSort } from '../../nxlib/view';
import { toggleAudition, useStopAuditionOnClose } from '../../store/audition';
import { goHome, useEditor } from '../../store/editor';
import { confirmDialog } from '../dialogs';
import { Icon } from '../icons';
import { LangSwitch } from '../LangSwitch';
import { LogoMark } from '../LogoMark';
import { NxDetail, NxScanInfo } from './NxDetail';
import { songPills, SlotChips, Thumb, updText } from './parts';
import { songKey, syncedSongs, usePcSync } from '../../sync/store';
import { recentChanges, scopeName, type RecentChange } from '../sync/common';
import { SyncChip, SyncSideCard, syncedFolders, withSyncPills } from '../sync/parts';

const ROW = 62;

export function filterName(f: NxFilter): string {
  switch (f) {
    case 'missing':
      return tr('難易度が足りない', 'Missing difficulties');
    case 'edited':
      return tr('エディタで直した', 'Edited in the editor');
    case 'ai':
      return tr('AI で作った難易度あり', 'Has AI-made difficulties');
    case 'drive':
      return usePcSync.getState().settings.on ? tr('同期する曲', 'Synced songs') : tr('Google Drive にある', 'On Google Drive');
    case 'synced':
      return tr('同期で変わった曲', 'Changed by sync');
    case 'draft':
      return tr('保存していない続き', 'Unsaved changes');
    case 'checks':
      return tr('点検のある曲', 'Songs with issues');
  }
}

export const FILTER_COLOR: Record<NxFilter, string> = { missing: '#b78cff', edited: '#4cc2ff', ai: '#c9b3ff', drive: '#5bd69a', synced: '#5fd4cf', draft: '#ffc768', checks: '#ff9a5c' };

/** 出すしぼりこみ（「同期で変わった曲」は PC どうしの同期をしているときだけ） */
export function shownFilters(syncOn: boolean): NxFilter[] {
  return NX_FILTERS.filter((f) => f !== 'synced' || syncOn);
}

/** 同期で変わった曲（しぼりこみ・数） */
export function useSyncedSet(): ReadonlySet<string> | undefined {
  const on = usePcSync((s) => s.settings.on);
  const log = usePcSync((s) => s.log);
  return useMemo(() => (on ? syncedSongs(log) : undefined), [on, log]);
}

function sortName(s: NxSort): string {
  switch (s) {
    case 'updated':
      return tr('更新日（新しい順）', 'Updated (newest first)');
    case 'title':
      return tr('曲名', 'Title');
    case 'artist':
      return tr('アーティスト', 'Artist');
    case 'bpm':
      return tr('BPM（速い順）', 'BPM (fastest first)');
    case 'level':
      return tr('レベル（高い順）', 'Level (highest first)');
    case 'checks':
      return tr('点検の多い順', 'Most issues first');
  }
}

const SORTS: NxSort[] = ['updated', 'title', 'artist', 'bpm', 'level', 'checks'];

function useView() {
  const songs = useNxLib((s) => s.songs);
  const q = useNxLib((s) => s.q);
  const sort = useNxLib((s) => s.sort);
  const box = useNxLib((s) => s.box);
  const filter = useNxLib((s) => s.filter);
  const drafts = useNxLib((s) => s.drafts);
  const synced = useSyncedSet();
  return useMemo(() => viewSongs(songs, { q, sort, box, filter, drafts, synced }), [songs, q, sort, box, filter, drafts, synced]);
}

function permText(st: Pick<NxState, 'perm'>, atStart: boolean): string {
  if (st.perm !== 'granted') return tr('まだ（開く・読み直すときに聞きます）', 'Not yet (asked when you open or reload)');
  return atStart ? tr('毎回許可（Chrome）', 'Allowed on every visit (Chrome)') : tr('許可済み', 'Allowed');
}

/** 開いたときから許可があった（Chrome が「毎回許可」を覚えている） */
let grantedAtStart: boolean | null = null;

export function SongsPage() {
  const place = useNxLib((s) => s.place);
  const ready = useNxLib((s) => s.ready);
  const perm = useNxLib((s) => s.perm);
  const songs = useNxLib((s) => s.songs);
  const scan = useNxLib((s) => s.scan);
  const sel = useNxLib((s) => s.sel);
  const filter = useNxLib((s) => s.filter);
  const outsideLater = useNxLib((s) => s.outsideLater);
  const list = useView();
  const searchRef = useRef<HTMLInputElement>(null);
  useStopAuditionOnClose('nx:');
  if (ready && grantedAtStart === null) grantedAtStart = perm === 'granted';

  // 開いたら：許可があれば裏で変わった曲だけ読み直す（前の一覧はすぐ出す）。保存していない続きも見直す
  useEffect(() => {
    void refreshDrafts();
    const st = useNxLib.getState();
    if (st.place && st.perm === 'granted' && !st.scan && Date.now() - st.at > 30_000) void rescanNx();
  }, [ready]);

  const selSong = list.find((s) => s.id === sel) ?? null;

  // キー：↑↓ で選ぶ、Enter で開く、Space で試聴、/ で探す、Esc で探す言葉・しぼりこみを外す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal-back, .ps-drawer-back')) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const st = useNxLib.getState();
      const cur = list.findIndex((s) => s.id === st.sel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (typing && t?.tagName !== 'INPUT') return;
        e.preventDefault();
        const next = list[Math.max(0, Math.min(list.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) setNxView({ sel: next.id });
        return;
      }
      if (e.key === 'Enter' && (!typing || t?.tagName === 'INPUT')) {
        const s = list[cur];
        if (s) {
          e.preventDefault();
          void openNxSong(s);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (st.q) setNxView({ q: '' });
        else if (st.filter) setNxView({ filter: null });
        else if (typing) t?.blur();
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === ' ') {
        const s = list[cur];
        if (s?.preview) {
          e.preventDefault();
          void toggleAudition(`nx:${s.id}`, nxPreviewLoader(s));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list]);

  if (!ready) return <div className="nx-app nx-loading" />;
  if (!place) return <NxFirst />;

  const firstScan = !!scan?.first;
  const outside = place.extra.map((x, i) => ({ ...x, i })).filter((x) => !x.dir);
  return (
    <div className="nx-app">
      <NxTop />
      <NxTool searchRef={searchRef} shown={list.length} />
      <NxSide />
      <div className="nx-list">
        {perm !== 'granted' && (
          <div className="nx-notice info">
            {Icon.info(14)}
            <div>
              <span>
                {tr(
                  '前回の一覧を出しています。曲を開く・読み直すときに、Chrome が読み書きの許可を 1 回聞きます（「毎回許可する」を選ぶと、次からは聞かれません）。',
                  'Showing the list from last time. Chrome asks once for permission to read and write when you open a song or reload ("Allow on every visit" stops it asking).',
                )}
              </span>
              <div className="nx-notice-acts">
                <button
                  className="btn small primary"
                  onClick={async () => {
                    if (await ensureNxPerm()) void rescanNx();
                  }}
                >
                  {tr('続ける', 'Continue')}
                </button>
              </div>
            </div>
          </div>
        )}
        {outside.length > 0 && !outsideLater && (
          <div className="nx-notice">
            {Icon.warn(14)}
            <div>
              <span>
                {tr('Config.ini の DTXPath にある ', 'DTXPath in Config.ini has ')}
                <b className="mono">{outside.map((x) => x.path).join(tr('・', ', '))}</b>
                {tr(
                  ' は、選んだフォルダの外です。ブラウザはそこを自分では開けないので、そのフォルダも選んでください（DTXMania と同じ曲がそろいます）。',
                  ', outside the chosen folder. The browser can’t open it by itself, so please choose that folder too (to get the same songs as DTXMania).',
                )}
              </span>
              <div className="nx-notice-acts">
                {outside.map((x) => (
                  <button key={x.i} className="btn small nx-amber" onClick={() => void pickNxExtra(x.i)}>
                    {outside.length > 1 ? tr(`${x.path} を選ぶ…`, `Choose ${x.path}…`) : tr('そのフォルダを選ぶ…', 'Choose that folder…')}
                  </button>
                ))}
                <button className="btn small ghost" onClick={laterNxExtra}>
                  {tr('あとで', 'Later')}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="nx-lh">
          <span className="c-song">{tr('曲', 'Song')}</span>
          <span className="c-chips">{tr('難易度とレベル', 'Difficulties and levels')}</span>
          <span className="c-more" />
          <span className="c-bpm">BPM</span>
          <span className="c-upd">{tr('更新', 'Updated')}</span>
        </div>
        {list.length === 0 && !scan ? (
          <div className="nx-empty">
            {songs.length === 0 ? (
              <>
                <b>{tr('曲がまだありません', 'No songs yet')}</b>
                <span className="lbl">
                  {perm === 'granted'
                    ? tr('「読み直す」で探すか、別のフォルダを選んでください。', 'Use "Reload" to search, or choose another folder.')
                    : tr('「続ける」で読み書きを許可すると、曲を探します。', 'Press "Continue" to allow access and search for songs.')}
                </span>
              </>
            ) : (
              <>
                <b>{tr('条件に合う曲がありません', 'No songs match')}</b>
                <button className="btn small" onClick={() => setNxView({ q: '', filter: null, box: null })}>
                  {tr('しぼりこみを外す', 'Clear filters')}
                </button>
              </>
            )}
          </div>
        ) : (
          <SongRows list={list} skeleton={firstScan ? 5 : 0} issues={filter === 'checks'} />
        )}
      </div>
      <div className="nx-det scroll">{firstScan ? <NxScanInfo /> : selSong ? <NxDetail key={selSong.id} s={selSong} /> : <NxNoSel />}</div>
      <NxFoot />
    </div>
  );
}

function NxNoSel() {
  return (
    <div className="nx-det-in nx-nosel">
      <span className="lbl">{tr('曲を選ぶと、ここに難易度とレベル・成績・点検が出ます。', 'Choose a song to see its difficulties, levels, records and checks here.')}</span>
      <span className="lbl">{tr('↑↓ で選ぶ · Enter で開く · Space で試聴 · / で探す', '↑↓ to choose · Enter to open · Space to preview · / to search')}</span>
    </div>
  );
}

/** 場所をまだ選んでいない（ホームのカードからも同じことができる） */
function NxFirst() {
  return (
    <div className="nx-app nx-first-wrap">
      <NxTop />
      <div className="nx-first">
        <h2>{tr('DTXMania の曲をまとめて扱う', 'Work with all your DTXMania songs')}</h2>
        <p>
          {tr(
            'DTXMania のフォルダを覚えると、ゲームに入っている曲を、画像・難易度・レベルの一覧から開いて直せます。新しい曲も、その中に保存できます。',
            'Remember your DTXMania folder to open and fix the songs in the game from a list with images, difficulties and levels. New songs can be saved into it too.',
          )}
        </p>
        <NxPickButton />
        <NxPromises />
      </div>
    </div>
  );
}

export function NxPickButton({ after }: { after?: () => void }) {
  return (
    <div className="nx-pick">
      <button
        className="btn primary"
        onClick={async () => {
          if (await pickNxPlace()) after?.();
        }}
      >
        {Icon.folder()} {tr('DTXMania のフォルダを選ぶ…', 'Choose the DTXMania folder…')}
      </button>
      <span className="lbl">{tr('DTXMania の .exe のあるフォルダか、DTXFiles のどちらでも', 'Either the folder with the DTXMania .exe or DTXFiles')}</span>
    </div>
  );
}

/** 読むもの・書くもの・Drive の約束 */
export function NxPromises() {
  return (
    <ul className="nx-promises">
      <li>
        {Icon.eye(14)}
        <span>{tr('読むのは名前と小さいファイル（set.def・譜面・成績・画像）だけ。音や動画は読みません。', 'Only names and small files are read (set.def, charts, records, images). No audio or video.')}</span>
      </li>
      <li>
        {Icon.pencil(14)}
        <span>{tr('書くのは、あなたが保存したときだけ。DTXFiles や BOX の直下には書かず、曲のフォルダの中に書きます。', 'Writing happens only when you save, inside the song’s own folder, never straight into DTXFiles or a BOX.')}</span>
      </li>
      <li>
        {Icon.cloud(14)}
        <span>{tr('Google Drive には、読み込みでも開いただけでも送りません。保存した曲だけ、その曲のフォルダを送ります。', 'Nothing goes to Google Drive when reading or just opening. Only a song you save is sent, as that song’s folder.')}</span>
      </li>
    </ul>
  );
}

function NxTop() {
  const place = useNxLib((s) => s.place);
  const scan = useNxLib((s) => s.scan);
  const perm = useNxLib((s) => s.perm);
  const hasDoc = useEditor((s) => s.doc.header.length > 0 || s.doc.chips.length > 0);
  const [menu, setMenu] = useState(false);
  return (
    <header className="nx-top">
      <button className="ib" onClick={goHome} title={tr('ホームに戻る', 'Back to home')} aria-label={tr('ホームに戻る', 'Back to home')}>
        {Icon.chevronLeft(16)}
      </button>
      <LogoMark />
      <span className="nx-title">
        <b>{tr('DTXMania の曲', 'DTXMania songs')}</b>
        <span className="lbl">{tr('ゲームに入っている曲を開いて直す', 'Open and fix the songs in the game')}</span>
      </span>
      {place && (
        <span className="nx-crumb" title={place.name}>
          {Icon.folder(13)}
          {place.name}
          <span className="dim">{place.kind === 'game' ? tr('（ゲームのフォルダ）', ' (game folder)') : tr('（曲のフォルダ）', ' (songs folder)')}</span>
        </span>
      )}
      <span className="grow" />
      <SyncChip />
      {place && (
        <button
          className="btn"
          disabled={!!scan}
          onClick={async () => {
            if (perm === 'granted' || (await ensureNxPerm())) void rescanNx({ full: true });
          }}
          title={tr('全部の曲を読み直します（DTXMania の「Reload Songs」と同じ）', 'Re-reads every song (like "Reload Songs" in DTXMania)')}
        >
          {Icon.refresh(14)}
          {tr('読み直す', 'Reload')}
        </button>
      )}
      {place && (
        <span className="nx-menu-wrap">
          <button className="btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            {Icon.sliders(14)}
            {tr('曲のある場所', 'Song location')}
          </button>
          {menu && <PlaceMenu close={() => setMenu(false)} />}
        </span>
      )}
      <LangSwitch small />
      {hasDoc && (
        <button className="btn" onClick={() => useEditor.setState({ screen: 'editor' })}>
          {tr('編集中の譜面に戻る', 'Back to the open chart')}
        </button>
      )}
    </header>
  );
}

function PlaceMenu({ close }: { close: () => void }) {
  const place = useNxLib((s) => s.place);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.nx-menu-wrap')) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [close]);
  if (!place) return null;
  return (
    <div className="nx-pop" ref={ref} role="menu">
      <button
        role="menuitem"
        onClick={() => {
          close();
          void pickNxPlace();
        }}
      >
        <b>{tr('別のフォルダを選ぶ…', 'Choose another folder…')}</b>
        <span className="lbl">{tr('ゲームのフォルダ（DTXMania の .exe のある所）か DTXFiles', 'The game folder (with the DTXMania .exe) or DTXFiles')}</span>
      </button>
      {place.extra.map((x, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => {
            close();
            void pickNxExtra(i);
          }}
        >
          <b className="mono">{x.dir ? tr(`${x.path} を選び直す…`, `Choose ${x.path} again…`) : tr(`${x.path} を選ぶ…`, `Choose ${x.path}…`)}</b>
          <span className="lbl">{tr('Config.ini の DTXPath にある、選んだフォルダの外の場所', 'A place in DTXPath outside the chosen folder')}</span>
        </button>
      ))}
      <button
        role="menuitem"
        onClick={async () => {
          close();
          const ok = await confirmDialog({
            title: tr('このフォルダを忘れますか？', 'Forget this folder?'),
            body: tr(
              `「${place.name}」と曲の一覧・小さい画像を、このブラウザから消します。フォルダのファイルは何も変わりません。`,
              `"${place.name}", the song list and the small images are removed from this browser. Nothing in the folder changes.`,
            ),
            ok: tr('忘れる', 'Forget'),
            danger: true,
          });
          if (ok) await forgetNxPlace();
        }}
      >
        <b>{tr('このフォルダを忘れる', 'Forget this folder')}</b>
        <span className="lbl">{tr('一覧と小さい画像をこのブラウザから消します（ファイルは消えません）', 'Removes the list and images from this browser (files stay)')}</span>
      </button>
    </div>
  );
}

function NxTool({ searchRef, shown }: { searchRef: React.RefObject<HTMLInputElement | null>; shown: number }) {
  const q = useNxLib((s) => s.q);
  const sort = useNxLib((s) => s.sort);
  const filter = useNxLib((s) => s.filter);
  const songs = useNxLib((s) => s.songs);
  const drafts = useNxLib((s) => s.drafts);
  const scan = useNxLib((s) => s.scan);
  const checking = useNxLib((s) => s.checking);
  const at = useNxLib((s) => s.at);
  const changed = useNxLib((s) => s.changed);
  const prevFolders = useNxLib((s) => s.folders);
  const synced = useSyncedSet();
  const syncOn = usePcSync((s) => s.settings.on);
  const counts = useMemo(() => (filter ? filterCounts(songs, drafts, synced) : null), [filter, songs, drafts, synced]);
  const syncN = useMemo(() => (syncOn ? syncedFolders(songs).n : 0), [syncOn, songs]);
  const n = songs.length;
  const charts = useMemo(() => chartCount(songs), [songs]);
  const time = at ? new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="nx-tool">
      <label className="nx-search">
        {Icon.search(14)}
        <input
          ref={searchRef}
          value={q}
          placeholder={tr('曲名・アーティスト・フォルダで探す', 'Search by title, artist or folder')}
          onChange={(e) => setNxView({ q: e.target.value })}
          aria-label={tr('曲を探す', 'Search songs')}
        />
        {q ? (
          <button className="ib nx-x" onClick={() => setNxView({ q: '' })} aria-label={tr('消す', 'Clear')}>
            {Icon.close(11)}
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </label>
      <label className="nx-sel">
        <span className="lbl">{tr('並べ替え', 'Sort')}</span>
        <select value={sort} onChange={(e) => setNxView({ sort: e.target.value as NxSort })}>
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {sortName(s)}
            </option>
          ))}
        </select>
      </label>
      {filter && (
        <span className="nx-fchip" style={{ '--c': FILTER_COLOR[filter] } as CSSProperties}>
          <i className="dot" />
          {filterName(filter)} {counts?.[filter] ?? ''}
          <button className="ib" onClick={() => setNxView({ filter: null })} aria-label={tr('しぼりこみを外す', 'Clear the filter')}>
            {Icon.close(10)}
          </button>
        </span>
      )}
      <span className="grow" />
      {scan ? (
        <span className="nx-prog-wrap">
          <span className="nx-prog-t">
            {tr('読み込み中', 'Reading')}　{tr('曲', 'songs')} <b className="mono">{scan.songs.toLocaleString()}</b> · {tr('フォルダ', 'folders')} <span className="mono">{scan.folders.toLocaleString()}</span>
          </span>
          <span className={`nx-prog ${scan.first ? 'any' : ''}`}>
            <i style={scan.first ? undefined : { width: `${Math.min(100, (scan.folders / Math.max(1, prevFolders)) * 100)}%` }} />
          </span>
          <button className="btn small" onClick={stopNxScan}>
            {tr('止める', 'Stop')}
          </button>
        </span>
      ) : (
        <span className="lbl nx-count">
          {shown !== n ? tr(`${shown} 曲 / ${n} 曲`, `${shown} of ${n} songs`) : tr(`${n.toLocaleString()} 曲 · 譜面 ${charts.toLocaleString()}`, `${n.toLocaleString()} ${pl(n, 'song')} · ${charts.toLocaleString()} ${pl(charts, 'chart')}`)}
          {syncOn && shown === n && tr(` · 同期する曲 ${syncN}`, ` · ${syncN} synced`)}
          {time && shown === n && tr(` · ${time} に読み込み`, ` · read ${time}`)}
          {changed > 0 && changed < n && shown === n && tr(`（変わった曲 ${changed} を読み直し）`, ` (${changed} changed ${pl(changed, 'song')} re-read)`)}
          {checking && tr(` · 点検中 ${checking.done}/${checking.total}`, ` · checking ${checking.done}/${checking.total}`)}
        </span>
      )}
    </div>
  );
}

function NxSide() {
  const songs = useNxLib((s) => s.songs);
  const boxes = useNxLib((s) => s.boxes);
  const drafts = useNxLib((s) => s.drafts);
  const box = useNxLib((s) => s.box);
  const filter = useNxLib((s) => s.filter);
  const place = useNxLib((s) => s.place);
  const perm = useNxLib((s) => s.perm);
  const scan = useNxLib((s) => s.scan);
  const syncOn = usePcSync((s) => s.settings.on);
  const synced = useSyncedSet();
  const bc = useMemo(() => boxCounts(songs), [songs]);
  const fc = useMemo(() => filterCounts(songs, drafts, synced), [songs, drafts, synced]);
  const outsideN = bc.get('') ?? 0;
  return (
    <nav className="nx-side scroll">
      <div className="nx-sh">BOX</div>
      <button className={`nx-si ${box === null ? 'on' : ''}`} onClick={() => setNxView({ box: null })}>
        {Icon.box(14)}
        <span className="ellipsis">{tr('すべて', 'All')}</span>
        <span className="n">{songs.length}</span>
      </button>
      {boxes.map((b) => (
        <button key={b.key} className={`nx-si ${box === b.key ? 'on' : ''}`} style={{ paddingLeft: 8 + b.depth * 12 }} onClick={() => setNxView({ box: b.key })} title={b.dirName}>
          {Icon.box(14)}
          <span className="ellipsis">{b.title}</span>
          {b.dot && <span className="tag">{b.dirName}</span>}
          <span className="n">{bc.get(b.key) ?? 0}</span>
        </button>
      ))}
      {boxes.length > 0 && outsideN > 0 && (
        <button className={`nx-si ${box === '' ? 'on' : ''}`} onClick={() => setNxView({ box: '' })}>
          {Icon.box(14)}
          <span className="ellipsis">{tr('BOX の外', 'Outside any BOX')}</span>
          <span className="n">{outsideN}</span>
        </button>
      )}
      <div className="nx-sh" style={{ marginTop: 6 }}>
        {tr('しぼりこみ', 'Filters')}
      </div>
      {shownFilters(syncOn).map((f) => (
        <button
          key={f}
          className={`nx-si ${filter === f ? 'on' : ''}`}
          onClick={() => setNxView(filter === f ? { filter: null } : { filter: f, ...(f === 'checks' ? { sort: 'checks' as NxSort } : {}) })}
          aria-pressed={filter === f}
        >
          <i className="dot" style={{ background: FILTER_COLOR[f] }} />
          <span className="ellipsis">{filterName(f)}</span>
          <span className="n">{scan?.first ? '—' : fc[f]}</span>
        </button>
      ))}
      <SyncSideCard />
      {place && (
        <div className="nx-where">
          <div className="h">
            {Icon.folder(13)}
            {tr('曲のある場所', 'Song location')}
          </div>
          <div className="k">
            <span>{tr('フォルダ', 'Folder')}</span>
            <b className="ellipsis">{place.name}</b>
          </div>
          {place.kind === 'game' && (
            <div className="k">
              <span>DTXPath</span>
              <b className="mono ellipsis" title={place.dtxPath.join(' ; ')}>
                {place.dtxPath.join(' ; ')}
              </b>
            </div>
          )}
          <div className="k">
            <span>{tr('読み書き', 'Access')}</span>
            <b>{permText({ perm }, !!grantedAtStart)}</b>
          </div>
        </div>
      )}
    </nav>
  );
}

function SongRows({ list, skeleton, issues }: { list: LibSong[]; skeleton: number; issues: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(800);
  const sel = useNxLib((s) => s.sel);
  const thumbs = useNxLib((s) => s.thumbs);
  const drafts = useNxLib((s) => s.drafts);
  const syncOn = usePcSync((s) => s.settings.on);
  const log = usePcSync((s) => s.log);
  const changes = useMemo(() => (syncOn ? recentChanges(log) : null), [syncOn, log]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // キーで選んだ曲が見えるように
  useEffect(() => {
    const el = ref.current;
    const i = list.findIndex((s) => s.id === sel);
    if (!el || i < 0) return;
    const y = i * ROW;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
  }, [sel, list]);
  const start = Math.max(0, Math.floor(top / ROW) - 6);
  const end = Math.min(list.length, Math.ceil((top + height) / ROW) + 6);
  return (
    <div className="nx-rows scroll" ref={ref} onScroll={(e) => setTop(e.currentTarget.scrollTop)} role="listbox" aria-label={tr('曲の一覧', 'Song list')}>
      <div style={{ height: (list.length + skeleton) * ROW, position: 'relative' }}>
        {list.slice(start, end).map((s, i) => (
          <SongRow key={s.id} s={s} y={(start + i) * ROW} on={s.id === sel} thumb={thumbs[s.id]} draft={(drafts[s.id]?.length ?? 0) > 0} issues={issues} sync={changes ? { change: changes.get(songKey(s)) } : undefined} />
        ))}
        {Array.from({ length: skeleton }, (_, i) => (
          <div key={`sk${i}`} className="nx-row skel" style={{ top: (list.length + i) * ROW }} aria-hidden="true">
            <span className="nx-thumb" />
            <span className="nx-tt">
              <i className="sk" style={{ width: 150 + ((i * 37) % 90), height: 12 }} />
              <i className="sk" style={{ width: 190 + ((i * 53) % 70), height: 10 }} />
            </span>
            <span className="nx-chips">
              {[0, 1, 2, 3].map((k) => (
                <span key={k} className="nx-dc skel" />
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SongRow({ s, y, on, thumb, draft, issues, sync }: { s: LibSong; y: number; on: boolean; thumb?: string; draft: boolean; issues: boolean; sync?: { change?: RecentChange } }) {
  const pills = sync && !issues ? withSyncPills(songPills(s, draft, issues), s, sync.change) : songPills(s, draft, issues);
  const more = s.charts.filter((c) => !c.slot).length;
  return (
    <div
      className={`nx-row ${on ? 'on' : ''} ${s.drums === false ? 'dim' : ''}`}
      style={{ top: y }}
      role="option"
      aria-selected={on}
      onClick={() => setNxView({ sel: s.id })}
      onDoubleClick={() => void openNxSong(s)}
    >
      {on && <i className="acc" />}
      <Thumb s={s} url={thumb} />
      <span className="nx-tt">
        <span className="nx-name-line">
          <span className="name">{s.title || tr('曲名なし', 'Untitled')}</span>
          {pills.map((p, i) => (
            <span key={i} className={`nx-pill ${p.k}`} title={p.title}>
              {p.icon === 'cloud' ? Icon.cloud(10) : p.icon === 'down' ? Icon.arrowDown(10) : null}
              {p.label}
            </span>
          ))}
        </span>
        <span className="sub">
          {s.artist}
          <span className="p">{s.path.join('/')}</span>
        </span>
      </span>
      <SlotChips
        s={s}
        onOpen={(k) => {
          setNxView({ sel: s.id });
          void openNxSong(s, chartIn(s, k));
        }}
        onAdd={(k) => {
          setNxView({ sel: s.id });
          void openNxGen(s, k);
        }}
      />
      <span className="nx-more">{more > 0 && <span title={tr(`ほかの難易度 ${more}`, `${more} more ${pl(more, 'difficulty', 'difficulties')}`)}>+{more}</span>}</span>
      <span className="nx-bpm mono">{bpmText(s.bpm)}</span>
      <span className="nx-upd">{updText(s.updated)}</span>
    </div>
  );
}

function NxFoot() {
  const place = useNxLib((s) => s.place);
  const perm = useNxLib((s) => s.perm);
  const songs = useNxLib((s) => s.songs);
  const scan = useNxLib((s) => s.scan);
  const connected = useDriveAuth((a) => a.connected);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    if (!connected || !tokenValid()) return;
    let live = true;
    storageQuota()
      .then((q) => live && q.limit !== null && setFree(q.limit - q.usage))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connected]);
  const syncOn = usePcSync((s) => s.settings.on);
  const syncPc = usePcSync((s) => s.settings.pc);
  const syncScope = usePcSync((s) => s.settings.scope);
  const linked = songs.filter((s) => s.drive?.state === 'linked' && !s.drive.play);
  const bytes = linked.reduce((a, s) => a + (s.drive?.bytes ?? 0), 0);
  const synced = useMemo(() => syncedFolders(songs), [songs]);
  return (
    <footer className="nx-statusbar">
      {place && (
        <span>
          {place.name}
          {tr('：', ': ')}
          <b>{perm === 'granted' ? tr('読み書きを許可', 'read and write allowed') : tr('許可はまだ', 'not allowed yet')}</b>
          {perm === 'granted' && grantedAtStart ? tr('（毎回許可）', ' (every visit)') : ''}
        </span>
      )}
      <span>
        Google Drive{tr('：', ': ')}
        {scan?.first ? (
          <b>{tr('読み込みでは何も送りません', 'nothing is sent while reading')}</b>
        ) : connected && syncOn ? (
          <>
            <b>{tr('PC どうしで同期', 'synced between PCs')}</b>
            {syncPc && tr(`（${syncPc}）`, ` (${syncPc})`)}
            {tr(` · ${scopeName({ scope: syncScope })} ${synced.n}（${bytesText(synced.bytes)}）`, ` · ${scopeName({ scope: syncScope })}: ${synced.n} (${bytesText(synced.bytes)})`)}
            {free !== null && tr(` · 空き ${bytesText(Math.max(0, free))}`, ` · ${bytesText(Math.max(0, free))} free`)}
          </>
        ) : connected ? (
          <>
            <b>{tr('保存した曲だけ送る', 'only songs you save are sent')}</b>
            {tr(` · 送った曲 ${linked.length}（${bytesText(bytes)}）`, ` · ${linked.length} ${pl(linked.length, 'song')} sent (${bytesText(bytes)})`)}
            {free !== null && tr(` · 空き ${bytesText(Math.max(0, free))}`, ` · ${bytesText(Math.max(0, free))} free`)}
          </>
        ) : (
          <b>{tr('つないでいません（何も送りません）', 'not connected (nothing is sent)')}</b>
        )}
      </span>
      <span className="grow" />
      <span>
        {scan?.first
          ? tr('初めての読み込みです。2 回目からは変わった曲だけ読みます', 'First read. From next time, only changed songs are read')
          : tr('Enter で開く · Space で試聴 · 難易度の枠を押すとその難易度を開く', 'Enter opens · Space previews · press a difficulty box to open it')}
      </span>
    </footer>
  );
}
