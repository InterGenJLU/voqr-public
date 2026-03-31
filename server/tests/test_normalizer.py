"""
Tests for VOQR TTS Text Normalizer.

Run: pytest server/tests/test_normalizer.py -v
"""

import sys
from pathlib import Path

# Add server directory to path so we can import the normalizer
sys.path.insert(0, str(Path(__file__).parent.parent))

from tts_normalizer import TTSNormalizer

n = TTSNormalizer()


# ═══════════════════════════════════════════════════════════════════════
# Markdown stripping
# ═══════════════════════════════════════════════════════════════════════

class TestMarkdown:
    def test_bold(self):
        assert "Distance" in n.normalize("**Distance**")
        assert "**" not in n.normalize("**Distance**")

    def test_italic(self):
        assert "*" not in n.normalize("*important*")

    def test_inline_code(self):
        assert "`" not in n.normalize("use `forEach`")

    def test_headings(self):
        assert "#" not in n.normalize("### Key Differences")

    def test_links(self):
        result = n.normalize("[click here](https://example.com)")
        assert "click here" in result
        assert "https" not in result

    def test_strikethrough(self):
        assert "~~" not in n.normalize("~~removed~~")

    def test_blockquotes(self):
        result = n.normalize("> This is a quote")
        assert result.strip().startswith("This is a quote")
        assert ">" not in result or "greater" in result  # shouldn't read as operator

    def test_horizontal_rules(self):
        result = n.normalize("above\n---\nbelow")
        assert "---" not in result


# ═══════════════════════════════════════════════════════════════════════
# Code blocks
# ═══════════════════════════════════════════════════════════════════════

class TestCodeBlocks:
    def test_fenced_code_removed(self):
        text = "Example:\n```javascript\nconst x = 42;\n```\nEnd."
        result = n.normalize(text)
        assert "const x" not in result
        assert "42" not in result

    def test_code_block_spoken_replacement(self):
        text = "Example:\n```python\nprint('hello')\n```\nEnd."
        result = n.normalize(text)
        assert "code example" in result.lower()
        assert "on screen" in result.lower()

    def test_code_block_no_dangling_backticks(self):
        text = "```\ncode\n```"
        result = n.normalize(text)
        assert "```" not in result


# ═══════════════════════════════════════════════════════════════════════
# Math / LaTeX
# ═══════════════════════════════════════════════════════════════════════

class TestMath:
    def test_display_math_with_result(self):
        text = r"$$ \text{Total} = \frac{2900}{25} = 116 \text{ gallons} $$"
        result = n.normalize(text)
        assert "116" in result
        assert "gallons" in result
        assert "$$" not in result

    def test_display_math_without_result(self):
        text = r"$$ \text{Formula} = \frac{a}{b} $$"
        result = n.normalize(text)
        assert "$$" not in result
        assert "\\frac" not in result
        assert "formula" in result.lower()
        assert "on screen" in result.lower()

    def test_inline_math(self):
        text = "The value is $x + y$."
        result = n.normalize(text)
        assert "$" not in result

    def test_backslash_commands_stripped(self):
        text = r"\text{hello} \frac{a}{b}"
        result = n.normalize(text)
        assert "\\" not in result


# ═══════════════════════════════════════════════════════════════════════
# Code identifiers
# ═══════════════════════════════════════════════════════════════════════

class TestCodeIdentifiers:
    def test_camel_case(self):
        assert "for each" in n.normalize("forEach")

    def test_camel_case_multi(self):
        result = n.normalize("getUserData")
        assert "get" in result
        assert "user" in result
        assert "data" in result

    def test_snake_case(self):
        result = n.normalize("user_data")
        assert "user data" in result
        assert "_" not in result

    def test_snake_case_multi(self):
        result = n.normalize("get_user_by_id")
        assert "get user by id" in result

    def test_dot_notation(self):
        result = n.normalize("array.map()")
        assert "array map" in result
        assert "()" not in result

    def test_preserve_javascript(self):
        result = n.normalize("Use JavaScript for this")
        assert "JavaScript" in result
        assert "java script" not in result.lower()

    def test_preserve_typescript(self):
        result = n.normalize("Written in TypeScript")
        assert "TypeScript" in result

    def test_preserve_github(self):
        result = n.normalize("Push to GitHub")
        assert "GitHub" in result


# ═══════════════════════════════════════════════════════════════════════
# Operators
# ═══════════════════════════════════════════════════════════════════════

