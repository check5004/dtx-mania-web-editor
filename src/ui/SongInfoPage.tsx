// 曲情報の画面：ヘッダの全項目、曲情報を調べるエージェント（Web検索・iTunes・公式YouTube・ジャケット）、サムネイルの選択とトリミング。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { YtPick } from '../ai/songAgent';
import { itunesSearch, youtubeOEmbed, youtubeThumbs, type ArtCandidate, type StoreHit } from '../ai/songInfo';
import { formatUsd, modelLabel } from '../ai/tasks';
import { setField } from '../edit/ops';
import { noKeyTitle, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { edit, goBack, openSettings, setFieldValue, toast, useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
import { ensureClues, lookupSong, stopLookup, useSongInfo, type InfoField, type LookupResult, type Suggestion } from '../store/songinfo';
import { ART_PRESETS, artPreset, loadArtImage, saveArt, saveArtCentered, type ArtPreset } from './artExport';
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
const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: '基本',
    fields: [
      { key: 'TITLE', label: '曲名' },
      { key: 'ARTIST', label: 'アーティスト' },
      { key: 'GENRE', label: 'ジャンル' },
      { key: 'COMMENT', label: 'コメント', hint: '選曲画面に出る説明', long: true },
      { key: 'PANEL', label: 'パネル', hint: '演奏中に流れる文', long: true },
    ],
  },
  {
    title: '難易度',
    fields: [
      { key: 'DLEVEL', label: 'ドラムのレベル', hint: '825 → 8.25、82 → 8.20' },
      { key: 'HIDDENLEVEL', label: 'レベルを隠す', hint: 'ON で選曲画面のレベルを「?」にする' },
    ],
  },
  {
    title: '選曲画面',
    fields: [
      { key: 'PREVIEW', label: 'プレビュー音', hint: '#PREVIEW', files: /\.(ogg|wav|mp3)$/i },
      { key: 'PREIMAGE', label: '画像', hint: '#PREIMAGE', files: IMG },
      { key: 'PREMOVIE', label: '動画', hint: '#PREMOVIE', files: /\.(avi|mp4|wmv|mpg)$/i },
    ],
  },
  {
    title: '演奏',
    fields: [
      { key: 'BPM', label: '曲頭のBPM', hint: '#BPM' },
      { key: 'BASEBPM', label: '基準のBPM', hint: '#BASEBPM（拡張BPMの基準）' },
      { key: 'STAGEFILE', label: '読み込み中の画像', hint: '#STAGEFILE', files: IMG },
      { key: 'BACKGROUND', label: '演奏中の背景', hint: '#BACKGROUND', files: IMG },
      { key: 'RESULTIMAGE', label: '結果画面の画像', hint: '#RESULTIMAGE', files: IMG },
      { key: 'PATH_WAV', label: '音のフォルダ', hint: '#PATH_WAV（音を別フォルダに置くとき）' },
    ],
  },
];

const KNOWN = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
const SKIP = /^(WAV|VOLUME|WAVVOL|PAN|WAVPAN|BPM|BMP|BMPTEX|AVI|AVIPAN|BGA|BGAPAN|SIZE)[0-9A-Z]{2}$/;
const INFO_FIELDS: InfoField[] = ['TITLE', 'ARTIST', 'GENRE', 'COMMENT', 'PANEL'];
const FIELD_LABEL: Record<InfoField, string> = { TITLE: '曲名', ARTIST: 'アーティスト', GENRE: 'ジャンル', COMMENT: 'コメント', PANEL: 'パネル' };

