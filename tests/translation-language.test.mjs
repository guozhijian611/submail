import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { canonicalLanguageTag, detectEnglishText, normalizeLibreLanguageCode } = await tsImport(
  "../apps/api/src/language.ts",
  import.meta.url
);

test("conservative English detection rejects short and ambiguous text", () => {
  assert.equal(detectEnglishText("Thanks."), "unknown");
  assert.equal(detectEnglishText("请尽快查看附件，并在明天下午之前回复确认。谢谢。"), "unknown");
  assert.equal(detectEnglishText("El informe contiene los resultados del proyecto y necesita una revisión detallada antes de la reunión."), "unknown");
  assert.equal(detectEnglishText("We hebben in dit project een plan dat is gemaakt voor de klant en we willen het voor de vergadering bespreken."), "unknown");
  assert.equal(detectEnglishText("Wir haben für dieses Projekt einen ausführlichen Plan erstellt und möchten ihn vor der Besprechung gemeinsam prüfen."), "unknown");
  assert.equal(detectEnglishText("Please review this proposal before the meeting，并在明天下午前回复确认，我们需要继续安排后续工作。"), "unknown");
  assert.equal(
    detectEnglishText("Please review the attached proposal and let us know if you have any questions before our meeting tomorrow."),
    "english"
  );
});

test("language tags are canonicalized and LibreTranslate receives base codes", () => {
  assert.equal(canonicalLanguageTag("zh-cn"), "zh-CN");
  assert.equal(canonicalLanguageTag("en-us-u-ca-gregory"), "en-US-u-ca-gregory");
  assert.equal(normalizeLibreLanguageCode("zh-CN"), "zh");
  assert.equal(normalizeLibreLanguageCode("zh-TW"), "zt");
  assert.equal(normalizeLibreLanguageCode("zh-Hant"), "zt");
  assert.equal(normalizeLibreLanguageCode("en-US"), "en");
  assert.throws(() => canonicalLanguageTag("zh_CN"), /BCP-47/);
});
