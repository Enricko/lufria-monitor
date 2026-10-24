import { extractFeedbackSuggestions } from "../src/components/FeedbackSuggestions";
import { CLAUDE_SLASH_COMMANDS } from "../src/components/CommandPalette";

export function testCommandAndFeedbackLogic() {
  const results: { name: string; passed: boolean; detail?: unknown }[] = [];
  const check = (name: string, passed: boolean, detail?: unknown) =>
    results.push({ name, passed, detail });

  // 1. Slash commands definitions
  check(
    "slash commands list contains essential commands",
    ["/model", "/status", "/cost", "/clear", "/plan", "/review", "/security-review", "/help"].every(
      (cmd) => CLAUDE_SLASH_COMMANDS.some((c) => c.name === cmd)
    )
  );

  // 2. Feedback extraction: specific question from user screenshot
  const screenshotQ = "Ada yang spesifik ingin dicek atau dikerjakan?";
  const screenshotSuggestions = extractFeedbackSuggestions(screenshotQ);
  check(
    "extracts contextual actions for server/work question",
    !!screenshotSuggestions &&
      screenshotSuggestions.items.length >= 3 &&
      screenshotSuggestions.items.some((it) => it.includes("Cek log")) &&
      screenshotSuggestions.items.some((it) => it.includes("resource server")),
    screenshotSuggestions
  );

  // 3. Feedback extraction: confirmation / yes-no
  const confirmQ = "Apakah Anda ingin saya menerapkan perubahan ini ke server sekarang?";
  const confirmSuggestions = extractFeedbackSuggestions(confirmQ);
  check(
    "extracts yes/no confirmation choices",
    !!confirmSuggestions &&
      confirmSuggestions.items.some((it) => it.includes("Ya, lanjutkan")) &&
      confirmSuggestions.items.some((it) => it.includes("batalkan")),
    confirmSuggestions
  );

  // 4. Feedback extraction: numbered choices in assistant message
  const numberedMsg =
    "Berikut beberapa pilihan langkah perbaikan:\n1. Restart service lufria-monitor\n2. Rebuild bundle frontend\n3. Cek error log systemd\nSilakan tentukan pilihan.";
  const numberedSuggestions = extractFeedbackSuggestions(numberedMsg);
  check(
    "extracts numbered options into interactive chips",
    !!numberedSuggestions &&
      numberedSuggestions.items.length === 3 &&
      numberedSuggestions.items[0] === "1. Restart service lufria-monitor" &&
      numberedSuggestions.items[1] === "2. Rebuild bundle frontend",
    numberedSuggestions
  );

  // 5. Feedback extraction: code fix questions
  const fixQ = "Ada bug di auth controller. Apakah ingin saya perbaiki sekarang?";
  const fixSuggestions = extractFeedbackSuggestions(fixQ);
  check(
    "extracts fix confirmation options",
    !!fixSuggestions &&
      fixSuggestions.items.some((it) => it.includes("perbaiki")),
    fixSuggestions
  );

  // 6. Feedback extraction: statement without question returns null
  const statement = "Service lufria-monitor sudah berjalan normal pada port 8090. Semua pengujian lulus.";
  const noSuggestions = extractFeedbackSuggestions(statement);
  check("statement without question returns null", noSuggestions === null, noSuggestions);

  return {
    results,
    passed: results.every((r) => r.passed),
  };
}
