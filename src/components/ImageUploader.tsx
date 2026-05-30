import React, { useRef } from 'react';

interface Props { value: string[]; onChange: (v: string[]) => void; }

export default function ImageUploader({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function pick() { inputRef.current?.click(); }

  function onFiles(files: FileList | null) {
    if (!files) return;
    const reads = Array.from(files).map(f => new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = rej;
      r.readAsDataURL(f);
    }));
    Promise.all(reads).then(urls => onChange([...value, ...urls]));
  }

  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button onClick={pick}>Attach Image(s)</button>
      <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => onFiles(e.target.files)} />
      {value.map((u, i) => (
        <div key={i} style={{ position: 'relative' }}>
          <img src={u} className="thumb" />
          <button
            style={{ position: 'absolute', top: 2, right: 2, padding: '0 6px' }}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >×</button>
        </div>
      ))}
    </div>
  );
}
