# DTX Web Editor

[DTXManiaNX](https://github.com/limyz/DTXmaniaNX) 向けの、ブラウザで動くドラム譜面エディタです。

**公開ページ:** https://check5004.github.io/dtx-mania-web-editor/

データはブラウザの中だけで扱い、どこにもアップロードしません。

## いまできること（段階2）

- 曲フォルダを開いて、DTXの読み込み・編集・保存ができます。
  - Chrome と Edge では、曲フォルダに直接上書き保存できます。
  - そのほかのブラウザでは、保存はダウンロードになります。
- 文字コードは Shift_JIS と UTF-8（BOM付き・BOMなし）を自動で判定して読みます。
- 保存はいつも Shift_JIS・CRLF です（NX がそのまま読める形式）。
- エディタが解釈しない行もそのまま残して保存します。#RANDOM/#IF、BGA、ギター・ベースのチップなどが対象です。
- 譜面は縦スクロールで、下から上へ進みます。
  - 10レーンで、4シンバル構成（左シンバル・HH・右シンバル・ライド）に対応しています。
  - グリッドは 1/4〜1/64 と3連で、ズームと全体マップがあります。
- チップの置き方と操作
  - クリックで置き、右クリック（ドラッグ）で消します。
  - Shift+クリックで HHオープン・左バスドラムを置きます。
  - 範囲選択、ドラッグや矢印キーでの移動、コピーと貼り付け、Undo/Redo ができます。
- BPM変化（#BPMzz と ch08）と、小節ごとの拍子（ch02）を扱えます。
- 原曲（BGM）とチップ音を同期して再生できます。
  - F5 は最初から、F6 はカーソル位置から再生し、F7 で止めます。
  - シークバーとメトロノームがあります。
- 曲フォルダに音が無いレーンでは、内蔵の合成ドラムキットの音を使います。保存するときに WAV ファイルとして曲フォルダへ書き出します。
- 編集中の譜面はブラウザ内に自動保存し、「最近の曲」から続きを開けます。

今後の段階で対応する予定のもの：

- 波形と候補チップの表示
- ループ再生と録音（キー・MIDI）
- 音源ライブラリ
- YouTube の参照
- AI による難易度づくり

## 開発

```sh
npm install
npm run dev      # 開発サーバー
npm test         # DTXの読み書き・タイミング・編集操作のテスト
npm run build    # 型チェックとビルド（dist/）
```

公開は `npm run deploy` で行います。ビルドした `dist` を `gh-pages` ブランチに置き、GitHub Pages はそのブランチから配信します（Settings → Pages → Deploy from a branch → `gh-pages` / `(root)`）。

GitHub Actions で自動公開したい場合は、`docs/deploy-workflow.yml` を `.github/workflows/deploy.yml` に置いて、Pages の Source を「GitHub Actions」に切り替えてください。

### 構成

| パス | 内容 |
| --- | --- |
| `src/dtx/` | DTXの解析・書き出し・文字コード・タイミング計算。NX の `CDTX.cs` と同じ解釈にそろえています |
| `src/edit/` | 配置・削除・移動・貼り付け・ヘッダ編集の操作 |
| `src/audio/` | Web Audio の再生エンジンと内蔵キット |
| `src/fs/` | 曲フォルダの読み書き（File System Access API）、set.def、自動保存 |
| `src/store/` | 状態管理（zustand）と Undo/Redo（immer のパッチ） |
| `src/ui/` | 画面 |
