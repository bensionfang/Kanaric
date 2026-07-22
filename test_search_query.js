// 搜尋字串的兩道加工:繁->簡 (查中國平台用) 與瀏覽器影片標題去噪。
// 執行:node test_search_query.js
const assert = require('assert');
const { toSimplified, toTraditional } = require('./web-app/s2t');
const { cleanBrowserQuery, isMusicAppSource } = require('./web-app/browser-query');

// --- toSimplified ---
assert.strictEqual(toSimplified('告白氣球'), '告白气球');
assert.strictEqual(toSimplified('周杰倫'), '周杰伦');
// 有假名 = 日文,一個字都不准動 (簡繁轉換會毀掉日文漢字)
assert.strictEqual(toSimplified('うっせぇわ'), 'うっせぇわ');
assert.strictEqual(toSimplified('打上花火 (feat. DAOKO)'), '打上花火 (feat. DAOKO)');
// 純漢字的日文歌名確實會被轉壞 —— 這正是呼叫端「原名先查、MISS 才重試簡體」的理由
assert.notStrictEqual(toSimplified('新宝島'), '新宝島');
assert.strictEqual(toSimplified(''), '');
// 沒動到既有的反向轉換
assert.strictEqual(toTraditional('告白气球'), '告白氣球');

// --- cleanBrowserQuery ---
const t = (title, artist) => cleanBrowserQuery(title, artist).title;

// 括號噪音
assert.strictEqual(t('うっせぇわ (Official Video)', 'Ado'), 'うっせぇわ');
assert.strictEqual(t('【MV】うっせぇわ', 'Ado'), 'うっせぇわ');
// 括號但不是噪音 -> 留著
assert.strictEqual(t('打上花火 (DAOKO × 米津玄師)', 'DAOKO'), '打上花火 (DAOKO × 米津玄師)');
// 「」內才是歌名
assert.strictEqual(t('YOASOBI「アイドル」 Official Music Video', 'Ayase / YOASOBI'), 'アイドル');
// 無括號尾綴噪音,可連剝
assert.strictEqual(t('Lemon MV', '米津玄師'), 'Lemon');
assert.strictEqual(t('小幸運 動態歌詞 中文字幕', '田馥甄'), '小幸運');
// ／歌手 尾綴:對得上才剝
assert.strictEqual(t('うっせぇわ／Ado', 'Ado'), 'うっせぇわ');
assert.strictEqual(t('うっせぇわ／Ado', ''), 'うっせぇわ／Ado');
// 歌名本身就含 /,尾段不是歌手 -> 不准砍
assert.strictEqual(t('シティ/ポップ', 'Ado'), 'シティ/ポップ');
// 全部剝光時退回原始標題,不能回空字串
assert.strictEqual(t('Official Music Video', 'Ado'), 'Official Music Video');

// 【】內才是歌名 (【MV】那種含噪音字的整塊在前一步就被剝掉了,走到這裡的就是歌名)
assert.strictEqual(
  t('周杰倫 Jay Chou【擱淺 Step Aside】-Official Music Video', '周杰倫 Jay Chou'),
  '擱淺 Step Aside');
// 使用者 DB 裡的實例:【Lyric Video】整塊剝掉,再剝 ／頻道名
assert.strictEqual(t('ダンス・デカダンス／Chevon 【Lyric Video】', 'Chevon-シェボン'), 'ダンス・デカダンス');

// 「歌手 - 歌名」前綴:前綴真的是歌手才剝 (不剝的話快取鍵會跟音樂 app 的分裂)
assert.strictEqual(t('ヨルシカ - 春泥棒（OFFICIAL VIDEO）', 'ヨルシカ / n-buna Official'), '春泥棒');
assert.strictEqual(t('Ado - うっせぇわ', 'Ado'), 'うっせぇわ');
// 前綴不是歌手 -> 一個字都不准動
assert.strictEqual(t('Chilli Beans. - rose', '米津玄師'), 'Chilli Beans. - rose');
// 歌名本身帶連字號的尾綴,剝掉歌手前綴後要完整留著
assert.strictEqual(t('Vaundy - 怪獣の花唄 - replica -', 'Vaundy'), '怪獣の花唄 - replica -');
// 沒有歌手資訊時不猜
assert.strictEqual(t('ヨルシカ - 春泥棒', ''), 'ヨルシカ - 春泥棒');

// 頻道名尾綴
assert.strictEqual(cleanBrowserQuery('Lemon', '米津玄師 - Topic').artist, '米津玄師');
assert.strictEqual(cleanBrowserQuery('Lemon', 'AdoVEVO').artist, 'Ado');

// --- isMusicAppSource (handleMediaUpdate / logListen / currentDuration 的共同閘門) ---
assert.strictEqual(isMusicAppSource('Spotify.exe'), true);
assert.strictEqual(isMusicAppSource('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'), true);
assert.strictEqual(isMusicAppSource('chrome.exe'), false);
assert.strictEqual(isMusicAppSource('msedge.exe'), false);
assert.strictEqual(isMusicAppSource(''), true);        // 未知來源保守當音樂 app
assert.strictEqual(isMusicAppSource(undefined), true);

console.log('test_search_query ok');