class TestOperators:
    def test_strict_equals(self):
        assert "strictly equals" in n.normalize("x === y")

    def test_strict_not_equals(self):
        assert "strictly does not equal" in n.normalize("x !== y")

    def test_arrow(self):
        assert "arrow" in n.normalize("x => y")

    def test_greater_equal(self):
        assert "greater than or equal" in n.normalize("x >= y")

    def test_less_equal(self):
        assert "less than or equal" in n.normalize("x <= y")

    def test_double_equals(self):
        assert "equals" in n.normalize("x == y")

    def test_not_equals(self):
        assert "does not equal" in n.normalize("x != y")

    def test_logical_and(self):
        assert " and " in n.normalize("x && y")

    def test_logical_or(self):
        assert " or " in n.normalize("x || y")

    def test_single_greater_than(self):
        result = n.normalize("x > y")
        assert "greater than" in result


# ═══════════════════════════════════════════════════════════════════════
# Units of measurement
# ═══════════════════════════════════════════════════════════════════════

class TestUnits:
    def test_gigabytes(self):
        assert "gigabytes" in n.normalize("16GB of RAM")

    def test_megabytes(self):
        assert "megabytes" in n.normalize("512MB")

    def test_gigahertz(self):
        assert "gigahertz" in n.normalize("3.5GHz processor")

    def test_milliseconds(self):
        assert "milliseconds" in n.normalize("100ms latency")

    def test_kilohertz(self):
        assert "kilohertz" in n.normalize("16kHz sample rate")

    def test_megabytes_per_second(self):
        assert "megabytes per second" in n.normalize("500MB/s")


# ═══════════════════════════════════════════════════════════════════════
# Percentages and multipliers
# ═══════════════════════════════════════════════════════════════════════

class TestPercentagesMultipliers:
    def test_percent(self):
        assert "percent" in n.normalize("100% complete")

    def test_decimal_percent(self):
        assert "percent" in n.normalize("99.9% accuracy")

    def test_multiplier_with_adjective(self):
        assert "times faster" in n.normalize("2x faster")

    def test_multiplier_standalone(self):
        assert "times" in n.normalize("10x improvement")

    def test_multiplier_various(self):
        assert "times better" in n.normalize("5x better")


# ═══════════════════════════════════════════════════════════════════════
# Emoji and Unicode
# ═══════════════════════════════════════════════════════════════════════

class TestEmojiUnicode:
    def test_checkmark_stripped(self):
        result = n.normalize("\u2705 Done")
        assert "\u2705" not in result
        assert "Done" in result

    def test_x_mark_stripped(self):
        result = n.normalize("\u274c Failed")
        assert "\u274c" not in result
        assert "Failed" in result

    def test_arrow_replaced(self):
        result = n.normalize("input \u2192 output")
        assert "\u2192" not in result
        assert "to" in result

    def test_greater_equal_symbol(self):
        result = n.normalize("x \u2265 5")
        assert "greater than or equal" in result

    def test_less_equal_symbol(self):
        result = n.normalize("x \u2264 5")
        assert "less than or equal" in result

    def test_infinity(self):
        result = n.normalize("approaches \u221e")
        assert "infinity" in result


# ═══════════════════════════════════════════════════════════════════════
# Numbered lists (context-aware)
# ═══════════════════════════════════════════════════════════════════════

class TestNumberedLists:
    def test_steps_context(self):
        text = "Follow these steps:\n\n1. Install it\n2. Run it"
        result = n.normalize(text)
        assert "Step 1" in result or "Step" in result

    def test_non_steps_context(self):
        text = "Key differences:\n\n1. Speed\n2. Size\n3. Quality"
        result = n.normalize(text)
        assert "First" in result
        assert "Second" in result
        assert "Third" in result

    def test_large_list_numbers(self):
        text = "Considerations:\n\n4. Fourth item\n5. Fifth item"
        result = n.normalize(text)
        assert "Fourth" in result or "Number 4" in result
        # No stutter: "Fourth... Fourth item" should become "Fourth... item"
        assert "Fourth... Fourth" not in result

    def test_instructions_context(self):
        text = "Instructions:\n\n1. Open file\n2. Edit\n3. Save"
        result = n.normalize(text)
        assert "Step" in result


# ═══════════════════════════════════════════════════════════════════════
# Acronyms
# ═══════════════════════════════════════════════════════════════════════

