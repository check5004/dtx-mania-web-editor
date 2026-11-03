// 精度テストのページ（bench.html）。曲フォルダを選ぶと、混ぜ方ごとにテスト曲を作って方式ごとに採点する。
// 自動で回すとき（scripts/bench.mjs）は window.__bench.run() を呼ぶ。
import { modelEvidence, onsetEvidence, type Evidence } from '../assist/evidence';
import { heardDrums, type HeardDrums } from '../assist/heard';
import { measureAudio, type MeasureAudio } from '../assist/measureAudio';
import { analyzeAudio } from '../audio/analysis';
import { computeFrameFeatures, type FrameFeatures } from '../audio/features';
import { transcribe } from '../transcribe/client';
import { drumHits, type DrumHit } from '../transcribe/peaks';
import { decodeDtx } from '../dtx/encoding';
import { parseDtx } from '../dtx/parse';
import { dtxFiles, normPath, type FolderFile, type SongFolder } from '../fs/folder';
import { bgmSource, tempoOf } from '../store/derived';
import { CLASS_LABEL, DRUM_CLASSES } from './classes';
import { AHEAD, calibBins, COMPLETION_METHODS, evaluateCompletion, offsetSummary, poolCompletion, poolEvidence, trainingRows, type ChartCompletion, type EvidenceInput } from './complete';
import { BENCH_METHODS } from './methods';
import { encodeWav, renderMix, type MixEvent } from './mix';
import { evaluateCase, poolResults, type CaseResult, type PooledRow } from './run';
import type { ClassScore } from './score';
import { buildCase, loadSong, MIX_KINDS, MIX_LABEL, MIX_NOTE, type Decoder, type LoadedSong, type MixKind } from './song';

