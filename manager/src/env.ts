// Dotenv, as Docker Compose reads it: the one encoder and the one parser.
//
// An env file is data. It is never sourced or evaluated, and it is never
// parsed by anything but this file, so reading and rewriting cannot disagree
// about where a value starts and ends.
//
// Compose interpolates dotenv values even inside double quotes, so a literal
// `$` is written `$$`, and double quotes are the only form that can represent
// every value. The rules are in docs/configuration.md ("Value encoding") and
// are verified by a round trip through real containers in tests/e2e/install.sh.
//
// A value whose quotes span several lines is valid dotenv but is not editable
// here: it is skipped when listing keys, and reading or writing it fails with a
// message saying to edit it by hand. Nothing written here ever produces one.

/** How a value is written on its line. */
export type Quoting = 'double' | 'single' | 'unquoted' | 'multiline';

export interface Assignment {
    /** Zero-based index of the line the assignment starts on. */
    readonly line: number;
    readonly key: string;
    readonly quoting: Quoting;
    /** The value as written, still escaped. Empty for a multi-line value. */
    readonly body: string;
}

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOUBLE = /^"((?:\\.|[^"\\])*)"/;
const SINGLE = /^'((?:\\'|[^'])*)'/;
const CLOSES_DOUBLE = /^(?:[^"\\]|\\.)*"/;

export const isValidKey = (key: string): boolean => VALID_KEY.test(key);

/** A key whose value spans several lines, which these helpers do not edit. */
export class MultilineValueError extends Error {
    constructor(key: string) {
        super(`${key} spans several lines; edit it by hand`);
    }
}

/** The lines of a file, without the newline that ends the last one. */
const linesOf = (text: string): string[] => {
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
};

/** Every assignment in the file, in order. */
export function scan(text: string): Assignment[] {
    const found: Assignment[] = [];
    let open: '"' | "'" | null = null;
    linesOf(text).forEach((original, index) => {
        if (open !== null) {
            // Inside a multi-line value: skip it rather than mistaking one of
            // its lines for an assignment.
            if (open === '"' ? CLOSES_DOUBLE.test(original) : original.includes("'")) {
                open = null;
            }
            return;
        }
        let line = original.trimStart();
        if (line === '' || line.startsWith('#')) {
            return;
        }
        if (/^export\s/.test(line)) {
            line = line.slice('export'.length).trimStart();
        }
        const equals = line.indexOf('=');
        if (equals < 0) {
            return;
        }
        const key = line.slice(0, equals).trimEnd();
        if (!isValidKey(key)) {
            return;
        }
        const raw = line.slice(equals + 1).replace(/^[ \t]+/, '');
        if (raw.startsWith('"')) {
            const match = DOUBLE.exec(raw);
            if (match) {
                found.push({ line: index, key, quoting: 'double', body: match[1] ?? '' });
            } else {
                open = '"';
                found.push({ line: index, key, quoting: 'multiline', body: '' });
            }
        } else if (raw.startsWith("'")) {
            const match = SINGLE.exec(raw);
            if (match) {
                found.push({ line: index, key, quoting: 'single', body: match[1] ?? '' });
            } else {
                open = "'";
                found.push({ line: index, key, quoting: 'multiline', body: '' });
            }
        } else {
            // Unquoted: ` #` starts a comment, trailing whitespace is trimmed.
            const comment = /\s#/.exec(raw);
            const body = (comment ? raw.slice(0, comment.index) : raw).trimEnd();
            found.push({ line: index, key, quoting: 'unquoted', body });
        }
    });
    return found;
}

const ESCAPES: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    '\\': '\\',
    '"': '"',
    "'": "'",
    $: '$',
};

/**
 * The value Compose hands on. One pass, so `\\n` is a backslash followed by
 * `n` rather than a newline.
 */
export function decode(assignment: Assignment): string {
    switch (assignment.quoting) {
        case 'multiline':
            throw new MultilineValueError(assignment.key);
        case 'single':
            // Literal; a backslash before a quote is the only escape.
            return assignment.body.replaceAll("\\'", "'");
        default:
            return assignment.body.replace(/\\([\s\S])|\$\$/g, (whole, escaped?: string) =>
                escaped === undefined ? '$' : (ESCAPES[escaped] ?? whole),
            );
    }
}

/**
 * The inside of a double-quoted value. Backslashes first: later substitutions
 * introduce their own, which must not be escaped a second time.
 */
export const encode = (value: string): string =>
    value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        // A function, because `$$` in a replacement string means one `$`.
        .replaceAll('$', () => '$$')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
        .replaceAll('\t', '\\t');

/** One line: `KEY="encoded"`. */
export function serialize(key: string, value: string): string {
    if (!isValidKey(key)) {
        throw new Error(`${JSON.stringify(key)} is not a valid variable name`);
    }
    return `${key}="${encode(value)}"`;
}

/** A whole file of fresh assignments, with an optional comment header. */
export function serializeAll(entries: readonly (readonly [string, string])[], header = ''): string {
    return header + entries.map(([key, value]) => `${serialize(key, value)}\n`).join('');
}

/** The last assignment of a key, which is the one Compose uses. */
const lastAssignment = (text: string, key: string): Assignment | undefined =>
    scan(text).findLast((assignment) => assignment.key === key);

/** The decoded value, or undefined when the key is absent. */
export function get(text: string, key: string): string | undefined {
    const assignment = lastAssignment(text, key);
    return assignment === undefined ? undefined : decode(assignment);
}

/** Every key, once, in the order of its first assignment; multi-line ones excluded. */
export function keys(text: string): string[] {
    return [
        ...new Set(
            scan(text)
                .filter((assignment) => assignment.quoting !== 'multiline')
                .map((assignment) => assignment.key),
        ),
    ];
}

/** Every decodable value; the last assignment of each key wins. */
export function toRecord(text: string): Record<string, string> {
    const record: Record<string, string> = {};
    for (const assignment of scan(text)) {
        if (assignment.quoting !== 'multiline') {
            record[assignment.key] = decode(assignment);
        }
    }
    return record;
}

/**
 * The file with KEY set to VALUE: the existing assignment replaced in place,
 * keeping its position and the comments around it, or a new one appended.
 */
export function set(text: string, key: string, value: string): string {
    const line = serialize(key, value);
    const assignment = lastAssignment(text, key);
    const lines = linesOf(text);
    if (assignment === undefined) {
        lines.push(line);
    } else if (assignment.quoting === 'multiline') {
        throw new MultilineValueError(key);
    } else {
        lines[assignment.line] = line;
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Keys whose value, as written, Compose will interpolate: a `$` that is not
 * doubled or escaped. The value the operator meant is probably not what the
 * container receives.
 */
export function lint(text: string): string[] {
    return scan(text)
        .filter(({ quoting }) => quoting === 'double' || quoting === 'unquoted')
        .filter(({ body }) =>
            body.replaceAll('\\\\', '').replaceAll('\\$', '').replaceAll('$$', '').includes('$'),
        )
        .map(({ key }) => key);
}