class TestAcronyms:
    def test_parenthetical_stripped(self):
        result = n.normalize("miles per gallon (MPG)")
        assert "(MPG)" not in result
        assert "miles per gallon" in result

    def test_standalone_expanded(self):
        result = n.normalize("Your car gets 25 MPG")
        assert "miles per gallon" in result

    def test_api(self):
        assert "A P I" in n.normalize("REST API")

    def test_json(self):
        assert "jason" in n.normalize("parse JSON")

    def test_sql(self):
        assert "sequel" in n.normalize("run SQL")

    # ── Hardware / infrastructure ──
    def test_bios(self):
        assert "bye-ose" in n.normalize("update the BIOS")

    def test_vram(self):
        assert "V ram" in n.normalize("not enough VRAM")

    # ── Networking ──
    def test_dns(self):
        assert "D N S" in n.normalize("check DNS records")

    def test_ssh(self):
        assert "S S H" in n.normalize("connect via SSH")

    def test_vpn(self):
        assert "V P N" in n.normalize("use a VPN")

    # ── Data formats ──
    def test_yaml(self):
        assert "yamel" in n.normalize("edit the YAML file")

    def test_toml(self):
        assert "tom-ul" in n.normalize("parse TOML config")

    def test_csv(self):
        assert "C S V" in n.normalize("export as CSV")

    def test_regex(self):
        assert "rej-ecks" in n.normalize("write a REGEX pattern")

    def test_uuid(self):
        assert "U U I D" in n.normalize("generate a UUID")

    # ── Dev tools ──
    def test_sdk(self):
        assert "S D K" in n.normalize("install the SDK")

    def test_npm(self):
        assert "N P M" in n.normalize("run NPM install")

    def test_k8s(self):
        assert "kates" in n.normalize("deploy to K8s")

    def test_stdin(self):
        assert "standard in" in n.normalize("read from STDIN")

    def test_posix(self):
        assert "pah-zicks" in n.normalize("POSIX compliant")

    def test_gnu(self):
        assert "guh-new" in n.normalize("GNU General Public License")

    # ── Cloud ──
    def test_aws(self):
        assert "A W S" in n.normalize("deploy to AWS")

    def test_saas(self):
        assert "sass" in n.normalize("a SaaS product")

    # ── Cybersecurity ──
    def test_siem(self):
        assert "seem" in n.normalize("configure the SIEM")

    def test_soc(self):
        assert "sock" in n.normalize("the SOC team")

    def test_osint(self):
        assert "oh-sint" in n.normalize("run OSINT research")

    def test_cve(self):
        assert "C V E" in n.normalize("filed a CVE")

    def test_owasp(self):
        assert "oh-wasp" in n.normalize("OWASP top ten")

    def test_waf(self):
        assert "waf" in n.normalize("behind a WAF")

    def test_mfa(self):
        assert "M F A" in n.normalize("enable MFA")

    def test_rbac(self):
        assert "are-back" in n.normalize("RBAC policies")

    # ── Healthcare ──
    def test_hipaa(self):
        assert "hip-ah" in n.normalize("HIPAA compliant")

    def test_phi(self):
        assert "P H I" in n.normalize("protect PHI data")

    def test_emr(self):
        assert "E M R" in n.normalize("update the EMR")

    def test_fhir(self):
        assert "fire" in n.normalize("FHIR resources")

    def test_nicu(self):
        assert "nick-you" in n.normalize("the NICU ward")

    def test_cabg(self):
        assert "cabbage" in n.normalize("scheduled for CABG")

    def test_nsaid(self):
        assert "en-said" in n.normalize("take an NSAID")

    def test_sob_medical(self):
        """SOB in medical context = shortness of breath, spelled out."""
        assert "S O B" in n.normalize("patient reports SOB")

    def test_copd(self):
        assert "C O P D" in n.normalize("diagnosed with COPD")


# ═══════════════════════════════════════════════════════════════════════
# Word slashes
# ═══════════════════════════════════════════════════════════════════════

class TestWordSlashes:
    def test_two_words(self):
        result = n.normalize("consent/authorization is required")
        assert "consent or authorization" in result

    def test_three_words(self):
        result = n.normalize("red/green/blue values")
        assert "red or green or blue" in result

    def test_url_not_affected(self):
        """URLs should not have slashes converted."""
        result = n.normalize("visit https://example.com/path/to/page")
        assert "or" not in result or "example" in result

    def test_path_not_affected(self):
        """File paths should not have slashes converted."""
        result = n.normalize("edit /home/user/file")
        assert "home or user" not in result

    def test_fraction_not_affected(self):
        """Numeric fractions should not be converted."""
        result = n.normalize("about 1/2 of the time")
        assert "1 or 2" not in result

    def test_units_not_affected(self):
        """Unit rates like KB/s should not be converted."""
        result = n.normalize("speed is 100 KB/s")
        assert "K B or s" not in result


# ═══════════════════════════════════════════════════════════════════════
# Currency
# ═══════════════════════════════════════════════════════════════════════

