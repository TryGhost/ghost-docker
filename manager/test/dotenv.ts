// Hand-written dotenv lines, and the value Compose reads from each: what
// env.ts must agree with. test/env.test.ts checks env.ts against these
// values; test/integration/compose.test.ts checks these values against the
// Compose in the image, so the two cannot drift apart unnoticed.
//
// None interpolates a variable: the values are what any site would get.

/** `KEY=...` exactly as written in the file, and the value Compose reads. */
export const DOTENV: readonly (readonly [line: string, value: string])[] = [
    // Unquoted: literal, but for `$$`, a ` #` comment and trailing space.
    ['U_PLAIN=hello world', 'hello world'],
    ['U_TAB=some\\tvalue', 'some\\tvalue'],
    ['U_NEWLINE=a\\nb', 'a\\nb'],
    ['U_BACKSLASHES=back\\\\slash', 'back\\\\slash'],
    ['U_QUOTES=say\\"hi\\"', 'say\\"hi\\"'],
    ['U_ESCAPED_DOLLAR=cost\\$5', 'cost\\$5'],
    ['U_DOUBLED_DOLLAR=cost$$5', 'cost$5'],
    ['U_COMMENT=value # a comment', 'value'],
    ['U_HASH=a#b', 'a#b'],
    ['U_TAB_HASH=a\t#b', 'a\t#b'],
    ['U_TRAILING=trailing   ', 'trailing'],
    ['U_LEADING=   leading', 'leading'],
    ["U_INNER_QUOTE=it's", "it's"],
    ['U_UNICODE=a\\u0041b', 'a\\u0041b'],
    // Double-quoted: Go's escapes, `\$` and `$$` for a dollar.
    ['D_TAB="some\\tvalue"', 'some\tvalue'],
    ['D_NEWLINE="a\\nb"', 'a\nb'],
    ['D_RETURN="a\\rb"', 'a\rb'],
    ['D_BELL="a\\ab"', 'a\x07b'],
    ['D_BACKSPACE="a\\bb"', 'a\bb'],
    ['D_FORMFEED="a\\fb"', 'a\fb'],
    ['D_VTAB="a\\vb"', 'a\vb'],
    ['D_BACKSLASH="back\\\\slash"', 'back\\slash'],
    ['D_BACKSLASH_N="a\\\\nb"', 'a\\nb'],
    ['D_TRAILING_BACKSLASH="a\\\\"', 'a\\'],
    ['D_QUOTES="say \\"hi\\""', 'say "hi"'],
    ['D_SINGLE_QUOTE="it\\\'s"', "it\\'s"],
    ['D_UNKNOWN="a\\qb"', 'a\\qb'],
    ['D_HEX="a\\x41b"', 'a\\x41b'],
    ['D_CONTROL="a\\cb"', 'a\\cb'],
    ['D_OCTAL="a\\0123b"', 'aSb'],
    ['D_SHORT_OCTAL="a\\01b"', 'a\\1b'],
    ['D_ZERO="a\\0b"', 'a\\b'],
    ['D_UNICODE="a\\u00e9b"', 'a\\u00e9b'],
    ['D_ESCAPED_UNICODE="a\\\\u0041b"', 'a\\u0041b'],
    ['D_ESCAPED_DOLLAR="cost \\$5"', 'cost $5'],
    ['D_DOUBLED_DOLLAR="cost $$5"', 'cost $5'],
    ['D_HASH="a #b"', 'a #b'],
    ['D_AFTER="quoted" # a comment', 'quoted'],
    // Single-quoted: literal, but for `\'`; no interpolation at all.
    ["S_TAB='some\\tvalue'", 'some\\tvalue'],
    ["S_BACKSLASHES='back\\\\slash'", 'back\\\\slash'],
    ["S_QUOTE='it\\'s'", "it's"],
    ["S_TRAILING_BACKSLASH='a\\\\'", 'a\\\\'],
    ["S_DOLLARS='cost $5 and $$5'", 'cost $5 and $$5'],
    ["S_UNICODE='a\\u0041b'", 'a\\u0041b'],
    // The line around them.
    ['export E_EXPORTED="yes"', 'yes'],
    ['E_SPACED= "after the equals"', 'after the equals'],
];

/** The key of a fixture line. */
export const keyOf = (line: string): string =>
    line
        .replace(/^export\s+/, '')
        .split('=')[0]!
        .trim();