export function SongInfoPage() {
  const fields = useEditor((s) => s.doc.fields);
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
  return (
    <div className="info-page">
      <header className="tempo-head">
        <button className="btn small ghost" onClick={goBack}>
          {Icon.back(14)} 戻る
        </button>
        <div className="vsep" />
        <h1>曲情報</h1>
        <span className="lbl ellipsis">
          {fields['TITLE'] || '無題'} · {fields['ARTIST'] || 'アーティスト未設定'} · Lv {formatLevel(fields['DLEVEL'])}
        </span>
      </header>
      <div className="info-body">
        <main className="info-main scroll">
          {GROUPS.map((g) => (
            <section key={g.title} className="card info-group">
              <h3>{g.title}</h3>
              <div className="info-grid">
                {g.fields.map((f) => (
                  <FieldRow key={f.key} f={f} value={fields[f.key] ?? ''} suggestion={suggestion[f.key]} alt={f.key === 'TITLE' ? result?.titleAlt : undefined} />
                ))}
              </div>
            </section>
          ))}
          {others.length > 0 && (
            <section className="card info-group">
              <h3>ほかの項目</h3>
              <div className="info-grid">
                {others.map((k) => (
                  <FieldRow key={k} f={{ key: k, label: `#${k}` }} value={fields[k] ?? ''} />
                ))}
              </div>
            </section>
          )}
          <p className="lbl">BGM・音・BGA の定義（#WAV・#BMP など）は左のパネルの「素材」や「ヘッダ」から直せます。</p>
        </main>
        <aside className="info-side scroll">
          <LookupCard />
          <ArtCard />
        </aside>
      </div>
    </div>
  );
}