class TestCurrency:
    def test_dollars(self):
        assert "dollars" in n.normalize("costs $50")

    def test_thousands(self):
        assert "thousand dollars" in n.normalize("$120K revenue")

    def test_dollars_cents(self):
        result = n.normalize("price is $9.99")
        assert "dollars" in result
        assert "cents" in result


# ═══════════════════════════════════════════════════════════════════════
# Task lists
# ═══════════════════════════════════════════════════════════════════════

class TestTaskLists:
    def test_checked_stripped(self):
        result = n.normalize("- [x] Done")
        assert "[x]" not in result
        assert "Done" in result

    def test_unchecked_stripped(self):
        result = n.normalize("- [ ] Todo")
        assert "[ ]" not in result
        assert "Todo" in result

    def test_inline_checkbox(self):
        result = n.normalize("Task [x] is complete")
        assert "[x]" not in result


# ═══════════════════════════════════════════════════════════════════════
# Regex patterns
# ═══════════════════════════════════════════════════════════════════════

class TestRegex:
    def test_regex_stripped(self):
        result = n.normalize("Use /^[a-z]+$/gi to match")
        assert "/^[a-z]+$/gi" not in result


# ═══════════════════════════════════════════════════════════════════════
# Numbered references
# ═══════════════════════════════════════════════════════════════════════

class TestReferences:
    def test_citation_stripped(self):
        result = n.normalize("According to research [1], this is true [2].")
        assert "[1]" not in result
        assert "[2]" not in result
        assert "research" in result
        # No orphan whitespace before punctuation
        assert " ," not in result
        assert " ." not in result


# ═══════════════════════════════════════════════════════════════════════
# Repeated punctuation
# ═══════════════════════════════════════════════════════════════════════

class TestPunctuation:
    def test_multiple_exclamation(self):
        result = n.normalize("Wow!!!")
        assert result.count("!") == 1

    def test_multiple_question(self):
        result = n.normalize("Really???")
        assert result.count("?") == 1

    def test_ellipsis_preserved(self):
        result = n.normalize("Wait... then go")
        assert "..." in result


# ═══════════════════════════════════════════════════════════════════════
# Fractions and decimals
# ═══════════════════════════════════════════════════════════════════════

class TestFractionsDecimals:
    def test_half(self):
        assert "one half" in n.normalize("Use 1/2 cup")

    def test_quarter(self):
        assert "one quarter" in n.normalize("1/4 of the way")

    def test_decimal(self):
        result = n.normalize("weighs about 3.14 kilograms")
        assert "point" in result


# ═══════════════════════════════════════════════════════════════════════
# Whitespace cleanup
# ═══════════════════════════════════════════════════════════════════════

class TestWhitespace:
    def test_multiple_spaces(self):
        result = n.normalize("too   many   spaces")
        assert "  " not in result

    def test_multiple_pauses_collapsed(self):
        result = n.normalize("pause... ... ... here")
        # Should not have triple ellipsis sequences
        assert "... ... ..." not in result


# ═══════════════════════════════════════════════════════════════════════
# Full AI response integration tests
# ═══════════════════════════════════════════════════════════════════════

class TestFullResponses:
    """Tests with realistic AI response text."""

    def test_code_explanation(self):
        text = """The `forEach` method in JavaScript iterates over arrays.

Unlike `array.map()`, it doesn't return a new array.

```javascript
const items = [1, 2, 3];
items.forEach(item => console.log(item));
```

Key points:
1. **Performance**: `forEach` is about 2x slower
2. **Return value**: Returns `undefined`"""

        result = n.normalize(text)
        # Code identifiers spoken naturally
        assert "for each" in result
        assert "array map" in result
        # Code block replaced
        assert "code example" in result.lower()
        # Markdown stripped
        assert "**" not in result
        assert "```" not in result
        # Multiplier handled
        assert "times" in result
        # List handled
        assert "First" in result or "Step" in result

    def test_gas_calculation(self):
        text = """To estimate gas needed:

1. **Distance**: About 2,900 miles
2. **Fuel Efficiency**: 25 miles per gallon (MPG)

$$ \\text{Total} = \\frac{2900}{25} = 116 \\text{ gallons} $$

You need about 116 gallons."""

        result = n.normalize(text)
        assert "(MPG)" not in result
        assert "$$" not in result
        assert "116" in result
        assert "**" not in result

    def test_technical_specs(self):
        text = "Requires 16GB RAM, 3.5GHz CPU, and 100ms latency or less."
        result = n.normalize(text)
        assert "gigabytes" in result
        assert "gigahertz" in result
        assert "milliseconds" in result


