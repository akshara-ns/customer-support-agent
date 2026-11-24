"use client";

import { useEffect, useRef } from "react";

/** Live time-domain waveform of an AnalyserNode (flat line when there is no signal). */
export function Waveform({ analyser, color, label }: { analyser: AnalyserNode | null; color: string; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    const data = new Uint8Array(analyser?.fftSize ?? 1024);
    let raf = 0;
    const draw = () => {
      const { width, height } = el;
      g.clearRect(0, 0, width, height);
      g.lineWidth = 2;
      g.strokeStyle = color;
      g.beginPath();
      if (analyser) analyser.getByteTimeDomainData(data);
      else data.fill(128);
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * width;
        const y = (data[i] / 255) * height;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, color]);

  return (
    <div className="waveform">
      <span className="small muted">{label}</span>
      <canvas ref={canvas} width={240} height={40} aria-label={`${label} audio waveform`} />
    </div>
  );
}
