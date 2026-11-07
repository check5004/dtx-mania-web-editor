# このリポジトリで作業するとき

- 画面に出す文は `tr('日本語', 'English')` で両方書き、`node scripts/i18n-check.mjs` を 0 件にする。
- 確かめは `npx tsc -b` と `npm test`。公開は `npm run deploy`（テストとビルドを通してから gh-pages に置く）。

## Safari・iPad（詳しくは docs/safari.md）

確かめているのは Chrome。Safari（ホーム画面のアプリ、iPad のほかのブラウザも同じ WebKit）は実機で確かめられないので、次を守る。`npm test` が見張っている（`scripts/safari-check.mjs`）。

- 音を鳴らし始めるのは、タップ・クリック・キーの操作の中。最初の `await` より前に `engine.ensure()` を呼ぶ。`setTimeout`・`.then`・購読・読み込みのあとで初めて鳴らさない。指は `pointerdown` では操作にならない（エンジンが `pointerup` でも起こす）。
- 鳴らす所を足したら、操作の中かを確かめて `scripts/safari-check.mjs` の `GESTURE_OK` に理由と足す。
- `new AudioContext` は `src/audio/engine.ts` だけ。音の読み込みは `engine.decodeAudio()`。
- Safari に無い API（フォルダ選択・Web MIDI・タブの音・`requestIdleCallback` など）は、有無を確かめてから使い、無いときの道を用意する。
- ブラウザの判定は `src/platform.ts`（動きの分岐は `IS_WEBKIT`、案内の文は `IS_SAFARI`）。
- Safari のためだけに大きく作り直さない（Chrome で使えれば足りる要望。うまく動かないときは Chrome を案内する）。迷ったら docs/safari.md。