# ═══════════════════════════════════════════════════════════════════════
# Version numbers
# ═══════════════════════════════════════════════════════════════════════

class TestVersionNumbers:
    def test_v_prefix_three_segment(self):
        result = n.normalize("v3.2.1")
        assert "version" in result
        assert "dot" in result
        assert "v3" not in result

    def test_v_prefix_two_segment(self):
        result = n.normalize("v2.0")
        assert "version 2 dot 0" in result

    def test_version_word_prefix(self):
        result = n.normalize("Version 3.12.3")
        assert "version" in result.lower()
        assert "dot" in result

    def test_tool_name_version(self):
        result = n.normalize("Python 3.12")
        assert "Python" in result
        assert "dot" in result
        assert "point" not in result

    def test_dot_x_pattern(self):
        result = n.normalize("Node 18.x")
        assert "18 dot x" in result

    def test_beta_suffix(self):
        result = n.normalize("v2.0.0-beta.1")
        assert "version" in result
        assert "beta" in result
        assert "1" in result

    def test_rc_suffix(self):
        result = n.normalize("v1.0.0-rc2")
        assert "version" in result
        assert "R C" in result

    def test_plain_decimal_not_affected(self):
        """Regular decimals should still use 'point' not 'dot'."""
        result = n.normalize("weighs 3.5 pounds")
        assert "point" in result
        assert "dot" not in result


# ═══════════════════════════════════════════════════════════════════════
# CLI command dictation
# ═══════════════════════════════════════════════════════════════════════

class TestCLICommands:
    def test_plain_command_reads_normally(self):
        result = n.normalize("git status")
        assert result == "git status"

    def test_plain_command_with_arg(self):
        result = n.normalize("npm install")
        assert result == "npm install"

    def test_long_flag_dictated(self):
        result = n.normalize("npm install --save-dev")
        assert "double dash" in result
        assert "save" in result
        assert "dev" in result
        assert "space" in result

    def test_short_flag_dictated(self):
        result = n.normalize("git commit -m \"fix bug\"")
        assert "dash" in result
        assert "double quote" in result or "quote" in result

    def test_capital_flag(self):
        result = n.normalize("curl -X POST")
        assert "capital X" in result
        assert "capital POST" in result

    def test_multiple_flags(self):
        result = n.normalize("pip install --upgrade --user flask")
        assert "double dash" in result
        assert "upgrade" in result
        assert "user" in result

    def test_combined_short_flags(self):
        result = n.normalize("grep -rf \"pattern\"")
        assert "dash" in result
        assert "R F" in result


# ═══════════════════════════════════════════════════════════════════════
# HTML tags
# ═══════════════════════════════════════════════════════════════════════

class TestHTMLTags:
    def test_simple_opening_tag(self):
        result = n.normalize("use a <div> element")
        assert "div" in result
        assert "<" not in result

    def test_opening_tag_with_attributes(self):
        result = n.normalize("wrap it in <span class=\"highlight\">")
        assert "span" in result
        assert "class=" not in result
        assert "<" not in result

    def test_closing_tag(self):
        result = n.normalize("close with </div>")
        assert "closing div" in result
        assert "<" not in result

    def test_self_closing_br(self):
        result = n.normalize("add a <br/> here")
        assert "line break" in result
        assert "<" not in result

    def test_self_closing_img(self):
        result = n.normalize("<img src=\"photo.jpg\"/>")
        assert "image tag" in result

    def test_html_block_replaced(self):
        """5+ lines of HTML should be replaced with description."""
        html = "<div>\n<header>\n<nav>\n<ul>\n<li>Home</li>\n</ul>\n</nav>\n</header>\n</div>"
        result = n.normalize(html)
        assert "shown on screen" in result.lower()
        assert "<div>" not in result

    def test_short_html_not_block_replaced(self):
        """Under 5 lines should keep tag names, not block-replace."""
        html = "use <div> and </div>"
        result = n.normalize(html)
        assert "div" in result
        assert "shown on screen" not in result.lower()


# ═══════════════════════════════════════════════════════════════════════
# Diff / patch format
# ═══════════════════════════════════════════════════════════════════════

class TestDiffFormat:
    def test_unified_diff_replaced(self):
        diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,4 @@\n line 1\n-removed\n+added\n line 3"
        result = n.normalize(diff)
        assert "diff" in result.lower()
        assert "shown on screen" in result.lower()
        assert "---" not in result
        assert "+++" not in result

    def test_diff_markers_stripped(self):
        diff = "--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,4 @@\n-old\n+new"
        result = n.normalize(diff)
        assert "@@ " not in result


