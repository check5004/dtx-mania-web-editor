// 曲情報の画面：ヘッダの全項目、曲情報を調べるエージェント（Web検索・iTunes・公式YouTube・ジャケット）、サムネイルの選択とトリミング。
import { tr, pl } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { YtPick } from '../ai/songAgent';
import { itunesSearch, youtubeOEmbed, youtubeThumbs, type ArtCandidate, type StoreHit } from '../ai/songInfo';
import { formatUsd, modelLabel } from '../ai/tasks';
import { setField } from '../edit/ops';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { useDevice } from '../store/device';
import { goBack, openSettings, setFieldValue, toast, useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
import { ensureClues, lookupSong, stopLookup, useSongInfo, type InfoField, type LookupResult, type Suggestion, type SuggestSource } from '../store/songinfo';
import { alignSongFields, editSong, setSongField, songFieldLabel, toastSongEdit, useOtherDiffs, useSongFieldSplits, type FieldSplit } from '../store/songSync';
import { ART_PRESETS, artPreset, loadArtImage, saveArt, writeArtCentered, type ArtPreset } from './artExport';
import { formatLevel } from './format';
import { Icon } from './icons';
import { CommitInput } from './LeftPanel';
import { youtubeId } from './youtube';

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  files?: RegExp;
  long?: boolean;
}

const IMG = /\.(png|jpe?g|bmp)$/i;
const groups = (): { id: string; title: string; fields: FieldDef[] }[] => [
  {
    id: 'basic',
    title: tr('基本', 'Basics'),
    fields: [
      { key: 'TITLE', label: tr('曲名', 'Title') },
      { key: 'ARTIST', label: tr('アーティスト', 'Artist') },
      { key: 'GENRE', label: tr('ジャンル', 'Genre') },
      { key: 'COMMENT', label: tr('コメント', 'Comment'), hint: tr('選曲画面に出る説明', 'Description on the song select screen'), long: true },
      { key: 'PANEL', label: tr('パネル', 'Panel'), hint: tr('演奏中に流れる文', 'Text that scrolls during play'), long: true },
    ],
  },
  {
    id: 'level',
    title: tr('難易度', 'Difficulty'),
    fields: [
      { key: 'DLEVEL', label: tr('ドラムのレベル', 'Drum level'), hint: tr('825 → 8.25、82 → 8.20', '825 → 8.25, 82 → 8.20') },
      { key: 'HIDDENLEVEL', label: tr('レベルを隠す', 'Hide level'), hint: tr('ON で選曲画面のレベルを「?」にする', 'ON shows the level as "?" on the song select screen') },
    ],
  },
  {
    id: 'select',
    title: tr('選曲画面', 'Song select'),
    fields: [
      { key: 'PREVIEW', label: tr('プレビュー音', 'Preview audio'), hint: '#PREVIEW', files: /\.(ogg|wav|mp3)$/i },
      { key: 'PREIMAGE', label: tr('画像', 'Image'), hint: '#PREIMAGE', files: IMG },
      { key: 'PREMOVIE', label: tr('動画', 'Movie'), hint: '#PREMOVIE', files: /\.(avi|mp4|wmv|mpg)$/i },
    ],
  },
  {
    id: 'play',
    title: tr('演奏', 'Play'),
    fields: [
      { key: 'BPM', label: tr('曲頭のBPM', 'Starting BPM'), hint: '#BPM' },
      { key: 'BASEBPM', label: tr('基準のBPM', 'Base BPM'), hint: tr('#BASEBPM（拡張BPMの基準）', '#BASEBPM (base for extended BPM)') },
      { key: 'STAGEFILE', label: tr('読み込み中の画像', 'Loading image'), hint: '#STAGEFILE', files: IMG },
      { key: 'BACKGROUND', label: tr('演奏中の背景', 'Background during play'), hint: '#BACKGROUND', files: IMG },
      { key: 'RESULTIMAGE', label: tr('結果画面の画像', 'Result screen image'), hint: '#RESULTIMAGE', files: IMG },
      { key: 'PATH_WAV', label: tr('音のフォルダ', 'Sound folder'), hint: tr('#PATH_WAV（音を別フォルダに置くとき）', '#PATH_WAV (when sounds are in another folder)') },
    ],
  },
];

const KNOWN = new Set(groups().flatMap((g) => g.fields.map((f) => f.key)));
const SKIP = /^(WAV|VOLUME|WAVVOL|PAN|WAVPAN|BPM|BMP|BMPTEX|AVI|AVIPAN|BGA|BGAPAN|SIZE)[0-9A-Z]{2}$/;
const INFO_FIELDS: InfoField[] = ['TITLE', 'ARTIST', 'GENRE', 'COMMENT', 'PANEL'];
const fieldLabel = (k: InfoField): string =>
  ({ TITLE: tr('曲名', 'Title'), ARTIST: tr('アーティスト', 'Artist'), GENRE: tr('ジャンル', 'Genre'), COMMENT: tr('コメント', 'Comment'), PANEL: tr('パネル', 'Panel') })[k];
/** 案の出どころの表示 */
const srcLabel = (s: SuggestSource): string => (s === 'tag' ? tr('タグ', 'Tag') : s);

