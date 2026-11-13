# Google Drive に保存する（v0.29.0〜）

曲フォルダ（ブラウザの中＝OPFS の曲も、PC の曲フォルダも）を、Google Drive の「DTX Web Editor/<曲フォルダ名>」と合わせます。

- 保存すると、変わったファイルだけ Drive に送る（初めて保存した曲は Drive に作ってつなぐ）。
- まだ保存していない続き（自動保存）も、20 秒ほど置いて送る（`.dtxe-autosave/<譜面>.json`）。
- 別の端末では、ホームやファイルメニューの「Drive から開く」で曲ごと取ってくる。続きの自動保存があれば、そこから開く。
- 両方の端末で変えたファイルは、保存のときに聞く。自動保存では送らずに置いておく。消したファイルは Drive からは消さない。

## 曲のフォルダの中身だけを合わせる（v0.37.0〜）

DTXMania の DTXFiles のように曲を集めたフォルダを曲フォルダとして選び、ほかの曲まで Drive に送ってしまったこと（v0.36.0 まで）があったので、次のようにしている。見分け方は `src/fs/songDir.ts`（DTXMania と同じく、譜面・set.def・box.def・成績 `*.score.ini` が直下にあるフォルダを1曲・曲のまとまりとみる）。

- 保存の場所を選ぶと、その中に曲のフォルダを作る（空のフォルダ・同じ名前の曲フォルダならそこへ。ほかの曲のフォルダなら聞く）。`src/app/songPlace.ts`
- ほかの曲も入ったフォルダ（DTXFiles など）で開いた曲は、Drive と合わせない。保存のときに、この曲だけのフォルダを作って移し（譜面が使うファイル・stems/・直下の譜面や音だけ）、Drive とのつなぎもそこへ移す。元の場所に残ったこの曲のファイルは、聞いてから消す（直下と stems/ の物だけ）。
- `pushSong` はほかの曲が入ったフォルダを送らない（`notSong`）。`pullSong` はそこへ取らない（`NotSongFolderError`）。
- Drive の曲フォルダに入ったほかの曲のフォルダは「新しいファイル」として出さず、送りも取りもしない（つなぎの記録からも外す）。知らせとフッターの「Drive にほかの曲」から、ゴミ箱に移せる（`trashJunk`。消さずにゴミ箱へ。30 日間は戻せる）。設定の「Drive の曲を点検する」で全部の曲を調べられる。
- ファイルメニューの「保存先のフォルダを変える…」で、曲を別の曲フォルダに写して付け替えられる（元のファイルは残す）。

## 曲ごと・保存したときだけ・大きい曲は聞く（v0.49.0〜）

