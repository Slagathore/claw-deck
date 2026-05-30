import React, { useEffect, useRef, useState } from 'react';

interface Props {
  src: string;                  // full-screen data URL
  onCancel: () => void;
  onCrop: (dataUrl: string) => void;
}

/**
 * Renderer-only region selector. Loads the captured full-screen image,
 * lets the user drag a rectangle, and crops via canvas. No main-process
 * overlay window required.
 */
export default function RegionSelect({ src, onCancel, onCrop }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  function onMouseDown(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    startRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDrag({ x: startRef.current.x, y: startRef.current.y, w: 0, h: 0 });
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!startRef.current) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setDrag({
      x: Math.min(startRef.current.x, cx),
      y: Math.min(startRef.current.y, cy),
      w: Math.abs(cx - startRef.current.x),
      h: Math.abs(cy - startRef.current.y)
    });
  }
  function onMouseUp() {
    const img = imgRef.current;
    if (!img || !drag || drag.w < 4 || drag.h < 4) { startRef.current = null; setDrag(null); return; }
    // map displayed coords -> natural coords
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const sx = drag.x * scaleX, sy = drag.y * scaleY;
    const sw = drag.w * scaleX, sh = drag.h * scaleY;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(sw));
    canvas.height = Math.max(1, Math.floor(sh));
    const ctx = canvas.getContext('2d');
    if (!ctx) { onCancel(); return; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    onCrop(canvas.toDataURL('image/png'));
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.85)',
      display: 'flex', flexDirection: 'column'
    }}>
      <div className="row" style={{ padding: 10, color: 'var(--text)' }}>
        <b>Drag to select a region</b>
        <span className="label">Esc to cancel</span>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel}>Cancel</button>
      </div>
      <div
        style={{ flex: 1, position: 'relative', overflow: 'auto', cursor: 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        <img
          ref={imgRef}
          src={src}
          onLoad={() => setLoaded(true)}
          draggable={false}
          style={{ maxWidth: '100%', display: 'block', userSelect: 'none', pointerEvents: 'none' }}
        />
        {drag && loaded && (
          <div style={{
            position: 'absolute',
            left: drag.x, top: drag.y + 0, // image is at top of scroll container; adjust if needed
            width: drag.w, height: drag.h,
            border: '2px dashed var(--accent)',
            background: 'rgba(124,156,255,.15)',
            pointerEvents: 'none'
          }} />
        )}
      </div>
    </div>
  );
}