/** 素材（#WAV・#BMP など）を直す所の案内。PC は左のパネル、タブレットは「音」のパネル、スマホは下の「音」のタブ */
function assetsWhere(phone: boolean, tablet: boolean): string {
  if (phone) return tr('BGM・音・BGA の定義（#WAV・#BMP など）は、下の「音」の「WAV」「画像」「ヘッダ」から直せます。', 'Edit BGM, sound and BGA definitions (#WAV, #BMP, etc.) from WAV, Images or Header under Sounds at the bottom.');
  if (tablet) return tr('BGM・音・BGA の定義（#WAV・#BMP など）は、「音」のパネルの「WAV」「画像」「ヘッダ」から直せます。', 'Edit BGM, sound and BGA definitions (#WAV, #BMP, etc.) from WAV, Images or Header in the Sounds panel.');
  return tr('BGM・音・BGA の定義（#WAV・#BMP など）は、左のパネルの「WAV」「画像」「ヘッダ」から直せます。', 'Edit BGM, sound and BGA definitions (#WAV, #BMP, etc.) from WAV, Images or Header in the left panel.');
}

export function SongInfoPage() {
  const fields = useEditor((s) => s.doc.fields);
  const phone = useDevice((s) => s.phone);
  const tablet = useDevice((s) => s.tablet);
  const result = useSongInfo((s) => s.result);
  useEffect(() => {
    ensureClues();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) goBack();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const others = Object.keys(fields).filter((k) => !KNOWN.has(k) && !SKIP.test(k) && !/^(GLEVEL|BLEVEL|BGMWAV)$/.test(k));
  const suggestion = (result?.fields ?? {}) as Partial<Record<string, Suggestion>>;
  const splits = useSongFieldSplits();
  const splitOf = (k: string) => splits.find((x) => x.key === k);
  return (
    <div className="info-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} {tr('戻る', 'Back')}
        </button>
        <div className="vsep" />
        <h1>{tr('曲情報', 'Song info')}</h1>
        <span className="lbl ellipsis">
          {fields['TITLE'] || tr('無題', 'Untitled')} · {fields['ARTIST'] || tr('アーティスト未設定', 'No artist')} · Lv {formatLevel(fields['DLEVEL'])}
        </span>
      </header>
      <div className="info-body">
        <main className="info-main scroll">
          <SongSyncNotice splits={splits} />
          {groups().map((g) => (
            <section key={g.id} className="card info-group">
              <h3>{g.title}</h3>
              <div className="info-grid">
                {g.fields.map((f) => (
                  <FieldRow key={f.key} f={f} value={fields[f.key] ?? ''} suggestion={suggestion[f.key]} alt={f.key === 'TITLE' ? result?.titleAlt : undefined} split={splitOf(f.key)} />
                ))}
              </div>
            </section>
          ))}
          {others.length > 0 && (
            <section className="card info-group">
              <h3>{tr('ほかの項目', 'Other fields')}</h3>
              <div className="info-grid">
                {others.map((k) => (
                  <FieldRow key={k} f={{ key: k, label: `#${k}` }} value={fields[k] ?? ''} />
                ))}
              </div>
            </section>
          )}
          <p className="lbl">{assetsWhere(phone, tablet)}</p>
        </main>
        <aside className="info-side scroll">
          <LookupCard />
          <ArtCard />
        </aside>
      </div>
    </div>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * 曲のもの（曲名・画像・試聴など）は、変えるとほかの難易度にも入ること。難易度によって違う欄があれば、それとそろえるボタン
 */
function SongSyncNotice({ splits }: { splits: FieldSplit[] }) {
  const others = useOtherDiffs();
  if (!others.length) return null;
  const sep = tr('・', ', ');
  if (!splits.length)
    return (
      <p className="lbl" style={{ margin: 0, lineHeight: 1.6 }}>
        {tr(
          `曲名・アーティスト・画像・試聴などは曲のものなので、変えると、同じだったほかの難易度（${others.map((o) => o.label).join(sep)}）にも入ります。レベルはこの難易度だけです。`,
          `Title, artist, images, preview and so on belong to the song, so changing them also updates the other difficulties (${others.map((o) => o.label).join(sep)}) that had the same value. The level is for this difficulty only.`,
        )}
      </p>
    );
  const none = tr('（なし）', '(none)');
  return (
    <div className="notice bgm-split">
      <span style={{ flex: 'none' }}>{Icon.warn(14)}</span>
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
        <b>{tr('難易度によって曲情報が違います', 'Song info differs between difficulties')}</b>
        <ul className="bgm-split-list">
          {splits.map((x) => {
            const text = x.others.map((o) => `${o.label}: ${o.value || none}`).join(' / ');
            return (
              <li key={x.key}>
                <span>{cap(songFieldLabel(x.key))}</span>
                <span className="ellipsis" title={text}>
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => void alignSongFields()} title={tr('ほかの難易度の、この欄を、この難易度の値にします（Ctrl+Z で戻せます）', 'Set these fields in the other difficulties to the values here (Ctrl+Z undoes it)')}>
            {tr('この難易度にそろえる', 'Match this difficulty')}
          </button>
          <span className="lbl">{tr('NX の選曲画面で難易度を替えると、曲名や画像・試聴が変わってしまいます', 'On the NX song select screen, switching difficulty changes the title, images or preview')}</span>
        </div>
      </div>
    </div>
  );
}

function FieldRow({ f, value, suggestion, alt, split }: { f: FieldDef; value: string; suggestion?: Suggestion; alt?: string; split?: FieldSplit }) {
  const folder = useEditor((s) => s.folder);
  const options = f.files && folder ? [...folder.files.values()].filter((x) => f.files!.test(x.name)) : null;
  const differs = (v: string | undefined) => v !== undefined && v.trim() !== '' && v.trim() !== value.trim();
  // 反映した案は、その欄に「✓ 反映済み」と「元に戻す」を残す（前の値に戻せる）
  const [taken, setTaken] = useState<{ value: string; prev: string } | null>(null);
  const isTaken = (v: string | undefined) => !!taken && v !== undefined && v.trim() === taken.value && value.trim() === taken.value;
  const take = (v: string, label: string) => {
    setTaken({ value: v.trim(), prev: value });
    setSongField(f.key, v.trim(), label);
  };
  const reflected = () => (
    <>
      <span className="reflect-chip ok">{tr('✓ 反映済み', '✓ Applied')}</span>
      <button
        className="link-btn"
        onClick={() => {
          setSongField(f.key, taken!.prev.trim() === '' ? undefined : taken!.prev, tr(`${f.label}を元に戻す`, `Revert ${f.label}`));
          setTaken(null);
        }}
        title={taken!.prev.trim() ? tr(`前の「${taken!.prev}」に戻します`, `Back to the previous “${taken!.prev}”`) : tr('前は空でした', 'It was empty before')}
      >
        {tr('元に戻す', 'Undo')}
      </button>
    </>
  );
  return (
    <>
      <span className="lbl info-label">
        {f.label}
        {f.hint && <span className="info-hint">{f.hint}</span>}
        {split && (
          <span className="reflect-chip changed info-split" title={split.others.map((o) => `${o.label}: ${o.value || tr('（なし）', '(none)')}`).join('\n')}>
            {tr('難易度で違う', 'Differs by difficulty')}
          </span>
        )}
      </span>
      <div>
        {f.key === 'HIDDENLEVEL' ? (
          <label className="row" style={{ gap: 8, minHeight: 30 }}>
            <input type="checkbox" checked={/^on$/i.test(value.trim())} onChange={(e) => setFieldValue(f.key, e.target.checked ? 'ON' : undefined, tr(`${f.label}を変更`, `Change ${f.label}`))} />
            <span className="lbl">{/^on$/i.test(value.trim()) ? tr('ON（選曲画面で「?」）', 'ON ("?" on song select)') : 'OFF'}</span>
          </label>
        ) : options && options.length > 0 ? (
          <select className="field" value={value} onChange={(e) => setSongField(f.key, e.target.value || undefined)}>
            <option value="">{tr('なし', 'None')}</option>
            {value && !options.some((o) => o.path === value) && <option value={value}>{tr(`${value}（見つかりません）`, `${value} (not found)`)}</option>}
            {options.map((o) => (
              <option key={o.path} value={o.path}>
                {o.path}
              </option>
            ))}
          </select>
        ) : (
          <CommitInput className={`field ${f.key === 'BPM' || f.key === 'DLEVEL' ? 'mono' : ''}`} value={value} onCommit={(v) => setSongField(f.key, v === '' ? undefined : v, tr(`${f.label}を変更`, `Change ${f.label}`))} />
        )}
        {f.key === 'DLEVEL' && value && <span className="lbl"> {tr('表示', 'Shown as')} {formatLevel(value)}</span>}
        {suggestion && (differs(suggestion.value) || isTaken(suggestion.value)) && (
          <div className={`info-suggest ${isTaken(suggestion.value) ? 'taken' : ''}`}>
            <span
              className="ai-mark"
              title={suggestion.src === 'AI' ? tr('AI が調べた案', 'Found by the AI') : suggestion.src === 'tag' ? tr('原曲のファイルのタグ', "Tag in the original's file") : tr('iTunes の配信情報', 'iTunes store info')}
            >
              {srcLabel(suggestion.src)}
            </span>
            <span className="grow">{suggestion.value}</span>
            {isTaken(suggestion.value) ? (
              reflected()
            ) : (
              <button
                className="link-btn"
                onClick={() => take(suggestion.value, tr(`${f.label}を${srcLabel(suggestion.src)}の案にする`, `Use the ${srcLabel(suggestion.src)} suggestion for ${f.label}`))}
              >
                {tr('反映', 'Apply')}
              </button>
            )}
          </div>
        )}
        {alt && (differs(alt) || isTaken(alt)) && (
          <div className={`info-suggest ${isTaken(alt) ? 'taken' : ''}`}>
            <span className="ai-mark" title={tr('英語・ローマ字などの別の表記', 'Another spelling, such as English or romanized')}>
              {tr('別表記', 'Alt.')}
            </span>
            <span className="grow">{alt}</span>
            {isTaken(alt) ? (
              reflected()
            ) : (
              <button className="link-btn" onClick={() => take(alt, tr(`${f.label}を別表記にする`, `Use the other spelling for ${f.label}`))}>
                {tr('反映', 'Apply')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---- 曲情報を調べる -------------------------------------------------------------------

const fmtLen = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function LookupCard() {
  const fields = useEditor((s) => s.doc.fields);
  const yt = useSidecar((s) => s.youtube);
  const hasKey = useHasAiKey();
  const model = useAi((s) => modelLabel(s.tasks.songinfo.model, s.models));
  const cost = useAi(() => taskCostEstimate('songinfo'));
  const clues = useSongInfo((s) => s.clues);
  const picture = useSongInfo((s) => s.picture);
  const status = useSongInfo((s) => s.status);
  const steps = useSongInfo((s) => s.steps);
  const error = useSongInfo((s) => s.error);
  const result = useSongInfo((s) => s.result);
  const [url, setUrl] = useState(yt?.url ?? '');
  const [oe, setOe] = useState<{ title: string; author: string } | null>(null);
  const [urlErr, setUrlErr] = useState<string | null>(null);
  useEffect(() => setUrl(yt?.url ?? ''), [yt?.url]);
  const running = status === 'running';

  const fetchYt = async () => {
    setUrlErr(null);
    if (!youtubeId(url)) {
      setUrlErr(tr('YouTube の URL を入れてください', 'Enter a YouTube URL'));
      return;
    }
    const r = await youtubeOEmbed(url);
    if (!r) {
      setUrlErr(tr('動画の情報を取れませんでした（非公開か、ネットワークの問題）', "Couldn't get the video's info (it may be private, or there's a network problem)"));
      return;
    }
    setOe({ title: r.title, author: r.author });
    if (!yt || yt.url !== url) setYoutube({ url, offset: yt?.offset ?? 0 });
  };

  const t = clues?.tags;
  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="ai-spark">{Icon.sparkle(14)}</span>
        <h3>{tr('曲情報を調べる', 'Look up song info')}</h3>
        <span className="grow" />
        {hasKey ? (
          <span className="lbl" title={tr('1回の目安（Web検索を数回含む）', 'Estimate per run (includes a few web searches)')}>
            {model} · {tr('約', '~')}
            {formatUsd(cost)}
          </span>
        ) : (
          <button className="link-btn" onClick={() => openSettings('ai')}>
            {tr('キーを設定', 'Set API key')}
          </button>
        )}
      </div>
      <div className="clue-box">
        <div className="lbl clue-head">{tr('手がかり', 'Clues')}</div>
        {clues ? (
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="clue-list grow">
              <div>
                <span className="clue-k">{tr('原曲', 'Original')}</span>
                <span className="ellipsis" title={clues.fileName ?? ''}>
                  {clues.fileName ?? tr('なし', 'None')}
                </span>
              </div>
              <div>
                <span className="clue-k">{tr('タグ', 'Tags')}</span>
                <span className="ellipsis" title={t ? [t.title, t.artist, t.album, t.year, t.genre].filter(Boolean).join(' / ') : ''}>
                  {t ? [t.title, t.artist, t.album, t.year].filter(Boolean).join(' / ') : clues.fileName ? tr('なし（ファイル名から探します）', 'None (searching by file name)') : '—'}
                </span>
              </div>
              {clues.durationSec ? (
                <div>
                  <span className="clue-k">{tr('長さ', 'Length')}</span>
                  <span className="mono">{fmtLen(clues.durationSec)}</span>
                </div>
              ) : null}
              {clues.folderName && (
                <div>
                  <span className="clue-k">{tr('フォルダ', 'Folder')}</span>
                  <span className="ellipsis">{clues.folderName}</span>
                </div>
              )}
            </div>
            {picture && <img className="clue-pic" src={picture} alt="" title={tr('原曲のファイルに入っていたジャケット', "Cover art embedded in the original's file")} />}
          </div>
        ) : (
          <div className="lbl">{tr('原曲のタグを読んでいます…', "Reading the original's tags…")}</div>
        )}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        <button
          className="btn primary grow"
          onClick={() => void lookupSong(true)}
          disabled={running}
          title={
            hasKey
              ? tr(
                  'ファイルのタグと名前から曲を特定し、Web検索で正式表記・年・ジャンル・公式のYouTube・ジャケットを探します',
                  'Identifies the song from the file tags and name, then searches the web for the official spelling, year, genre, official YouTube video and cover art',
                )
              : tr('タグと iTunes の配信情報から探します（無料）。AIのキーがあれば Web 検索もします', 'Searches the tags and iTunes store info (free). With an AI key, it also searches the web')
          }
        >
          {running ? <span className="spin" style={{ width: 13, height: 13 }} /> : Icon.sparkle(14)}{' '}
          {running ? tr('調べています…', 'Looking up…') : hasKey ? tr('AIで調べる（Web検索）', 'Look up with AI (web search)') : tr('タグと配信情報から調べる', 'Look up from tags and store info')}
        </button>
        {running && (
          <button className="btn" onClick={stopLookup}>
            {tr('止める', 'Stop')}
          </button>
        )}
      </div>
      {!hasKey && !running && (
        <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          {noKeyTitle()}
          {tr('。キーがあると、Web検索で公式の YouTube 動画・曲の紹介文も探します。', '. With a key, it also searches the web for the official YouTube video and a description of the song.')}
        </p>
      )}
      {steps.length > 0 && <StepList />}
      {error && <div className="ai-err">{error}</div>}
      {result && !running && <ResultView result={result} />}
      <details className="yt-manual" open={!!oe}>
        <summary className="lbl">{tr('YouTube の URL を自分で入れる', 'Enter a YouTube URL yourself')}</summary>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input className="field grow" value={url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" onClick={() => void fetchYt()} disabled={!url.trim()}>
            {tr('参照映像にする', 'Use as reference video')}
          </button>
        </div>
        {urlErr && <div className="ai-err">{urlErr}</div>}
        {oe && (
          <div className="info-oe">
            <b>{oe.title}</b>
            <span className="lbl"> {oe.author}</span>
            {!fields['TITLE'] && (
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <button className="link-btn" onClick={() => setSongField('TITLE', oe.title, tr('曲名を動画タイトルにする', 'Use the video title as the song title'))}>
                  {tr('動画タイトルを曲名にする', 'Use the video title as the song title')}
                </button>
              </div>
            )}
          </div>
        )}
      </details>
    </section>
  );
}

function StepList() {
  const steps = useSongInfo((s) => s.steps);
  const running = useSongInfo((s) => s.status === 'running');
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);
  return (
    <div className="agent-steps">
      <button className="agent-steps-head lbl" onClick={() => setOpen((o) => !o)}>
        {open ? Icon.chevronDown(12) : Icon.chevronRight(12)} {tr('経過', 'Progress')} ({steps.filter((s) => s.state !== 'run').length})
      </button>
      {open && (
        <ol ref={ref}>
          {steps.map((s) => (
            <li key={s.id} className={`agent-step ${s.state} ${s.kind}`}>
              <span className="agent-ic">{s.state === 'run' ? <span className="spin" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : s.state === 'fail' ? '×' : s.state === 'info' ? 'i' : '✓'}</span>
              <span className="agent-txt">
                {s.text}
                {s.detail && <span className="agent-detail">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const ytKind = (k: YtPick['kind']): string => ({ mv: 'MV', audio: tr('音源', 'Audio'), live: tr('ライブ', 'Live'), other: tr('動画', 'Video') })[k];

function ResultView({ result }: { result: LookupResult }) {
  const fields = useEditor((s) => s.doc.fields);
  const yt = useSidecar((s) => s.youtube);
  const curId = yt ? youtubeId(yt.url) : null;
  const changes = INFO_FIELDS.filter((k) => {
    const v = result.fields[k]?.value;
    return v && v.trim() !== (fields[k] ?? '').trim();
  });
  const firstYt = result.youtube[0] ?? null;
  const [useFields, setUseFields] = useState(true);
  const [useYt, setUseYt] = useState(true);
  const [useJacket, setUseJacket] = useState(!fields['PREIMAGE']);
  const [useBg, setUseBg] = useState(!fields['BACKGROUND'] && !fields['STAGEFILE']);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string[] | null>(null);
  const canYt = !!firstYt && curId !== firstYt.id;
  const items = [useFields && changes.length > 0, useYt && canYt, useJacket && !!result.jacket, useBg && !!firstYt].filter(Boolean).length;

  const applyAll = async () => {
    setBusy(true);
    const done: string[] = [];
    const failed: string[] = [];
    // 譜面に入れる値（曲情報の欄と、書き出した画像のファイル名）。最後に1つの変更にまとめる（Ctrl+Z で一度に戻る）
    const put: Record<string, string> = {};
    try {
      if (useFields && changes.length) {
        for (const k of changes) put[k] = result.fields[k]!.value.trim();
        done.push(tr(`${changes.length}項目`, `${changes.length} ${pl(changes.length, 'field')}`));
      }
      if (useYt && canYt && firstYt) {
        setYoutube({ url: firstYt.url, offset: yt?.offset ?? 0 });
        done.push(tr('参照映像', 'reference video'));
      }
      if (useJacket && result.jacket) {
        try {
          put.PREIMAGE = (await writeArtCentered(result.jacket, artPreset('pre-sq'))).name;
          done.push('#PREIMAGE');
        } catch (e) {
          failed.push(tr(`ジャケット（${(e as Error).message}）`, `cover art (${(e as Error).message})`));
        }
      }
      if (useBg && firstYt) {
        const cand: ArtCandidate = { url: `https://i.ytimg.com/vi/${firstYt.id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${firstYt.id}/maxresdefault.jpg`, label: '', source: 'youtube' };
        for (const id of ['stage', 'bg']) {
          try {
            put[artPreset(id).key] = (await writeArtCentered(cand, artPreset(id))).name;
            done.push(`#${artPreset(id).key}`);
          } catch (e) {
            failed.push(tr(`${artPreset(id).key}（${(e as Error).message}）`, `${artPreset(id).key} (${(e as Error).message})`));
            break;
          }
        }
      }
    } finally {
      setBusy(false);
    }
    // 曲のもの（曲名・画像など）なので、同じだったほかの難易度にも入れる
    const keys = Object.keys(put);
    const r = keys.length
      ? editSong(tr('曲情報をまとめて設定', 'Set song info in bulk'), (d) => {
          for (const k of keys) setField(d, k, put[k]);
        })
      : null;
    // 済んだものは外す（もう一度押して同じ画像を重ねて書き出さないように）
    setUseFields(false);
    setUseYt(false);
    if (done.includes('#PREIMAGE')) setUseJacket(false);
    if (done.includes('#BACKGROUND')) setUseBg(false);
    setApplied(done);
    if (failed.length) toast(tr(`設定できなかったもの: ${failed.join('、')}`, `Couldn't set: ${failed.join(', ')}`), 'warn', 8000);
    if (done.length) {
      const text = tr(`${done.join('・')} を設定しました（曲名などは Ctrl+Z で戻せます）`, `Set ${done.join(', ')} (Ctrl+Z undoes the title and other fields)`);
      if (r) void toastSongEdit(r, text, 'ok', 6000);
      else toast(text, 'ok', 6000);
    } else if (!failed.length) toast(tr('変わるものはありません', 'Nothing to change'), 'info');
  };

  return (
    <div className="info-ai">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {result.confidence ? (
          <span className={`ai-conf ${result.confidence}`}>
            {result.confidence === 'high' ? tr('自信度 高', 'High confidence') : result.confidence === 'medium' ? tr('自信度 中', 'Medium confidence') : tr('自信度 低', 'Low confidence')}
          </span>
        ) : (
          <span className="ai-tag">{tr('タグと iTunes から', 'From tags and iTunes')}</span>
        )}
        {result.year && <span className="lbl">{tr(`リリース ${result.year}年`, `Released ${result.year}`)}</span>}
        <span className="grow" />
        {result.ai && (
          <span className="lbl mono" title={tr(`${result.model} · Web検索 ${result.webSearches}回`, `${result.model} · ${result.webSearches} web ${pl(result.webSearches, 'search', 'searches')}`)}>
            {formatUsd(result.cost)}
          </span>
        )}
      </div>
      {result.notes && <p className="lbl" style={{ margin: '6px 0', lineHeight: 1.6 }}>{result.notes}</p>}
      {changes.length > 0 && (
        <div className="lbl" style={{ margin: '6px 0' }}>
          {tr(
            `案: ${changes.map((k) => fieldLabel(k)).join('・')}（左の各項目の「反映」でも選べます）`,
            `Suggestions: ${changes.map((k) => fieldLabel(k)).join(', ')} (you can also pick them with "Apply" on each field on the left)`,
          )}
        </div>
      )}
      {result.youtube.length > 0 && (
        <div className="yt-picks">
          <div className="lbl">{tr('公式の YouTube', 'Official YouTube')}</div>
          {result.youtube.map((y) => (
            <div key={y.id} className="yt-pick">
              <a href={y.url} target="_blank" rel="noreferrer" className="yt-thumb" title={tr('YouTube で開く', 'Open on YouTube')}>
                <img src={`https://i.ytimg.com/vi/${y.id}/mqdefault.jpg`} alt="" loading="lazy" />
              </a>
              <div className="yt-meta">
                <div className="ellipsis" title={y.title} style={{ fontWeight: 600 }}>
                  {y.title}
                </div>
                <div className="lbl ellipsis" title={y.why}>
                  {y.channel}
                </div>
                <div className="row" style={{ gap: 4, marginTop: 3 }}>
                  <span className={`ai-badge ${y.official ? 'ok' : ''}`}>{y.official ? tr('公式', 'Official') : tr('公式か不明', 'Maybe unofficial')}</span>
                  <span className="ai-tag">{ytKind(y.kind)}</span>
                  <span className="grow" />
                  {curId === y.id ? (
                    <span className="lbl">{tr('参照映像に設定中', 'Current reference video')}</span>
                  ) : (
                    <button
                      className="link-btn"
                      onClick={() => setYoutube({ url: y.url, offset: yt?.offset ?? 0 })}
                      title={tr('譜面の再生に合わせて動く参照映像にします', 'Use it as a reference video that plays along with the chart')}
                    >
                      {tr('参照映像にする', 'Use as reference video')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {items > 0 || changes.length > 0 || canYt || result.jacket || firstYt ? (
        <div className="bulk-apply">
          <div className="lbl" style={{ marginBottom: 4 }}>
            {tr('まとめて設定', 'Set in bulk')}
          </div>
          {changes.length > 0 && (
            <label>
              <input type="checkbox" checked={useFields} onChange={(e) => setUseFields(e.target.checked)} /> {changes.map((k) => fieldLabel(k)).join(tr('・', ', '))}
            </label>
          )}
          {canYt && (
            <label>
              <input type="checkbox" checked={useYt} onChange={(e) => setUseYt(e.target.checked)} /> {tr('公式動画を参照映像にする', 'Use the official video as the reference video')}
            </label>
          )}
          {result.jacket && (
            <label title={result.jacket.label}>
              <input type="checkbox" checked={useJacket} onChange={(e) => setUseJacket(e.target.checked)} />{' '}
              {tr(`ジャケットを #PREIMAGE（400×400）に${fields['PREIMAGE'] ? '（今の画像と置き換え）' : ''}`, `Cover art as #PREIMAGE (400×400)${fields['PREIMAGE'] ? ' (replaces the current image)' : ''}`)}
            </label>
          )}
          {firstYt && (
            <label>
              <input type="checkbox" checked={useBg} onChange={(e) => setUseBg(e.target.checked)} /> {tr('動画のサムネイルを #STAGEFILE・#BACKGROUND（1280×720）に', 'Video thumbnail as #STAGEFILE and #BACKGROUND (1280×720)')}
            </label>
          )}
          <button className="btn small primary" style={{ marginTop: 6 }} onClick={() => void applyAll()} disabled={busy || items === 0}>
            {busy ? tr('設定しています…', 'Setting…') : tr('まとめて設定', 'Set in bulk')}
          </button>
          <span className="lbl"> {applied?.length ? tr(`✓ ${applied.join('・')} を設定しました`, `✓ Set ${applied.join(', ')}`) : tr('画像は曲フォルダに PNG で書き出します', 'Images are written to the song folder as PNG')}</span>
        </div>
      ) : null}
      {result.sources.length > 0 && (
        <div className="info-src">
          <div className="lbl">{tr('調べた先', 'Sources')}</div>
          {result.sources.slice(0, 6).map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="ellipsis" title={s.url}>
              {s.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- サムネイル -----------------------------------------------------------------------

function ArtCard() {
  const yt = useSidecar((s) => s.youtube);
  const fields = useEditor((s) => s.doc.fields);
  const folder = useEditor((s) => s.folder);
  const found = useSongInfo((s) => s.result?.art);
  const jacket = useSongInfo((s) => s.result?.jacket ?? null);
  const picture = useSongInfo((s) => s.picture);
  const [hits, setHits] = useState<StoreHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState<ArtCandidate | null>(null);
  const [local, setLocal] = useState<ArtCandidate[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = yt ? youtubeId(yt.url) : null;
  const ytThumbs = useMemo(() => (id ? youtubeThumbs(id) : []), [id]);
  // 調べ終わったら、おすすめのジャケットを選んでおく
  useEffect(() => {
    if (jacket) setSel(jacket);
  }, [jacket]);
  // 曲フォルダの画像
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    void (async () => {
      const imgs = folder ? [...folder.files.values()].filter((f) => IMG.test(f.name) && !/^bmp|bga/i.test(f.name) && !/\.dtx\.\d{8,}_/i.test(f.name)).slice(0, 8) : [];
      const out: ArtCandidate[] = [];
      for (const f of imgs) {
        const u = URL.createObjectURL(await f.getFile());
        made.push(u);
        out.push({ url: u, big: u, label: f.path, source: 'file' });
      }
      if (alive) setLocal(out);
    })();
    return () => {
      alive = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [folder]);

  const search = async () => {
    setSearching(true);
    setMsg(null);
    try {
      const term = [fields['TITLE'], fields['ARTIST']].filter(Boolean).join(' ');
      const r = await itunesSearch(term);
      setHits(r);
      if (r.length === 0) setMsg(tr('見つかりませんでした。曲名とアーティストを確かめてください', 'Nothing found. Check the title and artist'));
    } catch (e) {
      setMsg(tr(`検索できませんでした: ${(e as Error).message}`, `Search failed: ${(e as Error).message}`));
    } finally {
      setSearching(false);
    }
  };

  const cands: ArtCandidate[] = [];
  const add = (c: ArtCandidate) => {
    if (!cands.some((x) => x.big === c.big)) cands.push(c);
  };
  for (const c of found ?? []) add(c);
  if (picture) add({ url: picture, big: picture, label: tr('原曲のファイルに入っていたジャケット', "Cover art embedded in the original's file"), source: 'file' });
  for (const c of ytThumbs.slice(0, 1)) add(c);
  for (const h of hits) add(h.art);
  for (const c of local) add(c);
  return (
    <section className="card ai-card">
      <h3>{tr('サムネイル', 'Artwork')}</h3>
      <p className="lbl" style={{ margin: '4px 0 8px' }}>
        {tr(
          '原曲のジャケット・配信サービスの公開アートワーク・YouTube のサムネイルから選び、切り取って設定します（AIには画像を作らせません）。',
          "Pick from the original's cover art, public store artwork or YouTube thumbnails, then crop and set it (the AI doesn't create images).",
        )}
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => void search()} disabled={searching || !(fields['TITLE'] || fields['ARTIST'])}>
          {searching ? tr('探しています…', 'Searching…') : tr('アートワークを探す（iTunes）', 'Find artwork (iTunes)')}
        </button>
        <button className="btn small ghost" onClick={() => fileRef.current?.click()}>
          {tr('画像ファイルを選ぶ', 'Choose an image file')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              const u = URL.createObjectURL(f);
              const c: ArtCandidate = { url: u, big: u, label: f.name, source: 'file' };
              setLocal((l) => [c, ...l]);
              setSel(c);
            }
            e.target.value = '';
          }}
        />
      </div>
      {msg && <div className="lbl" style={{ marginTop: 6 }}>{msg}</div>}
      {cands.length > 0 ? (
        <div className="art-grid">
          {cands.map((c, i) => (
            <button key={c.big + i} className={`art-cand ${sel?.big === c.big ? 'on' : ''} ${c === jacket || c.big === jacket?.big ? 'pick' : ''}`} onClick={() => setSel(c)} title={c.label}>
              <img src={c.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : (
        <p className="lbl">{id ? '' : tr('「曲情報を調べる」か、参照映像（YouTube）を設定すると候補が出ます。', 'Run "Look up song info" or set a reference video (YouTube) to see candidates.')}</p>
      )}
      {sel && <Cropper cand={sel} />}
    </section>
  );
}

function Cropper({ cand }: { cand: ArtCandidate }) {
  const [preset, setPreset] = useState<ArtPreset>(ART_PRESETS[0]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tainted, setTainted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 切り取り枠（画像の座標）。中心と大きさ（1 = 入る最大）
  const [cx, setCx] = useState(0.5);
  const [cy, setCy] = useState(0.5);
  const [scale, setScale] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setImg(null);
    setErr(null);
    setTainted(false);
    loadArtImage(cand).then(
      (r) => {
        if (!alive) return;
        setImg(r.img);
        setTainted(r.tainted);
      },
      () => alive && setErr(tr('画像を読み込めませんでした', "Couldn't load the image")),
    );
    setCx(0.5);
    setCy(0.5);
    setScale(1);
    return () => {
      alive = false;
    };
  }, [cand]);

  // 枠の大きさ（画像に対する割合）
  const iw = img?.naturalWidth ?? 1;
  const ih = img?.naturalHeight ?? 1;
  const aspect = preset.w / preset.h;
  const fitW = Math.min(iw, ih * aspect);
  const cw = (fitW * scale) / iw;
  const ch = ((fitW / aspect) * scale) / ih;
  const clampX = (x: number) => Math.max(cw / 2, Math.min(1 - cw / 2, x));
  const clampY = (y: number) => Math.max(ch / 2, Math.min(1 - ch / 2, y));
  const x0 = clampX(cx) - cw / 2;
  const y0 = clampY(cy) - ch / 2;

  const exportImage = async () => {
    if (!img) return;
    setErr(null);
    try {
      const { name, where, edit } = await saveArt(img, { x: x0 * iw, y: y0 * ih, w: cw * iw, h: ch * ih }, preset);
      // 画像は曲のものなので、同じだったほかの難易度にも入れる（入れたら知らせに足す）
      void toastSongEdit(
        edit,
        where === 'written'
          ? tr(`${name} を曲フォルダに書き出し、#${preset.key} に設定しました`, `Wrote ${name} to the song folder and set it as #${preset.key}`)
          : where === 'memory'
            ? tr(`${name} を作り #${preset.key} に設定しました（保存のときに曲フォルダへ書き出します）`, `Made ${name} and set it as #${preset.key} (written to the song folder when you save)`)
            : tr(`${name} をダウンロードしました。曲フォルダに入れてください`, `Downloaded ${name}. Put it in the song folder`),
        'ok',
        6000,
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: clampX(cx), cy: clampY(cy) };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    setCx(clampX(d.cx + (e.clientX - d.x) / r.width));
    setCy(clampY(d.cy + (e.clientY - d.y) / r.height));
  };

  return (
    <div className="cropper">
      <div className="lbl ellipsis" title={cand.label}>
        {cand.label}
      </div>
      <select className="field" value={preset.id} onChange={(e) => setPreset(artPreset(e.target.value))}>
        {ART_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {img ? (
        <div ref={box} className="crop-box" style={{ aspectRatio: `${iw} / ${ih}` }}>
          <img src={img.src} alt="" draggable={false} />
          <div
            className="crop-rect"
            style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${cw * 100}%`, height: `${ch * 100}%` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
          />
        </div>
      ) : (
        !err && <div className="lbl">{tr('読み込み中…', 'Loading…')}</div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <span className="lbl">{tr('大きさ', 'Size')}</span>
        <input type="range" min={0.3} max={1} step={0.01} value={scale} onChange={(e) => setScale(Number(e.target.value))} className="grow" />
        <span className="lbl mono">
          {img ? `${Math.round(cw * iw)}×${Math.round(ch * ih)}` : ''} → {preset.w}×{preset.h}
        </span>
      </div>
      {tainted && <p className="lbl" style={{ margin: 0 }}>{tr('この画像は配信元の設定で書き出せないことがあります。', "The image host's settings may prevent exporting this image.")}</p>}
      {err && <div className="ai-err">{err}</div>}
      <button className="btn primary small" onClick={() => void exportImage()} disabled={!img}>
        {tr(`切り取って #${preset.key} に設定`, `Crop and set as #${preset.key}`)}
      </button>
    </div>
  );
}
