/**
 * Print Resi — the ONLY stylesheet of the 100 x 150 mm packing slip.
 *
 * Isolated: every rule is scoped to `.print-resi-root` / `.resi-*`, and the sheet is
 * injected only while a print job is active (so `@page` and the print-only hiding
 * never affect the normal Order Detail page or a plain Ctrl+P of it).
 *
 *  - @page 100mm x 150mm, margin 0: the browser has no margin box to draw its own
 *    header/footer into, and the slip's 3 mm safe area is padding INSIDE the sheet.
 *  - The first sheet is 149.5 mm tall with overflow hidden so sub-pixel rounding can
 *    never spill a blank second page; real overflow is handled before printing
 *    (scale down, then a deliberate continuation page — see nextFitStep).
 *  - Monochrome: black text/borders/bars on white; logos are printed in grayscale.
 *  - Off screen (but laid out, so it can be measured) until the print media applies.
 */
export const PRINT_RESI_CSS = `
@page { size: 100mm 150mm; margin: 0; }
.print-resi-root { position: fixed; top: 0; left: -1000mm; visibility: hidden; pointer-events: none; z-index: -1; }
.print-resi-root, .print-resi-root * { box-sizing: border-box; }
.resi-sheet {
  width: 100mm; height: 149.5mm; padding: 3mm; overflow: hidden;
  display: flex; flex-direction: column; gap: 1.5mm;
  background: #fff; color: #000;
  font-family: Arial, Helvetica, sans-serif; font-size: 7pt; line-height: 1.25;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  break-after: page; page-break-after: always;
}
.resi-sheet:last-child { break-after: auto; page-break-after: auto; }
.resi-sheet--continuation { height: auto; min-height: 0; overflow: visible; display: block; }
.resi-sheet--continuation > * + * { margin-top: 1.5mm; }
.resi-box { border: 0.35mm solid #000; padding: 1.8mm 2.2mm; min-width: 0; }
.resi-header { flex: none; display: grid; grid-template-columns: 17mm 1fr; gap: 2.5mm; align-items: center; }
.resi-logo { display: block; width: 17mm; height: 17mm; object-fit: contain; filter: grayscale(1); }
.resi-title { margin: 0 0 1mm; font-size: 13pt; font-weight: 800; letter-spacing: 0.02em; text-align: center; }
.resi-meta { display: grid; grid-template-columns: auto auto minmax(0, 1fr); column-gap: 1mm; row-gap: 0.3mm; margin: 0; font-size: 7pt; }
.resi-meta dt, .resi-meta dd { margin: 0; }
.resi-strong { font-weight: 700; }
.resi-wrap { overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
.resi-middle { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5mm; }
.resi-col { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.resi-h { flex: none; display: flex; justify-content: space-between; gap: 1mm; margin: 0 0 1mm; padding-bottom: 0.6mm; border-bottom: 0.35mm solid #000; font-size: 8pt; font-weight: 800; }
.resi-h small { font-size: 7pt; font-weight: 700; }
.resi-col-body { flex: 1 1 auto; min-height: 0; overflow: hidden; font-size: calc(7pt * var(--resi-scale, 1)); }
.resi-sheet--continuation .resi-col-body { overflow: visible; }
.resi-col-body p { margin: 0 0 0.6mm; }
.resi-name { font-size: 1.15em; font-weight: 700; }
.resi-items, .resi-sub { list-style: none; margin: 0; padding: 0; }
.resi-item { padding: 0.6mm 0; border-bottom: 0.2mm dashed #000; break-inside: avoid; page-break-inside: avoid; }
.resi-item:last-child { border-bottom: 0; }
.resi-item-head { display: flex; gap: 1mm; font-weight: 700; }
.resi-qty { flex: none; }
.resi-sub { padding-left: 3mm; }
.resi-note { font-style: italic; }
.resi-source { margin: 0 0 0.8mm; font-size: 0.9em; font-style: italic; }
.resi-continued { margin-top: 0.8mm; font-weight: 700; }
.resi-ship { flex: none; padding-left: 0; padding-right: 0; }
/* The barcode spans the box border-to-border (93 mm budget); everything else keeps the box inset. */
.resi-ship > :not(.resi-barcode) { margin-left: 2.2mm; margin-right: 2.2mm; }
.resi-ship > .resi-barcode { margin: 1.2mm auto 0; }
.resi-ship-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; min-height: 8mm; }
.resi-courier-logo { display: block; height: 8mm; max-width: 30mm; object-fit: contain; filter: grayscale(1); }
/* Source logos are colour artwork: JNE on a light checkerboard (lifted to white), Paxel white-on-purple (inverted to dark-on-light so a thermal head does not print a solid block). */
.resi-courier-logo[data-courier="jne"] { filter: grayscale(1) contrast(1.5) brightness(1.08); }
.resi-courier-logo[data-courier="paxel"] { filter: grayscale(1) invert(1) contrast(1.6) brightness(1.15); }
.resi-courier-name { font-size: 11pt; font-weight: 800; }
.resi-service { font-size: 7pt; text-align: right; }
.resi-awb-line { margin: 1mm 0 0; font-size: 8pt; }
.resi-awb { font-size: 9pt; font-weight: 800; }
.resi-barcode { display: block; margin: 1.2mm auto 0; max-width: none; }
.resi-barcode-text { margin: 0.5mm 0 0; text-align: center; font-family: 'Courier New', Courier, monospace; font-size: 8pt; letter-spacing: 0.04em; }
.resi-cont-head { font-size: 8pt; font-weight: 700; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.print-resi-root) { display: none !important; }
  .print-resi-root { position: static !important; left: auto !important; visibility: visible !important; z-index: auto !important; }
}
`;
