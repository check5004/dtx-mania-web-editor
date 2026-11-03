// テスト用の合成ドラム（キック・スネア・ハイハット）。解析と精度測定のテストで使う。

export interface SynthHit {
  t: number;
  kind: 'kick' | 'snare' | 'hat' | 'crash';
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** 4/4 の8ビート。bars 小節ぶん、lead 秒の無音のあとに始まる */
export function eightBeat(bpm: number, bars: number, lead = 0.5): SynthHit[] {
  const beat = 60 / bpm;
  const hits: SynthHit[] = [];
  for (let b = 0; b < bars; b++) {
    const t0 = lead + b * 4 * beat;
    hits.push({ t: t0, kind: 'kick' }, { t: t0 + 2 * beat, kind: 'kick' }, { t: t0 + 2.5 * beat, kind: 'kick' });
    hits.push({ t: t0 + beat, kind: 'snare' }, { t: t0 + 3 * beat, kind: 'snare' });
    for (let k = 0; k < 8; k++) hits.push({ t: t0 + k * 0.5 * beat, kind: 'hat' });
    if (b % 4 === 0) hits.push({ t: t0, kind: 'crash' });
  }
  return hits.sort((a, b) => a.t - b.t);
}

export function synth(hits: SynthHit[], sr: number, duration: number): Float32Array {
  const out = new Float32Array(Math.ceil(sr * duration));
  const noise = rng(7);
  for (const h of hits) {
    const start = Math.round(h.t * sr);
    const len = Math.round(sr * (h.kind === 'crash' ? 1.2 : h.kind === 'hat' ? 0.06 : 0.3));
    let prev = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / sr;
      let v = 0;
      if (h.kind === 'kick') {
        // 立ち上がり 2ms、ピッチが少し下がる胴鳴り＋小さなビーターの音
        const f = 48 + 40 * Math.exp(-t / 0.025);
        const att = Math.min(1, t / 0.002);
        v = 0.9 * att * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.12) + 0.05 * noise() * Math.exp(-t / 0.004);
      } else if (h.kind === 'snare') {
        v = (0.5 * noise() + 0.35 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.07);
      } else {
        // 高域のノイズ（差分で低域を落とす）
        const n = noise();
        const hp = n - prev;
        prev = n;
        v = (h.kind === 'crash' ? 0.5 : 0.35) * hp * Math.exp(-t / (h.kind === 'crash' ? 0.5 : 0.015));
      }
      out[start + i] += v;
    }
  }
  return out;
}
