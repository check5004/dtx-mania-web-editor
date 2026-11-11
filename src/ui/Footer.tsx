import { tr, locale } from '../i18n';
import { isDiskFolder, supportsDirectWrite } from '../fs/folder';
import { HSplitter } from './Splitter';
import { bgmSource, docStats } from '../store/derived';
import { useEditor } from '../store/editor';
import { unsavedText, useUnsaved } from '../store/unsaved';
import { formatTime } from './format';
import { stemsActive, useStems } from '../store/stems';
import { localPlace, useLocalSongs } from '../store/localSongs';
import { DriveFooterChip } from './DriveUi';
import { songEndM, useSongLength, useSongSpan, useSoundsVersion } from './hooks';
import { TrackPanel, useTrackCount } from './Tracks';
import { useSidecar } from '../store/sidecar';
import { openSpecialSettings, specialCount } from '../store/special';

/** 下のトラック（原曲・ステム・譜面の音。上の帯はループとセクション）と状態の表示 */
export function Footer() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  // 保存していない変更（譜面と作業ファイル）
  const unsaved = useUnsaved();
  const savedAt = useEditor((s) => s.savedAt);
  const missingAll = useEditor((s) => s.missingWavs);
  useStems((s) => s.version);
  useSoundsVersion();
  // ステムを鳴らしているときは、書き出す予定の BGM が無いのは問題にしない
  const anchor = stemsActive() ? bgmSource(doc)?.wav : undefined;
  const missing = missingAll.filter((n) => n !== anchor);
  const stats = docStats(doc);
  // 特殊ノーツ（クラップなど）の数。分け方は作業ファイルの決めで変わる
  useSidecar((s) => s.special);
  const spCount = specialCount(doc);
  const length = useSongLength(doc);
  const span = useSongSpan(doc);
  // 上の境目の止まる高さ（細く・標準・ゆったり）はトラックの数で決まる
  const rows = useTrackCount();
  // 本体に入れ終わった・曲フォルダへ移したら描き直す
  useLocalSongs((s) => s.ver);
  const copying = useLocalSongs((s) => s.copying);

  const where = isDiskFolder(folder)
    ? tr(`${folder.name}/${meta.fileName}（曲フォルダに直接保存）`, `${folder.name}/${meta.fileName} (saved directly to the song folder)`)
    : folder?.local
      ? tr(`${folder.name}/${meta.fileName}（音ごと${localPlace()}に保存）`, `${folder.name}/${meta.fileName} (kept in ${localPlace()} with its audio)`)
      : copying
        ? tr(`${meta.fileName}（${localPlace()}に保存しています…）`, `${meta.fileName} (keeping it in ${localPlace()}…)`)
        : supportsDirectWrite()
          ? tr(`${meta.fileName}（保存するときに曲フォルダを選びます）`, `${meta.fileName} (you choose the song folder when saving)`)
          : tr(`${meta.fileName}（ダウンロードで保存）`, `${meta.fileName} (saved as a download)`);

  return (
    <footer className="footer">
      <HSplitter rows={rows} />
      <TrackPanel length={length} span={span} />
      <div className="status">
        <span>
          {tr('ノーツ', 'Notes')} <b>{stats.notes.toLocaleString(locale())}</b>
        </span>
        <span>
          {tr('小節', 'Measures')} <b>{Math.max(stats.measures, songEndM(doc))}</b>
        </span>
        <span>
          WAV <b>{stats.wavCount}</b>
        </span>
        {spCount > 0 && (
          <button className="status-link" onClick={openSpecialSettings} title={tr('特殊ノーツ（クラップなど）の設定を開く', 'Open the special note (claps etc.) settings')}>
            {tr('特殊ノーツ', 'Special notes')} <b>{spCount.toLocaleString(locale())}</b>
          </button>
        )}
        <span>
          {tr('長さ', 'Length')} <b>{formatTime(length, false)}</b>
        </span>
        {missing.length > 0 && (
          <span className="pill warn">
            {tr('見つからない音', 'Missing sounds')} {missing.length}
          </span>
        )}
        <span className="grow" />
        <span className="ellipsis" style={{ color: unsaved ? 'var(--amber)' : 'var(--mute)' }} title={unsaved ? tr(`保存していない変更：${unsavedText(unsaved)}`, `Unsaved changes: ${unsavedText(unsaved)}`) : undefined}>
          {unsaved ? tr(`未保存：${unsavedText(unsaved)}`, `Unsaved: ${unsavedText(unsaved)}`) : savedAt ? tr('保存済み', 'Saved') : tr('変更なし', 'No changes')} · {where}
        </span>
        <DriveFooterChip />
        <span className="pill" title={tr('保存するときの文字コード（NXが読める形式）', 'Text encoding used when saving (a format NX can read)')}>
          Shift_JIS
        </span>
      </div>
    </footer>
  );
}

