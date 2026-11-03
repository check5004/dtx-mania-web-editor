// 精度テストのページ（bench.html）。曲フォルダを選ぶと、混ぜ方ごとにテスト曲を作って方式ごとに採点する。
// 自動で回すとき（scripts/bench.mjs）は window.__bench.run() を呼ぶ。
import { normPath, type FolderFile, type SongFolder } from '../fs/folder';
import { CLASS_LABEL, DRUM_CLASSES } from './classes';
import { BENCH_METHODS } from './methods';
import { encodeWav } from './mix';
import { evaluateCase, poolResults, type CaseResult, type PooledRow } from './run';
import type { ClassScore } from './score';
import { buildCase, loadSong, MIX_KINDS, MIX_LABEL, MIX_NOTE, type Decoder, type MixKind } from './song';

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

function downloadJson() {
  if (!lastRun) return;
  const blob = new Blob([JSON.stringify(lastRun, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bench-${lastRun.at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
}

renderMixOptions();
$<HTMLInputElement>('pick').addEventListener('change', (e) => {
  songs = groupSongs([...((e.target as HTMLInputElement).files ?? [])]);
  renderSongs();
  $('run').toggleAttribute('disabled', songs.length === 0);
  setStatus(songs.length ? '' : 'DTX のあるフォルダが見つかりません');
});
$('run').addEventListener('click', () => void run());
$('json').addEventListener('click', downloadJson);

declare global {
  interface Window {
    __bench?: { run: typeof run; songs: () => string[]; pool: typeof poolResults };
  }
}
window.__bench = { run, songs: () => songs.map((s) => s.name), pool: poolResults };