# ═══════════════════════════════════════════════════════════════════════
# Abbreviations
# ═══════════════════════════════════════════════════════════════════════

class TestAbbreviations:
    def test_eg(self):
        assert "for example" in n.normalize("e.g. Python")

    def test_ie(self):
        assert "that is" in n.normalize("i.e. the main one")

    def test_vs(self):
        assert "versus" in n.normalize("vs. the old approach")

    def test_et_al(self):
        assert "and others" in n.normalize("et al. found that")

    def test_approx(self):
        assert "approximately" in n.normalize("approx. 500ms")

    def test_etc(self):
        assert "etcetera" in n.normalize("etc.")

    def test_without(self):
        assert "without" in n.normalize("w/o errors")

    def test_with(self):
        assert "with caching" in n.normalize("w/ caching")


# ═══════════════════════════════════════════════════════════════════════
# Email addresses
# ═══════════════════════════════════════════════════════════════════════

class TestEmailAddresses:
    def test_simple_email(self):
        result = n.normalize("contact user@example.com")
        assert "user at example dot com" in result
        assert "@" not in result

    def test_complex_email(self):
        result = n.normalize("send to admin@my-company.org")
        assert "at" in result
        assert "dot org" in result

    def test_email_in_prose(self):
        result = n.normalize("Email noreply@github.com for help")
        assert "noreply at github dot com" in result


# ═══════════════════════════════════════════════════════════════════════
# Inline JSON / YAML
# ═══════════════════════════════════════════════════════════════════════

class TestInlineJSON:
    def test_simple_json_readable(self):
        result = n.normalize('returns {"status": "ok"}')
        assert '"' not in result
        assert "{" not in result
        assert "status" in result

    def test_complex_json_replaced(self):
        result = n.normalize('returns {"name": "John", "age": 30, "city": "NYC"}')
        assert "jason snippet" in result

    def test_json_array_replaced(self):
        result = n.normalize('colors are ["red", "green", "blue"]')
        assert "jason array" in result
        assert "[" not in result

    def test_simple_array_readable(self):
        result = n.normalize('returns ["ok"]')
        assert '"' not in result


# ═══════════════════════════════════════════════════════════════════════
# Parenthetical prosody
# ═══════════════════════════════════════════════════════════════════════

class TestParentheticalProsody:
    def test_short_aside(self):
        result = n.normalize("install it (see docs)")
        assert "(" not in result
        assert ")" not in result
        assert "see docs" in result
        assert "..." in result

    def test_single_word(self):
        result = n.normalize("the flag (optional) controls")
        assert "optional" in result
        assert "(" not in result

    def test_long_parenthetical(self):
        """Long parentheticals should drop parens but not add pauses."""
        result = n.normalize("Python (a popular language used worldwide for many applications) is great")
        assert "(" not in result
        assert ")" not in result
        assert "popular language" in result


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: URL and file path protection
# ═══════════════════════════════════════════════════════════════════════

class TestURLsAndPaths:
    def test_url_spoken_with_domain(self):
        result = n.normalize("Visit https://docs.example.com/api for details")
        assert "link is shown on screen" in result
        assert "example" in result

    def test_url_not_eaten_by_regex_stripper(self):
        result = n.normalize("See https://example.com/path/to/page")
        assert "link is shown on screen" in result
        assert "https://" not in result

    def test_file_path_preserved(self):
        result = n.normalize("Edit the file at /home/user/.config/settings.json")
        assert "/home/user/.config/settings.json" in result

    def test_file_path_not_split(self):
        """Dot in filename should not be split by dot notation handler."""
        result = n.normalize("Open /etc/nginx/nginx.conf")
        assert "/etc/nginx/nginx.conf" in result


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: IP addresses
# ═══════════════════════════════════════════════════════════════════════

class TestIPAddresses:
    def test_ipv4_digit_by_digit(self):
        result = n.normalize("192.168.1.100")
        assert "one nine two" in result
        assert "dot" in result
        assert "one hundred" in result

    def test_ipv4_with_port(self):
        result = n.normalize("Server on 192.168.1.100:8080")
        assert "port 8080" in result
        assert "one nine two" in result

    def test_simple_ip(self):
        result = n.normalize("Connect to 10.0.0.1")
        assert "one zero" in result
        assert "dot" in result

    def test_ip_not_treated_as_version(self):
        """IP should not be read as version number."""
        result = n.normalize("192.168.1.1")
        assert "version" not in result


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: Clock times
# ═══════════════════════════════════════════════════════════════════════

