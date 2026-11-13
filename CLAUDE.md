# このリポジトリで作業するとき

- 画面に出す文は `tr('日本語', 'English')` で両方書き、`node scripts/i18n-check.mjs` を 0 件にする。
- ゲームは「DTXMania」と呼ぶ。画面の文・README・説明書・README の図に「NX」「DTXManiaNX」と書かない（楯さんの決め。`npm test` の `src/gameName.test.ts` が見張る）。コードの名前（nxlib など）とコメントはそのままでよい。
- 確かめは `npx tsc -b` と `npm test`。公開は `npm run deploy`（テストとビルドを通してから gh-pages に置く）。

## Safari・iPad（詳しくは docs/safari.md）

確かめているのは Chrome。Safari（ホーム画面のアプリ、iPad のほかのブラウザも同じ WebKit）は実機で確かめられないので、次を守る。`npm test` が見張っている（`scripts/safari-check.mjs`）。

- 音を鳴らし始めるのは、タップ・クリック・キーの操作の中。最初の `await` より前に `engine.ensure()` を呼ぶ。`setTimeout`・`.then`・購読・読み込みのあとで初めて鳴らさない。指は `pointerdown` では操作にならない（エンジンが `pointerup` でも起こす）。
- 鳴らす所を足したら、操作の中かを確かめて `scripts/safari-check.mjs` の `GESTURE_OK` に理由と足す。
- `new AudioContext` は `src/audio/engine.ts` だけ。音の読み込みは `engine.decodeAudio()`。
- Safari に無い API（フォルダ選択・Web MIDI・タブの音・`requestIdleCallback` など）は、有無を確かめてから使い、無いときの道を用意する。
- ブラウザの判定は `src/platform.ts`（動きの分岐は `IS_WEBKIT`、案内の文は `IS_SAFARI`）。
- スマホの全画面の画面を足したら、横は中身を左右の切り欠きの内側（`env(safe-area-inset-left/right)`）に、縦は上のバーの中身を上から 6px より下に置く（上端の帯 `.p-edge-top` が Safari のぼかしを消している）。docs/safari.md の「画面（iPhone）」。
- Safari のためだけに大きく作り直さない（Chrome で使えれば足りる要望。うまく動かないときは Chrome を案内する）。迷ったら docs/safari.md。

## README と説明書

- README.md は使う人向けの入口。図と画面写真が主で、開発者向けは最後に少しだけ。機能を足したら細かい説明は docs/manual.md に書き、README は大きな機能のときだけ足す。
- README の図（docs/readme/*.svg）と画面写真（docs/readme/shots/）は scripts/readme/ で作り直す（make-svgs.mjs・demo-song.mjs・shots.mjs・devices.mjs・shrink.py。使い方は各ファイルの頭）。写真はオリジナルのデモ曲で撮り、実在の曲を写さない。
- アプリのアイコンは scripts/icon-art.mjs（絵）と scripts/make-pwa-images.mjs（PWA の各サイズ・ファビコン・iPad の起動画面）。
