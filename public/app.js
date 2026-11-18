// Browser side: captures the mic, streams it to the local server, plays Gemini's audio.
const TAG_AUDIO = 1;
const STATUS_TEXT = {
  idle: 'Not started',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

const $ = (id) => document.getElementById(id);
let ws, micStream, captureCtx, playCtx, playback;
let running = false;
let bubble = null; // transcript paragraph currently being filled

$('toggle').onclick = () => (running ? stop() : start().catch(fail));

async function start() {
  running = true;
  $('toggle').textContent = 'Stop';
  $('toggle').className = 'stop';
  $('detail').hidden = true;
  setStatus('connecting');

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  $('mic').dataset.on = 'true';

  // Playback runs at 24 kHz, the rate of Gemini's audio.
  playCtx = new AudioContext({ sampleRate: 24000 });
  await playCtx.audioWorklet.addModule('worklets/playback.js');
  playback = new AudioWorkletNode(playCtx, 'pcm-playback');
  playback.connect(playCtx.destination);

  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
  ws.onmessage = onServerMessage;
  ws.onclose = () => running && fail(new Error('Lost connection to the local server.'));

  // Capture runs at the mic's own rate; the worklet downsamples to 16 kHz.
  captureCtx = new AudioContext();
  await captureCtx.audioWorklet.addModule('worklets/capture.js');
  const capture = new AudioWorkletNode(captureCtx, 'pcm-capture');
  capture.port.onmessage = (e) => {
    showLevel(new Int16Array(e.data));
    sendBinary(TAG_AUDIO, e.data);
  };
  captureCtx.createMediaStreamSource(micStream).connect(capture);
}

function stop() {
  running = false;
  ws?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  captureCtx?.close();
  playCtx?.close();
  $('toggle').textContent = 'Start';
  $('toggle').className = '';
  $('mic').dataset.on = 'false';
  $('level').style.width = '0';
  setStatus('idle');
}

function fail(err) {
  stop();
  setStatus('closed');
  showDetail(err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : err.message);
}

function sendBinary(tag, buffer) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const msg = new Uint8Array(1 + buffer.byteLength);
  msg[0] = tag;
  msg.set(new Uint8Array(buffer), 1);
  ws.send(msg);
}

function onServerMessage(e) {
  if (typeof e.data !== 'string') return playback.port.postMessage(e.data, [e.data]); // Gemini audio
  const msg = JSON.parse(e.data);
  if (msg.type === 'status') {
    setStatus(msg.state);
    if (msg.state === 'closed') fail(new Error(msg.detail || 'Session closed.'));
  } else if (msg.type === 'interrupted') {
    playback.port.postMessage('clear'); // you started talking: cut the voice off now
    bubble = null;
  } else if (msg.type === 'transcript') {
    addTranscript(msg.role, msg.text);
  } else if (msg.type === 'turnComplete') {
    bubble = null;
  }
}

function setStatus(state) {
  $('status').dataset.state = state;
  $('status').textContent = STATUS_TEXT[state];
}

function showDetail(text) {
  $('detail').textContent = text;
  $('detail').hidden = false;
}

function showLevel(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) / 0x8000;
  $('level').style.width = `${Math.min(100, rms * 400)}%`;
}

function addTranscript(role, text) {
  const box = $('transcript');
  box.querySelector('.empty')?.remove();
  if (!bubble || bubble.dataset.role !== role) {
    bubble = document.createElement('p');
    bubble.dataset.role = role;
    bubble.className = role;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Gemini';
    bubble.append(who, document.createTextNode(''));
    box.append(bubble);
  }
  bubble.lastChild.textContent += text;
  box.scrollTop = box.scrollHeight;
}
