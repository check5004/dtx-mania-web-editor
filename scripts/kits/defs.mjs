// 標準キットの作り方（scripts/make-kits.mjs が読む）。音源の場所は、音源を置いたフォルダ（--src）の中で書く。
// 使ってよい音源と取り方は scripts/kits/SOURCES.md（どれも再配布してよいもの。出どころは public/kits/CREDITS.txt）。
//
// レーン: lc hhc hho lp lbd sd rim ht bd lt ft cy rd（lbd を書かないキットは bd と同じ音）
// 音の書き方:
//   { sfz, key, vel, cc }        SFZ の音源（key は MIDI の番号、cc は { 番号: 値 }。書かない CC は作者の初期値）
//   { sf2, program, note, vel }  SoundFont（GeneralUser GS）のドラムセット
//   { file }                     音声ファイル1つ
//   { synth, lane }              自前の合成（scripts/kits/synth.mjs。lane を書かないときは同じレーン）
//   { mix: [音, …] }             重ねる（それぞれに gain（dB）・at（秒）を付けられる）
// どの音にも付けられるもの: pitch（半音）・fx（加工の列。下の FX）
// キットに付けられるもの: len（レーンごとの長さの上限・秒）・fx（{ レーン: 加工の列 }。'*' は全部のレーン）
//   head（{ レーン: dB }。頭をどこまで削るか。ペダルのハイハットは踏む前の音を -18 dB で削る）
//
// FX（make-kits.mjs の applyFx）:
//   ['hpf', Hz] ['lpf', Hz] ['peq', Hz, dB, 幅] ['low', Hz, dB] ['high', Hz, dB]（棚）
//   ['comp', { threshold, ratio, attack, release, makeup }] ['sat', dB, 混ぜ] ['crush', ビット, 間引き]
//   ['verb', { size, damp, predelay, wet, dry, tail }] ['gate', 保つ秒, 切る秒] ['punch', 量] ['decay', 秒] ['gain', dB]

/** レーンの長さの上限（秒）。前の版のキットと同じ */
export const LANE_LEN = { lc: 3.2, hhc: 0.6, hho: 1.6, lp: 0.6, lbd: 0.9, sd: 1.0, rim: 0.6, ht: 1.5, bd: 0.9, lt: 1.6, ft: 1.8, cy: 3.2, rd: 2.6 };
export const LANES = Object.keys(LANE_LEN);

// ---- 音源（どれも CC0。GeneralUser GS だけは独自の許諾で、前の版から使っているもの） ----
const BR = 'karoryfer.big-rusty-drums/Programs/01-full.sfz';
const UR = 'karoryfer.unruly-drums/Programs/01-kit-sticks.sfz';
const VD = 'virtuosity_drums/Programs/02-full-kit.sfz';
const VV = 'virtuosity_drums/Programs/08-vintage-mic.sfz';
const SW = 'karoryfer.swirly-drums/Programs/Full_kit.sfz';
const FS = 'karoryfer.frankensnare/Programs/04-12x5steel.sfz';
const GG = 'karoryfer.gogodze-phu-vol-ii/Programs/Kit.sfz';
const GU = 'GeneralUser.sf2';
const sp = (name, more = {}) => ({ file: `sonic-pi/${name}.flac`, ...more });
const fp = (name, more = {}) => ({ file: `freepats-synth/samples/${name}.wav`, ...more });

/** SFZ の音を、同じ設定で何度も書くための関数 */
const sfz = (file, base = {}) => (key, more = {}) => ({ sfz: file, key, ...base, ...more, cc: { ...(base.cc ?? {}), ...(more.cc ?? {}) } });

/** GeneralUser GS のドラムセット（前の版の6キット） */
function guKit(program, vel, notes = {}) {
  const gm = { lc: 49, hhc: 42, hho: 46, lp: 44, lbd: 36, sd: 38, rim: 37, ht: 48, bd: 36, lt: 45, ft: 41, cy: 57, rd: 51, ...notes };
  return Object.fromEntries(LANES.map((l) => [l, { sf2: GU, program, note: gm[l], vel }]));
}

const br = sfz(BR);
const ur = sfz(UR);
const vd = sfz(VD);
const vv = sfz(VV);
const sw = sfz(SW);
const gg = sfz(GG);