const SR = 44100;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let songs: SongFolder[] = [];
let lastRun: { results: CaseResult[]; pooled: PooledRow[]; tol: number; at: string } | null = null;
const fullSongs = new Set<string>(
  (new URLSearchParams(location.search).get('full') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** 選んだファイルを曲ごとに分ける。DTX が直下にあるフォルダを1曲とする */
function groupSongs(list: File[]): SongFolder[] {
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const dirs = new Set<string>();
  for (const f of list) {
    if (!/\.dtx$/i.test(f.name)) continue;
    const p = rel(f).split('/');
    dirs.add(p.slice(0, -1).join('/'));
  }
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  const by = new Map<string, Map<string, FolderFile>>();
  for (const f of list) {
    const r = rel(f);
    const d = sorted.find((x) => x === '' || r.startsWith(x + '/'));
    if (d === undefined) continue;
    const path = d ? r.slice(d.length + 1) : r;
    if (!by.has(d)) by.set(d, new Map());
    by.get(d)!.set(normPath(path), { path, name: f.name, size: f.size, getFile: async () => f });
  }
  return [...by.entries()]
    .map(([d, files]) => ({ name: d.split('/').pop() || '選んだ曲', files }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderSongs() {
  const box = $('songs');
  box.innerHTML = '';
  if (songs.length === 0) return;
  const head = document.createElement('div');
  head.className = 'lbl';
  head.style.width = '100%';
  head.textContent = `${songs.length} 曲。BGM がドラム入りの原曲そのもの（ドラム抜きでない）曲にはチェックを入れてください。「原曲」で測り、「合成」と「ドラム無し」は作りません。チェックの無い曲は、DTX でふつうのドラム抜きの BGM とみなします。`;
  box.append(head);
  for (const s of songs) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = fullSongs.has(s.name);
    c.onchange = () => (c.checked ? fullSongs.add(s.name) : fullSongs.delete(s.name));
    l.append(c, ` ${s.name}`);
    box.append(l);
  }
}

function renderMixOptions() {
  const box = $('mixes');
  for (const k of MIX_KINDS) {
    const l = document.createElement('label');
    l.title = MIX_NOTE[k];
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = true;
    c.dataset.mix = k;
    l.append(c, ` ${MIX_LABEL[k]}`);
    box.append(l);
  }
  const note = document.createElement('div');
  note.className = 'lbl';
  note.style.width = '100%';
  note.innerHTML = MIX_KINDS.map((k) => `<b>${MIX_LABEL[k]}</b>：${MIX_NOTE[k]}`).join('<br>');
  box.append(note);
}

let decodeCtx: OfflineAudioContext | null = null;
const decode: Decoder = async (bytes) => {
  decodeCtx ??= new OfflineAudioContext(2, 1, SR);
  try {
    const b = await decodeCtx.decodeAudioData(bytes);
    return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
  } catch {
    return null;
  }
};

function setStatus(msg: string) {
  $('status').textContent = msg;
}

export interface RunOptions {
  mixes?: MixKind[];
  /** BGM がドラム入りの原曲そのものの曲（名前） */
  full?: string[];
  tol?: number;
  wav?: boolean;
}

async function run(opts: RunOptions = {}) {
  const mixes = opts.mixes ?? MIX_KINDS.filter((k) => ($('mixes').querySelector(`[data-mix="${k}"]`) as HTMLInputElement).checked);
  const tol = opts.tol ?? Number(($('tol') as HTMLSelectElement).value);
  const keepWav = opts.wav ?? ($('wav') as HTMLInputElement).checked;
  const full = new Set(opts.full ?? fullSongs);
  const results: CaseResult[] = [];
  const skipped: { song: string; mix: MixKind; why: string }[] = [];
  const wavs: { song: string; mix: MixKind; url: string }[] = [];
  $('run').toggleAttribute('disabled', true);
  $('out').innerHTML = '';
  try {
    for (let i = 0; i < songs.length; i++) {
      const sf = songs[i];
      const tag = `曲 ${i + 1}/${songs.length} ${sf.name}`;
      setStatus(`${tag}: 読み込み中`);
      const s = await loadSong(sf, decode, SR, (m) => setStatus(`${tag}: ${m}`));
      if (!s) {
        skipped.push({ song: sf.name, mix: 'chips', why: '譜面（.dtx）が無い' });
        continue;
      }
      for (const mix of mixes) {
        setStatus(`${tag}: ${MIX_LABEL[mix]} を作成中`);
        await new Promise((r) => setTimeout(r, 0));
        const tc = buildCase(s, mix, { fullSong: full.has(sf.name) });
        if ('skip' in tc) {
          skipped.push({ song: sf.name, mix, why: tc.skip });
          continue;
        }
        if (keepWav) wavs.push({ song: sf.name, mix, url: URL.createObjectURL(new Blob([encodeWav(tc.channels, tc.sr) as BlobPart], { type: 'audio/wav' })) });
        const r = await evaluateCase(tc, BENCH_METHODS, tol, (m) => setStatus(`${tag}: ${MIX_LABEL[mix]} を ${m.label} で推定中`));
        results.push(r);
        renderResults(results, skipped, wavs, tol);
      }
    }
    const pooled = poolResults(results);
    lastRun = { results, pooled, tol, at: new Date().toISOString() };
    renderResults(results, skipped, wavs, tol);
    setStatus(`終わりました（${results.length} 件）`);
    $('json').toggleAttribute('disabled', false);
    return { ...lastRun, skipped };
  } catch (e) {
    setStatus(`止まりました: ${(e as Error).message}`);
    throw e;
  } finally {
    $('run').toggleAttribute('disabled', songs.length === 0);
  }
}

const f2 = (x: number | null) => (x === null ? '–' : x.toFixed(2));

function fCell(c: ClassScore | undefined): string {
  if (!c || c.f === null) return '<td class="f">–</td>';
  const tip = `正解 ${c.ref} ・推定 ${c.est} ・当たり ${c.tp}`;
  return `<td class="f" title="${tip}">${f2(c.f)}<small>${f2(c.precision)} / ${f2(c.recall)}</small></td>`;
}

function scoreRow(first: string, s: { all: ClassScore; classes: Record<string, ClassScore> }, extra = ''): string {
  const all = s.all;
  const dev = all.tp > 0 ? `${((all.devSum / all.tp) * 1000).toFixed(0)}ms` : '–';
  return `<tr><td class="l">${first}</td>${extra}${fCell(all)}${DRUM_CLASSES.map((k) => fCell(s.classes[k])).join('')}<td class="mono">${all.ref}</td><td class="mono">${all.est}</td><td class="mono">${dev}</td></tr>`;
}

const scoreHead = (first: string, extra = '') =>
  `<tr><th class="l">${first}</th>${extra}<th>全体</th>${DRUM_CLASSES.map((k) => `<th title="${CLASS_LABEL[k]}">${k}</th>`).join('')}<th>正解</th><th>推定</th><th title="当たった組のずれの平均（推定−正解）">ずれ</th></tr>`;

function renderResults(results: CaseResult[], skipped: { song: string; mix: MixKind; why: string }[], wavs: { song: string; mix: MixKind; url: string }[], tol: number) {
  const pooled = poolResults(results);
  let h = `<h2>まとめ（${new Set(results.map((r) => r.song)).size} 曲、許容 ±${Math.round(tol * 1000)}ms）</h2>`;
  h += '<p>曲をまたいで当たり・正解・推定の数を足してから計算した F 値。下の小さい数字は 適合率（推定のうち当たった割合）/ 再現率（正解のうち拾えた割合）。「ずれ」は当たった組の平均のずれ（推定−正解）。</p>';
  h += `<div class="scroll"><table>${scoreHead('混ぜ方', '<th class="l">方式</th>')}`;
  for (const r of pooled) h += scoreRow(`${MIX_LABEL[r.mix]}<br><span class="lbl">${r.songs} 曲</span>`, r.score, `<td class="l">${r.label}</td>`);
  h += '</table></div>';
  h += '<h2>曲ごと</h2>';
  for (const r of results) {
    h += `<details><summary>${r.song}・${MIX_LABEL[r.mix]}（${r.chart}、${Math.round(r.duration)}秒、正解 ${r.truth} 打）</summary>`;
    if (r.notes.length) h += `<ul>${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>`;
    h += `<div class="scroll"><table>${scoreHead('方式')}`;
    for (const m of r.methods) h += scoreRow(`${m.label}<br><span class="lbl">${m.ms}ms</span>`, m.score);
    h += '</table></div>';
    const m0 = r.methods[0];
    if (m0) {
      const lanes = Object.entries(m0.lanes).sort((a, b) => b[1].ref - a[1].ref);
      h += `<p class="lbl">レーンごとに拾えた割合（${m0.label}）: ${lanes.map(([k, v]) => `${k} ${v.hit}/${v.ref}`).join('・')}</p>`;
    }
    const w = wavs.find((x) => x.song === r.song && x.mix === r.mix);
    if (w) h += `<p><a href="${w.url}" download="${r.song}-${r.mix}.wav">混ぜた音を保存（WAV）</a></p>`;
    h += '</details>';
  }
  if (skipped.length) h += `<h2>作れなかったテスト曲</h2><ul>${skipped.map((s) => `<li>${s.song}・${MIX_LABEL[s.mix]}：${s.why}</li>`).join('')}</ul>`;
  h += `<h2>比べた方式</h2><ul>${BENCH_METHODS.map((m) => `<li><b>${m.label}</b>：${m.note}</li>`).join('')}</ul>`;
  $('out').innerHTML = h;
}

// ---- TAB補完（先の小節の予測） --------------------------------------------------------

let lastComplete: { results: ChartCompletion[]; at: string } | null = null;

interface SongAudio {
  frames: FrameFeatures;
  duration: number;
  bgmSec: number;
  /** 採譜モデルの打点（0 秒は正解の譜面の 0 秒） */
  hits: DrumHit[] | null;
  /** v0 の打点検出での照合 */
  v0: Evidence;
}

/** 曲の原曲に近い音（BGM＋ドラムの録音があれば重ねる）の特徴・採譜。0 秒は正解の譜面の 0 秒 */
async function songAudio(s: LoadedSong, useDrums: boolean, onStep: (m: string) => void): Promise<SongAudio | null> {
  const events: MixEvent[] = [];
  for (const p of [...s.bgm, ...(s.stem ? [s.stem] : [])]) {
    const sound = s.sounds.get(normPath(p.path));
    if (sound) events.push({ sec: p.sec, sound, gain: p.gain, pan: p.pan, choke: null });
  }
  if (events.length === 0 || s.bgm.length === 0) return null;
  let end = 0;
  for (const e of events) end = Math.max(end, e.sec + e.sound[0].length / s.sr);
  const ch = renderMix(events, s.sr, end);
  const frames = computeFrameFeatures(ch, s.sr);
  const v0 = onsetEvidence(analyzeAudio([...ch], s.sr));
  let hits: DrumHit[] | null = null;
  if (useDrums) {
    onStep('ドラムを採譜中');
    hits = drumHits(await transcribe(ch, s.sr, { onProgress: (st, p) => st === 'run' && onStep(`ドラムを採譜中 ${Math.round(p * 100)}%`) }));
  }
  return { frames, duration: end, bgmSec: s.bgm[0].sec, hits, v0 };
}

export interface CompleteOptions {
  /** 採譜モデルを使う方式も測る（既定は使う） */
  drums?: boolean;
  /** 点数の重みを学習するための行も返す */
  train?: boolean;
}

let lastTrain: { song: string; chart: string; rows: number[][] }[] = [];

async function runComplete(opts: CompleteOptions = {}) {
  const useDrums = opts.drums ?? true;
  const results: ChartCompletion[] = [];
  const train: { song: string; chart: string; rows: number[][] }[] = [];
  const skipped: string[] = [];
  $('runComplete').toggleAttribute('disabled', true);
  $('outComplete').innerHTML = '';
  try {
    for (let i = 0; i < songs.length; i++) {
      const sf = songs[i];
      const tag = `TAB補完 曲 ${i + 1}/${songs.length} ${sf.name}`;
      setStatus(`${tag}: 読み込み中`);
      const s = await loadSong(sf, decode, SR, (m) => setStatus(`${tag}: ${m}`));
      if (!s) {
        skipped.push(`${sf.name}：譜面（.dtx）が無い`);
        continue;
      }
      setStatus(`${tag}: 原曲の聞こえ方を調べています`);
      await new Promise((r) => setTimeout(r, 0));
      const feat = await songAudio(s, useDrums, (m) => setStatus(`${tag}: ${m}`));
      if (!feat) skipped.push(`${sf.name}：BGM が読めないので、原曲を使う方式は測らない`);
      for (const f of dtxFiles(sf)) {
        const { doc } = parseDtx(decodeDtx(new Uint8Array(await (await f.getFile()).arrayBuffer())).text);
        const tempo = tempoOf(doc);
        let audio: MeasureAudio | null = null;
        let heard: HeardDrums | null = null;
        let ev: EvidenceInput | null = null;
        const bx = bgmSource(doc)?.sec;
        if (feat && bx !== undefined) {
          const off = bx - feat.bgmSec;
          const last = Math.min(3599, tempo.locate(tempo.secToBeat(feat.duration + off)).m + 1);
          audio = measureAudio({ frames: feat.frames, offsetSec: off, duration: feat.duration }, tempo, last);
          const sources: Record<string, Evidence> = { v0: feat.v0 };
          if (feat.hits) {
            heard = heardDrums(feat.hits, tempo, off, feat.duration);
            sources.model = modelEvidence(feat.hits);
          }
          ev = { sources, toAudio: (sec) => sec - off, minScore: 0.2 };
        }
        setStatus(`${tag}: ${f.name} の先を予測中`);
        await new Promise((r) => setTimeout(r, 0));
        const r = evaluateCompletion(sf.name, f.name, doc, COMPLETION_METHODS, audio, heard, ev);
        if (r.blocks < 16) {
          skipped.push(`${sf.name}・${f.name}：ドラムの小節が少ない`);
          continue;
        }
        results.push(r);
        if (opts.train && audio) train.push({ song: sf.name, chart: f.name, rows: trainingRows(doc, audio, heard) });
        renderCompletion(results, skipped);
      }
    }
    lastComplete = { results, at: new Date().toISOString() };
    lastTrain = train;
    renderCompletion(results, skipped);
    setStatus(`TAB補完：終わりました（${results.length} 譜面）`);
    $('json').toggleAttribute('disabled', false);
    return { results, pooled: poolCompletion(results), skipped, evidence: poolEvidence(results), train: opts.train ? train : undefined };
  } catch (e) {
    setStatus(`止まりました: ${(e as Error).message}`);
    throw e;
  } finally {
    $('runComplete').toggleAttribute('disabled', songs.length === 0);
  }
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

function renderCompletion(results: ChartCompletion[], skipped: string[]) {
  const pooled = poolCompletion(results);
  const songsN = new Set(results.map((r) => r.song)).size;
  const withAudio = results.filter((r) => r.audio).length;
  let h = `<h2>TAB補完：まとめ（${songsN} 曲 ${results.length} 譜面、うち原曲あり ${withAudio}）</h2>`;
  h +=
    '<p>打ち終わった譜面を「前から順に打っている途中」とみなし、小節ごとに「その前だけ打ってある」状態から先の4小節を予測して、譜面の続きと比べます。<b>出した</b>＝正解が空でない小節のうち点線を出した割合、<b>そのまま</b>＝出した小節のうち正解とまったく同じだった割合（Tab だけで済む）、<b>F</b>＝チップの当たり具合、<b>手間の減り</b>＝全部採用して直したときに減るクリックの割合（(当たり−外れ)÷正解のチップ）。</p>';
  h += '<div class="scroll"><table><tr><th class="l">方式</th><th>譜面</th>';
  for (let i = 0; i < AHEAD; i++) h += `<th>+${i + 1} 小節目<br><span class="lbl">そのまま / 出した</span></th>`;
  h += '<th>次の小節の F<br><span class="lbl">適合 / 再現</span></th><th>手間の減り<br><span class="lbl">次の小節</span></th></tr>';
  for (const m of pooled) {
    h += `<tr><td class="l">${m.label}</td><td class="mono">${m.charts}</td>`;
    for (let i = 0; i < AHEAD; i++) {
      const o = offsetSummary(m.offsets[i]);
      h += `<td class="f">${pct(o.exactRate)}<small>出した ${pct(o.coverage)}</small></td>`;
    }
    const o0 = offsetSummary(m.offsets[0]);
    h += `<td class="f">${f2(o0.f)}<small>${f2(o0.precision)} / ${f2(o0.recall)}</small></td><td class="f">${pct(o0.saved)}</td></tr>`;
  }
  h += '</table></div>';
  const app = pooled.find((m) => m.id === 'audio') ?? pooled.find((m) => m.id === 'context');
  if (app) {
    h += `<h2>見込みは当てになるか（${app.label}、次の小節）</h2><p>候補の点数（見込み）ごとに、次の小節がそのまま正解だった割合。エディタは見込み 0.35 以上（ふつう）・0.5 以上（控えめ）・0.2 以上（多め）で点線を出します。</p>`;
    h += '<div class="scroll"><table><tr><th class="l">見込み</th><th>数</th><th>そのまま正解</th><th>F の平均</th></tr>';
    for (const b of calibBins(app.calib)) h += `<tr><td class="l mono">${b.lo.toFixed(1)}〜${b.hi.toFixed(1)}</td><td class="mono">${b.n}</td><td class="f">${pct(b.exact)}</td><td class="f">${f2(b.f)}</td></tr>`;
    h += '</table></div>';
  }
  const ev = poolEvidence(results);
  if (Object.keys(ev).length) {
    h += '<h2>原曲との照合（曲の構造も使う・見込み 0.2 以上・次の小節）</h2><p>予測したチップの近く（±50ms）に、同じ種類の打点があったか（聞こえる）／無かったか（聞こえない）で分けて、正解だった割合を比べます。差が大きい種類ほど、「聞こえない」の印が当てになります。</p>';
    h += '<div class="scroll"><table><tr><th class="l">照合</th>' + DRUM_CLASSES.map((k) => `<th>${k}<br><span class="lbl">聞こえる / 聞こえない</span></th>`).join('') + '</tr>';
    for (const [k, t] of Object.entries(ev)) {
      h += `<tr><td class="l">${k === 'v0' ? 'v0（3帯域の打点）' : k === 'model' ? '採譜モデル（ADTOF）' : k}</td>`;
      for (const cls of DRUM_CLASSES) {
        const x = t[cls];
        const a = x.heard ? x.heardOk / x.heard : null;
        const b = x.unheard ? x.unheardOk / x.unheard : null;
        h += x.heard + x.unheard ? `<td class="f">${pct(a)} / ${pct(b)}<small>${x.heard} / ${x.unheard} 個</small></td>` : '<td class="f">–</td>';
      }
      h += '</tr>';
    }
    h += '</table></div>';
  }
  h += '<h2>譜面ごと（次の小節：そのまま / 出した）</h2><div class="scroll"><table><tr><th class="l">曲・譜面</th><th>小節</th>';
  for (const m of pooled) h += `<th>${m.label}</th>`;
  h += '</tr>';
  for (const r of results) {
    h += `<tr><td class="l">${r.song}・${r.chart}${r.audio ? '' : '<br><span class="lbl">原曲なし</span>'}</td><td class="mono">${r.blocks}</td>`;
    for (const m of pooled) {
      const x = r.methods.find((y) => y.id === m.id);
      const o = x ? offsetSummary(x.offsets[0]) : null;
      h += `<td class="f">${o ? pct(o.exactRate) : '–'}<small>${o ? pct(o.coverage) : ''}</small></td>`;
    }
    h += '</tr>';
  }
  h += '</table></div>';
  if (skipped.length) h += `<h2>測らなかった譜面</h2><ul>${skipped.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  h += `<h2>比べた方式</h2><ul>${COMPLETION_METHODS.map((m) => `<li><b>${m.label}</b>：${m.note}</li>`).join('')}</ul>`;
  $('outComplete').innerHTML = h;
}

function downloadJson() {
  if (!lastRun && !lastComplete) return;
  const data = { ...(lastRun ?? {}), complete: lastComplete ? { ...lastComplete, pooled: poolCompletion(lastComplete.results) } : undefined };
  const at = lastRun?.at ?? lastComplete!.at;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bench-${at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
}

renderMixOptions();
$<HTMLInputElement>('pick').addEventListener('change', (e) => {
  songs = groupSongs([...((e.target as HTMLInputElement).files ?? [])]);
  renderSongs();
  $('run').toggleAttribute('disabled', songs.length === 0);
  $('runComplete').toggleAttribute('disabled', songs.length === 0);
  setStatus(songs.length ? '' : 'DTX のあるフォルダが見つかりません');
});
$('run').addEventListener('click', () => void run());
$('runComplete').addEventListener('click', () => void runComplete());
$('json').addEventListener('click', downloadJson);

/** TAB補完の結果を曲をまたいで足し、表に出す数にする（scripts/bench.mjs 用） */
function poolComplete(list: ChartCompletion[]) {
  return poolCompletion(list).map((m) => ({ id: m.id, label: m.label, charts: m.charts, offsets: m.offsets.map(offsetSummary), calib: calibBins(m.calib) }));
}

declare global {
  interface Window {
    __bench?: {
      run: typeof run;
      runComplete: typeof runComplete;
      songs: () => string[];
      pool: typeof poolResults;
      poolComplete: typeof poolComplete;
      poolEvidence: typeof poolEvidence;
      lastTrain: () => typeof lastTrain;
    };
  }
}
window.__bench = { run, runComplete, songs: () => songs.map((s) => s.name), pool: poolResults, poolComplete, poolEvidence, lastTrain: () => lastTrain };
