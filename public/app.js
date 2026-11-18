// Browser side: captures the mic (and optionally the screen), streams them to the
// local server, and plays Gemini's audio.
const TAG_AUDIO = 1;
const TAG_VIDEO = 2;
const FRAME_MS = 1000; // send at most one screen frame per second
const FRAME_MAX = 1280; // longest side of a sent frame, in pixels
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
let screenStream, screenVideo; // screenVideo is only used where frames can't be read directly
let frameBusy = false;
let lastFrame = 0;

$('toggle').onclick = () => (running ? stop() : start().catch(fail));
$('share').onclick = () => (screenStream ? stopShare() : startShare().catch(shareFailed));

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
  $('share').disabled = false;

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
    // Fallback screen capture is driven from here, not a timer: browsers slow
    // timers down in background tabs, and this page is usually in the background.
    if (screenVideo?.videoWidth) sendFrame(screenVideo, screenVideo.videoWidth, screenVideo.videoHeight);
  };
  captureCtx.createMediaStreamSource(micStream).connect(capture);
}

function stop() {
  running = false;
  stopShare();
  $('share').disabled = true;
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

async function startShare() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
  if (!running) return stream.getTracks().forEach((t) => t.stop());
  screenStream = stream;
  const track = stream.getVideoTracks()[0];
  track.onended = stopShare; // the browser's own "Stop sharing" button
  $('share').textContent = 'Stop sharing';
  $('screen').dataset.on = 'true';
  $('sharing').hidden = false;
  lastFrame = 0;

  if (window.MediaStreamTrackProcessor) {
    // Chrome and Edge: read frames straight off the track. Works in a background tab.
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      await sendFrame(frame, frame.displayWidth, frame.displayHeight);
      frame.close();
    }
  } else {
    screenVideo = document.createElement('video');
    screenVideo.muted = true;
    screenVideo.srcObject = stream;
    await screenVideo.play();
  }
}

function stopShare() {
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = screenVideo = undefined;
  $('share').textContent = 'Share screen';
  $('screen').dataset.on = 'false';
  $('sharing').hidden = true;
}

function shareFailed(err) {
  stopShare();
  if (err.name !== 'NotAllowedError') showDetail(`Screen sharing failed: ${err.message}`); // NotAllowedError: you cancelled the picker
}

// Sends one screen frame as a JPEG, unless one was sent less than FRAME_MS ago.
async function sendFrame(source, width, height) {
  const now = performance.now();
  if (frameBusy || now - lastFrame < FRAME_MS) return;
  frameBusy = true;
  lastFrame = now;
  try {
    const scale = Math.min(1, FRAME_MAX / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    sendBinary(TAG_VIDEO, await jpeg.arrayBuffer());

    const preview = $('preview');
    preview.width = 320;
    preview.height = Math.round((320 * h) / w);
    preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
  } finally {
    frameBusy = false;
  }
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
