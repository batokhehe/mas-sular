import { code128Bars, encodeCode128B, QUIET_ZONE_MODULES } from '@/lib/barcode/code128';

/**
 * Code 128 barcode as a crisp, scalable SVG (never rasterized). Encodes `value`
 * EXACTLY; renders nothing when it cannot (empty, non-printable, non-ASCII).
 */
export function Code128Barcode({ value, height = 64, className }: { value: string; height?: number; className?: string }) {
  const encoding = encodeCode128B(value);
  if (!encoding) return null;
  const width = encoding.modules.length + QUIET_ZONE_MODULES * 2;
  return (
    <svg
      data-slot="code128"
      role="img"
      aria-label={`Barcode ${value}`}
      viewBox={`0 0 ${width} ${height}`}
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
