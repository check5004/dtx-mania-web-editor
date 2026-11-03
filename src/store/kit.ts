// 使うキット。譜面を書くときはキットを選ぶだけでよく、WAV 番号の割り当てはエディタが行う。
// キットは「同梱の標準キット」と「ライブラリのキット（取り込んだ曲のキット・自分で作ったキット）」。
import { tr } from '../i18n';
import { create } from 'zustand';
import { builtinFile, builtinKitById, KIT_LANES, laneByKey, virtualSound } from '../audio/sounds';
import { toBase36x2 } from '../dtx/base36';
import { drumChannel } from '../dtx/model';
import { freeWavNumber, setField } from '../edit/ops';
import { pruneUnusedCreated, velOfWav, wavVariant } from '../edit/velocity';
import { edit, prepareSounds, setKitFileProvider, useEditor } from './editor';
import { useLibrary } from './library';

const KEY = 'dtxe.kit.v1';

function loadId(): string {
  try {
    return localStorage.getItem(KEY) || 'std';
  } catch {
    return 'std';
  }
}

export const useKit = create<{ kitId: string }>(() => ({ kitId: loadId() }));

export interface KitChoice {
  id: string;
  name: string;
  desc: string;
  group: 'builtin' | 'song' | 'own';
}

export function kitChoices(): KitChoice[] {
  const lib = useLibrary.getState();
  return [
    ...[...builtinKitById.values()].map((k) => ({ id: k.id, name: k.name, desc: k.desc, group: 'builtin' as const })),
    ...lib.kits
      .filter((k) => k.origin === 'song')
      .map((k) => ({ id: `lib:${k.id}`, name: k.name, desc: `${k.artist ? `${k.artist} · ` : ''}${tr('取り込んだ曲の音', 'sounds from an imported song')}`, group: 'song' as const })),
    ...lib.kits
      .filter((k) => k.origin === 'user')
      .map((k) => ({ id: `lib:${k.id}`, name: k.name, desc: tr('ライブラリで作ったキット', 'A kit you made in the library'), group: 'own' as const })),
  ];
}

/** キットのそのチャンネルの音（譜面の #WAV に書くファイル名）。キットに無いレーンは標準キット */
export function kitFile(ch: number, kitId = useKit.getState().kitId): string | null {
  const info = drumChannel(ch);
  const base = info ? info.base : ch;
  if (kitId.startsWith('lib:')) {
    const lib = useLibrary.getState();
    const k = lib.kits.find((x) => `lib:${x.id}` === kitId);
    const sid = k?.lanes[base];
    if (sid?.startsWith('builtin:')) {
      const [kit, lane] = sid.slice(8).split('/');
      const lch = laneByKey.get(lane)?.ch ?? base;
      return builtinFile(kit, lch) ?? builtinFile('std', base);
    }
    const s = sid ? lib.samples.find((x) => x.id === sid) : undefined;
    if (s) return s.file;
    return builtinFile('std', base);
  }
  return builtinFile(kitId, base) ?? builtinFile('std', base);
}

/** そのキットのそのレーンの音がどこから来たか（標準・曲から） */
export function kitFileOrigin(ch: number, kitId = useKit.getState().kitId): string {
  const f = kitFile(ch, kitId);
  return f ? (virtualSound(f)?.origin ?? '') : '';
}

setKitFileProvider((ch) => kitFile(ch));

/** キットを選ぶ。これから置くチップに使う（レーンに曲フォルダの音を選んでいればそのまま） */
export function setKit(id: string) {
  useKit.setState({ kitId: id });
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // 保存できなくても動く
  }
  // キットから来た音を使っているレーンは、新しいキットの音にする
  const s = useEditor.getState();
  const laneWav = { ...s.laneWav };
  for (const [ch, no] of Object.entries(laneWav)) {
    const path = s.doc.fields['WAV' + toBase36x2(no)];
    if (path === undefined || (virtualSound(path) && !s.folder?.files.has(path.toLowerCase()))) delete laneWav[Number(ch)];
  }
  useEditor.setState({ laneWav });
}

/** 置いてあるチップの音も、今のキットの音に替える（ベロシティは保つ。Ctrl+Z で戻せる） */
export function applyKitToChips(kitId = useKit.getState().kitId): number {
  let n = 0;
  const name = kitChoices().find((k) => k.id === kitId)?.name ?? kitId;
  const laneWav: Record<number, number> = {};
  edit(tr(`置いてあるチップの音を「${name}」にする`, `Switch placed chips to "${name}"`), (d) => {
    const baseNo = new Map<number, number>();
    const noFor = (ch: number): number | null => {
      if (baseNo.has(ch)) return baseNo.get(ch)!;
      const file = kitFile(ch, kitId);
      if (!file) return null;
      let no: number | null = null;
      for (const [k, v] of Object.entries(d.fields)) {
        if (/^WAV[0-9A-Z]{2}$/.test(k) && v.toLowerCase() === file.toLowerCase() && !d.fields['VOLUME' + k.slice(3)]) no = parseInt(k.slice(3), 36);
      }
      if (no === null) {
        no = freeWavNumber(d);
        if (no === null) return null;
        setField(d, 'WAV' + toBase36x2(no), file);
      }
      baseNo.set(ch, no);
      laneWav[ch] = no;
      return no;
    };
    for (const c of d.chips) {
      const info = drumChannel(c.ch);
      if (!info) continue;
      const base = noFor(info.base);
      if (base === null) continue;
      const vel = velOfWav(d.fields, c.v);
      const no = wavVariant(d, base, vel);
      if (no !== c.v) {
        c.v = no;
        n++;
      }
    }
    pruneUnusedCreated(d);
  });
  useEditor.setState((s) => ({ laneWav: { ...s.laneWav, ...laneWav } }));
  void prepareSounds();
  return n;
}

/** キットのレーン一覧（表示用） */
export function kitLanes(kitId = useKit.getState().kitId) {
  return KIT_LANES.map((l) => ({ ...l, file: kitFile(l.ch, kitId), origin: kitFileOrigin(l.ch, kitId) }));
}
