function youtubeCnSourceOrder(preferredSource, { youtube = false } = {}) {
  if (preferredSource === 'QQMusic') return ['QQMusic', 'NetEase', 'Kugou'];
  if (!['NetEase', 'Kugou'].includes(preferredSource)) {
    return youtube ? ['QQMusic', 'NetEase', 'Kugou'] : [];
  }
  return ['QQMusic', preferredSource, ...['NetEase', 'Kugou'].filter((source) => source !== preferredSource)];
}

function shouldAcceptYoutubeCnResult(requestedSource, result) {
  return requestedSource !== 'QQMusic' || (result?.source === 'QQMusic' && result.word === true);
}

module.exports = { youtubeCnSourceOrder, shouldAcceptYoutubeCnResult };
