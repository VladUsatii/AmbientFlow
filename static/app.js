let audioContext = null;
let engineNode = null;
let masterGain = null;
let compressor = null;
let makeupGain = null;
let analysisTapNode = null;
let analysisWorker = null;
let analysisSocket = null;
let spectrumNode = null;
let splitterNode = null;
let leftScopeNode = null;
let rightScopeNode = null;
let spectrumData = null;
let leftData = null;
let rightData = null;
let meterRAF = null;
let autoEvolveTimer = null;
let hasStarted = false;
let currentScene = null;
let currentPrompt = "";
let lastAnalysisSentAt = 0;

const analysisState = {
  salience: 0,
  focusRisk: 0,
  novelty: 0,
  rms: 0,
  centroidHz: 0,
  flux: 0,
  sharpness: 0,
  roughness: 0,
  stereoCorrelation: 1,
  reasons: [],
  salienceHistory: Array(180).fill(0),
  focusRiskHistory: Array(180).fill(0),
};

const promptEl = document.getElementById("prompt");
const modeEl = document.getElementById("mode");
const seedEl = document.getElementById("seed");
const gainEl = document.getElementById("gain");
const autoEvolveEl = document.getElementById("autoEvolve");
const startBtn = document.getElementById("startBtn");
const generateBtn = document.getElementById("generateBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const sceneOutEl = document.getElementById("sceneOut");
const analysisOutEl = document.getElementById("analysisOut");
const meterFillEl = document.getElementById("meterFill");
const generatedPromptEl = document.getElementById("generatedPrompt");
const nextMorphEl = document.getElementById("nextMorph");
const canvasEl = document.getElementById("vizCanvas");
const canvasCtx = canvasEl.getContext("2d");
const analysisStatusEl = document.getElementById("analysisStatus");
const salienceValueEl = document.getElementById("salienceValue");
const focusRiskValueEl = document.getElementById("focusRiskValue");
const noveltyValueEl = document.getElementById("noveltyValue");
const analysisReasonsEl = document.getElementById("analysisReasons");

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function pushHistory(arr, value) {
  arr.push(value);
  if (arr.length > 180) arr.shift();
}

function wsURL(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setScene(scene) {
  currentScene = scene;
  sceneOutEl.textContent = JSON.stringify(scene, null, 2);
}

function setGeneratedPrompt(text) {
  currentPrompt = text || "";
  generatedPromptEl.textContent = currentPrompt || "—";
}

function renderAnalysisText() {
  if (analysisStatusEl) analysisStatusEl.textContent = hasStarted ? "streaming" : "idle";
  if (salienceValueEl) salienceValueEl.textContent = analysisState.salience.toFixed(2);
  if (focusRiskValueEl) focusRiskValueEl.textContent = analysisState.focusRisk.toFixed(2);
  if (noveltyValueEl) noveltyValueEl.textContent = analysisState.novelty.toFixed(2);

  if (analysisReasonsEl) {
    analysisReasonsEl.textContent = analysisState.reasons.length
      ? analysisState.reasons.join(" • ")
      : "waiting for stable audio features…";
  }

  if (analysisOutEl) {
    analysisOutEl.textContent = JSON.stringify(
      {
        salience: Number(analysisState.salience.toFixed(4)),
        focusRisk: Number(analysisState.focusRisk.toFixed(4)),
        novelty: Number(analysisState.novelty.toFixed(4)),
        rms: Number(analysisState.rms.toFixed(5)),
        centroidHz: Number(analysisState.centroidHz.toFixed(1)),
        flux: Number(analysisState.flux.toFixed(4)),
        sharpness: Number(analysisState.sharpness.toFixed(4)),
        roughness: Number(analysisState.roughness.toFixed(4)),
        stereoCorrelation: Number(analysisState.stereoCorrelation.toFixed(4)),
        reasons: analysisState.reasons,
      },
      null,
      2,
    );
  }
}

function applyAnalysisSummary(summary) {
  if (!summary) return;

  analysisState.salience = clamp(Number(summary.salience || 0), 0, 1);
  analysisState.focusRisk = clamp(Number(summary.focusRisk || 0), 0, 1);
  analysisState.novelty = clamp(Number(summary.novelty || 0), 0, 1);
  analysisState.rms = Number(summary.rms || 0);
  analysisState.centroidHz = Number(summary.centroidHz || 0);
  analysisState.flux = Number(summary.flux || 0);
  analysisState.sharpness = Number(summary.sharpness || 0);
  analysisState.roughness = Number(summary.roughness || 0);
  analysisState.stereoCorrelation = Number(summary.stereoCorrelation ?? 1);
  analysisState.reasons = Array.isArray(summary.reasons) ? summary.reasons : [];

  pushHistory(analysisState.salienceHistory, analysisState.salience);
  pushHistory(analysisState.focusRiskHistory, analysisState.focusRisk);

  renderAnalysisText();
  maybeSendAnalysis(summary);
}

function ensureAnalysisWorker() {
  if (analysisWorker) return;
  analysisWorker = new Worker("/static/analysis-worker.js", { type: "module" });
  analysisWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg?.type === "analysis") {
      applyAnalysisSummary(msg.summary);
    }
  };
}

