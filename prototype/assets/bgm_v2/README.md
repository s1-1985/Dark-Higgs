# BGM 第2版 (docs/BGM_SPEC.md)
ChatGPT から届いた WAV を MP3 にしてここに置き、manifest.json に {"tracks":{"<ID>":{"f":["<file>.mp3",...],"d":ファイル秒,"l":true,"bpm":120,"bars":32,"tail":2}}} を足す。
f が複数 = 周回ごとに交互に使う別テイク。ここに無い曲は第1版 (../bgm/) で流れる。メニュー「BGM: 第1版」で全部第1版に戻せる。
