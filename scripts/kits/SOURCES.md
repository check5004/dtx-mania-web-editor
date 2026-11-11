# 標準キットの音源（作り直すとき）

`node scripts/make-kits.mjs --src <音源のフォルダ>` の `<音源のフォルダ>` に、次の名前で置く（リポジトリには入れない）。
どれも曲に入れて配ってよいライセンス（GeneralUser GS 以外は CC0）。出どころの一覧は `public/kits/CREDITS.txt`。

| 置く名前 | 中身 | 取り方 |
| --- | --- | --- |
| `GeneralUser.sf2` | GeneralUser GS v1.471 | `npm pack generaluser@1.47.1` の `package/GeneralUser.sf2` |
| `karoryfer.big-rusty-drums/` | Big Rusty Drums | `git clone https://github.com/sfzinstruments/karoryfer.big-rusty-drums` |
| `karoryfer.unruly-drums/` | Unruly Drums | `git clone https://github.com/sfzinstruments/karoryfer.unruly-drums` |
| `karoryfer.swirly-drums/` | Swirly Drums | `git clone https://github.com/sfzinstruments/karoryfer.swirly-drums` |
| `karoryfer.frankensnare/` | Frankensnare | `git clone https://github.com/sfzinstruments/karoryfer.frankensnare` |
| `karoryfer.gogodze-phu-vol-ii/` | Gogodze Phu Vol II | `git clone https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii` |
| `virtuosity_drums/` | Virtuosity Drums | `git clone https://github.com/sfzinstruments/virtuosity_drums` |
| `sonic-pi/` | Sonic Pi の samples フォルダ | Debian の `sonic-pi-samples`（3.2.2~repack-12）の `usr/share/sonic-pi/samples` |
| `freepats-synth/` | FreePats Synthesizer Percussion | https://freepats.zenvoid.org/Percussion/SynthesizerPercussion/SynthesizerPercussion-SFZ-20220718.7z を展開した中身 |

- 使う前に、それぞれのライセンス（CC0 の LICENSE・license、Sonic Pi は Debian の copyright で1ファイルずつ CC0 と出どころが書かれているもの）を確かめる。
  Sonic Pi の samples は、copyright に CC0 と書かれていないもの（`sn_generic`・`bd_mehackit` など）と、ループ（`loop_amen` など）は使わない。
- FluidR3（MIT。配る譜面に表示が要る）・DrumGizmo のキット（CC-BY）・Hydrogen のキット（GPL など）・AVL Drums（CC-BY-SA）は、
  譜面に入れて配る人に表示の義務が付くので使わない。
- 読むのに `ffmpeg` が要る。SFZ は `scripts/kits/sfz.mjs`（使う所だけの小さな読み手）で、1回の打撃の音をマイクごとの初期値で混ぜる。
- 自前の合成の音（`scripts/kits/synth.mjs`）は CC0 で配る。
