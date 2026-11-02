import type { ExportTable } from './export-table';

/** A spreadsheet cell's leading characters that Excel would run as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string): string {
  // Neutralise formula injection, then quote per RFC 4180.
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The table as CSV that opens correctly in Excel: UTF-8 with a byte-order mark
 * (so Arabic is read as Arabic), CRLF line ends, every cell quoted.
 */
export function toCsv(table: ExportTable): string {
  const lines = [table.headings, ...table.rows].map((row) => row.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
