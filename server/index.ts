// Local server: serves the page and relays between the browser and Gemini Live.
// All API keys stay in this process. The browser never sees them.
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { GeminiLive, MODEL } from './gemini.ts';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node 22 or newer is required (you have ${process.versions.node}). Run "nvm use" in this folder.`);
  process.exit(1);
}
try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  // no .env file; the page will explain what is missing
}

const PORT = Number(process.env.PORT) || 3210;
const ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

// Tags on binary messages from the browser
const TAG_AUDIO = 1;

const app = express();
app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
const server = createServer(app);

// Only pages served by this app may open the socket, not other sites in the browser.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }: { origin: string }) => ORIGINS.includes(origin),
});

wss.on('connection', (ws: WebSocket) => {
  const send = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  let gemini: GeminiLive | undefined;

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (data[0] === TAG_AUDIO) gemini?.sendAudio(data.subarray(1));
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'start' && !gemini) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return send({ type: 'status', state: 'closed', detail: 'GEMINI_API_KEY is missing. Add it to .env and restart.' });
      gemini = new GeminiLive(apiKey, {
        status: (state, detail) => send({ type: 'status', state, detail }),
        audio: (pcm) => ws.readyState === ws.OPEN && ws.send(pcm),
        interrupted: () => send({ type: 'interrupted' }),
        transcript: (role, text) => send({ type: 'transcript', role, text }),
        turnComplete: () => send({ type: 'turnComplete' }),
      });
      gemini.start();
    }
  });

  ws.on('close', () => gemini?.stop());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Voice pair programmer: http://localhost:${PORT}  (model: ${MODEL})`);
  if (!process.env.GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is set in your environment. Claude Code would bill the API instead of your subscription. Unset it and restart.');
  }
});
