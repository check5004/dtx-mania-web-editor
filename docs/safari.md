# Safari・iPad で動かすための決まり

このエディタは Chrome（PC・iPad）で確かめています。Safari（Mac・iPad・iPhone）とホーム画面に追加したアプリは、実機で確かめられないので、公開されている決まりに沿って作り、外れた書き方は `npm test` で止めます。

iPad・iPhone では、Chrome・Firefox・Edge も中身は Safari と同じ WebKit です。それでも Safari だけで動かないことがあります（アプリごとの音の設定や、自動再生の決まりの違い）。

**日々の作業で気にするのは「音を鳴らし始める所」と「Safari に無い API」の 2 つだけです。** どちらも `npm test`（`src/safariRules.test.ts` → `scripts/safari-check.mjs`）が見張っていて、引っかかると、このページのどこを読めばよいかを出します。

## 1. 音を鳴らし始める所（いちばん大事）

Safari は、タップ・クリック・キーの操作の中でしか音の出力（AudioContext）を動かし始めません。操作の外で作った出力は止まったままで、`resume()` も返ってきません。

- 再生用の AudioContext を作るのは `src/audio/engine.ts` の `engine.ensure()` だけ。ほかで `new AudioContext()` しない。
- ボタンの `onClick` などの中で、**最初の `await` より前に** `engine.ensure()` を呼ぶ。`await` のあと・`setTimeout`・`.then`・`subscribe`・読み込みが終わったときに、初めて鳴らさない。
- 指の操作で「操作」になるのは、指を離したとき（`pointerup`・`touchend`・`click`）。指が触れた瞬間（`pointerdown`）は操作にならない。エンジンは指を離したときにも出力を起こすので、パッドは `pointerdown` で鳴らしてよい（出力を作る最初の 1 回だけ鳴らないことがある）。
- マウスを重ねただけ（`mouseenter`）・スクロール・MIDI は操作ではない。
- 音のファイルの読み込みは `engine.decodeAudio()`、計算用の AudioBuffer は `engine.workCtx()`。Safari では、出力がまだ無ければ OfflineAudioContext で読むので、読み込みで出力を作らない。
- 出力を作り直しても、読み込んだ AudioBuffer はそのまま使える（context に縛られない）。

### 鳴らす所を足したとき

`engine.ensure` / `play` / `preview` / `previewBuffer` / `audition` / `testTone` / `resetOutput` / `clickAt` を新しい所から呼ぶと、`npm test` が「表にありません」と止めます。操作の中（最初の `await` の前）で呼んでいることを確かめて、`scripts/safari-check.mjs` の `GESTURE_OK` に「ファイル#関数」と理由を一言足します。関数の名前を変えたときも直します。

### エンジンが Safari のためにしていること

Safari（WebKit）のときだけ動きます。PC の Chrome・Edge の動きは変えていません。

| すること | なぜ |
| --- | --- |
| 出力を作る前に `navigator.audioSession.type = 'playback'`（iPadOS・iOS 17 から） | 既定では、消音（コントロールセンターのベル）にすると Web Audio が黙る |
| 操作のたびに、止まった出力（`suspended`、Safari だけの `interrupted`）を起こす | 電話・ほかのアプリの音・画面を離れたあとに止まる |
| 作った直後・画面に戻ったあとの操作で、1 サンプルの無音を鳴らす | 古い iOS は、操作の中で実際に音を鳴らすまで出力が開かない |
| 再生して 2 秒たっても音の時刻が進まなければ、止めて「もう一度 ▶」と知らせ、次の ▶ で出力を作り直す | 起こしても起きない出力がある（作り直すと鳴ることが多い） |
| iPad・iPhone で画面を離れたら再生を止める | 裏ではタイマーが止まり、戻ったときに音が一度に鳴る |

テスト: `src/audio/engineSafari.test.ts`（Safari の決まりをまねた偽物の AudioContext で確かめる）。

## 2. 音の形式