function FieldRow({ f, value, suggestion, alt }: { f: FieldDef; value: string; suggestion?: Suggestion; alt?: string }) {
  const folder = useEditor((s) => s.folder);
  const options = f.files && folder ? [...folder.files.values()].filter((x) => f.files!.test(x.name)) : null;
  const differs = (v: string | undefined) => v !== undefined && v.trim() !== '' && v.trim() !== value.trim();
  return (
    <>
      <span className="lbl info-label">
        {f.label}
        {f.hint && <span className="info-hint">{f.hint}</span>}
      </span>
      <div>
        {f.key === 'HIDDENLEVEL' ? (
          <label className="row" style={{ gap: 8, minHeight: 30 }}>
            <input type="checkbox" checked={/^on$/i.test(value.trim())} onChange={(e) => setFieldValue(f.key, e.target.checked ? 'ON' : undefined, `${f.label}を変更`)} />
            <span className="lbl">{/^on$/i.test(value.trim()) ? 'ON（選曲画面で「?」）' : 'OFF'}</span>
          </label>
        ) : options && options.length > 0 ? (
          <select className="field" value={value} onChange={(e) => setFieldValue(f.key, e.target.value || undefined)}>
            <option value="">なし</option>
            {value && !options.some((o) => o.path === value) && <option value={value}>{value}（見つかりません）</option>}
            {options.map((o) => (
              <option key={o.path} value={o.path}>
                {o.path}
              </option>
            ))}
          </select>
        ) : (
          <CommitInput className={`field ${f.key === 'BPM' || f.key === 'DLEVEL' ? 'mono' : ''}`} value={value} onCommit={(v) => setFieldValue(f.key, v === '' ? undefined : v, `${f.label}を変更`)} />
        )}
        {f.key === 'DLEVEL' && value && <span className="lbl"> 表示 {formatLevel(value)}</span>}
        {suggestion && differs(suggestion.value) && (
          <div className="info-suggest">
            <span className="ai-mark" title={suggestion.src === 'AI' ? 'AI が調べた案' : suggestion.src === 'タグ' ? '原曲のファイルのタグ' : 'iTunes の配信情報'}>
              {suggestion.src}
            </span>
            <span className="grow">{suggestion.value}</span>
            <button className="link-btn" onClick={() => setFieldValue(f.key, suggestion.value.trim(), `${f.label}を${suggestion.src}の案にする`)}>
              反映
            </button>
          </div>
        )}
        {alt && differs(alt) && (
          <div className="info-suggest">
            <span className="ai-mark" title="英語・ローマ字などの別の表記">別表記</span>
            <span className="grow">{alt}</span>
            <button className="link-btn" onClick={() => setFieldValue(f.key, alt.trim(), `${f.label}を別表記にする`)}>
              反映
            </button>
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
      setUrlErr('YouTube の URL を入れてください');
      return;
    }
    const r = await youtubeOEmbed(url);
    if (!r) {
      setUrlErr('動画の情報を取れませんでした（非公開か、ネットワークの問題）');
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
        <h3>曲情報を調べる</h3>
        <span className="grow" />
        {hasKey ? (
          <span className="lbl" title="1回の目安（Web検索を数回含む）">
            {model} · 約 {formatUsd(cost)}
          </span>
        ) : (
          <button className="link-btn" onClick={() => openSettings('ai')}>
            キーを設定
          </button>
        )}
      </div>
      <div className="clue-box">
        <div className="lbl clue-head">手がかり</div>
        {clues ? (
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div className="clue-list grow">
              <div>
                <span className="clue-k">原曲</span>
                <span className="ellipsis" title={clues.fileName ?? ''}>
                  {clues.fileName ?? 'なし'}
                </span>
              </div>
              <div>
                <span className="clue-k">タグ</span>
                <span className="ellipsis" title={t ? [t.title, t.artist, t.album, t.year, t.genre].filter(Boolean).join(' / ') : ''}>
                  {t ? [t.title, t.artist, t.album, t.year].filter(Boolean).join(' / ') : clues.fileName ? 'なし（ファイル名から探します）' : '—'}
                </span>
              </div>
              {clues.durationSec ? (
                <div>
                  <span className="clue-k">長さ</span>
                  <span className="mono">{fmtLen(clues.durationSec)}</span>
                </div>
              ) : null}
              {clues.folderName && (
                <div>
                  <span className="clue-k">フォルダ</span>
                  <span className="ellipsis">{clues.folderName}</span>
                </div>
              )}
            </div>
            {picture && <img className="clue-pic" src={picture} alt="" title="原曲のファイルに入っていたジャケット" />}
          </div>
        ) : (
          <div className="lbl">原曲のタグを読んでいます…</div>
        )}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        <button
          className="btn primary grow"
          onClick={() => void lookupSong(true)}
          disabled={running}
          title={hasKey ? 'ファイルのタグと名前から曲を特定し、Web検索で正式表記・年・ジャンル・公式のYouTube・ジャケットを探します' : 'タグと iTunes の配信情報から探します（無料）。AIのキーがあれば Web 検索もします'}
        >
          {running ? <span className="spin" style={{ width: 13, height: 13 }} /> : Icon.sparkle(14)} {running ? '調べています…' : hasKey ? 'AIで調べる（Web検索）' : 'タグと配信情報から調べる'}
        </button>
        {running && (
          <button className="btn" onClick={stopLookup}>
            止める
          </button>
        )}
      </div>
      {!hasKey && !running && (
        <p className="lbl" style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          {noKeyTitle()}。キーがあると、Web検索で公式の YouTube 動画・曲の紹介文も探します。
        </p>
      )}
      {steps.length > 0 && <StepList />}
      {error && <div className="ai-err">{error}</div>}
      {result && !running && <ResultView result={result} />}
      <details className="yt-manual" open={!!oe}>
        <summary className="lbl">YouTube の URL を自分で入れる</summary>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input className="field grow" value={url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => setUrl(e.target.value)} />
          <button className="btn small" onClick={() => void fetchYt()} disabled={!url.trim()}>
            参照映像にする
          </button>
        </div>
        {urlErr && <div className="ai-err">{urlErr}</div>}
        {oe && (
          <div className="info-oe">
            <b>{oe.title}</b>
            <span className="lbl"> {oe.author}</span>
            {!fields['TITLE'] && (
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <button className="link-btn" onClick={() => setFieldValue('TITLE', oe.title, '曲名を動画タイトルにする')}>
                  動画タイトルを曲名にする
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
        {open ? Icon.chevronDown(12) : Icon.chevronRight(12)} 経過（{steps.filter((s) => s.state !== 'run').length}）
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

const YT_KIND: Record<YtPick['kind'], string> = { mv: 'MV', audio: '音源', live: 'ライブ', other: '動画' };

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
    try {
      if (useFields && changes.length) {
        edit('曲情報をまとめて設定', (d) => {
          for (const k of changes) setField(d, k, result.fields[k]!.value.trim());
        });
        done.push(`${changes.length}項目`);
      }
      if (useYt && canYt && firstYt) {
        setYoutube({ url: firstYt.url, offset: yt?.offset ?? 0 });
        done.push('参照映像');
      }
      if (useJacket && result.jacket) {
        try {
          await saveArtCentered(result.jacket, artPreset('pre-sq'));
          done.push('#PREIMAGE');
        } catch (e) {
          failed.push(`ジャケット（${(e as Error).message}）`);
        }
      }
      if (useBg && firstYt) {
        const cand: ArtCandidate = { url: `https://i.ytimg.com/vi/${firstYt.id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${firstYt.id}/maxresdefault.jpg`, label: '', source: 'youtube' };
        for (const id of ['stage', 'bg']) {
          try {
            await saveArtCentered(cand, artPreset(id));
            done.push(`#${artPreset(id).key}`);
          } catch (e) {
            failed.push(`${artPreset(id).key}（${(e as Error).message}）`);
            break;
          }
        }
      }
    } finally {
      setBusy(false);
    }
    // 済んだものは外す（もう一度押して同じ画像を重ねて書き出さないように）
    setUseFields(false);
    setUseYt(false);
    if (done.includes('#PREIMAGE')) setUseJacket(false);
    if (done.includes('#BACKGROUND')) setUseBg(false);
    setApplied(done);
    if (failed.length) toast(`設定できなかったもの: ${failed.join('、')}`, 'warn', 8000);
    if (done.length) toast(`${done.join('・')} を設定しました（曲名などは Ctrl+Z で戻せます）`, 'ok', 6000);
    else if (!failed.length) toast('変わるものはありません', 'info');
  };

  return (
    <div className="info-ai">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {result.confidence ? (
          <span className={`ai-conf ${result.confidence}`}>{result.confidence === 'high' ? '自信度 高' : result.confidence === 'medium' ? '自信度 中' : '自信度 低'}</span>
        ) : (
          <span className="ai-tag">タグと iTunes から</span>
        )}
        {result.year && <span className="lbl">リリース {result.year}年</span>}
        <span className="grow" />
        {result.ai && (
          <span className="lbl mono" title={`${result.model} · Web検索 ${result.webSearches}回`}>
            {formatUsd(result.cost)}
          </span>
        )}
      </div>
      {result.notes && <p className="lbl" style={{ margin: '6px 0', lineHeight: 1.6 }}>{result.notes}</p>}
      {changes.length > 0 && (
        <div className="lbl" style={{ margin: '6px 0' }}>
          案: {changes.map((k) => FIELD_LABEL[k]).join('・')}（左の各項目の「反映」でも選べます）
        </div>
      )}
      {result.youtube.length > 0 && (
        <div className="yt-picks">
          <div className="lbl">公式の YouTube</div>
          {result.youtube.map((y) => (
            <div key={y.id} className="yt-pick">
              <a href={y.url} target="_blank" rel="noreferrer" className="yt-thumb" title="YouTube で開く">
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
                  <span className={`ai-badge ${y.official ? 'ok' : ''}`}>{y.official ? '公式' : '公式か不明'}</span>
                  <span className="ai-tag">{YT_KIND[y.kind]}</span>
                  <span className="grow" />
                  {curId === y.id ? (
                    <span className="lbl">参照映像に設定中</span>
                  ) : (
                    <button className="link-btn" onClick={() => setYoutube({ url: y.url, offset: yt?.offset ?? 0 })} title="譜面の再生に合わせて動く参照映像にします">
                      参照映像にする
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
            まとめて設定
          </div>
          {changes.length > 0 && (
            <label>
              <input type="checkbox" checked={useFields} onChange={(e) => setUseFields(e.target.checked)} /> {changes.map((k) => FIELD_LABEL[k]).join('・')}
            </label>
          )}
          {canYt && (
            <label>
              <input type="checkbox" checked={useYt} onChange={(e) => setUseYt(e.target.checked)} /> 公式動画を参照映像にする
            </label>
          )}
          {result.jacket && (
            <label title={result.jacket.label}>
              <input type="checkbox" checked={useJacket} onChange={(e) => setUseJacket(e.target.checked)} /> ジャケットを #PREIMAGE（400×400）に{fields['PREIMAGE'] ? '（今の画像と置き換え）' : ''}
            </label>
          )}
          {firstYt && (
            <label>
              <input type="checkbox" checked={useBg} onChange={(e) => setUseBg(e.target.checked)} /> 動画のサムネイルを #STAGEFILE・#BACKGROUND（1280×720）に
            </label>
          )}
          <button className="btn small primary" style={{ marginTop: 6 }} onClick={() => void applyAll()} disabled={busy || items === 0}>
            {busy ? '設定しています…' : 'まとめて設定'}
          </button>
          <span className="lbl"> {applied?.length ? `✓ ${applied.join('・')} を設定しました` : '画像は曲フォルダに PNG で書き出します'}</span>
        </div>
      ) : null}
      {result.sources.length > 0 && (
        <div className="info-src">
          <div className="lbl">調べた先</div>
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
      if (r.length === 0) setMsg('見つかりませんでした。曲名とアーティストを確かめてください');
    } catch (e) {
      setMsg(`検索できませんでした: ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  };

  const cands: ArtCandidate[] = [];
  const add = (c: ArtCandidate) => {
    if (!cands.some((x) => x.big === c.big)) cands.push(c);
  };
  for (const c of found ?? []) add(c);
  if (picture) add({ url: picture, big: picture, label: '原曲のファイルに入っていたジャケット', source: 'file' });
  for (const c of ytThumbs.slice(0, 1)) add(c);
  for (const h of hits) add(h.art);
  for (const c of local) add(c);
  return (
    <section className="card ai-card">
      <h3>サムネイル</h3>
      <p className="lbl" style={{ margin: '4px 0 8px' }}>
        原曲のジャケット・配信サービスの公開アートワーク・YouTube のサムネイルから選び、切り取って設定します（AIには画像を作らせません）。
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => void search()} disabled={searching || !(fields['TITLE'] || fields['ARTIST'])}>
          {searching ? '探しています…' : 'アートワークを探す（iTunes）'}
        </button>
        <button className="btn small ghost" onClick={() => fileRef.current?.click()}>
          画像ファイルを選ぶ
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
        <p className="lbl">{id ? '' : '「曲情報を調べる」か、参照映像（YouTube）を設定すると候補が出ます。'}</p>
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
      () => alive && setErr('画像を読み込めませんでした'),
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
      const { name, where } = await saveArt(img, { x: x0 * iw, y: y0 * ih, w: cw * iw, h: ch * ih }, preset);
      toast(
        where === 'written'
          ? `${name} を曲フォルダに書き出し、#${preset.key} に設定しました`
          : where === 'memory'
            ? `${name} を作り #${preset.key} に設定しました（保存のときに曲フォルダへ書き出します）`
            : `${name} をダウンロードしました。曲フォルダに入れてください`,
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
        !err && <div className="lbl">読み込み中…</div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <span className="lbl">大きさ</span>
        <input type="range" min={0.3} max={1} step={0.01} value={scale} onChange={(e) => setScale(Number(e.target.value))} className="grow" />
        <span className="lbl mono">
          {img ? `${Math.round(cw * iw)}×${Math.round(ch * ih)}` : ''} → {preset.w}×{preset.h}
        </span>
      </div>
      {tainted && <p className="lbl" style={{ margin: 0 }}>この画像は配信元の設定で書き出せないことがあります。</p>}
      {err && <div className="ai-err">{err}</div>}
      <button className="btn primary small" onClick={() => void exportImage()} disabled={!img}>
        切り取って #{preset.key} に設定
      </button>
    </div>
  );
}
