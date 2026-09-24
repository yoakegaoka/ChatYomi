# Windowsのトラブルシュート

## `Python 3.11以上が見つからない`

Python 3.11以上をインストールし、インストール画面で「Add Python to PATH」を有効にします。その後、`setup.cmd`をもう一度実行します。

## `uv が見つからない`

Irodori-TTS-Serverの公式READMEに従ってuvをインストールします。新しいPowerShellまたはコマンドプロンプトを開いてから、`setup.cmd`をもう一度実行します。

## Irodori-TTS-Serverのフォルダーが分からない

公式手順でIrodori-TTS-Serverを導入したフォルダーです。中に `pyproject.toml`、`.env.example`、`src` フォルダーなどがあります。

## 起動中のServerが指定したモデルと異なる

既に起動しているServerのモデルはAPIから変更できません。`stop.cmd` で停止し、[使いたいモデルを指定して起動](windows-onboarding.md#モデルを切り替える)してください。通常の `start.cmd` はv3を指定します。Server側の `.env` は変更しません。

## 起動が180秒以内に終わらない

初回のモデル取得、GPUドライバー、Serverの依存関係のいずれかで止まっている可能性があります。プロジェクトフォルダーの `irodori_server.err.log` の末尾を確認してください。

Irodori-TTS-Serverを初めて導入した直後は、公式READMEにある次の処理が完了しているか確認します。

```powershell
uv sync --extra cu128
```

## 管理画面が開かない

`start.cmd`のウィンドウを閉じずに、ブラウザで <http://127.0.0.1:8080/admin> を開きます。表示できない場合は、ウィンドウ内の赤または黄色のメッセージを確認します。

## 管理画面は開くが音声が生成されない

管理画面の状態表示でIrodori-TTS-Serverへ接続できているか確認します。モデルの初回読み込み中は、音声が返るまで時間がかかります。

## AIサイトで丸いボタンが表示されない

ViolentmonkeyまたはTampermonkeyが有効か、userscriptがインストール済みか確認します。サーバーを起動した状態で <http://127.0.0.1:8080/tts-readaloud.user.js> をもう一度開くと更新できます。

## ボタンはあるが音が鳴らない

丸いボタンを1回押して青色にしてから、新しく質問します。既に表示されていた過去の回答は自動では読み上げません。

## 停止できない

まず `stop.cmd` を実行します。それでも止まらない場合は、PowerShellで次を実行します。

```powershell
.\stop_server.ps1 -Force
```

想定外のアプリが同じポートを使用している場合、停止スクリプトは巻き添えを避けるため終了させません。
