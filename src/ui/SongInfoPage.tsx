// 曲情報の画面：ヘッダの全項目、AI による取得（Web検索で裏を取る）、サムネイルの選択とトリミング。
import { useEffect, useMemo, useRef, useState } from 'react';
import { AiError } from '../ai/openrouter';
import { cleanSongInfo, itunesSearch, SONG_INFO_SCHEMA, songInfoPrompt, youtubeOEmbed, youtubeThumbs, type ArtCandidate, type SongInfoAnswer, type StoreHit } from '../ai/songInfo';
import { formatUsd, modelLabel } from '../ai/tasks';
import { setField } from '../edit/ops';
import { downloadBytes, findFile, putFile } from '../fs/folder';
import { NO_KEY_TITLE, runAi, taskCostEstimate, useAi, useHasAiKey } from '../store/ai';
import { edit, goBack, openSettings, setFieldValue, toast, useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
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

export function SongInfoPage() {
  const fields = useEditor((s) => s.doc.fields);
  const [ai, setAi] = useState<{ answer: SongInfoAnswer; sources: { url: string; title: string }[]; cost: number; model: string } | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-back') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) goBack();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const others = Object.keys(fields).filter((k) => !KNOWN.has(k) && !SKIP.test(k) && !/^(GLEVEL|BLEVEL|BGMWAV)$/.test(k));
  const suggestion: Record<string, string> = ai
    ? { TITLE: ai.answer.title, ARTIST: ai.answer.artist, GENRE: ai.answer.genre, COMMENT: ai.answer.comment, PANEL: ai.answer.panel }
    : {};
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
                  <FieldRow key={f.key} f={f} value={fields[f.key] ?? ''} suggestion={suggestion[f.key]} />
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
          <AiCard result={ai} onResult={setAi} />
          <ArtCard />
        </aside>
      </div>
    </div>
  );
}

