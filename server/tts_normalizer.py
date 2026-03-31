"""
VOQR TTS Text Normalizer

Converts AI response text to natural spoken language.
Strips markdown, handles formulas, normalizes numbers and lists.

Reference: internal voice pipeline patterns (reimplemented for VOQR context).
"""

import re

# Kokoro pronunciation overrides — maps words to markdown phoneme syntax.
# Kokoro processes [word](/phonemes/) during G2P to force exact pronunciation.
# Add entries as ear-testing reveals mispronunciations.
# Keys are lowercase; matching is case-insensitive on whole words.
PRONUNCIATION_OVERRIDES: dict[str, str] = {
    # "example": "[example](/ɪɡˈzæmpəl/)",
}


class TTSNormalizer:
    """Converts AI response text to speech-friendly text."""

    def normalize(self, text: str) -> str:
        """Apply all normalization rules in order."""
        if not text or not text.strip():
            return text

        result = text

        # Order matters — structural first, then content, numbers last
        normalizations = [
            ("code_blocks", self._strip_code_blocks),
            ("diff_blocks", self._strip_diff_blocks),
            ("math_blocks", self._strip_math_blocks),
            ("regex_patterns", self._strip_regex_patterns),
            ("markdown_images", self._strip_markdown_images),
            ("task_lists", self._strip_task_lists),
            ("markdown", self._strip_markdown),
            ("html_blocks", self._normalize_html),
            ("inline_json_yaml", self._strip_inline_json_yaml),
            ("tables", self._strip_tables),
            ("emoji_unicode", self._strip_emoji_unicode),
            ("heteronyms", self._normalize_heteronyms),
            ("abbreviations", self._normalize_abbreviations),
            ("email_addresses", self._normalize_email_addresses),
            ("ip_addresses", self._normalize_ip_addresses),
            ("clock_times", self._normalize_clock_times),
            ("version_numbers", self._normalize_version_numbers),
            ("keyboard_shortcuts", self._normalize_keyboard_shortcuts),
            ("cli_commands", self._normalize_cli_commands),
            ("code_identifiers", self._normalize_code_identifiers),
            ("word_slashes", self._normalize_word_slashes),
            ("operators", self._normalize_operators),
            ("parenthetical_acronyms", self._strip_parenthetical_acronyms),
            ("acronyms", self._expand_acronyms),
            ("units", self._normalize_units),
            ("time_durations", self._normalize_time_durations),
            ("percentages", self._normalize_percentages),
            ("multipliers", self._normalize_multipliers),
            ("tilde_approx", self._normalize_tilde_approx),
            ("numbered_lists", self._normalize_numbered_lists),
            ("bullet_lists", self._normalize_bullet_lists),
            ("numbered_refs", self._strip_numbered_refs),
            ("pauses", self._normalize_pauses),
            ("parenthetical_prosody", self._normalize_parentheticals),
            ("currency", self._normalize_currency),
            ("decimals", self._normalize_decimals),
            ("fractions", self._normalize_fractions),
            ("parenthetical_cleanup", self._strip_empty_parentheticals),
            ("repeated_punctuation", self._normalize_repeated_punctuation),
            ("sentence_boundaries", self._normalize_sentence_boundaries),
            ("whitespace", self._normalize_whitespace),
            ("pronunciation", self._apply_pronunciation_overrides),
        ]

        for name, func in normalizations:
            try:
                result = func(result)
            except Exception as e:
                print(f"Warning: Normalization '{name}' failed: {e}")

        return result.strip()

    # ── Code blocks ──────────────────────────────────────────────────────

    def _strip_code_blocks(self, text: str) -> str:
        """Remove fenced code blocks — replace with spoken description."""
        # Multi-line fenced code blocks: ```lang\ncode\n```
        def _code_replacement(match):
            return "... A code example is shown on screen. ... "

        text = re.sub(
            r'```(\w*)\n.*?```',
            _code_replacement,
            text,
            flags=re.DOTALL,
        )
        return text

    # ── Math / LaTeX ─────────────────────────────────────────────────────

    def _strip_math_blocks(self, text: str) -> str:
        """Replace LaTeX math blocks with spoken summary."""
        # Display math: $$...$$ (multiline)
        def _math_replacement(match):
            content = match.group(1)
            # Try to extract a simple equation result
            equals_match = re.search(r'=\s*([\d,]+(?:\.\d+)?)\s*(?:\\text\{([^}]+)\})?', content)
            if equals_match:
                number = equals_match.group(1)
                unit = equals_match.group(2) or ""
                return f"which equals {number} {unit}".strip() + "."
            return "A mathematical formula is shown on screen."

        text = re.sub(r'\$\$(.*?)\$\$', _math_replacement, text, flags=re.DOTALL)
        # Inline math: $...$
        text = re.sub(r'\$([^$]+)\$', lambda m: m.group(1), text)
        # \frac{a}{b} → a over b
        text = re.sub(r'\\frac\{([^}]+)\}\{([^}]+)\}', r'\1 over \2', text)
        # \text{...} → just the text
        text = re.sub(r'\\text\{([^}]+)\}', r'\1', text)
        # Remaining backslash commands
        text = re.sub(r'\\[a-zA-Z]+', '', text)
        return text

    # ── Markdown formatting ──────────────────────────────────────────────

    def _strip_markdown(self, text: str) -> str:
        """Strip markdown formatting that TTS would read literally."""
        # Bold: **text** or __text__
        text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
        text = re.sub(r'__(.+?)__', r'\1', text)
        # Orphan ** that survived (e.g., nested bold/italic like **What *are* Holes?**)
        text = text.replace('**', '')
        # Italic: *text* (not mid-word)
        text = re.sub(r'(?<!\w)\*(.+?)\*(?!\w)', r'\1', text)
        # Orphan * that survived
        text = re.sub(r'(?<!\w)\*(?!\w)', '', text)
        # Inline code: `text`
        text = re.sub(r'`(.+?)`', r'\1', text)
        # Strikethrough: ~~text~~
        text = re.sub(r'~~(.+?)~~', r'\1', text)
        # Headings: ### text
        text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
        # Links: [text](url) → text
        text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
        # Raw URLs: https://www.example.com/path → "A link is shown on screen for example.com"
        def _url_to_spoken(match):
            url = match.group(0)
            # Extract domain and speak dots
            domain_match = re.search(r'https?://(?:www\.)?([^/\s]+)', url)
            if domain_match:
                domain = domain_match.group(1).replace('.', ' dot ')
            else:
                domain = 'the link'
            return f'a link is shown on screen for {domain}'

        text = re.sub(r'https?://\S+', _url_to_spoken, text)
        # Blockquotes: > text → text
        text = re.sub(r'^>\s+', '', text, flags=re.MULTILINE)
        # Horizontal rules
        text = re.sub(r'^---+$', '', text, flags=re.MULTILINE)
        text = re.sub(r'^\*\*\*+$', '', text, flags=re.MULTILINE)
        # Trailing asterisk on names (astronomical notation: M87*, Sagittarius A*, Sgr A*)
        text = re.sub(r'(\w)\*(?=[\s,;:.\)\]!?]|$)', r'\1', text)
        return text

    # ── Markdown images ─────────────────────────────────────────────────

    def _strip_markdown_images(self, text: str) -> str:
        """Strip markdown images: ![alt text](url) → alt text."""
        # ![alt text](url) → just the alt text
        text = re.sub(r'!\[([^\]]*)\]\([^)]+\)', r'\1', text)
        # Bare ![...] without link
        text = re.sub(r'!\[([^\]]*)\]', r'\1', text)
        return text

    # ── Tables ───────────────────────────────────────────────────────────

    def _strip_tables(self, text: str) -> str:
        """Replace markdown tables with spoken summary."""
        # Detect table pattern: lines with | separators
        table_pattern = r'(?:^\|.+\|$\n?){2,}'
        text = re.sub(table_pattern, '(table omitted)\n', text, flags=re.MULTILINE)
        return text

    # ── Regex patterns ────────────────────────────────────────────────────

    def _strip_regex_patterns(self, text: str) -> str:
        """Remove regex patterns — unreadable by TTS.

        Must not match URLs (http://...) or file paths (/home/...).
        """
        # Protect URLs
        url_preserved = {}
        for url_match in re.finditer(r'https?://\S+', text):
            placeholder = f"__RXURL_{len(url_preserved)}__"
            url_preserved[placeholder] = url_match.group(0)
            text = text.replace(url_match.group(0), placeholder)

        # Protect file paths: /word/word or ~/word patterns
        path_preserved = {}
        for path_match in re.finditer(r'(?:~|(?<!\w))(?:/[\w.@-]+){2,}(?:/[\w.@-]*)?', text):
            placeholder = f"__RXPATH_{len(path_preserved)}__"
            path_preserved[placeholder] = path_match.group(0)
            text = text.replace(path_match.group(0), placeholder)

        # /pattern/flags style — only match regex-like patterns
        # Require flags or common regex chars inside to distinguish from prose
        text = re.sub(r'(?<!\w)/(?:\\.|[^/\n])+/[gimsuvy]+', '', text)
        # Also match patterns with clear regex syntax: /^...$/, /[...]/
        text = re.sub(r'(?<!\w)/(?=.*[\[\]^$\\])(?:\\.|[^/\n])+/', '', text)

        # Restore paths and URLs
        for placeholder, path in path_preserved.items():
            text = text.replace(placeholder, path)
        for placeholder, url in url_preserved.items():
            text = text.replace(placeholder, url)

        return text

    # ── Task lists ──────────────────────────────────────────────────────

    def _strip_task_lists(self, text: str) -> str:
        """Strip markdown task list checkboxes."""
        # - [x] Done → Done, - [ ] Todo → Todo (at line start)
        text = re.sub(r'^[\-\*]\s*\[\s*[xX]\s*\]\s*', '... ', text, flags=re.MULTILINE)
        text = re.sub(r'^[\-\*]\s*\[\s*\]\s*', '... ', text, flags=re.MULTILINE)
        # Inline checkboxes anywhere
        text = re.sub(r'\[\s*[xX]\s*\]', '', text)
        text = re.sub(r'\[\s*\]', '', text)
        return text

    # ── Emoji & Unicode symbols ─────────────────────────────────────────

    # Common emoji/symbols in AI responses — map to spoken or empty
    _EMOJI_MAP = {
        '\u2705': '',         # checkmark
        '\u274c': '',         # X mark
        '\u26a0': '',         # warning
        '\U0001f527': '',     # wrench
        '\U0001f41b': '',     # bug
        '\U0001f4a1': '',     # lightbulb
        '\U0001f680': '',     # rocket
        '\U0001f4dd': '',     # memo
        '\U0001f50d': '',     # magnifying glass
        '\U0001f4e6': '',     # package
        '\U0001f389': '',     # party
        '\U0001f3af': '',     # target
        '\U0001f4cc': '',     # pushpin
        '\U0001f6a8': '',     # siren
        '\U0001f512': '',     # lock
        '\U0001f513': '',     # unlock
    }

    def _strip_emoji_unicode(self, text: str) -> str:
        """Strip emoji and normalize unicode symbols to spoken form."""
        # Smart/curly quotes → straight quotes (Kokoro's phonemizer needs ASCII apostrophes)
        text = text.replace('\u2018', "'")   # left single quote
        text = text.replace('\u2019', "'")   # right single quote (used in contractions)
        text = text.replace('\u201C', '"')   # left double quote
        text = text.replace('\u201D', '"')   # right double quote

        # Known emoji → replacement (usually empty)
        for emoji, replacement in self._EMOJI_MAP.items():
            text = text.replace(emoji, replacement)

        # Arrow symbols
        text = text.replace('\u2192', ' to ')     # →
        text = text.replace('\u2190', ' from ')   # ←
        text = text.replace('\u2193', ' down to ')  # ↓
        text = text.replace('\u2191', ' up to ')    # ↑
        text = text.replace('\u21d2', ' implies ')   # ⇒

        # Math/comparison symbols
        text = text.replace('\u2265', 'greater than or equal to')  # ≥
        text = text.replace('\u2264', 'less than or equal to')     # ≤
        text = text.replace('\u2260', 'not equal to')              # ≠
        text = text.replace('\u2248', 'approximately equal to')    # ≈
        text = text.replace('\u00d7', 'times')                     # ×
        text = text.replace('\u00f7', 'divided by')                # ÷
        text = text.replace('\u00b1', 'plus or minus')             # ±
        text = text.replace('\u221e', 'infinity')                  # ∞

        # Remaining emoji — strip any unicode emoji characters
        text = re.sub(
            r'[\U0001F600-\U0001F64F'   # emoticons
            r'\U0001F300-\U0001F5FF'    # symbols & pictographs
            r'\U0001F680-\U0001F6FF'    # transport & map
            r'\U0001F1E0-\U0001F1FF'    # flags
            r'\U00002702-\U000027B0'    # dingbats
            r'\U0000FE00-\U0000FE0F'    # variation selectors
            r'\U0000200D'               # zero width joiner
            r']+', '', text
        )

        return text

    # ── Code identifiers in prose ───────────────────────────────────────

    # Known proper names that happen to be camelCase/PascalCase — don't split
    _PRESERVE_NAMES = {
        'JavaScript', 'TypeScript', 'CoffeeScript', 'ActionScript',
        'OpenAI', 'ChatGPT', 'GitHub', 'GitLab', 'BitBucket',
        'MongoDB', 'PostgreSQL', 'MySQL', 'SQLite',
        'Node.js', 'NodeJS', 'React.js', 'ReactJS', 'Vue.js', 'VueJS',
        'Angular.js', 'AngularJS', 'Next.js', 'NextJS', 'Express.js',
        'PowerShell', 'IntelliJ', 'WebSocket', 'localhost',
        'iPhone', 'iPad', 'macOS', 'iOS', 'YouTube',
        'DevOps', 'DevTools', 'webpack', 'PostCSS',
    }

    def _normalize_code_identifiers(self, text: str) -> str:
        """Convert camelCase, snake_case, PascalCase, dot.notation to spoken form."""

        # Protect URLs from dot-splitting
        url_preserved = {}
        for url_match in re.finditer(r'https?://\S+', text):
            placeholder = f"__URL_{len(url_preserved)}__"
            url_preserved[placeholder] = url_match.group(0)
            text = text.replace(url_match.group(0), placeholder)

        # Protect file paths from dot-splitting
        path_preserved = {}
        for path_match in re.finditer(r'(?:~|(?<!\w))(?:/[\w.@-]+){2,}(?:/[\w.@-]*)?', text):
            placeholder = f"__PATH_{len(path_preserved)}__"
            path_preserved[placeholder] = path_match.group(0)
            text = text.replace(path_match.group(0), placeholder)

        # Protect known proper names from splitting
        preserved = {}
        for name in self._PRESERVE_NAMES:
            if name in text:
                placeholder = f"__PRESERVE_{len(preserved)}__"
                preserved[placeholder] = name
                text = text.replace(name, placeholder)

        # camelCase and PascalCase → space-separated words
        # e.g., forEach → for each, getUserData → get user data
        def _split_camel(match):
            word = match.group(0)
            # Don't split if it's a preserved placeholder
            if word.startswith('__PRESERVE_'):
                return word
            # Split on camelCase boundaries
            parts = re.sub(r'([a-z])([A-Z])', r'\1 \2', word)
            # Split on consecutive uppercase followed by lowercase (e.g., XMLParser → XML Parser)
            parts = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', parts)
            return parts.lower()

        # Match camelCase/PascalCase identifiers (at least one case transition)
        text = re.sub(r'\b[a-z]+(?:[A-Z][a-z]+)+\b', _split_camel, text)       # camelCase
        text = re.sub(r'\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b', _split_camel, text)  # PascalCase

        # snake_case → space-separated
        # e.g., user_data → user data, get_user_by_id → get user by id
        def _split_snake(match):
            return match.group(0).replace('_', ' ')

        text = re.sub(r'\b[a-z]+(?:_[a-z]+)+\b', _split_snake, text)

        # Dot notation in method calls: array.map() → array map
        # Only match when at least one side contains a letter (avoids 9.99, 3.14)
        text = re.sub(r'([a-zA-Z_]\w*)\.(\w+)\(\)', r'\1 \2', text)
        text = re.sub(r'(\w+)\.([a-zA-Z_]\w*)\(\)', r'\1 \2', text)
        text = re.sub(r'([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)', r'\1 \2', text)

        # Restore preserved names
        for placeholder, name in preserved.items():
            text = text.replace(placeholder, name)

        # Restore URLs and file paths
        for placeholder, url in url_preserved.items():
            text = text.replace(placeholder, url)
        for placeholder, path in path_preserved.items():
            text = text.replace(placeholder, path)

        return text

    # ── Operators ───────────────────────────────────────────────────────

    def _normalize_operators(self, text: str) -> str:
        """Convert comparison and logical operators to spoken form."""
        # Order matters — longer operators first to avoid partial matches
        replacements = [
            ('===', ' strictly equals '),
            ('!==', ' strictly does not equal '),
            ('??=', ' nullish assign '),
            ('??', ' or if null '),
            ('?.', ' optional '),
            ('=>', ' arrow '),
            ('->', ' arrow '),
            ('>=', ' greater than or equal to '),
            ('<=', ' less than or equal to '),
            ('==', ' equals '),
            ('!=', ' does not equal '),
            ('&&', ' and '),
            ('||', ' or '),
        ]

        for op, spoken in replacements:
            text = text.replace(op, spoken)

        # Single > and < when surrounded by spaces (avoid HTML tags)
        text = re.sub(r'\s>\s', ' greater than ', text)
        text = re.sub(r'\s<\s', ' less than ', text)
        # > or < directly before a digit (e.g., >20, <5) — require space or line start before
        text = re.sub(r'(?<=\s)>\s*(\d)', r'greater than \1', text)
        text = re.sub(r'(?<=\s)<\s*(\d)', r'less than \1', text)
        text = re.sub(r'^>\s*(\d)', r'greater than \1', text)
        text = re.sub(r'^<\s*(\d)', r'less than \1', text)

        return text

    # ── Units of measurement ────────────────────────────────────────────

    _UNITS = {
        'GB': 'gigabytes',
        'MB': 'megabytes',
        'KB': 'kilobytes',
        'TB': 'terabytes',
        'GHz': 'gigahertz',
        'MHz': 'megahertz',
        'kHz': 'kilohertz',
        'Hz': 'hertz',
        'ms': 'milliseconds',
        'ns': 'nanoseconds',
        'Mbps': 'megabits per second',
        'Gbps': 'gigabits per second',
        'KB/s': 'kilobytes per second',
        'MB/s': 'megabytes per second',
        'GB/s': 'gigabytes per second',
    }

    def _normalize_units(self, text: str) -> str:
        """Convert unit abbreviations to spoken form: 16GB → 16 gigabytes."""
        # Sort by length descending so longer units match first (MB/s before MB)
        for unit, spoken in sorted(self._UNITS.items(), key=lambda x: -len(x[0])):
            # Match number + unit (with optional space)
            text = re.sub(
                rf'(\d+(?:\.\d+)?)\s*{re.escape(unit)}\b',
                rf'\1 {spoken}',
                text,
            )
        return text

    # ── Percentages ─────────────────────────────────────────────────────

    def _normalize_percentages(self, text: str) -> str:
        """100% → 100 percent."""
        text = re.sub(r'(\d+(?:\.\d+)?)\s*%', r'\1 percent', text)
        return text

    # ── Multipliers ─────────────────────────────────────────────────────

    def _normalize_multipliers(self, text: str) -> str:
        """2x faster → 2 times faster, 10x → 10 times."""
        # Nx followed by adjective
        text = re.sub(
            r'(\d+)x\s+(faster|slower|larger|bigger|smaller|more|less|better|worse|cheaper|higher|lower)',
            r'\1 times \2',
            text, flags=re.IGNORECASE,
        )
        # Standalone Nx
        text = re.sub(r'(\d+)x\b', r'\1 times', text)
        return text

    # ── Numbered references ─────────────────────────────────────────────

    def _strip_numbered_refs(self, text: str) -> str:
        """Strip citation-style references: [1], [2], [source 3]."""
        text = re.sub(r'\[\d+\]', '', text)
        text = re.sub(r'\[source\s+\d+\]', '', text, flags=re.IGNORECASE)
        # Clean orphan whitespace before punctuation left by stripping
        text = re.sub(r'\s+([,.\;:!?])', r'\1', text)
        return text

    # ── Repeated punctuation ────────────────────────────────────────────

    def _normalize_repeated_punctuation(self, text: str) -> str:
        """!!! → !, ??? → ?"""
        text = re.sub(r'!{2,}', '!', text)
        text = re.sub(r'\?{2,}', '?', text)
        return text

    # ── Lists ────────────────────────────────────────────────────────────

    _ORDINALS = {
        1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', 5: 'Fifth',
        6: 'Sixth', 7: 'Seventh', 8: 'Eighth', 9: 'Ninth', 10: 'Tenth',
    }

    def _normalize_numbered_lists(self, text: str) -> str:
        """Context-aware numbered list reading.

        If preceding text mentions steps/instructions → 'Step one...'
        Otherwise → 'First...', 'Second...', etc.
        """
        # Detect if this is a steps/instructions context
        # Match at end of line (section headers) or as leading phrase before a colon
        steps_pattern = re.compile(
            r'(?:'
            r'steps?|instructions?|procedure|how to|follow(?:ing)?'
            r'|here\'?s how|what to do|to do this|to accomplish'
            r'|what you need|to get started|to set up|to install'
            r'|to configure|to create|to build|to fix|to resolve'
            r')(?:\s+\w+)*\s*[:.]',
            re.IGNORECASE,
        )
        is_steps = bool(steps_pattern.search(text))

        def _numbered(match):
            num = int(match.group(1))
            content = match.group(2)
            if is_steps:
                return f"Step {num}. {content}"
            elif num in self._ORDINALS:
                ordinal = self._ORDINALS[num]
                # Avoid stutter: "4. Fourth item" → "Fourth. item" not "Fourth. Fourth item"
                if content.lower().startswith(ordinal.lower()):
                    content = content[len(ordinal):].lstrip()
                return f"{ordinal}. {content}"
            else:
                return f"Number {num}. {content}"

        text = re.sub(r'^(\d{1,3})\.\s+(.+)$', _numbered, text, flags=re.MULTILINE)

        # Bare numbered items (e.g., "1." isolated from content by SpeechChunker)
        def _bare_numbered(match):
            num = int(match.group(1))
            if num in self._ORDINALS:
                return f"{self._ORDINALS[num]}."
            return f"Number {num}."

        text = re.sub(r'^(\d{1,3})\.\s*$', _bare_numbered, text, flags=re.MULTILINE)
        return text

    def _normalize_bullet_lists(self, text: str) -> str:
        """Strip bullet markers, add pause."""
        text = re.sub(r'^[\-\*]\s+', '... ', text, flags=re.MULTILINE)
        return text

    # ── Pauses / punctuation ─────────────────────────────────────────────

    def _normalize_pauses(self, text: str) -> str:
        """Convert punctuation patterns to natural speech pauses."""
        # Colon at end of line (section headers) → pause
        text = re.sub(r':\s*\n', '...\n', text)
        # Label: Sentence (short label followed by capital letter) → pause for breathing room
        text = re.sub(r':\s+(?=[A-Z])', '... ', text)
        # Colon mid-sentence (other cases) → comma for natural flow
        text = re.sub(r':\s+', ', ', text)
        # En-dash between digits: 3–5 → "3 to 5" (ranges)
        text = re.sub(r'(\d)\s*–\s*(\d)', r'\1 to \2', text)
        # Em-dash style: " - " and "—" → pause
        text = text.replace(" - ", "... ")
        text = text.replace("—", "... ")
        # Remaining en-dashes (non-numeric) → pause
        text = text.replace("–", "... ")
        # Multiple newlines → single pause
        text = re.sub(r'\n{2,}', '\n... ', text)
        return text

    # ── Currency ─────────────────────────────────────────────────────────

    def _normalize_currency(self, text: str) -> str:
        """$120K → 120 thousand dollars, $3.8 billion → 3.8 billion dollars."""
        # $NNK → N thousand dollars
        text = re.sub(
            r'\$(\d+(?:,\d{3})*)K\b',
            lambda m: f"{m.group(1).replace(',', '')} thousand dollars",
            text, flags=re.IGNORECASE,
        )
        # $N.N billion/million
        text = re.sub(
            r'\$([\d.]+)\s*(billion|million|trillion)',
            r'\1 \2 dollars',
            text, flags=re.IGNORECASE,
        )
        # $NNN.NN → N dollars and NN cents (MUST be before whole-dollar pattern)
        text = re.sub(
            r'\$(\d+)\.(\d{2})\b',
            lambda m: f"{m.group(1)} dollars and {m.group(2)} cents",
            text,
        )
        # $NNN.N → N point N dollars (non-standard cents like $9.9)
        text = re.sub(
            r'\$(\d+)\.(\d)\b',
            lambda m: f"{m.group(1)} point {m.group(2)} dollars",
            text,
        )
        # $NNN → N dollars (whole dollars only — no decimal following)
        text = re.sub(r'\$(\d+(?:,\d{3})*)(?!\.\d)', r'\1 dollars', text)
        return text

    # ── Decimals ─────────────────────────────────────────────────────────

    def _normalize_decimals(self, text: str) -> str:
        """30.1 → thirty point one. Preserves version-like patterns."""
        # Skip if already processed (contains "dollars", "cents", "percent", etc.)
        # Only match N.N where it's a standalone decimal, not part of a chain (a.b.c)
        def _decimal_replace(match):
            whole = match.group(1)
            frac = match.group(2)
            return f"{whole} point {frac}"

        # Match decimals that are NOT:
        # - Part of version chains (followed by .digit)
        # - Part of IP addresses (preceded by digit.)
        # - Already handled by currency (preceded by $)
        text = re.sub(
            r'(?<!\.)(?<!\$)(\d+)\.(\d+)(?!\.)',
            _decimal_replace,
            text,
        )
        return text

    # ── Fractions ─────────────────────────────────────────────────────────

    def _normalize_fractions(self, text: str) -> str:
        """Simple fractions: 1/2 → one half, 3/4 → three quarters."""
        fraction_words = {
            "1/2": "one half",
            "1/3": "one third",
            "2/3": "two thirds",
            "1/4": "one quarter",
            "3/4": "three quarters",
        }
        for frac, spoken in fraction_words.items():
            text = text.replace(frac, spoken)
        return text

    # ── Word slashes ─────────────────────────────────────────────────────

    def _normalize_word_slashes(self, text: str) -> str:
        """Convert word/word slashes to 'or': consent/authorization → consent or authorization.

        Only matches alphabetic words separated by slashes — not paths, URLs,
        fractions, or units (KB/s already handled by _normalize_units).
        """
        # Protect URLs
        url_preserved: dict[str, str] = {}
        for url_match in re.finditer(r'https?://\S+', text):
            placeholder = f"__SLASHURL_{len(url_preserved)}__"
            url_preserved[placeholder] = url_match.group(0)
            text = text.replace(url_match.group(0), placeholder)

        # Protect file paths: /word/word or ~/word patterns
        path_preserved: dict[str, str] = {}
        for path_match in re.finditer(r'(?:~|(?<!\w))(?:/[\w.@-]+){2,}(?:/[\w.@-]*)?', text):
            placeholder = f"__SLASHPATH_{len(path_preserved)}__"
            path_preserved[placeholder] = path_match.group(0)
            text = text.replace(path_match.group(0), placeholder)

        # Match word/word patterns: 2+ alpha words (3+ chars each) separated by /
        text = re.sub(
            r'\b([a-zA-Z]{2,})/([a-zA-Z]{2,}(?:/[a-zA-Z]{2,})*)\b',
            lambda m: m.group(0).replace('/', ' or '),
            text,
        )

        # Restore paths and URLs
        for placeholder, original in path_preserved.items():
            text = text.replace(placeholder, original)
        for placeholder, original in url_preserved.items():
            text = text.replace(placeholder, original)

        return text

    # ── Parenthetical acronyms ─────────────────────────────────────────

    def _strip_parenthetical_acronyms(self, text: str) -> str:
        """Strip redundant acronyms in parentheses after the full phrase.
        'miles per gallon (MPG)' → 'miles per gallon'
        """
        # Match "phrase (ACRONYM)" or "phrase (ACRONYMs)" — optional trailing lowercase
        text = re.sub(r'\s*\([A-Z]{2,5}s?\)', '', text)
        return text

    # ── Acronym expansion ────────────────────────────────────────────────

    # Common acronyms that should be spoken as full words or spelled out.
    # Organized by domain — all shipped to all users (no conflicting entries).
    _ACRONYMS = {
        # ── Units / measurements ──
        'MPG': 'miles per gallon',
        'MPH': 'miles per hour',
        'RPM': 'revolutions per minute',

        # ── Hardware / infrastructure ──
        'CPU': 'C P U',
        'GPU': 'G P U',
        'RAM': 'ram',
        'ROM': 'rom',
        'SSD': 'S S D',
        'HDD': 'hard drive',
        'USB': 'U S B',
        'HDMI': 'H D M I',
        'BIOS': 'bye-ose',
        'SCSI': 'scuzzy',
        'NIC': 'nick',
        'UPS': 'U P S',
        'PSU': 'P S U',
        'VRAM': 'V ram',

        # ── Web / networking ──
        'API': 'A P I',
        'URL': 'U R L',
        'HTML': 'H T M L',
        'CSS': 'C S S',
        'HTTP': 'H T T P',
        'HTTPS': 'H T T P S',
        'DNS': 'D N S',
        'TCP': 'T C P',
        'UDP': 'U D P',
        'IP': 'I P',
        'SSH': 'S S H',
        'SSL': 'S S L',
        'TLS': 'T L S',
        'FTP': 'F T P',
        'SMTP': 'S M T P',
        'IMAP': 'eye-map',
        'CORS': 'cores',
        'REST': 'rest',
        'CRUD': 'crud',
        'AJAX': 'ay-jacks',
        'OAuth': 'oh-auth',
        'NGINX': 'engine-x',
        'CDN': 'C D N',
        'VPN': 'V P N',
        'WiFi': 'why-fie',
        'LAN': 'lan',
        'WAN': 'wan',
        'NAT': 'nat',
        'DHCP': 'D H C P',

        # ── Data formats / languages ──
        'SQL': 'sequel',
        'JSON': 'jason',
        'YAML': 'yamel',
        'TOML': 'tom-ul',
        'XML': 'X M L',
        'CSV': 'C S V',
        'PDF': 'P D F',
        'SVG': 'S V G',
        'PNG': 'ping',
        'JPEG': 'jay-peg',
        'GIF': 'gif',
        'REGEX': 'rej-ecks',
        'UUID': 'U U I D',
        'GUID': 'gwid',
        'SAML': 'sam-ul',
        'LDAP': 'L dap',
        'JWT': 'J W T',

        # ── Dev tools / concepts ──
        'AI': 'A I',
        'ML': 'M L',
        'LLM': 'L L M',
        'NLP': 'N L P',
        'TTS': 'T T S',
        'STT': 'S T T',
        'VAD': 'V A D',
        'IDE': 'I D E',
        'CLI': 'C L I',
        'GUI': 'gooey',
        'SDK': 'S D K',
        'NPM': 'N P M',
        'OS': 'O S',
        'FAQ': 'F A Q',
        'ETA': 'E T A',
        'ORM': 'O R M',
        'WYSIWYG': 'wiz-ee-wig',
        'FIFO': 'fye-foe',
        'LIFO': 'lye-foe',
        'ENUM': 'ee-num',
        'CRON': 'kron',
        'POSIX': 'pah-zicks',
        'GNU': 'guh-new',
        'IEEE': 'eye-triple-ee',
        'K8s': 'kates',
        'STDIN': 'standard in',
        'STDOUT': 'standard out',
        'STDERR': 'standard error',

        # ── Cloud / services ──
        'AWS': 'A W S',
        'GCP': 'G C P',
        'SaaS': 'sass',
        'PaaS': 'pass',
        'IaaS': 'eye-az',
        'VM': 'V M',
        'VPS': 'V P S',
        'EC2': 'E C 2',
        'S3': 'S 3',
        'CI': 'C I',
        'CD': 'C D',

        # ── Cybersecurity ──
        'SIEM': 'seem',
        'SOC': 'sock',
        'OSINT': 'oh-sint',
        'CVE': 'C V E',
        'NIST': 'nist',
        'OWASP': 'oh-wasp',
        'MITRE': 'my-ter',
        'APT': 'A P T',
        'IOC': 'I O C',
        'IDS': 'I D S',
        'IPS': 'I P S',
        'WAF': 'waf',
        'EDR': 'E D R',
        'XDR': 'X D R',
        'MDR': 'M D R',
        'SOAR': 'soar',
        'IAM': 'I A M',
        'MFA': 'M F A',
        'SSO': 'S S O',
        'RBAC': 'are-back',
        'SBOM': 'S bomb',
        'DAST': 'dast',
        'SAST': 'sast',
        'CTF': 'C T F',
        'IOT': 'I O T',
        'OT': 'O T',
        'SCADA': 'skay-dah',
        'PKI': 'P K I',
        'HSM': 'H S M',
        'DLP': 'D L P',
        'TTPs': 'T T Ps',
        'ZTNA': 'Z T N A',

        # ── Healthcare / medical ──
        'HIPAA': 'hip-ah',
        'PHI': 'P H I',
        'EMR': 'E M R',
        'EHR': 'E H R',
        'SOAP': 'soap',
        'ICD': 'I C D',
        'CPT': 'C P T',
        'HL7': 'H L 7',
        'FHIR': 'fire',
        'PRN': 'P R N',
        'BID': 'B I D',
        'TID': 'T I D',
        'QID': 'Q I D',
        'NPO': 'N P O',
        'DNR': 'D N R',
        'NICU': 'nick-you',
        'ICU': 'I C U',
        'ED': 'E D',
        'ER': 'E R',
        'CABG': 'cabbage',
        'HEENT': 'heent',
        'SOB': 'S O B',
        'ABG': 'A B G',
        'CBC': 'C B C',
        'BMP': 'B M P',
        'CMP': 'C M P',
        'WBC': 'W B C',
        'RBC': 'R B C',
        'EKG': 'E K G',
        'ECG': 'E C G',
        'EEG': 'E E G',
        'MRI': 'M R I',
        'CT': 'C T',
        'PCP': 'P C P',
        'BMI': 'B M I',
        'UTI': 'U T I',
        'DVT': 'D V T',
        'PE': 'P E',
        'SSRI': 'S S R I',
        'NSAID': 'en-said',
        'COPD': 'C O P D',
    }

    def _expand_acronyms(self, text: str) -> str:
        """Expand standalone acronyms to spoken form."""
        for acronym, spoken in self._ACRONYMS.items():
            # Only match standalone (word boundaries), case-sensitive
            text = re.sub(rf'\b{re.escape(acronym)}\b', spoken, text)
        return text

    # ── Version numbers ────────────────────────────────────────────────

    def _normalize_version_numbers(self, text: str) -> str:
        """Normalize version strings: v3.2.1 → version 3 dot 2 dot 1.

        Runs before decimal normalizer to protect dotted chains from
        being converted to 'point' notation.
        """
        # Semver prefixes FIRST: ^2.0.0 → caret 2 dot 0 dot 0, ~1.5.0 → tilde 1 dot 5 dot 0
        def _semver_prefix(match):
            prefix = 'caret' if match.group(1) == '^' else 'tilde'
            numbers = match.group(2).replace('.', ' dot ')
            return f"{prefix} {numbers}"

        text = re.sub(
            r'([~^])(\d+\.\d+(?:\.\d+)*)',
            _semver_prefix,
            text,
        )

        # v1.2.3, v1.2.3-beta.1, v1.2.3-rc2
        def _version_replace(match):
            prefix = match.group(1) or ""  # 'v' or 'version ' or ''
            numbers = match.group(2)       # '3.2.1'
            suffix = match.group(3) or ""  # '-beta.1' etc.

            # "v" or "V" → "version", "version X" → "version"
            if prefix.lower().strip() in ('v', 'version'):
                spoken = "version "
            elif prefix:
                spoken = prefix
            else:
                spoken = ""

            # Dots in version → "dot"
            spoken += numbers.replace('.', ' dot ')

            # Handle suffixes: -beta.1 → beta 1, -rc2 → R C 2
            if suffix:
                suffix = suffix.lstrip('-')
                suffix = suffix.replace('.', ' ')
                # rc/alpha/beta are words; standalone letters get spaced
                suffix = re.sub(r'\b(rc)(\d+)', r'R C \2', suffix, flags=re.IGNORECASE)
                spoken += " " + suffix

            return spoken

        # Match: optional v/version prefix, dotted number chain (2+ segments), optional suffix
        text = re.sub(
            r'\b(v(?:ersion\s+)?)?(\d+\.\d+(?:\.\d+)+)([-][a-zA-Z][a-zA-Z0-9.]*)?',
            _version_replace,
            text,
            flags=re.IGNORECASE,
        )

        # Simple v-prefix versions: v2.0, v3.12, v18.x (two segments or .x)
        def _simple_version(match):
            prefix = match.group(1)
            numbers = match.group(2)
            spoken = "version " if prefix.lower().startswith('v') else prefix
            spoken += numbers.replace('.', ' dot ')
            return spoken

        text = re.sub(
            r'\b(v(?:ersion\s+)?)(\d+\.(?:\d+|x))\b',
            _simple_version,
            text,
            flags=re.IGNORECASE,
        )

        # Tool/language name followed by version: Python 3.12, Node 22.1
        _tools = r'(?:Python|Node|Ruby|Java|PHP|Perl|Go|Rust|Swift|Kotlin|Dart|Elixir|React|Angular|Vue|Django|Rails|Flask|Express|Electron)'
        text = re.sub(
            rf'({_tools})\s+(\d+\.(?:\d+|x))',
            lambda m: f"{m.group(1)} {m.group(2).replace('.', ' dot ')}",
            text,
        )

        # Standalone N.x patterns not caught above: 18.x, 3.x
        text = re.sub(
            r'(\d+)\.x\b',
            r'\1 dot x',
            text,
        )

        return text

    # ── IP addresses ───────────────────────────────────────────────────

    _DIGIT_WORDS = {
        '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
        '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    }

    def _normalize_ip_addresses(self, text: str) -> str:
        """Normalize IPv4 addresses: 192.168.1.100 → one nine two dot one six eight dot one dot one hundred.

        Reads each octet digit-by-digit, except round hundreds (100, 200)
        which are spoken as words. Runs before version normalizer to prevent
        IPs being treated as version chains.
        """
        ipv4_pattern = r'\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b'

        def _ip_to_spoken(match):
            ip = match.group(0)
            parts = ip.split('.')
            spoken_parts = []
            for part in parts:
                if part in ('100', '200'):
                    spoken_parts.append('one hundred' if part == '100' else 'two hundred')
                else:
                    spoken_parts.append(' '.join(self._DIGIT_WORDS[d] for d in part))
            return ' dot '.join(spoken_parts)

        # Also handle IP:port — speak port separately
        def _ip_port_to_spoken(match):
            ip_spoken = _ip_to_spoken(type('M', (), {'group': lambda s, n=0: match.group(1)})())
            port = match.group(2)
            return f"{ip_spoken} port {port}"

        text = re.sub(
            rf'({ipv4_pattern}):(\d+)',
            _ip_port_to_spoken,
            text,
        )
        text = re.sub(ipv4_pattern, _ip_to_spoken, text)
        return text

    # ── Clock times ───────────────────────────────────────────────────

    def _normalize_clock_times(self, text: str) -> str:
        """Protect clock times from colon normalization.

        14:30 → 14 30, 14:30:05 → 14 30 05.
        Must run before pause normalizer which converts colons.
        """
        # HH:MM:SS
        text = re.sub(
            r'\b(\d{1,2}):(\d{2}):(\d{2})\b',
            r'\1 \2 \3',
            text,
        )
        # HH:MM
        text = re.sub(
            r'\b(\d{1,2}):(\d{2})\b',
            r'\1 \2',
            text,
        )
        return text

    # ── Keyboard shortcuts ────────────────────────────────────────────

    def _normalize_keyboard_shortcuts(self, text: str) -> str:
        """Normalize keyboard shortcuts: Ctrl+Shift+P → Control Shift P."""
        key_map = {
            'Ctrl': 'Control',
            'Cmd': 'Command',
            'Alt': 'Alt',
            'Shift': 'Shift',
            'Meta': 'Meta',
            'Esc': 'Escape',
            'Del': 'Delete',
            'Ins': 'Insert',
            'Tab': 'Tab',
            'Enter': 'Enter',
            'Backspace': 'Backspace',
        }

        def _shortcut_replace(match):
            keys = match.group(0).split('+')
            spoken = []
            for key in keys:
                spoken.append(key_map.get(key, key))
            return ' '.join(spoken)

        # Match modifier+key patterns: Ctrl+Shift+P, Cmd+C, Alt+Tab
        modifier_pattern = '|'.join(re.escape(k) for k in key_map.keys())
        text = re.sub(
            rf'(?:{modifier_pattern})(?:\+\w+)+',
            _shortcut_replace,
            text,
        )
        return text

    # ── CLI command dictation ─────────────────────────────────────────

    # Common CLI command prefixes for detection
    # CLI commands for dictation detection.
    # EXCLUDES common English words (go, make, cat, rm, cp, mv, ln) that
    # cause false positives in AI prose responses.
    _CLI_COMMANDS = {
        'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'pipx',
        'git', 'gh', 'curl', 'wget', 'docker', 'kubectl',
        'cargo', 'rustup', 'brew', 'apt', 'apt-get', 'yum', 'dnf',
        'python', 'python3', 'deno', 'bun',
        'cmake', 'mvn', 'gradle',
        'ssh', 'scp', 'rsync', 'chmod', 'chown',
        'mkdir', 'grep', 'sed', 'awk',
        'systemctl', 'journalctl', 'sudo',
    }

    def _normalize_cli_commands(self, text: str) -> str:
        """Detect CLI commands and apply dictation mode for complex ones.

        Plain commands (no flags/special chars) read normally.
        Complex commands (with flags, pipes, redirects) get character-aware dictation.
        """
        # Build command prefix pattern
        cmd_prefix = '|'.join(re.escape(c) for c in sorted(self._CLI_COMMANDS, key=len, reverse=True))

        def _dictate_command(match):
            cmd = match.group(0).strip()

            # If no flags or special characters, read normally
            has_flags = bool(re.search(r'\s--?\w', cmd))
            has_special = bool(re.search(r'[|><"\'`$]', cmd))

            if not has_flags and not has_special:
                return cmd

            # Complex command — dictation mode
            parts = []
            tokens = cmd.split(' ')
            for i, token in enumerate(tokens):
                if i > 0:
                    parts.append('space')

                if token.startswith('--'):
                    # Long flag: --save-dev → "double dash save dash dev"
                    flag_name = token[2:]
                    spoken_flag = flag_name.replace('-', ', dash, ')
                    parts.append(f'double dash, {spoken_flag}')
                elif token.startswith('-') and len(token) > 1 and not token[1:].isdigit():
                    # Short flag: -m → "dash M", -rf → "dash R F"
                    flag_chars = token[1:]
                    if len(flag_chars) == 1:
                        char_desc = f'capital {flag_chars.upper()}' if flag_chars.isupper() else flag_chars
                        parts.append(f'dash, {char_desc}')
                    else:
                        # Multiple short flags: -rf → "dash R F"
                        spaced = ' '.join(c.upper() for c in flag_chars)
                        parts.append(f'dash, {spaced}')
                elif token.startswith('"') or token.startswith("'"):
                    # Quoted string
                    quote_type = 'double quote' if token.startswith('"') else 'single quote'
                    inner = token.strip('"').strip("'")
                    # Check if closing quote is in same token
                    if token.endswith('"') or token.endswith("'"):
                        parts.append(f'open {quote_type}, {inner}, close {quote_type}')
                    else:
                        parts.append(f'open {quote_type}, {inner}')
                elif token.endswith('"') or token.endswith("'"):
                    quote_type = 'double quote' if token.endswith('"') else 'single quote'
                    inner = token.strip('"').strip("'")
                    parts.append(f'{inner}, close {quote_type}')
                elif token == '|':
                    parts.append('pipe')
                elif token == '>':
                    parts.append('redirect to')
                elif token == '>>':
                    parts.append('append to')
                elif token == '<':
                    parts.append('redirect from')
                elif token == '&&':
                    parts.append('and then')
                elif token == '||':
                    parts.append('or else')
                elif '@' in token and not token.startswith('@'):
                    # Package@version: express@4.x → "express at 4 dot x"
                    pkg, ver = token.split('@', 1)
                    ver_spoken = ver.replace('.', ' dot ')
                    parts.append(f'{pkg}, at, {ver_spoken}')
                elif token.isupper() and token.isalpha() and len(token) > 1:
                    # All-caps words: POST, GET, HEAD → "capital POST"
                    parts.append(f'capital {token}')
                else:
                    parts.append(token)

            return ', '.join(parts)

        # Match: known command prefix followed by arguments
        # Stop at natural sentence boundaries (period+space, comma+space after non-flag)
        # to avoid over-dictating into surrounding prose
        def _find_and_dictate(match):
            cmd_name = match.group(1)
            args = match.group(2)

            # Find where the command ends and prose begins
            # A command ends before prose words that aren't part of commands
            prose_boundary = re.search(
                r'\s+(?:to|and then|for|if|when|that|which|before|after|so|but)\s+(?![/-])',
                args,
            )
            if prose_boundary:
                cmd_part = cmd_name + ' ' + args[:prose_boundary.start()].strip()
                prose_part = args[prose_boundary.start():]
                # Create a simple object with group() method for _dictate_command
                class FakeMatch:
                    def group(self, n=0):
                        return cmd_part
                return _dictate_command(FakeMatch()) + prose_part
            return _dictate_command(match)

        text = re.sub(
            rf'(?<!\w)({cmd_prefix})\s+([^\n]+)',
            _find_and_dictate,
            text,
        )

        return text

    # ── HTML tags ─────────────────────────────────────────────────────

    # Common HTML tags that should be named when spoken
    _HTML_TAG_NAMES = {
        'div', 'span', 'p', 'a', 'img', 'br', 'hr',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'table', 'tr', 'td', 'th',
        'form', 'input', 'button', 'select', 'option', 'textarea',
        'header', 'footer', 'nav', 'main', 'section', 'article', 'aside',
        'script', 'style', 'link', 'meta', 'head', 'body', 'html',
        'pre', 'code', 'blockquote', 'em', 'strong', 'b', 'i', 'u',
        'video', 'audio', 'canvas', 'svg', 'iframe',
    }

    def _normalize_html(self, text: str) -> str:
        """Normalize HTML tags in prose.

        Simple/short HTML (< 5 lines): open/close tag names spoken.
        Complex HTML blocks (>= 5 lines): replaced with description.
        """
        # First: detect multi-line HTML blocks (5+ lines of tag-heavy content)
        def _html_block_replacement(match):
            return "... An H T M L example is shown on screen. ..."

        # Match blocks of 5+ consecutive lines that start with or contain HTML tags
        text = re.sub(
            r'(?:^[ \t]*<[^>]+>.*$\n?){5,}',
            _html_block_replacement,
            text,
            flags=re.MULTILINE,
        )

        # Self-closing tags: <br/>, <hr/>, <img .../> → "line break", "horizontal rule", "image tag"
        self_closing_spoken = {
            'br': 'line break',
            'hr': 'horizontal rule',
            'img': 'image tag',
        }
        for tag, spoken in self_closing_spoken.items():
            text = re.sub(rf'<{tag}\s*[^>]*/?\s*>', spoken, text, flags=re.IGNORECASE)

        # Closing tags: </div> → "closing div"
        def _closing_tag(match):
            tag_name = match.group(1).lower()
            if tag_name in self._HTML_TAG_NAMES:
                return f"closing {tag_name}"
            return ""

        text = re.sub(r'</(\w+)\s*>', _closing_tag, text)

        # Opening tags with attributes: <div class="foo"> → "div"
        # Opening tags without attributes: <div> → "div"
        def _opening_tag(match):
            tag_name = match.group(1).lower()
            if tag_name in self._HTML_TAG_NAMES:
                return tag_name
            return ""

        text = re.sub(r'<(\w+)(?:\s+[^>]*)?\s*>', _opening_tag, text)

        return text

    # ── Diff / patch format ───────────────────────────────────────────

    def _strip_diff_blocks(self, text: str) -> str:
        """Replace diff/patch format with spoken description.

        Diffs are inherently visual — replace with description.
        """
        # Unified diff blocks: --- a/file or +++ b/file followed by @@ markers
        # Requires a path after --- or +++ ON THE SAME LINE (no newline crossing)
        text = re.sub(
            r'(?:^(?:---[^\S\n]+[a-zA-Z/]|[+]{3}[^\S\n]+[a-zA-Z/]|@@\s).*$\n?)+(?:^[+\- ].*$\n?)*',
            '... A code diff is shown on screen. ...\n',
            text,
            flags=re.MULTILINE,
        )

        # Standalone @@ markers
        text = re.sub(r'@@\s[^@]+@@', '', text)

        return text

    # ── Heteronyms ─────────────────────────────────────────────────────────

    def _normalize_heteronyms(self, text: str) -> str:
        """Fix words TTS mispronounces due to ambiguous spelling.

        Uses surrounding context to determine pronunciation, then respells
        the word phonetically so Kokoro reads it correctly.

        Reference: internal voice pipeline heteronym pattern.
        """
        # ── read: present "reed" vs past "red" ──
        # After modal verbs or "to" → present tense (reed)
        text = re.sub(
            r'\b(can|will|could|should|may|might|to|please|must|shall)\s+read\b',
            r'\1 reed',
            text, flags=re.IGNORECASE,
        )
        # "Read the..." at sentence start → imperative (present tense)
        # Only match at start of line/string to avoid catching past tense mid-sentence
        text = re.sub(
            r'(?:^|(?<=\.\s)|(?<=\n))Read\s+(the|a|an|this|that|these|those|it|my|your|our)\b',
            r'Reed \1',
            text,
        )

        # ── live: adjective "lyve" vs verb "liv" ──
        # "live server/stream/demo/preview/reload/data/update" → adjective (lyve)
        text = re.sub(
            r'\blive\s+(server|stream|streaming|demo|preview|reload|reloading|data|update|updates|event|events|feed|view|coding|session|environment)\b',
            r'lyve \1',
            text, flags=re.IGNORECASE,
        )
        # "go live" / "is live" / "went live" / "now live" → adjective (lyve)
        text = re.sub(
            r'\b(go|goes|going|went|is|are|was|were|now|gone)\s+live\b',
            r'\1 lyve',
            text, flags=re.IGNORECASE,
        )

        # ── close: verb "kloze" vs adjective "kloce" ──
        # "close the/a/this" / "close it" → verb (kloze) — Kokoro default is fine
        # "close to" / "close enough" → adjective (kloce)
        text = re.sub(
            r'\bclose\s+(to|enough|together|behind|by)\b',
            r'kloce \1',
            text, flags=re.IGNORECASE,
        )

        # ── lead: noun "led" vs verb "leed" ──
        # "lead developer/engineer/architect/role/position" → noun/adjective (leed)
        text = re.sub(
            r'\blead\s+(developer|engineer|architect|designer|role|position|maintainer|author)\b',
            r'leed \1',
            text, flags=re.IGNORECASE,
        )
        # "take the lead" / "in the lead" → noun (leed)
        text = re.sub(
            r'\b(the|a|take|took|in)\s+lead\b',
            r'\1 leed',
            text, flags=re.IGNORECASE,
        )

        # ── present: noun/adj "PREH-zent" vs verb "preh-ZENT" ──
        # "present tense/day/time/state/value" → adjective (default pronunciation fine)
        # "present the/a/your/our" → verb (preh-ZENT)
        text = re.sub(
            r'\bpresent\s+(the|a|an|your|our|my|this|their|it)\b',
            r'preh-zent \1',
            text, flags=re.IGNORECASE,
        )

        # ── minute: time "MIN-it" vs adjective "my-NEWT" ──
        # "minute detail/difference/change/amount" → adjective (my-newt)
        text = re.sub(
            r'\bminute\s+(detail|details|difference|differences|change|changes|amount|amounts|variation|variations|adjustment|adjustments)\b',
            r'my-newt \1',
            text, flags=re.IGNORECASE,
        )

        return text

    # ── Tilde as approximately ────────────────────────────────────────────

    def _normalize_tilde_approx(self, text: str) -> str:
        """~100ms → approximately 100ms, ~2x → approximately 2x."""
        text = re.sub(r'~(\d)', r'approximately \1', text)
        return text

    # ── Time durations ────────────────────────────────────────────────────

    def _normalize_time_durations(self, text: str) -> str:
        """Normalize time durations: 2h 30m → 2 hours 30 minutes."""
        # Hours + minutes: 2h 30m, 2h30m
        text = re.sub(r'(\d+)h\s*(\d+)m\b', r'\1 hours \2 minutes', text)
        # Standalone hours: 2h, 24h
        text = re.sub(r'(\d+)h\b', r'\1 hours', text)
        # Standalone minutes: 30m, 5m (but not 16m as in "16MB" — require space/end after)
        text = re.sub(r'(\d+)m(?=\s|$|[,.])', r'\1 minutes', text)
        # Standalone seconds: 30s, 5s
        text = re.sub(r'(\d+)s(?=\s|$|[,.])', r'\1 seconds', text)
        return text

    # ── Abbreviations ─────────────────────────────────────────────────────

    # Common abbreviations in AI responses → spoken form
    # Order matters: longer patterns first to avoid partial matches
    _ABBREVIATIONS = [
        (r'\bet\s+al\.', 'and others'),
        (r'\be\.g\.', 'for example'),
        (r'\bi\.e\.', 'that is'),
        (r'\bcf\.', 'compare'),
        (r'\bvs\.', 'versus'),
        (r'\bapprox\.', 'approximately'),
        (r'\betc\.', 'etcetera'),
        (r'\bdept\.', 'department'),
        (r'\bgovt\.', 'government'),
        (r'\bincl\.', 'including'),
        (r'\bw/o\b', 'without'),
        (r'\bw/(?=\s)', 'with'),
        (r'\bmin\.', 'minimum'),
        (r'\bmax\.', 'maximum'),
        (r'\bavg\.', 'average'),
        (r'\bnum\.', 'number'),
        (r'\bconfig\.', 'config'),
        (r'\bdoc(?:s)?\.(?=\s|$)', 'docs'),
    ]

    def _normalize_abbreviations(self, text: str) -> str:
        """Expand common abbreviations to spoken form."""
        for pattern, spoken in self._ABBREVIATIONS:
            text = re.sub(pattern, spoken, text, flags=re.IGNORECASE)
        return text

    # ── Email addresses ───────────────────────────────────────────────────

    def _normalize_email_addresses(self, text: str) -> str:
        """Normalize email addresses: user@example.com → user at example dot com."""
        def _email_replace(match):
            local = match.group(1)
            domain = match.group(2)
            # Split domain on dots
            domain_parts = domain.split('.')
            spoken_domain = ' dot '.join(domain_parts)
            return f"{local} at {spoken_domain}"

        text = re.sub(
            r'([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})',
            _email_replace,
            text,
        )
        return text

    # ── Inline JSON / YAML ────────────────────────────────────────────────

    def _strip_inline_json_yaml(self, text: str) -> str:
        """Replace inline JSON/YAML snippets with spoken description.

        Short key-value mentions stay readable. Complex objects/arrays
        get replaced with a description.
        """
        # Multi-line or complex JSON objects: { ... } spanning multiple keys
        # Match braces with at least one colon inside (key: value)
        def _json_replacement(match):
            content = match.group(0)
            # Count commas to estimate complexity
            if content.count(',') >= 2 or '\n' in content:
                return 'a jason snippet'
            # Simple single key-value: {"key": "value"} → keep readable
            # Strip the braces and quotes for speech
            inner = content.strip('{}').strip()
            inner = inner.replace('"', '').replace("'", '')
            return inner

        # Match JSON-like objects: { ... } with quoted keys
        text = re.sub(
            r'\{[^{}]*"[^{}]*"[^{}]*:[^{}]*\}',
            _json_replacement,
            text,
        )

        # JSON arrays in prose: ["a", "b", "c"]
        text = re.sub(
            r'\[[^\[\]]*"[^\[\]]*"[^\[\]]*\]',
            lambda m: 'a jason array' if m.group(0).count(',') >= 2 else m.group(0).replace('"', '').replace("'", ''),
            text,
        )

        # YAML-like inline: key: value patterns that look like config
        # Only match if it looks like a YAML block (multiple key: value lines)
        text = re.sub(
            r'(?:^[a-zA-Z_]\w*:\s+.+$\n){3,}',
            'a configuration snippet is shown.\n',
            text,
            flags=re.MULTILINE,
        )

        return text

    # ── Parenthetical prosody ─────────────────────────────────────────────

    def _normalize_parentheticals(self, text: str) -> str:
        """Convert parenthetical asides to natural pause-wrapped speech.

        (see docs) → ... see docs ...
        (optional) → ... optional ...
        """
        def _paren_replace(match):
            content = match.group(1).strip()
            if not content:
                return ''
            # Short parentheticals (1-6 words) become paused asides
            word_count = len(content.split())
            if word_count <= 6:
                return f'... {content} ...'
            # Longer parentheticals: just remove the parens, keep content
            return f', {content},'

        # Match parentheses with content
        text = re.sub(r'\(([^)]+)\)', _paren_replace, text)
        return text

    # ── Empty parentheticals ─────────────────────────────────────────────

    def _strip_empty_parentheticals(self, text: str) -> str:
        """Remove empty or near-empty parentheses left after other normalizations."""
        text = re.sub(r'\(\s*\)', '', text)
        return text

    # ── Sentence boundary detection ──────────────────────────────────────

    # Abbreviations whose trailing period is NOT a sentence boundary
    _SENTENCE_ABBREVS = frozenset({
        'dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'st', 'vs', 'etc', 'prof',
        'gen', 'gov', 'sgt', 'lt', 'col', 'capt', 'rev',
        'approx', 'dept', 'est', 'inc', 'corp', 'ave',
        'min', 'max', 'avg', 'num', 'config', 'doc', 'docs',
    })

    def _normalize_sentence_boundaries(self, text: str) -> str:
        """Insert pause markers at sentence boundaries for natural TTS pacing.

        Detects real sentence endings ([.!?] followed by space + capital letter)
        while skipping abbreviation periods. Inserts a brief pause marker
        so Kokoro pauses naturally between sentences.

        Reference: internal voice pipeline pattern.
        """
        # Find sentence boundaries: punctuation followed by space and uppercase
        # This is more precise than just [.!?]\s — requires evidence of a new sentence
        result = []
        i = 0
        while i < len(text):
            result.append(text[i])

            # Check for sentence boundary: . or ! or ? followed by space(s) and uppercase
            if text[i] in '.!?' and i + 1 < len(text):
                # Look ahead for space + capital letter (new sentence)
                j = i + 1
                while j < len(text) and text[j] == ' ':
                    j += 1

                if j < len(text) and j > i + 1 and text[j].isupper():
                    # Check if the period is from an abbreviation
                    if text[i] == '.':
                        # Find the word before the dot
                        word_start = i - 1
                        while word_start >= 0 and text[word_start].isalpha():
                            word_start -= 1
                        word_before = text[word_start + 1:i].lower()

                        if word_before in self._SENTENCE_ABBREVS:
                            i += 1
                            continue

                    # Real sentence boundary — ensure a pause
                    # Add a newline after the punctuation+space for Kokoro pacing
                    # (Kokoro treats newlines as natural pauses)
                    result.append('\n')

            i += 1

        return ''.join(result)

    # ── Whitespace cleanup ───────────────────────────────────────────────

    def _normalize_whitespace(self, text: str) -> str:
        """Clean up excessive whitespace and empty lines."""
        # Multiple spaces → single space
        text = re.sub(r'  +', ' ', text)
        # Multiple ellipsis pauses → single
        text = re.sub(r'(?:\.\.\.\s*){2,}', '... ', text)
        # Trim lines
        text = '\n'.join(line.strip() for line in text.split('\n'))
        # Remove empty lines
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text

    # ── Pronunciation overrides ──────────────────────────────────────────

    def _apply_pronunciation_overrides(self, text: str) -> str:
        """Replace known words with Kokoro markdown phoneme syntax.

        Runs last so all other normalization is complete before matching.
        Uses word boundaries to avoid partial matches (e.g., "close" but not "closet").
        """
        for word, replacement in PRONUNCIATION_OVERRIDES.items():
            text = re.sub(
                rf'\b{re.escape(word)}\b',
                replacement,
                text,
                flags=re.IGNORECASE,
            )
        return text