function ensureAnalysisSocket() {
  if (analysisSocket && (analysisSocket.readyState === WebSocket.OPEN || analysisSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  analysisSocket = new WebSocket(wsURL("/ws/analysis"));
  analysisSocket.onclose = () => {
    analysisSocket = null;
    window.setTimeout(() => {
      if (hasStarted) ensureAnalysisSocket();
    }, 2000);
  };
}

function maybeSendAnalysis(summary) {
  const now = performance.now();
  if (now - lastAnalysisSentAt < 250) return;
  lastAnalysisSentAt = now;

  if (analysisSocket?.readyState === WebSocket.OPEN) {
    analysisSocket.send(
      JSON.stringify({
        t: summary.t,
        salience: summary.salience,
        focusRisk: summary.focusRisk,
        novelty: summary.novelty,
        rms: summary.rms,
        centroidHz: summary.centroidHz,
        flux: summary.flux,
        sharpness: summary.sharpness,
        roughness: summary.roughness,
        stereoCorrelation: summary.stereoCorrelation,
        reasons: summary.reasons,
      }),
    );
  }
}

function clearAutoEvolve() {
  if (autoEvolveTimer) {
    clearTimeout(autoEvolveTimer);
    autoEvolveTimer = null;
  }
  nextMorphEl.textContent = "auto-evolve off";
}

function scheduleAutoEvolve(scene) {
  clearAutoEvolve();
  if (!autoEvolveEl.checked || !scene) return;

  const minMs = Math.max(1000, Number(scene.evolve_every_min_s || 60) * 1000);
  const maxMs = Math.max(minMs + 1000, Number(scene.evolve_every_max_s || 110) * 1000);
  const delayMs = minMs + Math.random() * (maxMs - minMs);
  nextMorphEl.textContent = `next auto-morph in ${(delayMs / 1000).toFixed(0)}s`;

  autoEvolveTimer = setTimeout(() => {
    updateSceneOnly(true).catch((err) => {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    });
  }, delayMs);
}

async function fetchScene(previousScene = null) {
  const rawSeed = seedEl.value.trim();

  const payload = {
    prompt: promptEl.value.trim() || null,
    mode: modeEl.value,
    seed: rawSeed === "" ? null : Number(rawSeed),
    previous_scene: previousScene,
  };

  const res = await fetch("/api/scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || "Failed to generate scene");
  }

  return res.json();
}

async function initAudioIfNeeded() {
  if (audioContext) return;

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/static/ambient-processor.js");
  await audioContext.audioWorklet.addModule("/static/analysis-tap-processor.js");

  engineNode = new AudioWorkletNode(audioContext, "ambient-engine", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  analysisTapNode = new AudioWorkletNode(audioContext, "analysis-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  ensureAnalysisWorker();
  ensureAnalysisSocket();

  analysisTapNode.port.onmessage = (event) => {
    if (event.data?.type === "audio_frame") {
      analysisWorker.postMessage(event.data);
    }
  };

  masterGain = audioContext.createGain();
  compressor = audioContext.createDynamicsCompressor();
  makeupGain = audioContext.createGain();
  spectrumNode = audioContext.createAnalyser();
  splitterNode = audioContext.createChannelSplitter(2);
  leftScopeNode = audioContext.createAnalyser();
  rightScopeNode = audioContext.createAnalyser();

  masterGain.gain.value = Number(gainEl.value) / 100 * 1.6;
  makeupGain.gain.value = 1.35;

  compressor.threshold.value = -20;
  compressor.knee.value = 20;
  compressor.ratio.value = 3.0;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.18;

  spectrumNode.fftSize = 2048;
  spectrumNode.smoothingTimeConstant = 0.82;
  leftScopeNode.fftSize = 2048;
  rightScopeNode.fftSize = 2048;

  spectrumData = new Uint8Array(spectrumNode.frequencyBinCount);
  leftData = new Float32Array(leftScopeNode.fftSize);
  rightData = new Float32Array(rightScopeNode.fftSize);

  engineNode.connect(masterGain);
  masterGain.connect(compressor);
  compressor.connect(makeupGain);
  makeupGain.connect(analysisTapNode);
  analysisTapNode.connect(spectrumNode);
  spectrumNode.connect(audioContext.destination);

  analysisTapNode.connect(splitterNode);
  splitterNode.connect(leftScopeNode, 0);
  splitterNode.connect(rightScopeNode, 1);

  startVisualizerLoop();
  renderAnalysisText();
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.floor(canvasEl.clientWidth * ratio);
  const height = Math.floor(canvasEl.clientHeight * ratio);
  if (canvasEl.width !== width || canvasEl.height !== height) {
    canvasEl.width = width;
    canvasEl.height = height;
  }
}

function drawSpectrum(x, y, width, height) {
  const bins = 140;
  const step = Math.max(1, Math.floor(spectrumData.length / bins));
  const barW = width / bins;

  for (let i = 0; i < bins; i++) {
    const idx = i * step;
    const mag = spectrumData[idx] / 255;
    const barH = Math.max(1, mag * height);
    const bx = x + i * barW;
    canvasCtx.fillStyle = `rgba(${90 + i}, ${140 + i * 0.5}, 255, 0.9)`;
    canvasCtx.fillRect(bx, y + height - barH, Math.max(1, barW - 1), barH);
  }
}

function drawWaveform(x, y, width, height) {
  canvasCtx.beginPath();
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = "rgba(180, 235, 255, 0.95)";

  for (let i = 0; i < leftData.length; i += 2) {
    const px = x + (i / (leftData.length - 1)) * width;
    const py = y + height * 0.5 + (leftData[i] * 0.5 + rightData[i] * 0.5) * height * 0.42;
    if (i === 0) canvasCtx.moveTo(px, py);
    else canvasCtx.lineTo(px, py);
  }
  canvasCtx.stroke();
}

function drawVectorscope(x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const radius = size * 0.42;

  canvasCtx.strokeStyle = "rgba(110, 160, 255, 0.25)";
  canvasCtx.lineWidth = 1;
  canvasCtx.beginPath();
  canvasCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  canvasCtx.stroke();
  canvasCtx.beginPath();
  canvasCtx.moveTo(cx - radius, cy);
  canvasCtx.lineTo(cx + radius, cy);
  canvasCtx.moveTo(cx, cy - radius);
  canvasCtx.lineTo(cx, cy + radius);
  canvasCtx.stroke();

  canvasCtx.fillStyle = "rgba(120, 255, 210, 0.2)";
  for (let i = 0; i < leftData.length; i += 6) {
    const l = leftData[i];
    const r = rightData[i];
    const px = cx + (l - r) * radius;
    const py = cy + (l + r) * radius * 0.65;
    canvasCtx.fillRect(px, py, 1.5, 1.5);
  }
}

function drawSceneMeters(x, y, width, height) {
  if (!currentScene) return;
  const keys = ["brightness", "density", "movement", "warmth", "air", "shimmer"];
  const labels = ["bright", "dense", "move", "warm", "air", "shim"];
  const gap = 10;
  const barW = (width - gap * (keys.length - 1)) / keys.length;

  canvasCtx.font = `${12 * (window.devicePixelRatio || 1)}px Inter, system-ui, sans-serif`;
  canvasCtx.textBaseline = "bottom";

  for (let i = 0; i < keys.length; i++) {
    const value = Math.max(0, Math.min(1, Number(currentScene[keys[i]] || 0)));
    const bx = x + i * (barW + gap);
    const by = y;

    canvasCtx.fillStyle = "rgba(18, 31, 49, 0.95)";
    canvasCtx.fillRect(bx, by, barW, height);

    canvasCtx.fillStyle = "rgba(120, 166, 255, 0.95)";
    canvasCtx.fillRect(bx, by + height * (1 - value), barW, height * value);

    canvasCtx.fillStyle = "rgba(235, 242, 255, 0.95)";
    canvasCtx.fillText(labels[i], bx + 4, by - 6);
  }
}

function drawAnalysisTimeline(x, y, width, height) {
  const a = analysisState.salienceHistory;
  const b = analysisState.focusRiskHistory;

  canvasCtx.fillStyle = "rgba(8, 13, 26, 0.72)";
  canvasCtx.fillRect(x, y, width, height);

  canvasCtx.strokeStyle = "rgba(255,255,255,0.08)";
  canvasCtx.beginPath();
  canvasCtx.moveTo(x, y + height * 0.25);
  canvasCtx.lineTo(x + width, y + height * 0.25);
  canvasCtx.moveTo(x, y + height * 0.5);
  canvasCtx.lineTo(x + width, y + height * 0.5);
  canvasCtx.moveTo(x, y + height * 0.75);
  canvasCtx.lineTo(x + width, y + height * 0.75);
  canvasCtx.stroke();

  const drawLine = (values, stroke) => {
    canvasCtx.beginPath();
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = stroke;

    for (let i = 0; i < values.length; i++) {
      const px = x + (i / Math.max(1, values.length - 1)) * width;
      const py = y + height * (1 - values[i]);
      if (i === 0) canvasCtx.moveTo(px, py);
      else canvasCtx.lineTo(px, py);
    }

    canvasCtx.stroke();
  };

  drawLine(a, "rgba(111, 255, 198, 0.95)");
  drawLine(b, "rgba(255, 166, 111, 0.95)");

  canvasCtx.font = `${11 * (window.devicePixelRatio || 1)}px Inter, system-ui, sans-serif`;
  canvasCtx.fillStyle = "rgba(230, 236, 255, 0.92)";
  canvasCtx.fillText("salience", x + 8, y + 16);
  canvasCtx.fillStyle = "rgba(255, 206, 170, 0.92)";
  canvasCtx.fillText("focus risk", x + 72, y + 16);
}

function drawAnalysisBadges(x, y, width) {
  const badges = [
    ["SAL", analysisState.salience, "rgba(111,255,198,0.95)"],
    ["RISK", analysisState.focusRisk, "rgba(255,166,111,0.95)"],
    ["NOV", analysisState.novelty, "rgba(145,185,255,0.95)"],
  ];

  const gap = 10 * (window.devicePixelRatio || 1);
  const badgeW = Math.min(120 * (window.devicePixelRatio || 1), (width - gap * 2) / 3);
  const badgeH = 44 * (window.devicePixelRatio || 1);

  canvasCtx.font = `${11 * (window.devicePixelRatio || 1)}px Inter, system-ui, sans-serif`;
  canvasCtx.textBaseline = "middle";

  badges.forEach(([label, value, fill], index) => {
    const bx = x + index * (badgeW + gap);

    canvasCtx.fillStyle = "rgba(8, 13, 26, 0.76)";
    canvasCtx.fillRect(bx, y, badgeW, badgeH);

    canvasCtx.fillStyle = "rgba(255,255,255,0.72)";
    canvasCtx.fillText(label, bx + 10, y + badgeH * 0.34);

    canvasCtx.fillStyle = fill;
    canvasCtx.fillText(Number(value).toFixed(2), bx + 10, y + badgeH * 0.72);
  });
}

function drawAnalysisReasons(x, y, width) {
  canvasCtx.fillStyle = "rgba(8, 13, 26, 0.72)";
  canvasCtx.fillRect(x, y, width, 34 * (window.devicePixelRatio || 1));

  canvasCtx.font = `${11 * (window.devicePixelRatio || 1)}px Inter, system-ui, sans-serif`;
  canvasCtx.textBaseline = "middle";
  canvasCtx.fillStyle = "rgba(218, 228, 255, 0.92)";

  const text = analysisState.reasons.length ? analysisState.reasons.join(" • ") : "stable field";
  canvasCtx.fillText(text, x + 10, y + 17 * (window.devicePixelRatio || 1));
}

function startVisualizerLoop() {
  const loop = () => {
    if (!spectrumNode || !leftScopeNode || !rightScopeNode) return;

    resizeCanvas();
    spectrumNode.getByteFrequencyData(spectrumData);
    leftScopeNode.getFloatTimeDomainData(leftData);
    rightScopeNode.getFloatTimeDomainData(rightData);

    const w = canvasEl.width;
    const h = canvasEl.height;

    canvasCtx.clearRect(0, 0, w, h);

    const bg = canvasCtx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#0c1420");
    bg.addColorStop(1, "#0a0f18");
    canvasCtx.fillStyle = bg;
    canvasCtx.fillRect(0, 0, w, h);

    const pad = 18 * (window.devicePixelRatio || 1);
    const spectrumH = h * 0.42;
    const scopeH = h * 0.18;
    const lowerY = pad + spectrumH + scopeH + 18 * (window.devicePixelRatio || 1);
    const rightBlock = h * 0.26;
    const leftWidth = w - pad * 2 - rightBlock - 16 * (window.devicePixelRatio || 1);

    drawSpectrum(pad, pad, w - pad * 2, spectrumH);
    drawWaveform(pad, pad + spectrumH + 10 * (window.devicePixelRatio || 1), w - pad * 2, scopeH);
    drawVectorscope(w - pad - rightBlock, lowerY - 8 * (window.devicePixelRatio || 1), rightBlock);
    drawAnalysisBadges(pad, lowerY, leftWidth);
    drawAnalysisTimeline(pad, lowerY + 54 * (window.devicePixelRatio || 1), leftWidth, h * 0.12);
    drawSceneMeters(
      pad,
      lowerY + 54 * (window.devicePixelRatio || 1) + h * 0.12 + 18 * (window.devicePixelRatio || 1),
      leftWidth,
      h * 0.11,
    );
    drawAnalysisReasons(
      pad,
      lowerY + 54 * (window.devicePixelRatio || 1) + h * 0.12 + 18 * (window.devicePixelRatio || 1) + h * 0.11 + 14 * (window.devicePixelRatio || 1),
      leftWidth,
    );

    let sum = 0;
    for (let i = 0; i < leftData.length; i++) {
      const v = 0.5 * (leftData[i] + rightData[i]);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / leftData.length);
    const pct = Math.max(0, Math.min(100, rms * 240));
    meterFillEl.style.width = `${pct}%`;

    meterRAF = requestAnimationFrame(loop);
  };

  cancelAnimationFrame(meterRAF);
  meterRAF = requestAnimationFrame(loop);
}

async function startAudioAndGenerate() {
  try {
    setStatus("Initializing audio...");
    await initAudioIfNeeded();

    if (audioContext.state !== "running") {
      await audioContext.resume();
    }

    ensureAnalysisSocket();

    const data = await fetchScene(currentScene);
    setGeneratedPrompt(data.prompt);
    setScene(data.scene);

    engineNode.port.postMessage({ type: "scene_init", scene: data.scene });
    hasStarted = true;
    renderAnalysisText();
    scheduleAutoEvolve(data.scene);

    setStatus(`Running. ${data.scene.root} ${data.scene.scale} • ${data.scene.texture_family}`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}

async function updateSceneOnly(isAutomatic = false) {
  try {
    if (!hasStarted) {
      await startAudioAndGenerate();
      return;
    }

    setStatus(isAutomatic ? "Auto-morphing scene..." : "Generating new scene...");

    const data = await fetchScene(currentScene);
    setGeneratedPrompt(data.prompt);
    setScene(data.scene);
    engineNode.port.postMessage({ type: "scene_morph", scene: data.scene });

    scheduleAutoEvolve(data.scene);
    setStatus(`Updated. ${data.scene.root} ${data.scene.scale} • ${data.scene.texture_family}`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}

async function stopAudio() {
  try {
    clearAutoEvolve();
    if (!audioContext) return;
    await audioContext.suspend();
    hasStarted = false;
    renderAnalysisText();
    setStatus("Audio suspended.");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}

gainEl.addEventListener("input", () => {
  if (masterGain) {
    masterGain.gain.value = Number(gainEl.value) / 100 * 1.6;
  }
});

autoEvolveEl.addEventListener("change", () => {
  if (autoEvolveEl.checked) scheduleAutoEvolve(currentScene);
  else clearAutoEvolve();
});

window.addEventListener("resize", resizeCanvas);
startBtn.addEventListener("click", startAudioAndGenerate);
generateBtn.addEventListener("click", () => updateSceneOnly(false));
stopBtn.addEventListener("click", stopAudio);

setStatus("Ready. Click Start Audio.");
setGeneratedPrompt("");
renderAnalysisText();
resizeCanvas();