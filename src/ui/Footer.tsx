import { tr, locale } from '../i18n';
import { supportsDirectWrite } from '../fs/folder';
import { HSplitter } from './Splitter';
import { bgmSource, docStats } from '../store/derived';
import { isDirty, useEditor } from '../store/editor';
import { formatTime } from './format';
import { stemsActive, useStems } from '../store/stems';
import { songEndM, useSongLength, useSongSpan, useSoundsVersion } from './hooks';
import { TrackPanel, useTrackRows } from './Tracks';

/** 下のトラック（原曲・ステム・譜面の音。上の帯はループとセクション）と状態の表示 */
export function Footer() {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const folder = useEditor((s) => s.folder);
  const dirty = useEditor(isDirty);
  const savedAt = useEditor((s) => s.savedAt);
  const missingAll = useEditor((s) => s.missingWavs);
  useStems((s) => s.version);
  useSoundsVersion();
  // ステムを鳴らしているときは、書き出す予定の BGM が無いのは問題にしない
  const anchor = stemsActive() ? bgmSource(doc)?.wav : undefined;
  const missing = missingAll.filter((n) => n !== anchor);
  const stats = docStats(doc);
  const length = useSongLength(doc);
  const span = useSongSpan(doc);
  // 上の境目の止まる高さ（細く・標準・ゆったり）はトラックの数で決まる
  const rows = useTrackRows().length;

  const where = folder?.dir
    ? tr(`${folder.name}/${meta.fileName}（曲フォルダに直接保存）`, `${folder.name}/${meta.fileName} (saved directly to the song folder)`)
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
        <span>
          {tr('長さ', 'Length')} <b>{formatTime(length, false)}</b>
        </span>
        {missing.length > 0 && (
          <span className="pill warn">
            {tr('見つからない音', 'Missing sounds')} {missing.length}
          </span>
        )}
        <span className="grow" />
        <span className="ellipsis" style={{ color: dirty ? 'var(--amber)' : 'var(--mute)' }}>
          {dirty ? tr('未保存の変更あり', 'Unsaved changes') : savedAt ? tr('保存済み', 'Saved') : tr('変更なし', 'No changes')} · {where}
        </span>
        <span className="pill" title={tr('保存するときの文字コード（NXが読める形式）', 'Text encoding used when saving (a format NX can read)')}>
          Shift_JIS
        </span>
      </div>
    </footer>
  );
}