function FieldRow({ f, value, suggestion }: { f: FieldDef; value: string; suggestion?: string }) {
  const folder = useEditor((s) => s.folder);
  const options = f.files && folder ? [...folder.files.values()].filter((x) => f.files!.test(x.name)) : null;
  const differs = suggestion !== undefined && suggestion.trim() !== '' && suggestion.trim() !== value.trim();
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
        {differs && (
          <div className="info-suggest">
            <span className="ai-mark">AI</span>
            <span className="grow">{suggestion}</span>
            <button className="link-btn" onClick={() => setFieldValue(f.key, suggestion!.trim(), `${f.label}をAIの案にする`)}>
              反映
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function AiCard({
  result,
  onResult,
}: {
  result: { answer: SongInfoAnswer; sources: { url: string; title: string }[]; cost: number; model: string } | null;
  onResult: (r: { answer: SongInfoAnswer; sources: { url: string; title: string }[]; cost: number; model: string } | null) => void;
}) {
  const fields = useEditor((s) => s.doc.fields);
  const yt = useSidecar((s) => s.youtube);
  const hasKey = useHasAiKey();
  const running = useAi((s) => (s.running.songinfo ?? 0) > 0);
  const model = useAi((s) => modelLabel(s.tasks.songinfo.model, s.models));
  const cost = useAi(() => taskCostEstimate('songinfo'));
  const [url, setUrl] = useState(yt?.url ?? '');
  const [oe, setOe] = useState<{ title: string; author: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setUrl(yt?.url ?? ''), [yt?.url]);

  const fetchYt = async () => {
    setErr(null);
    if (!youtubeId(url)) {
      setErr('YouTube の URL を入れてください');
      return null;
    }
    const r = await youtubeOEmbed(url);
    if (!r) {
      setErr('動画の情報を取れませんでした（非公開か、ネットワークの問題）');
      return null;
    }
    setOe({ title: r.title, author: r.author });
    if (!yt || yt.url !== url) setYoutube({ url, offset: yt?.offset ?? 0 });
    return r;
  };

  const askAi = async () => {
    setErr(null);
    let o = oe;
    if (!o && youtubeId(url)) o = await fetchYt();
    const p = songInfoPrompt({
      title: fields['TITLE'] ?? '',
      artist: fields['ARTIST'] ?? '',
      youtubeTitle: o?.title,
      youtubeAuthor: o?.author,
      genre: fields['GENRE'],
      bpm: Number(fields['BPM']) || undefined,
    });
    if (!fields['TITLE'] && !o) {
      setErr('曲名か YouTube の URL を入れてください');
      return;
    }
    try {
      const r = await runAi<Partial<SongInfoAnswer>>('songinfo', { ...p, schema: SONG_INFO_SCHEMA, maxTokens: 1500 });
      if (!r) return;
      onResult({ answer: cleanSongInfo(r.data), sources: r.citations, cost: r.costUsed, model: r.model });
    } catch (e) {
      setErr(e instanceof AiError ? e.message : `失敗しました: ${(e as Error).message}`);
    }
  };

  const applyAll = () => {
    if (!result) return;
    const a = result.answer;
    const map: [string, string][] = [
      ['TITLE', a.title],
      ['ARTIST', a.artist],
      ['GENRE', a.genre],
      ['COMMENT', a.comment],
      ['PANEL', a.panel],
    ];
    const changes = map.filter(([k, v]) => v.trim() && v.trim() !== (fields[k] ?? '').trim());
    if (changes.length === 0) {
      toast('変わる項目はありません', 'info');
      return;
    }
    edit('曲情報をAIの案にする', (d) => {
      for (const [k, v] of changes) setField(d, k, v.trim());
    });
    toast(`${changes.length} 項目を反映しました（Ctrl+Z で戻せます）`, 'ok');
  };

  return (
    <section className="card ai-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="ai-spark">{Icon.sparkle(14)}</span>
        <h3>AIで調べる</h3>
        <span className="grow" />
        {hasKey ? (
          <span className="lbl">
            {model} · 約 {formatUsd(cost)}
          </span>
        ) : (
          <button className="link-btn" onClick={() => openSettings('ai')}>
            キーを設定
          </button>
        )}
      </div>
      <div className="lbl" style={{ margin: '8px 0 4px' }}>
        YouTube の URL（動画タイトルとサムネイルはキーが無くても取れます）
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="field grow" value={url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => setUrl(e.target.value)} />
        <button className="btn small" onClick={() => void fetchYt()} disabled={!url.trim()}>
          取得
        </button>
      </div>
      {oe && (
        <div className="info-oe">
          <b>{oe.title}</b>
          <span className="lbl"> {oe.author}</span>
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            {!fields['TITLE'] && (
              <button className="link-btn" onClick={() => setFieldValue('TITLE', oe.title, '曲名を動画タイトルにする')}>
                動画タイトルを曲名にする
              </button>
            )}
          </div>
        </div>
      )}
      <button className="btn primary" style={{ width: '100%', marginTop: 10 }} onClick={() => void askAi()} disabled={!hasKey || running} title={hasKey ? '正式表記・ジャンル・年・コメント・パネル文を Web 検索で調べます' : NO_KEY_TITLE}>
        {Icon.sparkle(14)} {running ? '調べています…' : 'AIで曲情報を調べる'}
      </button>
      {!hasKey && <p className="lbl" style={{ margin: '6px 0 0' }}>{NO_KEY_TITLE}。キーが無くても左の項目は手で入力できます。</p>}
      {err && <div className="ai-err">{err}</div>}
      {result && (
        <div className="info-ai">
          <div className="row" style={{ gap: 6 }}>
            <span className={`ai-conf ${result.answer.confidence}`}>{result.answer.confidence === 'high' ? '自信度 高' : result.answer.confidence === 'medium' ? '自信度 中' : '自信度 低'}</span>
            {result.answer.year && <span className="lbl">リリース {result.answer.year}年</span>}
            <span className="grow" />
            <span className="lbl mono">{formatUsd(result.cost)}</span>
          </div>
          {result.answer.notes && <p className="lbl" style={{ margin: '6px 0' }}>{result.answer.notes}</p>}
          {result.sources.length > 0 && (
            <div className="info-src">
              <div className="lbl">調べた先</div>
              {result.sources.slice(0, 5).map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="ellipsis">
                  {s.title}
                </a>
              ))}
            </div>
          )}
          <button className="btn small" style={{ marginTop: 8 }} onClick={applyAll}>
            案をまとめて反映
          </button>
          <span className="lbl"> 項目ごとの「反映」でも選べます</span>
        </div>
      )}
    </section>
  );
}

// ---- サムネイル -----------------------------------------------------------------------

interface Preset {
  id: string;
  label: string;
  key: 'PREIMAGE' | 'STAGEFILE' | 'BACKGROUND';
  w: number;
  h: number;
  file: string;
}

const PRESETS: Preset[] = [
  { id: 'pre-sq', label: 'PREIMAGE 正方形 400×400', key: 'PREIMAGE', w: 400, h: 400, file: 'preimage.png' },
  { id: 'pre-old', label: 'PREIMAGE 縦長 204×269（旧DTXMania）', key: 'PREIMAGE', w: 204, h: 269, file: 'preimage.png' },
  { id: 'stage', label: 'STAGEFILE 1280×720', key: 'STAGEFILE', w: 1280, h: 720, file: 'stagefile.png' },
  { id: 'bg', label: 'BACKGROUND 1280×720', key: 'BACKGROUND', w: 1280, h: 720, file: 'background.png' },
];

function ArtCard() {
  const yt = useSidecar((s) => s.youtube);
  const fields = useEditor((s) => s.doc.fields);
  const folder = useEditor((s) => s.folder);
  const [hits, setHits] = useState<StoreHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState<ArtCandidate | null>(null);
  const [local, setLocal] = useState<ArtCandidate[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = yt ? youtubeId(yt.url) : null;
  const ytThumbs = useMemo(() => (id ? youtubeThumbs(id) : []), [id]);
  // 曲フォルダの画像
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    void (async () => {
      const imgs = folder ? [...folder.files.values()].filter((f) => IMG.test(f.name) && !/^bmp|bga/i.test(f.name)).slice(0, 8) : [];
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

  const cands = [...ytThumbs.slice(0, 1), ...hits.map((h) => h.art), ...local];
  return (
    <section className="card ai-card">
      <h3>サムネイル</h3>
      <p className="lbl" style={{ margin: '4px 0 8px' }}>
        YouTube のサムネイルと、配信サービスの公開アートワークから選びます（AIには画像を作らせません）。
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
            <button key={c.big + i} className={`art-cand ${sel?.big === c.big ? 'on' : ''}`} onClick={() => setSel(c)} title={c.label}>
              <img src={c.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : (
        <p className="lbl">{id ? '' : '参照動画（YouTube）を設定するとサムネイルも候補に出ます。'}</p>
      )}
      {sel && <Cropper cand={sel} />}
    </section>
  );
}

function Cropper({ cand }: { cand: ArtCandidate }) {
  const folder = useEditor((s) => s.folder);
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
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
    const load = (src: string, cors: boolean) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        if (cors) im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('読み込めませんでした'));
        im.src = src;
      });
    void (async () => {
      const srcs = cand.big !== cand.url ? [cand.big, cand.url] : [cand.url];
      for (const src of srcs) {
        try {
          const im = await load(src, cand.source !== 'file');
          // YouTube の maxres が無いときは 120×90 の灰色が返る
          if (im.naturalWidth <= 120 && srcs.length > 1 && src !== srcs[srcs.length - 1]) continue;
          if (alive) setImg(im);
          return;
        } catch {
          try {
            const im = await load(src, false);
            if (alive) {
              setImg(im);
              setTainted(true);
            }
            return;
          } catch {
            // 次
          }
        }
      }
      if (alive) setErr('画像を読み込めませんでした');
    })();
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
  const ch = (fitW / aspect) * scale / ih;
  const clampX = (x: number) => Math.max(cw / 2, Math.min(1 - cw / 2, x));
  const clampY = (y: number) => Math.max(ch / 2, Math.min(1 - ch / 2, y));
  const x0 = clampX(cx) - cw / 2;
  const y0 = clampY(cy) - ch / 2;

  const exportImage = async () => {
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = preset.w;
    c.height = preset.h;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, x0 * iw, y0 * ih, cw * iw, ch * ih, 0, 0, preset.w, preset.h);
    let blob: Blob | null = null;
    try {
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    } catch {
      blob = null;
    }
    if (!blob) {
      setErr('この画像は配信元が書き出しを許可していないため切り取れません。画像を保存してから「画像ファイルを選ぶ」で選んでください');
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let name = preset.file;
    if (folder) {
      // 同じ名前があれば番号を付ける
      for (let i = 2; findFile(folder, name) && i < 50; i++) name = preset.file.replace('.png', `_${i}.png`);
      const where = await putFile(folder, name, bytes);
      setFieldValue(preset.key, name, `#${preset.key} を ${name} にする`);
      toast(where === 'written' ? `${name} を曲フォルダに書き出し、#${preset.key} に設定しました` : `${name} を作り #${preset.key} に設定しました（保存のときに曲フォルダへ書き出します）`, 'ok', 6000);
    } else {
      downloadBytes(name, bytes, 'image/png');
      setFieldValue(preset.key, name, `#${preset.key} を ${name} にする`);
      toast(`${name} をダウンロードしました。曲フォルダに入れてください`, 'ok', 6000);
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
      <select className="field" value={preset.id} onChange={(e) => setPreset(PRESETS.find((p) => p.id === e.target.value)!)}>
        {PRESETS.map((p) => (
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
