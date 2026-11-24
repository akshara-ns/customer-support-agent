"use client";

import { useEffect, useState } from "react";
import type { useVoice } from "@/components/voice/useVoice";

type Voice = ReturnType<typeof useVoice>;
interface Clip {
  id: string;
  label: string;
  text: string;
}

/** /voice-debug: connection state, data-channel events, interruptions, test clips. */
export function VoiceDebugPanel({ voice }: { voice: Voice }) {
  const [clips, setClips] = useState<Clip[]>([]);
  useEffect(() => {
    fetch("/voice-test/clips.json")
      .then((r) => r.json())
      .then(setClips)
      .catch(() => {});
  }, []);

  return (
    <div className="voice-debug small">
      <div className="debug-grid">
        <div>
          <strong>Connection</strong>
          <div className="mono">
            state={voice.state} pc={voice.conn.pc} ice={voice.conn.ice} dc={voice.conn.dc}
          </div>
          <div className="mono">realtime cost≈${voice.costUsd.toFixed(4)}</div>
        </div>
        <div>
          <strong>Interruptions</strong>
          {voice.interruptions.length === 0 && <div className="muted">none yet</div>}
          {voice.interruptions.map((i) => (
            <div key={i.at} className="mono">
              mute {i.muteMs}ms after speech_started
              {i.fromSpeechOnsetMs !== null && ` · ${i.fromSpeechOnsetMs}ms after caller started`} · heard≈{i.heardMs}ms · truncation {i.truncation}
            </div>
          ))}
        </div>
      </div>
      {voice.mode === "clips" && voice.state === "live" && (
        <div className="clip-row">
          {clips.map((c) => (
            <button key={c.id} type="button" className="secondary" title={c.text} onClick={() => void voice.playClip(c.id)}>
              {c.label}
            </button>
          ))}
          <button type="button" className="secondary" onClick={voice.simulateDrop}>
            Simulate network drop
          </button>
        </div>
      )}
      <details open>
        <summary>Data-channel events ({voice.log.length})</summary>
        <ol className="event-log mono" data-testid="voice-log">
          {voice.log.slice(-60).map((e, i) => (
            <li key={`${e.t}-${i}`}>
              {new Date(e.t).toISOString().slice(11, 23)} {e.dir === "in" ? "←" : e.dir === "out" ? "→" : "•"} {e.type}
              {e.detail ? ` ${e.detail}` : ""}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
