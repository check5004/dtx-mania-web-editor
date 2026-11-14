// フレーズ候補の状態：範囲、候補（点線で譜面に出す）、選んでいる候補、反映。
import { tr } from '../i18n';
import { create } from 'zustand';
import { AiError } from '../ai/openrouter';
import { buildContext, decodeCandidates, phraseSchema, phrasePrompt, ruleCandidates, type PhraseCandidate } from '../ai/phrase';
import { drumChannel, SD_RIM } from '../dtx/model';
import { lastMeasure } from '../gen/features';
import { levelOfField } from './guideline';
import { hasAiKey, runAi } from './ai';
import { aiOnsets } from './assist';
import { bgmSource, tempoOf } from './derived';
import { edit, prepareSounds, toast, useEditor, wavForChannel, wavForVoice } from './editor';
import { humanMeasure, markAuto } from './provenance';

export interface PhraseState {
  open: boolean;
  kind: 'fill' | 'rhythm';
  from: number;
  to: number;
  instruction: string;
  cands: PhraseCandidate[];
  index: number;
  loading: boolean;
  error: string | null;
  cost: number | null;
  /** 候補を作ったときの譜面（変わったら古いと示す） */
  madeFor: unknown;
}

export const usePhrase = create<PhraseState>(() => ({ open: false, kind: 'fill', from: 0, to: 0, instruction: '', cands: [], index: 0, loading: false, error: null, cost: null, madeFor: null }));
const get = usePhrase.getState;
const set = usePhrase.setState;

/** 選んだチップの小節（無ければカーソルの小節）を範囲にして開く。4小節まで */
export function openPhrase() {
  const s = useEditor.getState();
  const tempo = tempoOf(s.doc);
  let from: number;
  let to: number;
  const sel = new Set(s.selection);
  const ms = s.doc.chips.filter((c) => sel.has(c.id) && drumChannel(c.ch)).map((c) => c.m);
  if (ms.length) {
    from = Math.min(...ms);
    to = Math.min(Math.max(...ms), from + 3);
  } else {
    from = to = tempo.locate(Math.max(0, s.cursorBeat)).m;
  }
  set({ open: true, from, to, cands: [], index: 0, error: null, cost: null });
}

export function closePhrase() {
  set({ open: false, cands: [], error: null });
}

export function setPhraseRange(from: number, to: number) {
  const f = Math.max(0, Math.min(from, to));
  set({ from: f, to: Math.min(Math.max(from, to), f + 3), cands: [], index: 0 });
}

export function current(): PhraseCandidate | null {
  const p = get();
  return p.open ? (p.cands[p.index] ?? null) : null;
}

let ac: AbortController | null = null;

export async function makeCandidates(kind: 'fill' | 'rhythm') {
  const s = useEditor.getState();
  const p = get();
  const tempo = tempoOf(s.doc);
  const onsets = aiOnsets();
  const bgm = bgmSource(s.doc);
  const offsetSec = bgm?.sec ?? 0;
  set({ kind, loading: true, error: null, cands: [], index: 0, cost: null });
  const rule = () => ruleCandidates(s.doc, tempo, { from: p.from, to: p.to, onsets: onsets && bgm ? onsets : null, offsetSec, lastMeasure: lastMeasure(s.doc) });
  if (!hasAiKey()) {
    const cands = rule();
    set({ loading: false, cands, madeFor: s.doc, error: cands.length ? null : tr('似た小節も直前の小節も見つかりませんでした', 'No similar measure or previous measure was found') });
    return;
  }
  ac?.abort();
  ac = new AbortController();
  try {
    const ctx = buildContext(s.doc, tempo, {
      kind,
      from: p.from,
      to: p.to,
      instruction: p.instruction,
      targetLevel: levelOfField(s.doc.fields['DLEVEL'], s.doc.fields['DLVDEC']),
      onsets: onsets && bgm ? onsets : null,
      offsetSec,
      human: humanMeasure(s.doc),
    });
    const r = await runAi<{ candidates?: unknown[] }>('phrase', { ...phrasePrompt(ctx), schema: phraseSchema(), maxTokens: 3000, signal: ac.signal });
    if (!r) {
      set({ loading: false });
      return;
    }
    const cands = decodeCandidates(r.data as Parameters<typeof decodeCandidates>[0], p, tempo);
    if (cands.length === 0) {
      set({
        loading: false,
        cands: rule(),
        madeFor: s.doc,
        cost: r.costUsed,
        error: tr('AIの候補が使える形になりませんでした。似た小節からの候補を出しています', "The AI's ideas weren't usable. Showing ideas from similar measures instead"),
      });
      return;
    }
    set({ loading: false, cands, madeFor: s.doc, cost: r.costUsed });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    const cands = rule();
    const msg = e instanceof AiError ? e.message : (e as Error).message;
    set({ loading: false, cands, madeFor: s.doc, error: `${msg}${cands.length ? tr('（似た小節からの候補を出しています）', ' (showing ideas from similar measures)') : ''}` });
  }
}

export function stepCandidate(d: 1 | -1) {
  const p = get();
  if (p.cands.length === 0) return;
  set({ index: (p.index + d + p.cands.length) % p.cands.length });
}

/** 選んでいる候補で範囲のドラムを置き換える */
export function applyCandidate() {
  const c = current();
  if (!c) return;
  const { from, to } = get();
  const fieldsBefore = Object.keys(useEditor.getState().doc.fields).length;
  const ok = edit(tr(`フレーズ候補「${c.name}」を反映`, `Apply phrase idea "${c.name}"`), (d) => {
    for (let i = d.chips.length - 1; i >= 0; i--) {
      const x = d.chips[i];
      if (x.m >= from && x.m <= to && drumChannel(x.ch)?.kind === 'normal') d.chips.splice(i, 1);
    }
    // リムはリムの音（スネアと同じチャンネル）
    for (const n of c.notes) d.chips.push({ id: d.nextId++, ch: n.ch, m: n.m, f: { n: n.f.n, d: n.f.d }, v: n.rim ? wavForVoice(d, SD_RIM) : wavForChannel(d, n.ch) });
  });
  if (Object.keys(useEditor.getState().doc.fields).length !== fieldsBefore) void prepareSounds();
  if (ok) {
    // 自動で入れた小節として覚える（AI の手本にしない。手で直すと作者の小節になる）
    markAuto(useEditor.getState().doc, Array.from({ length: to - from + 1 }, (_, i) => from + i));
    toast(tr(`「${c.name}」を置きました（Ctrl+Z で戻せます）`, `Placed "${c.name}" (undo with Ctrl+Z)`), 'ok');
    set({ cands: [], index: 0 });
  }
}
