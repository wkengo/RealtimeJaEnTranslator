リアルタイム日英翻訳（GitHub Pages / iPhone対応）

【公開先】
https://wkengo.github.io/RealtimeJaEnTranslator/

【GitHub Pagesへ配置】
1. GitHubで「RealtimeJaEnTranslator」というリポジトリを作成します。
2. このフォルダの中身を、リポジトリのルートへそのままアップロードします。
3. GitHubの Settings → Pages を開きます。
4. Deploy from a branch を選択します。
5. Branch: main / Folder: /(root) を選択して保存します。
6. 数分後、上記URLへアクセスします。

【初回使用】
1. 「開始」を押します。
2. ブラウザのマイク利用を「許可」します。
3. 日本語で話します。
4. 日本語と英語が同じ行に表示されます。

※ Webブラウザのセキュリティ上、ページを開いただけで自動的にマイク開始はできません。毎回最初に「開始」を1回押す必要があります。

【単語辞書】
・「単語辞書」を開き、「よみがな」と「表記」を登録します。
・例：たかえ → 貴恵
・辞書は端末ごとのブラウザ内（localStorage）へ保存されます。
・CSV読込／CSV出力で別端末へ移行できます。
・音声認識結果に読みがそのまま出た場合はアプリ側で即時置換し、さらにGeminiへ辞書を渡して同音語の補正も行います。

【コピー】
・PC：日本語またはEnglishのセルを右クリック →「コピー」
・PC／iPhone：各セル右側の「⧉」を押すと、そのセルだけコピーします。
・「全文コピー」は、日本語[TAB]English の形式で全行をコピーします。

【CSV保存】
「CSV保存」で、日本語／Englishの2列として保存します。

【iPhoneでアプリ風に使う】
1. Safariで公開URLを開きます。
2. 共有ボタン →「ホーム画面に追加」を選びます。
3. 次回からホーム画面のアイコンで起動できます。

【マイク確認】
画面上部の「マイク」メーターが発話に合わせて動けば、ブラウザまで音声が届いています。

【構成】
・音声認識：ブラウザの SpeechRecognition（iPhoneはSafari、PCはChrome/Edgeを推奨）
・日本語補正／フィラー除去／英訳：Firebase AI Logic → Gemini 3.7 Flash
・不正利用対策：Firebase App Check + reCAPTCHA Enterprise

【重要】
Firebase App CheckのreCAPTCHA Enterpriseで wkengo.github.io を登録済みであることが前提です。
Firebase AI LogicのApp Check「強制適用」は、GitHub Pages公開後に正常リクエストが「検証済み」として確認できてから有効にしてください。
