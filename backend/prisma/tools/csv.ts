/**
 * RFC 4180 CSV for the JNE mapping tools: quoted fields may hold commas, doubled
 * quotes and NEWLINES (JNE's own master has location names with embedded line
 * breaks), CRLF and LF are both accepted, and a UTF-8 byte-order mark is dropped.
 *
 * Splitting on '\n' is exactly the bug this replaces: a single quoted newline
 * shifts every later column of that record and silently corrupts the report.
 */

export class CsvParseError extends Error {}

/** All records, header included, as arrays of field strings. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // Set when a quoted field has just closed: only a delimiter or line end may follow.
  let closed = false;
  let line = 1;
  let quoteStartLine = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (closed && ch !== ',' && ch !== '\n' && ch !== '\r') {
      throw new CsvParseError(`line ${line}: text after a closing quote`);
    }
    if (ch === '"') {
      if (field !== '') throw new CsvParseError(`line ${line}: quote inside an unquoted field`);
      quoted = true;
      quoteStartLine = line;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      closed = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closed = false;
      line++;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new CsvParseError(`line ${quoteStartLine}: unterminated quoted field`);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CsvRecord {
  /** 1-based record number after the header - stable across embedded newlines. */
  record: number;
  values: Record<string, string>;
}

/**
 * Records keyed by header name. Every record must have exactly the header's field
 * count; a short or long record is an error, never padded or truncated.
 */
export function parseCsvRecords(text: string, required: readonly string[] = []): { header: string[]; records: CsvRecord[] } {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
  if (rows.length === 0) throw new CsvParseError('empty file: no header');
  const header = rows[0].map((h) => h.trim());
  const missing = required.filter((h) => !header.includes(h));
  if (missing.length) throw new CsvParseError(`missing column(s): ${missing.join(', ')}`);
  const records = rows.slice(1).map((r, i) => {
    if (r.length !== header.length) {
      throw new CsvParseError(`record ${i + 1}: ${r.length} field(s), header has ${header.length}`);
    }
    return { record: i + 1, values: Object.fromEntries(header.map((h, j) => [h, r[j]])) };
  });
  return { header, records };
}

function escapeField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize rows (header first) so that parseCsv reads back exactly the same values. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  return [header.map(escapeField).join(','), ...rows.map((r) => header.map((h) => escapeField(r[h])).join(','))].join('\n') + '\n';
}
