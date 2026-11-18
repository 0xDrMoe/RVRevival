// Finds the knowledge base articles (and tags) that match a ticket: plain
// keyword search (BM25), no training and no embeddings, so it's free, fast and
// predictable. Only what it finds goes to the AI, which keeps requests small
// and keeps answers to what the server wrote.

// Common words in the bot's languages that say nothing about a topic.
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by can could do does for from had has have how i if in is it its me my no not of on or our please so " +
    "that the their them then there they this to was we what when where which who why will with would you your " +
    "el la los las un una y o de del en es que por para con se lo le al su " +
    "der die das und ist ein eine nicht ich mit zu den von " +
    "le la les un une et est des du en que pour pas je il " +
    "o a os as um uma e de do da em que para com não " +
    "il lo la gli le un una e di che per non con"
  ).split(" "),
);

// A rough English stem, so "refund", "refunds" and "refunded" match:
// plurals and -ing / -ed endings. Other languages are left as they are.
export function stem(word) {
  if (!/^[a-z]+$/.test(word) || word.length <= 3) {
    return word;
  }
  if (word.endsWith("ies") && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }
  if (/(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  if (word.endsWith("ing") && word.length > 5) {
    return word.slice(0, -3);
  }
  if (word.endsWith("ed") && word.length > 4) {
    return word.slice(0, -2);
  }
  return word;
}

// Lowercase words of two letters or more, in any alphabet, stemmed.
export function words(text) {
  return (
    String(text ?? "")
      .toLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.filter((word) => !STOP_WORDS.has(word))
      .map(stem) ?? []
  );
}

const K1 = 1.2;
const B = 0.75;
// Words in a title count this many times.
const TITLE_WEIGHT = 3;

// The documents ({ id, title, body }) that best match `query`, best first,
// with a score above zero, at most `limit` of them.
export function search(documents, query, { limit = 5 } = {}) {
  const queryWords = [...new Set(words(query))];
  if (queryWords.length === 0 || documents.length === 0) {
    return [];
  }
  const indexed = documents.map((document) => {
    const terms = [...Array(TITLE_WEIGHT).fill(words(document.title)).flat(), ...words(document.body)];
    const counts = new Map();
    for (const term of terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return { document, counts, length: terms.length };
  });
  const averageLength = indexed.reduce((sum, entry) => sum + entry.length, 0) / indexed.length || 1;
  const documentFrequency = new Map(queryWords.map((word) => [word, indexed.filter((entry) => entry.counts.has(word)).length]));
  const total = indexed.length;
  return indexed
    .map(({ document, counts, length }) => {
      let score = 0;
      for (const word of queryWords) {
        const frequency = counts.get(word) ?? 0;
        if (frequency === 0) {
          continue;
        }
        const containing = documentFrequency.get(word);
        const idf = Math.log(1 + (total - containing + 0.5) / (containing + 0.5));
        score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / averageLength));
      }
      return { document, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.document);
}

// The best matches that fit in `maxCharacters` together.
export function pickContext(documents, query, { limit = 5, maxCharacters = 12_000 } = {}) {
  const picked = [];
  let used = 0;
  for (const document of search(documents, query, { limit })) {
    const size = document.title.length + document.body.length;
    if (used + size > maxCharacters) {
      continue;
    }
    picked.push(document);
    used += size;
  }
  return picked;
}
