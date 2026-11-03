import { supportsDirectWrite } from '../fs/folder';
import { HSplitter } from './Splitter';
import { bgmSource, docStats } from '../store/derived';
import { isDirty, useEditor } from '../store/editor';
import { formatTime } from './format';
import { stemsActive, useStems } from '../store/stems';
import { useSongLength, useSoundsVersion } from './hooks';
import { TrackPanel } from './Tracks';

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

  const where = folder?.dir
    ? `${folder.name}/${meta.fileName}（曲フォルダに直接保存）`
    : supportsDirectWrite()
      ? `${meta.fileName}（保存するときに曲フォルダを選びます）`
      : `${meta.fileName}（ダウンロードで保存）`;

  return (
    <footer className="footer">
      <HSplitter />
      <TrackPanel length={length} />
      <div className="status">
        <span>
          ノーツ <b>{stats.notes.toLocaleString()}</b>
        </span>
        <span>
          小節 <b>{stats.measures}</b>
        </span>
        <span>
          WAV <b>{stats.wavCount}</b>
        </span>
        <span>
          長さ <b>{formatTime(length, false)}</b>
        </span>
        {missing.length > 0 && <span className="pill warn">見つからない音 {missing.length}</span>}
        <span className="grow" />
        <span className="ellipsis" style={{ color: dirty ? 'var(--amber)' : 'var(--mute)' }}>
          {dirty ? '未保存の変更あり' : savedAt ? '保存済み' : '変更なし'} · {where}
        </span>
        <span className="pill" title="保存するときの文字コード（NXが読める形式）">
          Shift_JIS
        </span>
      </div>
    </footer>
  );
}