/** よく使うハイハット（SFZ の 42 閉じ・46 開き（CC4 で開き具合）・44 ペダル） */
const hats = (f, open = { cc: { 4: 120 } }) => ({ hhc: f(42), hho: f(46, open), lp: f(44) });
/** Virtuosity Drums のハイハット（閉じも開きも 42。CC4 が大きいほど閉じる） */
const vhats = (f, more = {}) => ({ hhc: f(42, { ...more, cc: { 4: 127 } }), hho: f(42, { cc: { 4: 10 } }), lp: f(44) });

/** 残響（大きいホール） */
const HALL = ['verb', { size: 0.86, damp: 0.35, predelay: 0.02, wet: 0.32, dry: 1, tail: 1.8 }];

export const KITS = [
  // ---- 前の版から（GeneralUser GS） ----
  // keepLevel: 前の版と同じ作り方（音量をそろえず、ピークを -1 dB にするだけ）
  { id: 'std', keepLevel: true, lanes: guKit(0, 112) },
  { id: 'rock', keepLevel: true, lanes: guKit(16, 116) },
  { id: 'room', keepLevel: true, lanes: guKit(8, 112) },
  { id: 'jazz', keepLevel: true, lanes: guKit(40, 104) },
  // 808/909 は左右のシンバルが同じ音（TR-808 Cymbal）なので、右は少し高くして聞き分けられるようにする
  { id: 'elec', keepLevel: true, lanes: { ...guKit(25, 112), cy: { sf2: GU, program: 25, note: 57, vel: 112, pitch: 3 } } },
  { id: 'metal', keepLevel: true, lanes: guKit(16, 120, { cy: 52, lbd: 35, bd: 35 }) },

  // ---- ロック（Big Rusty Drums: 24 インチのキック・14 インチのスネア・14/15/18/22 インチのタム） ----
  {
    id: 'vintage',
    lanes: { bd: br(36), sd: br(38), rim: br(37), ...hats(br), ht: br(47), lt: br(45), ft: br(43), lc: br(49), cy: br(65), rd: br(51) },
  },
  {
    // 強く叩く・スネアはリムショット・右はチャイナ・タムは低め・キックは芯を足す
    id: 'heavy',
    lanes: (() => {
      const h = sfz(BR, { vel: 127 });
      return {
        // キックとスネアは強めに潰して（やわらかく歪ませて）前に出す
        bd: h(36, { cc: { 74: 70 }, fx: [['high', 3000, 3], ['sat', 10, 1]] }),
        sd: h(40, { fx: [['comp', { threshold: -20, ratio: 4, attack: 2, release: 100 }], ['sat', 6, 0.7]] }),
        rim: h(37),
        ...hats(h),
        ht: h(45),
        lt: h(43),
        ft: h(41),
        lc: h(49),
        cy: h(57),
        rd: h(51),
      };
    })(),
  },
  {
    // 80 年代のゲートリバーブ（スネアとタムに大きい残響をかけて、すぐ切る）
    id: 'gated',
    len: { sd: 1.0, ht: 1.0, lt: 1.0, ft: 1.1 },
    lanes: {
      bd: br(36, { cc: { 76: 80 }, fx: [['verb', { size: 0.7, damp: 0.5, wet: 0.25, tail: 0.6 }], ['gate', 0.12, 0.05]] }),
      sd: br(38, { vel: 120, fx: [['verb', { size: 0.92, damp: 0.25, predelay: 0.004, wet: 0.85, tail: 1 }], ['gate', 0.26, 0.06], ['comp', { threshold: -16, ratio: 3, attack: 5, release: 100 }]] }),
      rim: br(37),
      ...hats(br),
      ht: br(47, { fx: [['verb', { size: 0.9, damp: 0.3, predelay: 0.004, wet: 0.7, tail: 1 }], ['gate', 0.34, 0.08]] }),
      lt: br(45, { fx: [['verb', { size: 0.9, damp: 0.3, predelay: 0.004, wet: 0.7, tail: 1 }], ['gate', 0.38, 0.08]] }),
      ft: br(43, { fx: [['verb', { size: 0.9, damp: 0.3, predelay: 0.004, wet: 0.7, tail: 1 }], ['gate', 0.42, 0.09]] }),
      lc: br(49),
      cy: br(52),
      rd: br(51),
    },
  },
  {
    // 広い会場（全部に残響）
    id: 'arena',
    len: { bd: 1.6, lbd: 1.6, sd: 2.0, rim: 1.2, hhc: 1.0, lp: 1.0, hho: 2.2, ht: 2.2, lt: 2.4, ft: 2.6, lc: 3.8, cy: 3.8, rd: 3.2 },
    fx: { '*': [HALL] },
    lanes: { bd: br(36, { vel: 120 }), sd: br(38, { vel: 120 }), rim: br(37), ...hats(br), ht: br(47), lt: br(45), ft: br(43), lc: br(49), cy: br(65), rd: br(51) },
  },
  {
    // 70 年代のロック（Gogodze Phu Vol II。シンバルは Virtuosity Drums）
    id: 'seventies',
    lanes: { bd: gg(36), sd: gg(38), rim: gg(37), hhc: gg(42), hho: gg(46, { cc: { 4: 127 } }), lp: gg(44), ht: gg(45), lt: gg(43), ft: gg(41), lc: vd(49), cy: vd(57), rd: vd(51) },
  },
  {
    // ガレージ（Unruly Drums: 20 インチのキック・14 インチのスネア）
    id: 'garage',
    lanes: { bd: ur(36), sd: ur(38), rim: ur(37), ...hats(ur), ht: ur(47), lt: ur(45), ft: ur(41), lc: ur(49), cy: ur(55), rd: ur(51) },
  },

  // ---- ポップ・ファンク ----
  {
    // 乾いた音（Big Rusty のミュートと近いマイク。部屋の音を少なく）
    id: 'dry',
    lanes: (() => {
      const d = sfz(BR, { cc: { 76: 110, 90: 100, 49: 100, 82: 20, 16: 40, 31: 20, 35: 20, 39: 20, 43: 20 } });
      return { bd: d(36), sd: d(38), rim: d(37), ...hats(d), ht: d(47), lt: d(45), ft: d(43), lc: br(49), cy: br(61), rd: br(51) };
    })(),
  },
  {
    // 太いスネア（Unruly Drums の 22 インチのスネア）
    id: 'fat',
    lanes: {
      bd: ur(35),
      sd: ur(26, { fx: [['comp', { threshold: -18, ratio: 3, attack: 8, release: 140, makeup: 2 }]] }),
      rim: ur(25),
      ...hats(ur),
      ht: ur(47),
      lt: ur(45),
      ft: ur(41),
      lc: ur(55),
      cy: br(65),
      rd: ur(51),
    },
  },
  {
    // ファンク（高く張ったスチールのスネア Frankensnare 12x5・ミュートしたキック）
    id: 'funk',
    lanes: {
      bd: ur(34),
      sd: { sfz: FS, key: 38 },
      rim: { sfz: FS, key: 37 },
      ...hats(ur),
      ht: ur(47),
      lt: ur(45),
      ft: ur(41),
      lc: ur(49),
      cy: vd(55),
      rd: br(60),
    },
  },
  {
    // ライブハウス（Virtuosity Drums の部屋のマイクを上げる）
    id: 'live',
    lanes: (() => {
      const l = sfz(VD, { cc: { 107: 90, 109: 110 } });
      return {
        bd: l(36),
        sd: l(38),
        rim: l(88),
        ...vhats(l),
        ht: l(48),
        lt: l(41, { pitch: 3 }),
        ft: l(41),
        lc: l(49),
        cy: l(55),
        rd: l(51),
      };
    })(),
  },

  // ---- ジャズ・アコースティック ----
  {
    // スウィング（Virtuosity Drums。タムは2つなので、ロータムはフロアタムを少し高く）
    id: 'swing',
    lanes: { bd: vd(36), sd: vd(38), rim: vd(88), ...vhats(vd), ht: vd(48), lt: vd(41, { pitch: 3 }), ft: vd(41), lc: vd(49), cy: vd(57), rd: vd(51) },
  },
  {
    // ブラシ（Swirly Drums。クロススティックは Virtuosity Drums）
    id: 'brushes',
    lanes: { bd: sw(36), sd: sw(38), rim: vd(88, { vel: 90 }), ...hats(sw), ht: sw(47), lt: sw(43), ft: sw(41), lc: sw(49), cy: sw(57), rd: sw(51) },
  },
  {
    // 古い録音（Virtuosity Drums の古いマイク1本）
    id: 'retro',
    head: { lp: -10 },
    lanes: { bd: vv(36), sd: vv(38), rim: vv(88), ...vhats(vv), ht: vv(48), lt: vv(41, { pitch: 3 }), ft: vv(41), lc: vv(49), cy: vv(57), rd: vv(59) },
  },

  // ---- エレクトロ ----
  // ダンス（GeneralUser GS の Dance: 909 のキック・ダンスのスネア）
  { id: 'dance', lanes: guKit(26, 112) },
  {
    // 80 年代のエレドラ（GeneralUser GS の Electronic。スネアとタムにゲートリバーブ）
    id: 'eighties',
    lanes: (() => {
      const k = guKit(24, 112);
      const g = (hold) => [['verb', { size: 0.9, damp: 0.3, predelay: 0.004, wet: 0.6, tail: 1 }], ['gate', hold, 0.07]];
      return { ...k, sd: { ...k.sd, fx: g(0.24) }, ht: { ...k.ht, fx: g(0.3) }, lt: { ...k.lt, fx: g(0.34) }, ft: { ...k.ft, fx: g(0.38) } };
    })(),
  },
  {
    // アナログのリズムマシン風（FreePats の合成ドラム。ライドは自前の合成）
    id: 'analog',
    lanes: {
      bd: fp('Kick04'),
      sd: fp('Snare09'),
      rim: fp('Claves01'),
      hhc: fp('ClosedHiHat01-01'),
      hho: fp('OpenHiHat02-01'),
      lp: fp('ClosedHiHat02-01'),
      ht: fp('HighTom02-01'),
      lt: fp('MidTom02-01'),
      ft: fp('LowTom02-01'),
      lc: fp('Cymbal01-01'),
      cy: fp('Cymbal02'),
      rd: { synth: 'analog', lane: 'rd' },
    },
  },
  {
    // ハウス（Sonic Pi の音: キック・スネア・ハイハット・シンバル、FreePats のクラップ。タム・リム・ライドは自前の合成）
    id: 'house',
    lanes: {
      bd: sp('bd_haus'),
      sd: { mix: [fp('Clap01'), sp('sn_dolf', { gain: -5 })] },
      rim: { synth: 'house', lane: 'rim' },
      hhc: sp('drum_cymbal_closed', { fx: [['hpf', 2500]] }),
      hho: sp('drum_cymbal_open', { fx: [['hpf', 2000]] }),
      lp: sp('drum_cymbal_pedal', { fx: [['hpf', 2500]] }),
      ht: { synth: 'house', lane: 'ht' },
      lt: { synth: 'house', lane: 'lt' },
      ft: { synth: 'house', lane: 'ft' },
      lc: sp('drum_cymbal_hard'),
      cy: sp('drum_splash_hard'),
      rd: { synth: 'house', lane: 'rd' },
    },
  },
  {
    // ローファイ（Virtuosity Drums の古いマイクを、こもらせて少し歪ませる）
    id: 'lofi',
    head: { lp: -10 },
    fx: { '*': [['lpf', 7000], ['sat', 8, 0.5], ['crush', 11, 2]] },
    lanes: { bd: vv(36, { vel: 100 }), sd: vv(38, { vel: 100 }), rim: vv(88), ...vhats(vv, { vel: 90 }), ht: vv(48), lt: vv(41, { pitch: 3 }), ft: vv(41), lc: vv(49), cy: vv(55), rd: vv(51) },
  },
  { id: 'trap', len: { bd: 1.6, lbd: 1.6 }, lanes: synthKit('trap') },

  // ---- ゲーム・シンセ ----
  // 8ビット（ノイズの音は片寄り（直流）が大きいので、低い所を切ってから）
  { id: 'chip', fx: { '*': [['hpf', 30]] }, lanes: synthKit('chip') },
  { id: 'fm', lanes: synthKit('fm') },
];

function synthKit(name) {
  return Object.fromEntries(LANES.filter((l) => l !== 'lbd').map((l) => [l, { synth: name }]));
}

export const kitById = new Map(KITS.map((k) => [k.id, k]));