- OGG（Vorbis・Opus）は Safari 18.4（iPadOS・iOS 18.4、macOS 15.4）から読める（[WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)）。DTX の音はほとんど OGG なので、それより前の Safari では鳴らない。読めなかった音があれば知らせる（`src/store/editor.ts` の `warnOldSafariOgg`、右の「お知らせ」）。
- WAV・MP3 はどの版でも読める。
- 書き出し（エンコード）は `wasm-media-encoders` で行うので、ブラウザに頼らない。

## 3. Safari に無い・違う API

使うときは、あるか確かめてから使い、無いときの道を用意します。`scripts/safari-check.mjs` の `API_OK` に無いファイルで使うと `npm test` が止めます。

| API | Safari | どうしているか |
| --- | --- | --- |
| フォルダ・ファイルを選ぶ（`showDirectoryPicker` など） | 無い | 有無を見る。iPad は ZIP で開き、共有で保存（`NO_FOLDER_PICK`） |
| `<input webkitdirectory>` | iPad は無い | iPad では出さない |
| Web MIDI（`requestMIDIAccess`） | 無い | `NO_MIDI` で出さない |
| タブの音（`getDisplayMedia` の音） | 無い | `canCaptureTab()`。YouTube の自動同期は Chrome・Edge だけ |
| `requestIdleCallback` | 無い版がある | 有無を見て、無ければ `setTimeout` |
| `AudioContext.outputLatency` | 無い版がある | 無ければ 0 とみなす |
| `<audio>`・`<video>` の `play()` | 操作の中でしか鳴らない | 音は Web Audio で鳴らす。作る所は `MEDIA_OK` |
| YouTube の埋め込み | 音ありの再生は、映像を一度タップするまで始まらないことがある | 参照映像は消音が基本 |
| サイトの保存データ | 7 日使わないと消えることがある（ホーム画面のアプリは別） | [Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) |

JavaScript の機能は `tsconfig.json` の `lib`（ES2023 = Safari 16.4 以降で動く範囲）までにする。上げない（`Object.groupBy`・`Promise.withResolvers` は Safari 17.4、Iterator helpers は 18.4 から）。

### 画面（iPad）

- 入力欄の文字は 16px 以上（小さいと iPad の Safari が画面を拡大する）。タブレットの画面では `src/tablet.css` で 16px にしている。
- 画面の高さは `--app-h`（`src/store/device.ts` が表示域から入れる）。`100vh` はアドレスバーの出し入れで変わるので、全画面の高さには使わない。
- ホバーに頼らない（指では出ない）。長押し・右クリックのメニューで代わりを用意する。

### 画面（iPhone）：上端のぼかしと切り欠き

- iOS 26 からの Safari は、ページの上端（ステータスバーのすぐ下）に、だんだん薄くなるぼかしをかける。上のバーのボタンや文字がぼやけて見にくくなる。`theme-color` はもう使われない（色はページから拾う）。
- ぼかしを消すには、上端に「幅いっぱい（画面の 90% 以上）・不透明・`position: fixed`（か sticky）」の物を置く。Safari は上端の真ん中・上から 4px の所で一番上にある物を探し、見つかるとその背景色をステータスバーの裏まで伸ばして、ぼかしを出さない（WebKit の `LocalFrameView::fixedContainerEdges` と `WKWebView` の `_shouldHideTopScrollPocket`）。背景色をそのまま使うのは、その物の高さが 10px を超えるときだけ（薄いと画素を拾う）。`backdrop-filter` があると「色がいくつもある」扱いになるので付けない。`::before` のような疑似要素では見つけてもらえない（本物の要素にする）。
- スマホの縦では、`src/App.tsx` が置く `.p-edge-top`（`src/phone.css`）がこの帯。上のバーと同じ色で、画面の上へはみ出させて高さ 22px（見えるのは上の 6px）、指は下へ通す。ダイアログやメニューの暗い幕はこの上に重なる（そのときは Safari が幕の色を伸ばす）。
- そのため、スマホの縦の全画面の画面は、上のバーの中身を上から 6px より下に置く（`.p-top`・`.ph-top` は `padding-top: max(env(safe-area-inset-top), 4px)`）。Safari のタブの縦では `env(safe-area-inset-top)` は 0 になる（ページはステータスバーの下から始まる）。
- ホーム画面のアプリは `apple-mobile-web-app-status-bar-style` を `black` にしている（ステータスバーは黒で、ページはその下から始まる）。`black-translucent` にすると、iOS 26 以降はページの上の方に大きくぼかしがかかる報告があるので変えない。この設定はホーム画面に追加したときに読まれるので、変えたら追加し直してもらう必要がある。
- 横向きでは左右に切り欠き（ノッチ・Dynamic Island）が来る。全画面の画面は `env(safe-area-inset-left)`・`env(safe-area-inset-right)` の内側に中身を置く（`src/phone.css` の `html.phone-land` の各ページの並び、ホームの `.ph-top`・`.ph-main`、譜面の `.p-editor.land`）。スマホの全画面の画面を足したら、ここに足す。
- 確かめ方: Playwright（Chromium）で CDP の `Emulation.setSafeAreaInsetsOverride` を使い、iPhone 17 の縦（上 62・下 34）・横（左右 62・下 21）と、Safari のタブの縦（上 0）を入れて撮る。上端の真ん中・上から 4px で一番上にあるのが `.p-edge-top` かは、帯の `pointer-events` を一時的に戻して `document.elementFromPoint` で見る。ぼかしそのものは実機でしか見えない。

