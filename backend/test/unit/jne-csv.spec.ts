/**
 * The CSV reader behind the JNE mapping tools. JNE's own master has location names
 * with embedded line breaks; splitting a file on newlines shifted every later column
 * of such a record and silently corrupted an audit report, so these cases are pinned.
 */
import { CsvParseError, parseCsv, parseCsvRecords, toCsv } from '../../prisma/tools/csv';

describe('parseCsv', () => {
  it('keeps a newline inside a quoted field as part of that field', () => {
    const text = 'code,raw_name,kind\nBTH10317,"SERASAN\nTIMUR,NATUNA",DESTINATION\nBDO10104,"BOJONG SOANG,SOREANG",DESTINATION\n';
    expect(parseCsv(text)).toEqual([
      ['code', 'raw_name', 'kind'],
      ['BTH10317', 'SERASAN\nTIMUR,NATUNA', 'DESTINATION'],
      ['BDO10104', 'BOJONG SOANG,SOREANG', 'DESTINATION'],
    ]);
  });

  it('reads doubled quotes, CRLF line endings and a UTF-8 BOM', () => {
    const text = '﻿a,b\r\n"say ""hi""",x\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['say "hi"', 'x'],
    ]);
  });

  it('keeps UTF-8 text intact', () => {
    expect(parseCsv('name\nKecamatan Ñagari – Barat\n')).toEqual([['name'], ['Kecamatan Ñagari – Barat']]);
  });

  it('accepts a missing final newline and empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('refuses an unterminated quote instead of swallowing the rest of the file', () => {
    expect(() => parseCsv('a,b\n"open,1\n2,3\n')).toThrow(CsvParseError);
  });

  it('refuses a quote in the middle of an unquoted field', () => {
    expect(() => parseCsv('a\nab"c\n')).toThrow(/quote inside an unquoted field/);
  });

  it('refuses text after a closing quote instead of gluing it onto the field', () => {
    expect(() => parseCsv('a,b\n"BDO10104"x,1\n')).toThrow(/text after a closing quote/);
    expect(() => parseCsv('a\n"x" \n')).toThrow(/text after a closing quote/);
    // A quoted field followed directly by a delimiter, line end or end of input is fine.
    expect(parseCsv('a,b\n"x","y"\r\n"z",""')).toEqual([
      ['a', 'b'],
      ['x', 'y'],
      ['z', ''],
    ]);
  });
});

describe('parseCsvRecords', () => {
  it('numbers records by record, not by physical line, across embedded newlines', () => {
    const { records } = parseCsvRecords('code,name\nX1,"two\nlines"\nX2,plain\n', ['code']);
    expect(records.map((r) => [r.record, r.values.code])).toEqual([
      [1, 'X1'],
      [2, 'X2'],
    ]);
  });

  it('refuses a missing required column or a record of the wrong width', () => {
    expect(() => parseCsvRecords('a,b\n1,2\n', ['c'])).toThrow(/missing column/);
    expect(() => parseCsvRecords('a,b\n1,2,3\n')).toThrow(/3 field\(s\), header has 2/);
  });
});

describe('toCsv round trip', () => {
  it('writes what parseCsv reads back unchanged', () => {
    const rows = [{ code: 'BTH10317', name: 'SERASAN\nTIMUR, "NATUNA"' }];
    const text = toCsv(['code', 'name'], rows);
    expect(parseCsvRecords(text).records[0].values).toEqual(rows[0]);
  });
});
