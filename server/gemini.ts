// One Gemini Live session: connects, relays audio, and reconnects on its own.
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';

export const MODEL = 'gemini-3.8-live';

const SYSTEM_PROMPT = `You are a concise, friendly pair programmer talking with a developer by voice.

Rules:
- Keep spoken replies short: one or two sentences unless asked for more.
- Don't repeat back what the developer said.
- If you didn't clearly hear something, ask instead of guessing.
- The developer can share their screen. When they do, you get it as video frames, about one per second. Use what you see to answer, and refer to code, files, and errors by what is on screen.
- If nothing is shared, or the text is too small to read, say so instead of guessing.`;

export type Status = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface GeminiHandlers {
  status(state: Status, detail?: string): void;
  audio(pcm24k: Buffer): void;
  interrupted(): void;
  transcript(role: 'user' | 'gemini', text: string): void;
  turnComplete(): void;
}

const MAX_RETRIES = 5;

export class GeminiLive {
  private ai: GoogleGenAI;
  private session?: Session;
  private handle?: string; // latest session resumption handle
  private generation = 0; // bumps on every connect, so stale callbacks are ignored
  private retries = 0;
  private stopped = false;

  constructor(apiKey: string, private on: GeminiHandlers) {
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  }

  start() {
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.session?.close();
    this.session = undefined;
  }

  sendAudio(pcm16k: Buffer) {
    this.session?.sendRealtimeInput({
      audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  sendVideo(jpeg: Buffer) {
    this.session?.sendRealtimeInput({
      video: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
    });
  }

  private async connect() {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.session?.close();
    this.session = undefined;
    this.on.status(this.handle || this.retries ? 'reconnecting' : 'connecting');

    try {
      const session = await this.ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_PROMPT,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Without these two, audio+video sessions end after about 2 minutes
          // and every connection ends after about 10.
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: { handle: this.handle },
        },
        callbacks: {
          onmessage: (m) => gen === this.generation && this.onMessage(m),
          onerror: (e) => console.error('[gemini] error:', e.message),
          onclose: (e) => gen === this.generation && this.retry(e.reason || `closed (code ${e.code})`),
        },
      });
      if (gen !== this.generation) return session.close();
      this.session = session;
    } catch (err) {
      if (gen === this.generation) this.retry(err instanceof Error ? err.message : String(err));
    }
  }

  private retry(reason: string) {
    this.session = undefined;
    if (this.stopped) return;
    console.error('[gemini] disconnected:', reason);
    if (++this.retries > MAX_RETRIES) {
      this.stopped = true;
      return this.on.status('closed', reason);
    }
    if (this.retries > 2) this.handle = undefined; // the handle may have expired; start fresh
    this.on.status('reconnecting', reason);
    setTimeout(() => void this.connect(), Math.min(1000 * 2 ** (this.retries - 1), 10_000));
  }

  private onMessage(m: LiveServerMessage) {
    if (process.env.DEBUG) {
      // Raw server messages, with audio payloads shortened
      console.log('[gemini]', JSON.stringify(m, (k, v) => (k === 'data' && typeof v === 'string' ? `<${v.length} chars>` : v)));
    }
    if (m.setupComplete) {
      this.retries = 0;
      this.on.status('connected');
    }
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.goAway) {
      // The server is about to drop this connection: move to a new one now.
      console.log('[gemini] goAway, time left:', m.goAway.timeLeft);
      void this.connect();
      return;
    }

    const content = m.serverContent;
    if (!content) return;
    if (content.interrupted) this.on.interrupted();
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) this.on.audio(Buffer.from(part.inlineData.data, 'base64'));
    }
    if (content.inputTranscription?.text) this.on.transcript('user', content.inputTranscription.text);
    if (content.outputTranscription?.text) this.on.transcript('gemini', content.outputTranscription.text);
    if (content.turnComplete) this.on.turnComplete();
  }
}
