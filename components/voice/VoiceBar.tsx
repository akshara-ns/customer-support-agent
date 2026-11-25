"use client";

import type { useVoice } from "@/components/voice/useVoice";
import { voiceStatusLabel, voiceTimer } from "@/components/voice/voiceLabels";
import { Waveform } from "@/components/voice/Waveform";

type Voice = ReturnType<typeof useVoice>;

export function VoiceBar({ voice, allowClips = false }: { voice: Voice; allowClips?: boolean }) {
  const active = voice.state === "live" || voice.state === "connecting" || voice.state === "reconnecting";
  return (
    <div className={`voice-bar voice-${voice.state}`} role="region" aria-label="Voice mode">
      <div className="voice-row">
        {voice.state === "live" ? (
          <span className={`activity activity-${voice.activity}`} role="status" aria-live="polite">
            <span className="activity-dot" aria-hidden="true" />
            {voiceStatusLabel(voice.state, voice.activity)}
          </span>
        ) : (
          <span className={`pill pill-${voice.state}`} role="status" aria-live="polite">
            {voiceStatusLabel(voice.state, voice.activity)}
          </span>
        )}
        {voice.state === "live" && <span className="mono small">{voiceTimer(voice.elapsed, voice.maxSeconds)}</span>}
        <span className="spacer" />
        {!active && (
          <>
            <button type="button" onClick={() => void voice.start("mic")}>
              {voice.state === "idle" ? "Start voice" : "Start again"}
            </button>
            {allowClips && (
              <button type="button" className="secondary" onClick={() => void voice.start("clips")}>
                Start with test clips
              </button>
            )}
          </>
        )}
        {voice.state === "reconnecting" && (
          <button type="button" onClick={voice.restart}>
            Restart voice (same session)
          </button>
        )}
        {active && (
          <button type="button" className="secondary" onClick={() => voice.stop()}>
            End voice
          </button>
        )}
      </div>
      {active && (
        <div className="voice-row">
          <Waveform analyser={voice.micAnalyser} color="#2563eb" label={voice.mode === "clips" ? "Caller (test clips)" : "You"} />
          <Waveform analyser={voice.agentAnalyser} color="#16a34a" label="Agent" />
        </div>
      )}
      {voice.state === "reconnecting" && <p className="small">The connection dropped. Restart to continue the same conversation.</p>}
      {voice.endedReason && voice.state === "ended" && <p className="small muted">{voice.endedReason}</p>}
      {voice.error && <p className="small error-text">{voice.error}</p>}
    </div>
  );
}
