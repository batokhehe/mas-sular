import { code128Bars, encodeCode128 } from '@/lib/barcode/code128';

/**
 * Code 128 barcode as a crisp, scalable SVG (never rasterized). Encodes `value`
 * EXACTLY (automatic set B/C — digit runs packed in set C); renders nothing when it
 * cannot (empty, non-printable, non-ASCII). `widthMm`/`heightMm` give it a physical
 * size for print; otherwise it is sized by `className`.
 */
export function Code128Barcode({
  value,
  height = 64,
  className,
  widthMm,
  heightMm,
}: {
  value: string;
  height?: number;
  className?: string;
  widthMm?: number;
  heightMm?: number;
}) {
  const encoding = encodeCode128(value);
  if (!encoding) return null;
  const width = encoding.totalModules;
  return (
    <svg
      data-slot="code128"
      data-value={value}
      role="img"
      aria-label={`Barcode ${value}`}
      viewBox={`0 0 ${width} ${height}`}
      width={widthMm ? `${widthMm}mm` : undefined}
      height={heightMm ? `${heightMm}mm` : undefined}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={className}
    >
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" />
      {code128Bars(encoding.modules).map(([x, w]) => (
        <rect key={x} x={x} y={0} width={w} height={height} fill="#000000" />
      ))}
    </svg>
  );
}
