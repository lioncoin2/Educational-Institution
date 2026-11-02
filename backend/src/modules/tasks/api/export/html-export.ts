import type { ExportTable } from './export-table';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The table as a self-contained, right-to-left, print-ready page — the browser's
 * "save as PDF" turns it into the PDF export (ADR 0052 §12). Every value is
 * escaped; the page carries no script.
 */
export function toPrintableHtml(
  table: ExportTable,
  meta: {
    readonly title: string;
    readonly filters: readonly string[];
    readonly truncated: boolean;
  },
): string {
  const head = table.headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = table.rows
    .map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
    .join('\n');
  const filters = meta.filters.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  const notice = meta.truncated
    ? '<p class="notice">الملف يعرض أول جزء فقط؛ ضيّقي الفترة لإظهار الباقي.</p>'
    : '';
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title)}</title>
<style>
  body { font-family: system-ui, "Noto Naskh Arabic", sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  ul { margin: 0 0 16px; padding-inline-start: 18px; color: #444; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: start; vertical-align: top; }
  th { background: #eef3f1; }
  tr { break-inside: avoid; }
  .notice { color: #8a4b00; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(meta.title)}</h1>
<ul>${filters}</ul>
${notice}
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table>
</body>
</html>
`;
}
