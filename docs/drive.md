# Google Drive に保存する（v0.29.0〜）

曲フォルダ（ブラウザの中＝OPFS の曲も、PC の曲フォルダも）を、Google Drive の「DTX Web Editor/<曲フォルダ名>」と合わせます。

- 保存すると、変わったファイルだけ Drive に送る（初めて保存した曲は Drive に作ってつなぐ）。
- まだ保存していない続き（自動保存）も、20 秒ほど置いて送る（`.dtxe-autosave/<譜面>.json`）。
- 別の端末では、ホームやファイルメニューの「Drive から開く」で曲ごと取ってくる。続きの自動保存があれば、そこから開く。
- 両方の端末で変えたファイルは、保存のときに聞く。自動保存では送らずに置いておく。消したファイルは Drive からは消さない。

## コードの場所

| 何 | どこ |
| --- | --- |
| ログイン（GIS のトークン、小窓とページ切り替え） | `src/drive/auth.ts` |
| Drive REST v3 を直接呼ぶ（再送・大きいファイルの再開できる送り方） | `src/drive/api.ts` |
| 合わせ方（つなぎの記録 `.dtxe-drive.json`・MD5 で比べる・送る／取る） | `src/drive/sync.ts`、`src/drive/md5.ts` |
| 保存・自動保存・開くとのつなぎ、状態 | `src/app/driveActions.ts` |
| 画面（ホームのカード・設定・フッター・iPad の保存シート） | `src/ui/DriveUi.tsx` |

つなぎの記録 `.dtxe-drive.json` と `.dtxe-autosave/` は曲フォルダの中に置き、Drive にも ZIP の書き出しにも入れない（`syncedPath()`）。

## Google Cloud の設定

- OAuth クライアント（ウェブ アプリケーション）: `918924939494-oirrr67hcpk8nps7ul494g6m720at5jv.apps.googleusercontent.com`（公開して良い値）
- 承認済みの JavaScript 生成元: `https://check5004.github.io`
- 承認済みのリダイレクト URI: `https://check5004.github.io/dtx-mania-web-editor/`（ホーム画面のアプリで小窓が開けないときのページ切り替え用）
- スコープは `drive.file` だけ（このアプリが作ったファイルだけ見える）。審査は要らない。
- 公開ステータスは「テスト」（テストユーザーだけ使える）。テストのままだと許可が 7 日で切れ、週に 1 回ほど Google の確認画面が出る。出したくなければ Google Auth Platform の「対象」で「アプリを公開」にする（`drive.file` だけなら「確認されていないアプリ」の警告も出ない）。
- 生成元に無い所（`localhost` など）ではログインできない。開発中に本物の Drive で試すなら、生成元に足す。

## 試験

- `src/drive/sync.test.ts`：偽の Drive（`src/drive/fakeDrive.testutil.ts`、fetch の代わり）で、送る・取る・両方で変わった・自動保存・同じ名前の曲・Drive で消した曲・ログイン切れを確かめる。
- 小窓・ページ切り替えのログインと、iPad（ホーム画面のアプリ）での動きは、実機でしか確かめられない。
