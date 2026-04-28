const PINYIN_CHARS_RE = /[A-Za-züÜvVāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s·'’-]+/;
const TRAILING_PAREN_RE = new RegExp(`^([\\s\\S]*?)\\s*[（(]\\s*(${PINYIN_CHARS_RE.source})\\s*[)）]\\s*$`);
const TRAILING_LABEL_RE = new RegExp(`^([\\s\\S]*?)\\s*(?:[-—–,:;]|\\s)\\s*(?:pinyin|pin yin)\\s*[:：]?\\s*(${PINYIN_CHARS_RE.source})\\s*$`, 'i');

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function looksLikePinyin(value) {
  const text = normalize(value);
  if (!text) return false;
  if (!PINYIN_CHARS_RE.test(text)) return false;
  return /[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(text);
}

export function splitExpectedAnswerAndPinyin(rawAnswer, explicitPinyin = '') {
  const answer = normalize(rawAnswer);
  const providedHint = normalize(explicitPinyin);

  if (!answer) {
    return {
      expected_answer: '',
      pinyin_hint: looksLikePinyin(providedHint) ? providedHint : ''
    };
  }

  if (looksLikePinyin(providedHint)) {
    return { expected_answer: answer, pinyin_hint: providedHint };
  }

  let match = answer.match(TRAILING_PAREN_RE);
  if (match && looksLikePinyin(match[2])) {
    return { expected_answer: normalize(match[1]), pinyin_hint: normalize(match[2]) };
  }

  match = answer.match(TRAILING_LABEL_RE);
  if (match && looksLikePinyin(match[2])) {
    return { expected_answer: normalize(match[1]), pinyin_hint: normalize(match[2]) };
  }

  return { expected_answer: answer, pinyin_hint: '' };
}

export function getExpectedAnswer(card = {}) {
  const normalized = normalize(card.expected_answer);
  if (normalized) return normalized;
  return splitExpectedAnswerAndPinyin(card.expected_answer_text || '').expected_answer;
}

export function getPinyinHint(card = {}) {
  const hint = normalize(card.pinyin_hint);
  if (hint) return hint;
  return splitExpectedAnswerAndPinyin(card.expected_answer_text || '').pinyin_hint;
}