## 4. ブラウザの判定

`src/platform.ts` に集めています。UA を見る判定はここ以外に書かない。

- `IS_IOS`: iPad・iPhone。iPad の Safari は既定で Mac と名乗るので、指で触れるか（`maxTouchPoints > 1`）で見分ける。
- `IS_WEBKIT`: Safari の仕組み（Mac の Safari、iPad・iPhone のすべてのブラウザ）。**動きの分岐はこれ。**
- `IS_SAFARI`: Safari そのもの。**案内の文はこれ**（iPad の Chrome は Chrome で確かめているので案内を出さない）。
- `webkitAtLeast(18, 4)`・`oggUnsupported()`: 版で分ける。
- ホーム画面に追加したアプリとして開いているかは `src/pwa/display.ts` の `isStandalone()`。

## 5. 画面での案内と確かめ方

- ホーム（PC・タブレット）の上に、Safari かホーム画面のアプリのときだけ「まだ実機で確かめていません。うまく動かないときは Chrome を」の案内を出す（`src/ui/SafariNotice.tsx`、閉じたら出さない）。
- 設定の「音の出力」（`src/ui/AudioCheck.tsx`）: 出力の様子・テスト音・出力の作り直し・読める音の形式。iPad で音が出ないと言われたら、ここの様子を送ってもらう。
- 実機が無いときの確かめ方:
  1. `npx vitest run src/audio/engineSafari.test.ts src/platform.test.ts src/safariRules.test.ts`
  2. Playwright（Chromium）で iPad の UA と `maxTouchPoints` を入れ、`navigator.audioSession` を偽物にして、案内・設定の画面と再生を見る（WebKit そのものの動きは確かめられない）。
  3. 本当の確かめは実機。

## 6. 知られている WebKit の不具合（2026-11 時点）

| 不具合 | エンジンの対処 |
| --- | --- |
| 消音で Web Audio が黙る（[237322](https://bugs.webkit.org/show_bug.cgi?id=237322)） | `audioSession` を `playback` に |
| `interrupted` のまま戻らない（[273511](https://bugs.webkit.org/show_bug.cgi?id=273511)） | 時刻が進まなければ作り直す |
| ほかのタブを閉じたあと音が出ない（[276687](https://bugs.webkit.org/show_bug.cgi?id=276687)） | 画面に戻ったら起こす・作り直す |
| 裏から戻ると `resume()` が返らない（[281566](https://bugs.webkit.org/show_bug.cgi?id=281566)） | `resume()` を待たず、時刻で確かめる |
| ホーム画面のアプリで、裏から戻ると音が出ない（iOS 26.0〜26.1、[291892](https://bugs.webkit.org/show_bug.cgi?id=291892)） | 時刻が進まなければ作り直す |

## 参考

- [Audio Session API](https://w3c.github.io/audio-session/)（`navigator.audioSession`）
- [HTML: 操作として数える入力](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event)（`pointerdown` は指では数えない）
- [MDN: Autoplay guide for media and Web Audio APIs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
