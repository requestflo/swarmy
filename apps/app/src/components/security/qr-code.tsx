import * as React from 'react';
import { encodeQr, qrSvgPath } from './qr';

interface QrCodeProps {
  value: string;
  /** Rendered edge length in px. */
  size?: number;
  label: string;
}

/** A QR code as inline SVG (dark modules on white, 4-module quiet zone). */
export function QrCode({ value, size = 192, label }: QrCodeProps): React.JSX.Element {
  const { d, dim } = React.useMemo(() => {
    const qr = encodeQr(value);
    return { d: qrSvgPath(qr), dim: qr.size + 8 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className="rounded-md"
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
