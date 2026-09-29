/**
 * Half-duplex guard for a live speech-to-speech session (pure logic, unit-tested).
 *
 * While the agent's audio is audible (and for a short hangover after it) the microphone is not
 * streamed to the model: through speakers, the agent's own voice comes back into the mic and the
 * model's server-side activity detection hears it as the participant "interrupting" — the agent
 * stops mid-sentence, then answers its own echo (repeating the greeting, etc.). The local VAD, which
 * raises its threshold while the agent plays, decides when the participant really is talking; the
 * last few chunks (the pre-roll the VAD needed to make up its mind) are then sent first so the first
 * syllable is not lost.
 */
export class MicGate {
  private ring: string[] = [];
  /** Agent audio is playing (or stopped very recently). */
  agentAudible = false;
  /** The local VAD hears the participant. */
  userSpeaking = false;
  /** Push-to-talk held: always stream. */
  forced = false;

  constructor(readonly prerollChunks = 5) {}

  get closed(): boolean {
    return this.agentAudible && !this.userSpeaking && !this.forced;
  }

  /** What to send for a new mic chunk: the chunk itself, or nothing (kept as pre-roll) while closed. */
  offer(chunk: string): string[] {
    if (!this.closed) return [chunk];
    this.ring.push(chunk);
    if (this.ring.length > this.prerollChunks) this.ring.shift();
    return [];
  }

  /** Take the last `keep` pre-roll chunks (oldest first) and drop the rest. */
  release(keep = this.prerollChunks): string[] {
    const out = keep > 0 ? this.ring.slice(-keep) : [];
    this.ring = [];
    return out;
  }

  get buffered(): number {
    return this.ring.length;
  }
}