class TestClockTimes:
    def test_hh_mm_ss(self):
        result = n.normalize("Completed at 14:30:05 UTC")
        assert ":" not in result.replace("...", "")
        assert "14" in result
        assert "30" in result
        assert "05" in result

    def test_hh_mm(self):
        result = n.normalize("Meeting at 9:30")
        assert ":" not in result.replace("...", "")


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: Additional operators
# ═══════════════════════════════════════════════════════════════════════

class TestAdditionalOperators:
    def test_nullish_coalescing(self):
        result = n.normalize("x ?? y")
        assert "??" not in result
        assert "null" in result

    def test_optional_chaining(self):
        result = n.normalize("obj?.prop")
        assert "?." not in result
        assert "optional" in result

    def test_nullish_assign(self):
        result = n.normalize("x ??= y")
        assert "??=" not in result
        assert "nullish" in result


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: Markdown images
# ═══════════════════════════════════════════════════════════════════════

class TestMarkdownImages:
    def test_image_with_alt(self):
        result = n.normalize("![alt text](image.png)")
        assert "!" not in result
        assert "alt text" in result
        assert "image.png" not in result

    def test_image_no_alt(self):
        result = n.normalize("![](diagram.svg)")
        assert "!" not in result
        assert "diagram" not in result


# ═══════════════════════════════════════════════════════════════════════
# Edge cases: Semver prefixes
# ═══════════════════════════════════════════════════════════════════════

class TestSemverPrefixes:
    def test_caret(self):
        result = n.normalize("^2.0.0")
        assert "caret" in result
        assert "dot" in result
        assert "^" not in result

    def test_tilde_semver(self):
        result = n.normalize("~1.5.0")
        assert "tilde" in result
        assert "dot" in result
        assert "~" not in result

    def test_tilde_approx_not_semver(self):
        """~100ms should be 'approximately', not 'tilde'."""
        result = n.normalize("~100ms")
        assert "approximately" in result
        assert "tilde" not in result


# ═══════════════════════════════════════════════════════════════════════
# Polish: Keyboard shortcuts
# ═══════════════════════════════════════════════════════════════════════

class TestKeyboardShortcuts:
    def test_ctrl_shift(self):
        result = n.normalize("Press Ctrl+Shift+P")
        assert "Control" in result
        assert "Shift" in result
        assert "P" in result
        assert "+" not in result

    def test_cmd(self):
        result = n.normalize("Use Cmd+C to copy")
        assert "Command" in result
        assert "C" in result


# ═══════════════════════════════════════════════════════════════════════
# Polish: Tilde approximation
# ═══════════════════════════════════════════════════════════════════════

class TestTildeApprox:
    def test_tilde_number(self):
        result = n.normalize("~100ms latency")
        assert "approximately" in result
        assert "~" not in result

    def test_tilde_multiplier(self):
        result = n.normalize("~2x faster")
        assert "approximately" in result


# ═══════════════════════════════════════════════════════════════════════
# Polish: Time durations
# ═══════════════════════════════════════════════════════════════════════

class TestTimeDurations:
    def test_hours_minutes(self):
        result = n.normalize("Takes 2h 30m")
        assert "2 hours" in result
        assert "30 minutes" in result

    def test_hours_only(self):
        result = n.normalize("runs for 24h")
        assert "24 hours" in result

    def test_seconds(self):
        result = n.normalize("timeout after 30s")
        assert "30 seconds" in result

    def test_compact_format(self):
        result = n.normalize("ETA 1h30m")
        assert "1 hours" in result
        assert "30 minutes" in result


# ═══════════════════════════════════════════════════════════════════════
# Heteronyms (context-dependent pronunciation)
# ═══════════════════════════════════════════════════════════════════════

