const STOPWORDS: Record<string, readonly string[]> = {
  en: [
    'the',
    'of',
    'and',
    'to',
    'in',
    'is',
    'it',
    'that',
    'for',
    'with',
    'this',
    'are',
    'was',
    'not',
    'but',
    'on',
    'as',
    'you',
  ],
  fr: [
    'le',
    'la',
    'les',
    'de',
    'des',
    'du',
    'une',
    'et',
    'est',
    'que',
    'qui',
    'dans',
    'pour',
    'avec',
    'ce',
    'sur',
    'pas',
    'sont',
  ],
};

export type Language = 'en' | 'fr' | 'unknown';

const MIN_WORDS = 10;

const MIN_STOPWORD_RATE = 0.02;

const TECHNICAL = /`[^`\n]*`|https?:\/\/\S+|\S*[/\\]\S*/g;

const STRUCTURAL_LINE = /^\s*(?:[-*+>]\s|#{1,6}\s|\d+[.)]\s|\|)/;

const INLINE_MARKUP = /[*_~]{1,3}|\[|\]|\(|\)/g;

function wordsIn(text: string): string[] {
  return text
    .replace(TECHNICAL, ' ')
    .replace(INLINE_MARKUP, ' ')
    .toLowerCase()
    .replace(/[^\p{Letter}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => /\p{Letter}/u.test(word));
}

function languageOf(words: readonly string[]): Language {
  let best: Language = 'unknown';
  let bestRate = MIN_STOPWORD_RATE;
  let tied = false;
  for (const [language, list] of Object.entries(STOPWORDS)) {
    const rate = words.filter((word) => list.includes(word)).length / words.length;
    if (rate > bestRate) {
      bestRate = rate;
      best = language as Language;
      tied = false;
    } else if (rate === bestRate && best !== 'unknown') {
      tied = true;
    }
  }
  return tied ? 'unknown' : best;
}

export function detectLanguage(text: string): Language {
  const words = wordsIn(text);
  if (words.length < MIN_WORDS) return 'unknown';
  return languageOf(words);
}

export interface Style {
  language: Language;

  words: number;

  meanSentenceLength: number;

  structureShare: number;
}

function splitLines(text: string): { prose: string[]; structural: string[] } {
  const prose: string[] = [];
  const structural: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    (STRUCTURAL_LINE.test(line) ? structural : prose).push(line);
  }
  return { prose, structural };
}

export function styleOf(text: string): Style | null {
  const words = wordsIn(text);
  if (words.length < MIN_WORDS) return null;

  const language = languageOf(words);
  const { prose, structural } = splitLines(text);

  const sentenceWords = prose
    .join(' ')
    .split(/[.!?]+(?:\s|$)/)
    .map((sentence) => wordsIn(sentence).length)
    .filter((count) => count > 0);

  const structuralWords = structural.reduce((total, line) => total + wordsIn(line).length, 0);

  return {
    language,
    words: words.length,
    meanSentenceLength: sentenceWords.length
      ? sentenceWords.reduce((a, b) => a + b, 0) / sentenceWords.length
      : Number.NaN,
    structureShare: structuralWords / words.length,
  };
}
