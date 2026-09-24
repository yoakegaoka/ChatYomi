# Windowsから削除する

本ソフトはインストーラーを使わないポータブル構成です。通常の設定・音声・ログ・専用Python環境はプロジェクトフォルダー内に保存されます。

## 削除手順

1. **`uninstall.cmd`** をダブルクリックします。
2. ViolentmonkeyまたはTampermonkeyの管理画面から、本userscriptを削除します。
3. LAN利用のためファイアウォール規則を追加した場合だけ、管理者PowerShellで次を実行します。

   ```powershell
   Remove-NetFirewallRule -DisplayName "TTS読み上げサーバ"
   ```

4. `uninstall.cmd`のウィンドウを閉じ、このプロジェクトフォルダーを削除します。

## プロジェクトフォルダーと一緒に削除されるもの

- `.venv/`: 本ソフト専用のPython環境
- `.local/settings.json`: Irodori-TTS-Serverの設置場所
- `config.yaml`: 管理画面やサーバーの設定
- `voices/`内の利用者音声と音声設定
- `readings.local*.yaml`、`readings.unknown.yaml`: 利用者の読み辞書と収集結果
- `*.log`: 起動・診断ログ

残したい音声や読み辞書がある場合は、フォルダー削除前にバックアップしてください。

## 自動削除しないもの

次は他のソフトでも使われる可能性があるため、本ソフトから削除しません。

- Python
- uv
- Irodori-TTS-Server本体とその仮想環境
- Hugging Faceなどのモデルキャッシュ
- ViolentmonkeyまたはTampermonkey本体
- 利用者が手動で作成した、上記以外のファイアウォール規則

Irodori-TTS-Serverやモデルも今後使わない場合は、それぞれの公式手順と保存場所を確認して個別に削除してください。

## 調査結果

本ソフトはWindowsサービス、スタートアップ、タスクスケジューラ、レジストリへ登録しません。JSON保存への移行後は、新規インストールでユーザー環境変数も作成しません。

プロジェクト外に残り得るものは、ブラウザのuserscript、任意で追加したファイアウォール規則、共有ツールとモデルキャッシュです。以前の版でServer側の `.env` を変更した場合は、その版が作成した `.env.before-tts-reader` を確認し、必要なら手動で戻してください。現在の版はServer側の設定を変更しません。