class TestHeteronyms:
    # ── read ──
    def test_read_after_modal(self):
        assert "reed" in n.normalize("You can read the docs")

    def test_read_imperative(self):
        assert "Reed" in n.normalize("Read the documentation first")

    def test_read_past_tense(self):
        """Past tense 'read' should NOT be changed."""
        result = n.normalize("I read it yesterday")
        assert "reed" not in result.lower()

    # ── live ──
    def test_live_adjective(self):
        assert "lyve" in n.normalize("Deploy to the live server")

    def test_live_go_live(self):
        assert "lyve" in n.normalize("The site will go live tomorrow")

    def test_live_verb_unchanged(self):
        """Verb 'live' (reside) should NOT be changed."""
        result = n.normalize("I live in New York")
        assert "lyve" not in result

    # ── close ──
    def test_close_adjective(self):
        assert "kloce" in n.normalize("The values are close to zero")

    def test_close_verb_unchanged(self):
        """Verb 'close' (shut) should NOT be changed."""
        result = n.normalize("Close the connection")
        assert "kloce" not in result

    # ── lead ──
    def test_lead_noun(self):
        assert "leed" in n.normalize("She is the lead developer")

    def test_lead_verb_unchanged(self):
        """Verb 'lead' (guide/cause) should NOT be changed."""
        result = n.normalize("This will lead to errors")
        assert "leed" not in result.lower() or "will leed" not in result.lower()

    # ── present ──
    def test_present_verb(self):
        assert "preh-zent" in n.normalize("Present the results to the team")

    def test_present_adj_unchanged(self):
        """Adjective 'present' should NOT be changed."""
        result = n.normalize("The present value is null")
        assert "preh-zent" not in result

    # ── minute ──
    def test_minute_adjective(self):
        assert "my-newt" in n.normalize("A minute detail in the code")

    def test_minute_time_unchanged(self):
        """Time 'minute' should NOT be changed."""
        result = n.normalize("Wait one minute")
        assert "my-newt" not in result


# ═══════════════════════════════════════════════════════════════════════
# Sentence boundary detection
# ═══════════════════════════════════════════════════════════════════════

class TestSentenceBoundaries:
    def test_simple_boundaries(self):
        """Sentence endings should get pause markers."""
        result = n.normalize("This is fast. Try it now.")
        # The two sentences should be separated
        assert "\n" in result

    def test_abbreviation_not_split(self):
        """Abbreviation periods should NOT trigger sentence splits."""
        result = n.normalize("Use Dr. Smith's library")
        # "Dr." should not cause a split — text should stay on one line
        lines = [l for l in result.split('\n') if l.strip()]
        assert len(lines) == 1

    def test_multi_sentence(self):
        result = n.normalize("Install it. Configure it. Run it.")
        lines = [l for l in result.split('\n') if l.strip()]
        assert len(lines) >= 2

    def test_question_boundary(self):
        result = n.normalize("Does it work? Yes it does.")
        assert "\n" in result

    def test_exclamation_boundary(self):
        result = n.normalize("It works! Now deploy it.")
        assert "\n" in result


# ── Pronunciation overrides ──────────────────────────────────────────────

class TestPronunciationOverrides:
    """Tests for Kokoro markdown pronunciation override system."""

    def test_override_applied(self):
        """Overrides replace matching words with phoneme syntax."""
        import tts_normalizer
        original = tts_normalizer.PRONUNCIATION_OVERRIDES.copy()
        try:
            tts_normalizer.PRONUNCIATION_OVERRIDES["voqr"] = "[voqr](/voʊkər/)"
            result = n.normalize("Welcome to voqr.")
            assert "[voqr](/voʊkər/)" in result
        finally:
            tts_normalizer.PRONUNCIATION_OVERRIDES.clear()
            tts_normalizer.PRONUNCIATION_OVERRIDES.update(original)

    def test_override_case_insensitive(self):
        """Overrides match regardless of case."""
        import tts_normalizer
        original = tts_normalizer.PRONUNCIATION_OVERRIDES.copy()
        try:
            tts_normalizer.PRONUNCIATION_OVERRIDES["voqr"] = "[VOQR](/voʊkər/)"
            result = n.normalize("Try VOQR today.")
            assert "[VOQR](/voʊkər/)" in result
        finally:
            tts_normalizer.PRONUNCIATION_OVERRIDES.clear()
            tts_normalizer.PRONUNCIATION_OVERRIDES.update(original)

    def test_override_whole_word_only(self):
        """Overrides don't match partial words."""
        import tts_normalizer
        original = tts_normalizer.PRONUNCIATION_OVERRIDES.copy()
        try:
            tts_normalizer.PRONUNCIATION_OVERRIDES["close"] = "[close](/kloʊs/)"
            result = n.normalize("Do not closet your feelings.")
            assert "[close]" not in result
            assert "closet" in result
        finally:
            tts_normalizer.PRONUNCIATION_OVERRIDES.clear()
            tts_normalizer.PRONUNCIATION_OVERRIDES.update(original)

    def test_empty_dict_passthrough(self):
        """No overrides means text passes through unchanged."""
        import tts_normalizer
        original = tts_normalizer.PRONUNCIATION_OVERRIDES.copy()
        try:
            tts_normalizer.PRONUNCIATION_OVERRIDES.clear()
            result = n.normalize("Hello world.")
            assert "Hello world" in result
        finally:
            tts_normalizer.PRONUNCIATION_OVERRIDES.clear()
            tts_normalizer.PRONUNCIATION_OVERRIDES.update(original)
