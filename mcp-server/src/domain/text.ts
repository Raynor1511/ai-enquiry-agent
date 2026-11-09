/**
 * Small, dependency-free text helpers shared by the tools and both data stores.
 * The Postgres store mirrors `nameKey` with the SQL function `name_key(text)`,
 * so any change here must be made there too (seed/sql/001_schema.sql).
 */

/** Lowercase, strip punctuation (keeping letters of any alphabet, digits and spaces), collapse whitespace. */
export function normaliseText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Key used to compare people's names: letters and single spaces only. "O'Neill " -> "oneill". */
export function nameKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do", "for", "from", "get", "have",
  "hi", "i", "im", "in", "is", "it", "its", "me", "my", "need", "of", "on", "or", "our", "please", "so", "some",
  "that", "the", "there", "this", "to", "we", "what", "when", "with", "would", "you", "your", "how", "much",
  "cost", "price", "quote", "like", "want", "looking", "know", "just", "help", "thanks", "hello",
]);

/** Very light stemmer: enough to make "leaking"/"leaks"/"leak" and "radiators"/"radiator" meet. */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("es") && /(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Content-word stems of a piece of text, in order, without stopwords. */
export function contentStems(input: string): string[] {
  return normaliseText(input)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Reduce a keyword phrase exactly the way query text is reduced (stopwords out, words stemmed),
 * so "service my boiler" can match a query whose content words are "service boiler".
 */
export function stemPhrase(phrase: string): string {
  return contentStems(phrase).join(" ");
}
