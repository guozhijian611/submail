import { francAll } from "franc-min";

export type EnglishDetection = "english" | "unknown";

const englishMarkers = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "can", "could",
  "for", "from", "has", "have", "if", "in", "is", "it", "not", "of", "on", "or", "our",
  "please", "that", "the", "their", "this", "to", "was", "we", "were", "will", "with",
  "would", "you", "your"
]);

export function canonicalLanguageTag(value: string): string {
  const trimmed = value.trim();
  try {
    const canonical = Intl.getCanonicalLocales(trimmed);
    if (canonical.length !== 1) throw new Error("invalid language tag");
    return canonical[0];
  } catch {
    throw new Error("目标语言必须是有效的 BCP-47 语言标签，例如 zh-CN 或 en");
  }
}

export function normalizeLibreLanguageCode(value: string): string {
  const canonical = canonicalLanguageTag(value);
  const locale = new Intl.Locale(canonical);
  if (locale.language === "zt") return "zt";
  if (locale.language === "zh") {
    if (locale.script === "Hant" || ["TW", "HK", "MO"].includes(locale.region ?? "")) return "zt";
    return "zh";
  }
  return locale.language.toLowerCase();
}

export function detectEnglishText(value: string): EnglishDetection {
  const cleaned = value
    .normalize("NFKC")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, " ");
  const letters = cleaned.match(/\p{L}/gu) ?? [];
  if (letters.length < 40) return "unknown";
  const latinLetters = cleaned.match(/\p{Script=Latin}/gu) ?? [];
  if (latinLetters.length / letters.length < 0.85) return "unknown";
  const asciiLetters = cleaned.match(/[A-Za-z]/g) ?? [];
  if (asciiLetters.length / latinLetters.length < 0.85) return "unknown";
  const words = cleaned.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (words.length < 8) return "unknown";
  const markerWords = words.filter((word) => englishMarkers.has(word));
  const distinctMarkers = new Set(markerWords);
  if (distinctMarkers.size < 3 || markerWords.length / words.length < 0.12) return "unknown";
  const ranked = francAll(cleaned, { minLength: 40 });
  const [first, second] = ranked;
  if (!first || first[0] !== "eng" || first[1] < 0.9) return "unknown";
  if (second && first[1] - second[1] < 0.12) return "unknown";
  return "english";
}
