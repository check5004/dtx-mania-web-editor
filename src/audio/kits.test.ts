// 同梱の標準キット: どのキットも全部のレーンの音がそろっていて、4 シンバル（左・右・ライド・ハイハット）が別の音か
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_KITS, KIT_GENRES, KIT_LANES, kitSourceById, parseBuiltinFile, builtinFile } from './sounds';

const file = (kit: string, lane: string) => new URL(`../../public/kits/${kit}/${lane}.ogg`, import.meta.url);
const hash = (kit: string, lane: string) => createHash('sha256').update(readFileSync(file(kit, lane))).digest('hex');
const kits = BUILTIN_KITS.filter((k) => k.id !== 'synth');

describe('標準キット', () => {
  it('名前は英小文字だけ（譜面に書くファイル名 dtxweb_<キット>_<レーン>.wav から読み戻せる）', () => {
    for (const k of BUILTIN_KITS) {
      expect(k.id).toMatch(/^[a-z]+$/);
      const f = builtinFile(k.id, KIT_LANES[0].ch)!;
      expect(parseBuiltinFile(f)?.kit).toBe(k.id);
    }
    expect(new Set(BUILTIN_KITS.map((k) => k.id)).size).toBe(BUILTIN_KITS.length);
  });

  it('ジャンルと音の出どころが決まっている', () => {
    const genres = new Set(KIT_GENRES.map((g) => g.id));
    for (const k of BUILTIN_KITS) {
      expect(genres.has(k.genre)).toBe(true);
      expect(k.sources.length).toBeGreaterThan(0);
      for (const s of k.sources) expect(kitSourceById.has(s)).toBe(true);
      expect(k.name).not.toBe('');
      expect(k.desc).not.toBe('');
    }
  });

  it('どのキットも全部のレーンの音がある', () => {
    for (const k of kits) for (const l of KIT_LANES) expect(existsSync(file(k.id, l.key)), `${k.id}/${l.key}.ogg`).toBe(true);
  });

  it('左シンバル・右シンバル・ライド・ハイハット（閉じ・開き・ペダル）とスネア・リムがそれぞれ別の音', () => {
    for (const k of kits) {
      const lanes = ['lc', 'cy', 'rd', 'hhc', 'hho', 'lp', 'sd', 'rim'];
      expect(new Set(lanes.map((l) => hash(k.id, l))).size, k.id).toBe(lanes.length);
    }
  });
});
