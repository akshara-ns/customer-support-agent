/** Audio graph for voice: caller input (mic or test clips), level analysers for the waveform, clip playback. */

export interface CallerAudio {
  analyser: AnalyserNode;
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Set in mic mode (stopped on teardown). */
  micStream: MediaStream | null;
  /** Set in clip mode (test clips are played into it). */
  clipDest: MediaStreamAudioDestinationNode | null;
}

function analyser(ctx: AudioContext): AnalyserNode {
  const a = ctx.createAnalyser();
  a.fftSize = 1024;
  return a;
}

/** The outgoing audio track: the microphone, or a destination that test clips are played into. */
export async function createCallerAudio(ctx: AudioContext, mode: "mic" | "clips"): Promise<CallerAudio> {
  const mic = analyser(ctx);
  if (mode === "mic") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ctx.createMediaStreamSource(stream).connect(mic);
    return { analyser: mic, stream, track: stream.getAudioTracks()[0], micStream: stream, clipDest: null };
  }
  const dest = ctx.createMediaStreamDestination();
  // A real mic always has a noise floor. Pure digital silence makes WebRTC stop sending packets
  // (DTX), so the server never hears the silence that ends a turn. Add -60 dB noise.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const ch = noise.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.001;
  const floor = ctx.createBufferSource();
  floor.buffer = noise;
  floor.loop = true;
  floor.connect(dest);
  floor.start();
  return { analyser: mic, stream: dest.stream, track: dest.stream.getAudioTracks()[0], micStream: null, clipDest: dest };
}

/** Level analyser on the agent's incoming audio (for the waveform). */
export function agentAnalyser(ctx: AudioContext, stream: MediaStream): AnalyserNode {
  const a = analyser(ctx);
  ctx.createMediaStreamSource(stream).connect(a);
  return a;
}

/** Plays a pre-recorded caller utterance into the outgoing track; `onStart` runs just before playback. Returns its duration in seconds. */
export async function playClipInto(
  ctx: AudioContext,
  dest: MediaStreamAudioDestinationNode,
  level: AnalyserNode,
  id: string,
  onStart: () => void,
): Promise<number> {
  const buf = await (await fetch(`/voice-test/${id}.mp3`)).arrayBuffer();
  const audio = await ctx.decodeAudioData(buf);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(dest);
  src.connect(level);
  onStart();
  src.start();
  return audio.duration;
}
