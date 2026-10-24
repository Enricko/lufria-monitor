import { useMemo, useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";

interface FeedbackSuggestionsProps {
  lastMessageText?: string;
  disabled?: boolean;
  onSelect: (prompt: string) => void;
}

interface SuggestionGroup {
  title: string;
  items: string[];
}

export function extractFeedbackSuggestions(text?: string): SuggestionGroup | null {
  if (!text || !text.trim()) return null;
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // 1. Check for numbered choices (e.g. "1. Restart service\n2. Cek log\n3. Lanjut")
  const numberedMatches = raw.match(/(?:^|\n)\s*([0-9]+[\.\)]\s*[^\n\r]+)/g);
  if (numberedMatches && numberedMatches.length >= 2 && numberedMatches.length <= 6) {
    const items = numberedMatches
      .map((m) => m.trim().replace(/^[0-9]+[\.\)]\s*/, "").replace(/^[*`_]+|[*`_]+$/g, "").trim())
      .filter((item) => item.length > 0 && item.length <= 65);
    if (items.length >= 2) {
      return {
        title: "Pilih Opsi Tindakan",
        items: items.slice(0, 4).map((it, idx) => `${idx + 1}. ${it}`),
      };
    }
  }

  // 2. Specific server & service follow-up (e.g. "Ada yang spesifik ingin dicek atau dikerjakan?")
  if (
    lower.includes("ingin dicek atau dikerjakan") ||
    lower.includes("ada yang spesifik") ||
    lower.includes("ada yang ingin dicek") ||
    lower.includes("apa yang ingin dikerjakan") ||
    lower.includes("apa yang ingin dicek")
  ) {
    return {
      title: "Saran Tindakan Cepat",
      items: [
        "Cek log & error service",
        "Cek resource server (CPU & RAM)",
        "Lanjut kerjakan task",
        "Tampilkan ringkasan status",
      ],
    };
  }

  // 3. Code fix / modification questions (more specific than general confirmation)
  if (
    (lower.includes("perbaiki") || lower.includes("terapkan") || lower.includes("fix")) &&
    (raw.endsWith("?") || lower.includes("apakah") || lower.includes("mau") || lower.includes("ingin"))
  ) {
    return {
      title: "Persetujuan Perubahan",
      items: ["Ya, perbaiki sekarang", "Tunjukkan diff perubahan dulu", "Batalkan perubahan"],
    };
  }

  // 4. Confirmation / Yes-No questions
  const isConfirm =
    lower.includes("apakah anda ingin") ||
    lower.includes("apakah ingin") ||
    lower.includes("mau dilanjutkan") ||
    lower.includes("ingin lanjut") ||
    lower.includes("apakah setuju") ||
    lower.includes("apakah perlu") ||
    lower.includes("do you want to proceed") ||
    lower.includes("should i continue") ||
    lower.includes("would you like to proceed") ||
    lower.includes("are you sure") ||
    lower.includes("setuju?");

  if (isConfirm) {
    return {
      title: "Umpan Balik Keputusan",
      items: ["Ya, lanjutkan", "Tidak, batalkan", "Jelaskan lebih detail dulu"],
    };
  }

  // 5. Open questions ending in '?'
  if (raw.endsWith("?") || /\?\s*$/.test(raw)) {
    if (lower.includes("bagaimana") || lower.includes("opsi mana") || lower.includes("pilih")) {
      return {
        title: "Pilihan Rekomendasi",
        items: [
          "Lanjut dengan opsi yang direkomendasikan",
          "Jelaskan perbandingan opsinya",
          "Biar saya tentukan nanti",
        ],
      };
    }
    return {
      title: "Umpan Balik Cepat",
      items: ["Ya, lanjutkan", "Jelaskan lebih rinci", "Sudah cukup, terima kasih"],
    };
  }

  return null;
}

export function FeedbackSuggestions({
  lastMessageText,
  disabled,
  onSelect,
}: FeedbackSuggestionsProps) {
  const [dismissedText, setDismissedText] = useState<string | null>(null);

  const group = useMemo(() => {
    if (!lastMessageText || lastMessageText === dismissedText) return null;
    return extractFeedbackSuggestions(lastMessageText);
  }, [lastMessageText, dismissedText]);

  if (!group || group.items.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Action suggestions"
      className="mb-2 rounded-xl border border-line bg-surface/80 p-2 text-xs shadow-sm backdrop-blur-sm animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-medium text-muted">
        <span className="flex items-center gap-1.5 text-accent">
          <Sparkles size={12} /> {group.title}:
        </span>
        <button
          type="button"
          onClick={() => setDismissedText(lastMessageText || null)}
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg transition-colors cursor-pointer"
          title="Tutup saran"
          aria-label="Dismiss suggestions"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {group.items.map((item) => (
          <button
            key={item}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(item)}
            className="group flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] font-medium text-fg-2 transition-all hover:border-accent hover:bg-accent/10 hover:text-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            <span>{item}</span>
            <ArrowRight
              size={11}
              className="text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-transform"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
