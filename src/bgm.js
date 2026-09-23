// An original, looping field-day rhythm made with Web Audio. Nothing is fetched.
const TEMPO = 116;
const STEP_SECONDS = 60 / TEMPO / 4;
const LOOKAHEAD_SECONDS = 0.2;

let context;
let master;
let noiseBuffer;
let scheduler;
let nextStepTime = 0;
let stepIndex = 0;

function createNoiseBuffer() {
  const length = Math.round(context.sampleRate * 0.4);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) samples[index] = Math.random() * 2 - 1;
  return buffer;
}

function playTone(time, frequency, duration, volume, type = 'sine') {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, time);
  gain.gain.setValueAtTime(0.001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  oscillator.connect(gain).connect(master);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.01);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}

function playNoise(time, duration, volume, frequency, type = 'bandpass') {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = noiseBuffer;
  filter.type = type;
  filter.frequency.setValueAtTime(frequency, time);
  filter.Q.value = 0.8;
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  source.connect(filter).connect(gain).connect(master);
  source.start(time);
  source.stop(time + duration);
  source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
}

function playBigDrum(time, strong) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(strong ? 150 : 180, time);
  oscillator.frequency.exponentialRampToValueAtTime(strong ? 54 : 70, time + 0.22);
  gain.gain.setValueAtTime(0.001, time);
  gain.gain.exponentialRampToValueAtTime(strong ? 0.72 : 0.44, time + 0.009);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
  oscillator.connect(gain).connect(master);
  oscillator.start(time);
  oscillator.stop(time + 0.33);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  playNoise(time, 0.08, strong ? 0.11 : 0.07, 780);
}

function playStep(time, absoluteStep) {
  const beat = absoluteStep % 16;
  if (beat === 0 || beat === 8) playBigDrum(time, true);
  if (beat === 4 || beat === 12) {
    playBigDrum(time, false);
    playNoise(time, 0.14, 0.2, 1800);
  }
  if (beat === 2 || beat === 6 || beat === 10 || beat === 14) {
    playTone(time, beat === 14 ? 240 : 275, 0.09, 0.075, 'triangle');
    playNoise(time, 0.055, 0.045, 4800, 'highpass');
  }
  if (beat === 7 || beat === 15) playNoise(time, 0.075, 0.055, 5200, 'highpass');

  // A light pentatonic call sits behind the drum, changing every other bar.
  const notes = absoluteStep % 32 < 16
    ? { 0: 523.25, 3: 587.33, 6: 659.25, 10: 783.99, 14: 659.25 }
    : { 0: 783.99, 3: 659.25, 6: 587.33, 10: 523.25, 14: 587.33 };
  if (notes[beat]) playTone(time, notes[beat], 0.18, 0.045, 'triangle');
}

function schedule() {
  while (nextStepTime < context.currentTime + LOOKAHEAD_SECONDS) {
    playStep(nextStepTime, stepIndex);
    nextStepTime += STEP_SECONDS;
    stepIndex += 1;
  }
}

export async function startBgm() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!context || context.state === 'closed') {
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0.001;
    master.connect(context.destination);
    noiseBuffer = createNoiseBuffer();
  }
  try {
    await context.resume();
  } catch {
    return false;
  }
  if (scheduler) return true;
  master.gain.setTargetAtTime(0.18, context.currentTime, 0.04);
  nextStepTime = context.currentTime + 0.06;
  stepIndex = 0;
  schedule();
  scheduler = window.setInterval(schedule, 80);
  return true;
}

export function stopBgm() {
  if (scheduler) window.clearInterval(scheduler);
  scheduler = undefined;
  if (context && master) master.gain.setTargetAtTime(0.001, context.currentTime, 0.025);
}

window.addEventListener('pagehide', stopBgm);