「DTXMania の曲」（ゲームの曲をまとめて一覧にする。[説明書](manual.md#dtxmania-の曲pc)）で、Drive を無料の 15 GB で使い切らないように、次の決まりにした。

- 一覧の読み込み・曲を開いただけでは何も送らない（`src/nxlib/` は Drive を呼ばない）。送るのは今まで通り、保存した曲の、その曲のフォルダだけ。
- 「この曲は送らない」の印：つないでいない曲の `.dtxe-drive.json` に `{"v":1,"skip":true}` を書く（`writeDriveSkip`・`readDriveSkip`・`isSkipText`）。保存しても送らない（`skipped()`）。フッターの「Drive にも保存」で押して送ると、つなぎの記録で上書きされて消える。保存の画面のチェックを外したとき・一覧の詳しい所の「この曲は送らない」・下の 100 MB の確かめで「この曲は Drive に送らない」を選んだときに書く。つないだ曲の記録は上書きも消しもしない。
- 初めて送る曲が 100 MB（`BIG_FIRST`）をこえるときは、送る前に聞く（`firstPush()`、画面は `src/ui/DriveFirstDialog.tsx`）。Drive の空き（`storageQuota()`）と、このアプリで送った曲の大きさ（`listDriveSongs()` の `s`）も見せる。
  - 動画を除いて送る：つなぎの記録に `noVideo: true` を残し、次からも動画（`.mp4` `.mov` `.webm` `.avi` など）を送りも取りもしない（`localFiles(folder, noVideo)`）。動画はこの端末の曲フォルダに残り、ほかの機器では動画なしで開く。
  - 全部送る／この曲は Drive に送らない（印を書く。次からも聞かない）／あとで（閉じる。次の保存でまた聞く）。
  - 空きが足りない送り方は選べない。自動保存（`kind: 'autosave'`）はつないでいない曲を作らないので聞かない。

## PC どうしの同期（v0.54.0〜）

作る PC と遊ぶ PC が別のとき、「DTXMania の曲」（`src/nxlib/`）で覚えたゲームの曲を、同じ Google アカウントの Drive で合わせる（[説明書](manual.md#pc-どうしの同期google-drive)）。上の「保存した曲だけ送る」とは別の道で、曲のフォルダの `.dtxe-drive.json` は同じ物を使う（どちらから送っても、つなぎの記録は 1 つ）。

- Drive の置き方: 「DTX Web Editor/DTXFiles/<BOX のフォルダ>/<曲のフォルダ>」（`libPath`。DTXMania の曲と同じ並び。ゲームのフォルダを選んだときは DTXFiles の中から）。曲のフォルダに `appProperties.dtxe = 'song'`（iPad の「Drive から開く」でも見つかる）、成績だけの曲は `play = '1'`、ファイルに送った PC の名前 `dev`。「DTX Web Editor」の直下の曲（iPad・前の版）は、`importBox` の BOX へ取り、Drive でも動かす。
- 控え: 両方で直したファイルの残さなかった方を「DTX Web Editor/控え/<日付>/<曲>/」へ（`dtxe = 'bak'`）。30 日より古い控えは片付ける。戻すのは `restoreBackup`（控えの版を新しい方として送る）。
- PC の印: 「DTX Web Editor/.sync/<pcId>.json」（`dtxe = 'pc'`）を同期のたびに書き、その時刻で PC の時計と Drive の時計の差を測る（ずれていれば、両方で直したファイルの新しい方を決めずに聞く）。
- 変化: Drive の changes で、ほかの PC が変えた曲だけ中を読み直す（この PC が書いた物は `mine` で除く）。設定が変わったとき（`settingsSig`）は全部読み直す。
- 決め方（`planSong`、1 曲のファイルごと）: この PC の今・Drive の今・前に合わせたとき（`.dtxe-drive.json` の `files`）の 3 つで比べる。大きさと更新時刻が記録と同じならそのまま、違えば MD5。
  - 片方だけ変わった → そちらへ合わせる。両方で変わった作るファイル → 新しく直した方（`keepLocal`・`keepRemote`）で、もう一方は控え。初めて合わせる曲で、この PC の版がほかの PC の作るファイルを置きかえるとき・時計がずれているときは聞く（`ask`）。
  - 遊ぶファイル（`kindOf` が `play`：`*.score.ini`・`*.ghost`）は別の扱い。score.ini は `mergeScoreIni`（回数は前にまとめた成績 `scores` から増えた分を足す。無ければ多い方。いい記録は良い方）、ゴーストはまとめた score.ini で良い方を選んだ側から。
  - 消えた: 記録にあって片方で消えた → もう一方も消す（Drive はゴミ箱、PC は消す）。消えた側で直していたら戻す。一度にたくさん消えていたら消さずに戻す（`guardMass`）。成績は消さない。曲のフォルダごと消えたときは聞く。
  - 開いている曲（エディタで開いている）は、この PC の作るファイルを書きかえない（`wait`。エディタで「取り込む」→ `syncTake`）。DTXMania が開いていて書けないファイルは `later`（次の同期で）。
- いつ: アプリを開いたとき・開いている間 5 分ごと・曲を保存したとき（その曲だけ、`syncSaved`）・「今すぐ同期」（`syncNow`。押した操作の中でログインとフォルダの許可を聞く）。開いたとき・5 分ごとはログインの小窓を出せないので、切れていたら帯で知らせる。
- 記録: 設定は localStorage `dtxe.pcsync`、状態（`SyncState`：Drive の曲の索引・changes の印・聞いたことの答え）と同期の記録（30 日）は IndexedDB。
- 大きさ: 設定の画面で、合わせる曲の大きさを数え（`measureSongs`）、Drive の空き（`about.storageQuota`）と比べる。全部の曲が空きに入らなければ選べない。

| 何 | どこ |
| --- | --- |
| 型・聞くこと・同期の結果 | `src/sync/types.ts` |
| 作るファイル・遊ぶファイルの見分け | `src/sync/kind.ts` |
| score.ini を読む・まとめる | `src/sync/scoreIni.ts` |
| 1 曲のファイルをどうするか | `src/sync/plan.ts` |
| 同期の本体（Drive の置き方・控え・PC の印・初めての比べ・実行） | `src/sync/engine.ts` |
| いつ動かすか・状態・記録・設定 | `src/sync/store.ts` |
| 画面（設定・容量の警告・初めての確認・記録・帯・一覧の印・曲の「同期」） | `src/ui/sync/`、`src/sync.css` |
| エディタで開いている曲との行き来（「取り込む」） | `src/app/driveActions.ts` |

試験: `src/sync/plan.test.ts`・`src/sync/scoreIni.test.ts`・`src/sync/engine.test.ts`（偽の Drive と、メモリの中のフォルダ `src/sync/memfs.testutil.ts` で 2 台・3 台の PC）。画面は、Playwright で 2 つのブラウザ（作る PC・遊ぶ PC。別々の OPFS に偽の DTXMania のフォルダ）と、Node の偽の Drive 1 つをつないで確かめた（初めての同期・成績の行き来・両方で直した譜面・容量の警告・ログイン切れ・開いている曲の「取り込む」）。

## コードの場所

| 何 | どこ |
| --- | --- |
| ログイン（GIS のトークン、小窓とページ切り替え） | `src/drive/auth.ts` |
| Drive REST v3 を直接呼ぶ（再送・大きいファイルの再開できる送り方） | `src/drive/api.ts` |
| 合わせ方（つなぎの記録 `.dtxe-drive.json`・MD5 で比べる・送る／取る） | `src/drive/sync.ts`、`src/drive/md5.ts` |
| 保存・自動保存・開くとのつなぎ、状態 | `src/app/driveActions.ts` |
| 画面（ホームのカード・設定・フッター・iPad の保存シート） | `src/ui/DriveUi.tsx` |
| 曲フォルダの見分け方・この曲のファイル | `src/fs/songDir.ts` |
| 大きい曲を初めて送る前に聞く画面 | `src/ui/DriveFirstDialog.tsx` |

つなぎの記録 `.dtxe-drive.json` と `.dtxe-autosave/` は曲フォルダの中に置き、Drive にも ZIP の書き出しにも入れない（`syncedPath()`）。

## Google Cloud の設定

- OAuth クライアント（ウェブ アプリケーション）: `918924939494-oirrr67hcpk8nps7ul494g6m720at5jv.apps.googleusercontent.com`（公開して良い値）
- 承認済みの JavaScript 生成元: `https://check5004.github.io`
- 承認済みのリダイレクト URI: `https://check5004.github.io/dtx-mania-web-editor/`（ホーム画面のアプリで小窓が開けないときのページ切り替え用）
- スコープは `drive.file` だけ（このアプリが作ったファイルだけ見える）。審査は要らない。
- 公開ステータスは「テスト」（テストユーザーだけ使える）。テストのままだと許可が 7 日で切れ、週に 1 回ほど Google の確認画面が出る。出したくなければ Google Auth Platform の「対象」で「アプリを公開」にする（`drive.file` だけなら「確認されていないアプリ」の警告も出ない）。
- 生成元に無い所（`localhost` など）ではログインできない。開発中に本物の Drive で試すなら、生成元に足す。

## 試験

- `src/drive/sync.test.ts`：偽の Drive（`src/drive/fakeDrive.testutil.ts`、fetch の代わり）で、送る・取る・両方で変わった・自動保存・同じ名前の曲・Drive で消した曲・ログイン切れ・ほかの曲が入ったフォルダ（送らない・取らない・ゴミ箱へ）を確かめる。
- `src/fs/songDir.test.ts`：曲フォルダの見分け方・保存の場所の決め方・移すときに写す／消すファイル。
- 小窓・ページ切り替えのログインと、iPad（ホーム画面のアプリ）での動きは、実機でしか確かめられない。
