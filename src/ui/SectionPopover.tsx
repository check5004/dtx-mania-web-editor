// セクション（Aメロ・サビなど）のメモを付ける小窓。DTXには書かず、作業ファイル（.dtxe.json）に残す。
import { useEffect, useRef, useState } from 'react';
import { toMeasure } from '../dtx/base36';
import { SECTION_COLORS, SECTION_PRESETS, removeSection, sectionColor, setSection, setSectionColor, useSidecar } from '../store/sidecar';

export function SectionPopover({ m, x, y, onClose }: { m: number; x: number; y: number; onClose: () => void }) {
  const sections = useSidecar((s) => s.sections);
  const colors = useSidecar((s) => s.sectionColors);
  const own = sections.find((s) => s.m === m) ?? null;
  const [name, setName] = useState(own?.name ?? '');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 開いたクリックで閉じないように少し待つ
    const t = window.setTimeout(() => window.addEventListener('pointerdown', away), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const commit = (n: string) => {
    const v = n.trim();
    if (!v) return;
    setSection(m, v);
    onClose();
  };
  const color = name.trim() ? sectionColor(name.trim(), colors) : '#8B95A4';

  return (
    <div ref={ref} className="popover" style={{ left: x, top: y, width: 268 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>小節 {toMeasure(m)} からのセクション</b>
        <span className="grow" />
        <button className="ib" style={{ width: 24, height: 24 }} onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="chip-wrap" style={{ marginBottom: 8 }}>
        {SECTION_PRESETS.map((p) => (
          <button
            key={p.name}
            className={`tag ${name === p.name ? 'on' : ''}`}
            style={{ ['--c' as string]: sectionColor(p.name, colors) }}
            onClick={() => commit(p.name)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          commit(name);
        }}
      >
        <span className="dot" style={{ background: color, width: 10, height: 10, flex: 'none' }} />
        <input ref={input} className="field" style={{ height: 28 }} value={name} placeholder="名前（例: サビ2）" onChange={(e) => setName(e.target.value)} />
        <button className="btn small primary" type="submit" disabled={!name.trim()}>
          付ける
        </button>
      </form>
      {name.trim() && (
        <div className="row" style={{ gap: 4, marginTop: 8 }}>
          <span className="lbl" style={{ marginRight: 4 }}>
            色
          </span>
          {SECTION_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${color.toLowerCase() === c.toLowerCase() ? 'on' : ''}`}
              style={{ background: c }}
              title="同じ名前のセクションはすべてこの色になります"
              onClick={() => setSectionColor(name.trim(), c)}
              aria-label={`色 ${c}`}
            />
          ))}
        </div>
      )}
      {own && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn small ghost"
            onClick={() => {
              removeSection(m);
              onClose();
            }}
          >
            前とつなげる（区切りを消す）
          </button>
        </div>
      )}
      <p className="lbl" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>
        同じ名前は同じ色になります。セクションはDTXに入らず、作業ファイル（.dtxe.json）に保存します。
      </p>
    </div>
  );
}
