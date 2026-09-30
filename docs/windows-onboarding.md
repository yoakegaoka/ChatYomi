# Windowsで使い始める

このツールは、Claude・Copilot Chat・Gemini・ChatGPTの回答を、PC上のIrodori-TTSで読み上げます。

## 用意するもの

- Windows 11
- Irodori-TTSが動作するNVIDIA GPU搭載PC
- Python 3.11以上
- [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)

現在はIrodori-TTS-Serverだけ先に導入する必要があります。公式ページの「Installation」に従い、任意のフォルダーへ用意してください。Server側の設定ファイルは本ソフトから変更しません。

## 1. 初回セットアップ

ダウンロードしたフォルダーにある **`setup.cmd`** をダブルクリックします。

フォルダー選択画面が出たら、`Irodori-TTS-Server`フォルダーを選びます。

セットアップは次を自動で行います。

- このツール専用のPython環境を作る
- 必要なファイルをインストールする
- Irodori-TTS-Serverの場所と起動に必要なツールを確認する

初期状態ではIrodori-TTS v3・bf16を使用します。一度モデルを選ぶと、以後の起動でもそのモデルを使います。Server側の `.env` は変更しません。モデルを変えたい場合は、下の[モデルを切り替える](#モデルを切り替える)を参照してください。

最後に「Setup finished」と表示されれば準備完了です。

## 2. 起動する

**`start.cmd`** をダブルクリックします。

初回はモデルのダウンロードと読み込みに時間がかかります。準備ができると管理画面がブラウザで開きます。

管理画面が自動で開かない場合は、次を開いてください。

<http://127.0.0.1:8080/admin>

## 3. 読み上げる声を登録する

最初は声を登録せずに、管理画面の「声を試す・調整する」で動作確認できます。自分で声を設定する場合は、「声を追加する」で名前を入力し、15～30秒程度のWAVファイルを選びます。追加後に試聴し、普段使う声にする場合は「基本の声にする」を押します。

雑音やBGMが少なく、1人の声がはっきり入った音声が適しています。

参照音声を使わずに声質を指定する場合は、[モデルを切り替える](#モデルを切り替える)の手順で v4-Large などの VoiceDesign 対応モデルを選びます。管理画面の「声を試す・調整する」で「標準の声」を選び、「対応モデル用：読み上げる声のイメージ」を開いて希望する声質を入力してください。試聴後に「この声の設定を保存」を押します。v3 標準モデルでは入力した声のイメージは反映されません。

## 4. ブラウザへ読み上げ機能を追加する

1. FirefoxまたはChromeへ、ViolentmonkeyかTampermonkeyを追加します。
2. サーバーを起動した状態で、<http://127.0.0.1:8080/tts-readaloud.user.js> を開きます。
3. 表示されたインストール画面でインストールします。
4. Claude、Copilot Chat、Gemini、ChatGPTのいずれかを開きます。
5. 画面右下の丸いボタンを1回押して、灰色から青色にします。
6. AIへ質問します。回答が完成すると読み上げが始まります。

最初に丸いボタンを押す操作は、ブラウザの音声再生制限を解除するために必要です。

PCで読み上げを確認できたら、Androidでの追加手順は[Androidで使う](usage.md#androidで使う)を参照してください。

## 5. 停止する

**`stop.cmd`** をダブルクリックします。

読み上げ用サーバーとIrodori-TTS-Serverが停止します。

## モデルを切り替える

初期状態ではv3を使用します。v3は実機比較で読み上げの欠落が少なく安定して使えました。v4.1-Smallでは一部の文章で文字の読み落としが再現しました。一方、v4-LargeのINT8量子化版は開発者の環境で動作と発声を確認済みです。モデルは用途に応じて選べます。

モデルを変えるときは **`select_model.cmd`** をダブルクリックします。現在のモデルと最近使ったモデル、v3、v4-LargeのINT8量子化版が一覧に出ます。一覧にないモデルは「新しいモデルIDを入力」を選び、Irodori-TTS-Serverが対応するHugging FaceのチェックポイントIDを入力します。量子化版はリポジトリIDにサブフォルダー名を付けます。例: `Aratako/Irodori-TTS-v4-Large-Quantized/int8-weight-only`。

選択後、ChatYomiが起動します。すでにChatYomiから起動したServerが動いている場合は、停止してから選んだモデルで起動し直します。外部から起動したServerは自動停止しません。モデルの読み込みに成功すると選択が保存され、次回からは **`start.cmd` をダブルクリックするだけ**で同じモデルを使えます。読み込みに失敗した場合は以前の選択が残ります。

v3に戻すときも `select_model.cmd` で選びます。管理画面の「詳細設定とヘルプ」→「接続情報」で、起動したモデルを確認できます。PowerShellに慣れている場合は、`.\start.cmd -IrodoriCheckpoint <モデルID>` で今回だけ別のモデルを指定できます。この指定は保存されません。

v4-Largeは、[T5Gemma 2を使うテキスト・声質説明用エンコーダーと、最長120秒の参照音声への対応](https://huggingface.co/Aratako/Irodori-TTS-v4-Large)が特徴です。INT8量子化版は、[公式モデルカード](https://huggingface.co/Aratako/Irodori-TTS-v4-Large-Quantized)によるとモデルファイルが3,662 MiBで、NVIDIA CUDAとbf16での推論が案内されています。ChatYomiから起動するときはbf16を指定します。初回はモデルの取得に時間がかかります。v3とは音声の特徴や生成時間が異なるため、登録済みの声と読み上げる文章で試聴してください。

**モデルの利用条件は異なります。** [v3](https://huggingface.co/Aratako/Irodori-TTS-500M-v3)はMITライセンスです。[v4-Large量子化版](https://huggingface.co/Aratako/Irodori-TTS-v4-Large-Quantized)には[Gemma Terms of Use](https://ai.google.dev/gemma/terms)と公開元の追加制限が適用されます。ほかのモデルも公開元の条件を確認してください。ChatYomiのコードのMITライセンスは、別途取得するモデルには適用されません。

## うまくいかない場合

[Windowsのトラブルシュート](troubleshooting-windows.md)を確認してください。エラーが表示された場合は、ウィンドウを閉じる前にメッセージを確認すると原因を特定しやすくなります。

## 詳しい操作が必要な場合

ボタン、声、Androidでの利用、読み方の調整は[詳しい使い方](usage.md)を参照してください。

## アンインストール

削除するときは [Windowsから削除する](uninstall-windows.md) を参照してください。通常の利用データはプロジェクトフォルダー内に保存されます。
