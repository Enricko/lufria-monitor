"""Estimated prices for models the Claude Code CLI can't price itself (custom providers).

Per 1M tokens (input / output) USD, from public upstream pricing. Estimates only: the real cost through a
router depends on its credits/plan. Cache reads and writes are priced like Anthropic's (0.1x / 1.25x input).
"""

_PRICING: dict[str, tuple[float, float]] = {
    # (input_per_1M, output_per_1M)
    # Anthropic via Antigravity
    "ag/claude-opus-5-5":           (15.0,  75.0),
    "ag/claude-opus-5-5-high":      (15.0,  75.0),
    "ag/claude-opus-5-5-medium":    (15.0,  75.0),
    "ag/claude-opus-5-5-low":       (15.0,  75.0),
    "ag/claude-opus-4-6-thinking":  (15.0,  75.0),
    "ag/claude-sonnet-5-5":         (3.0,   15.0),
    "ag/claude-sonnet-5-5-high":    (3.0,   15.0),
    "ag/claude-sonnet-5-5-medium":  (3.0,   15.0),
    "ag/claude-sonnet-5-5-low":     (3.0,   15.0),
    "ag/claude-sonnet-4-6":         (3.0,   15.0),
    "claude-sonnet-free":           (0.0,    0.0),
    # Gemini via Antigravity
    "ag/gemini-3.8-flash":          (0.075,  0.30),
    "ag/gemini-3.8-flash-high":     (0.075,  0.30),
    "ag/gemini-3.8-flash-medium":   (0.075,  0.30),
    "ag/gemini-3.8-flash-low":      (0.075,  0.30),
    "ag/gemini-3.7-flash-high":     (0.075,  0.30),
    "ag/gemini-3.7-flash-medium":   (0.075,  0.30),
    "ag/gemini-3.7-flash-low":      (0.075,  0.30),
    "ag/gemini-3.6-flash-high":     (0.075,  0.30),
    "ag/gemini-3.6-flash-medium":   (0.075,  0.30),
    "ag/gemini-3.6-flash-low":      (0.075,  0.30),
    "ag/gemini-3.1-pro-high":       (1.25,   5.0),
    "ag/gemini-3.1-pro-low":        (1.25,   5.0),
    "ag/gemini-4-argon-high":       (1.25,   5.0),
    "ag/gemini-pro-agent":          (1.25,   5.0),
    # GPT via Codex
    "ag/gpt-oss-120b-medium":       (3.0,   12.0),
    "cx/gpt-6.1-sol":               (2.50,  10.0),
    "cx/gpt-6-sol":                 (2.50,  10.0),
    "cx/gpt-6-sol[1m]":             (2.50,  10.0),
    "cx/gpt-6-luna":                (2.50,  10.0),
    "cx/gpt-6-luna[1m]":            (2.50,  10.0),
    "cx/gpt-6-astra":               (2.50,  10.0),
    "cx/gpt-6-astra[1m]":           (2.50,  10.0),
    "cx/gpt-5.6-sol":               (2.50,  10.0),
    "cx/gpt-5.6-sol[1m]":           (2.50,  10.0),
    "cx/gpt-5.6-sol-review":        (2.50,  10.0),
    "cx/gpt-5.6-luna":              (2.50,  10.0),
    "cx/gpt-5.6-luna[1m]":         (2.50,  10.0),
    "cx/gpt-5.6-luna-review":       (2.50,  10.0),
    "cx/gpt-5.6-terra":             (2.50,  10.0),
    "cx/gpt-5.6-terra[1m]":         (2.50,  10.0),
    "cx/gpt-5.6-terra-review":      (2.50,  10.0),
    "cx/gpt-daybreak-blue-latest":  (2.50,  10.0),
    "cx/gpt-reserve":               (2.50,  10.0),
    "cx/codex-auto-review":         (2.50,  10.0),
    # DeepSeek / GLM / MiniMax via CodeBuddy
    "cbai/deepseek-v4.1-flash":     (0.27,  1.10),
    "cbai/glm-5.0":                 (0.50,  2.00),
    "cbai/glm-5.1":                 (0.50,  2.00),
    "cbai/glm-5.2":                 (0.50,  2.00),
    "cbai/glm-5.3":                 (0.50,  2.00),
    "cbai/glm-5.3-flash":           (0.10,  0.40),
    "cbai/glm-5v-turbo":            (0.50,  2.00),
    "cbai/minimax-m2.7":            (0.80,  3.50),
    "cbai/minimax-m3":              (0.80,  3.50),
    # Grok / union
    "gcli/grok-4.5-high":           (3.0,   15.0),
    "grok-high":                    (3.0,   15.0),
    "oc/union-alpha":               (1.0,    4.0),
    "oc/jev-1.13-free":             (0.0,    0.0),
    # Lufria auto
    "lufria-auto-xhigh":            (3.0,   15.0),
    "AntiGravity-Tops":             (3.0,   15.0),
}


def prices(model: str) -> tuple[float, float]:
    """(input, output) per 1M tokens: exact match, then the same provider prefix, then a middle-of-the-road guess."""
    found = _PRICING.get(model)
    if not found:
        for key, val in _PRICING.items():
            if model.startswith(key.split("-")[0]):
                found = val
                break
    return found or (1.0, 4.0)


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int,
                      cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float:
    in_price, out_price = prices(model)
    billed_input = input_tokens + cache_write_tokens * 1.25 + cache_read_tokens * 0.1
    return round((billed_input * in_price + output_tokens * out_price) / 1_000_000, 6)


def cli_knows_price(model: str) -> bool:
    """Official Claude models: the CLI's own cost (cost-state / result) is the better number."""
    return model.startswith("claude-") and model not in _PRICING
