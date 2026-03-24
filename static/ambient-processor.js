class AmbientEngine extends AudioWorkletProcessor {
    constructor() {
      super();
  
      this.sceneReady = false;
      this.currentScene = this.sceneOrDefault({});
      this.targetScene = { ...this.currentScene };
  
      this.seed = 1337;
      this.randState = 1337;
      this.time = 0;
  
      this.phaseBank = new Float64Array(128);
      this.prevChord = [110, 165, 247, 330];
      this.currChord = [110, 165, 247, 330];
      this.fadeSamples = 1;
      this.fadeSamplesLeft = 0;
      this.samplesUntilNextChord = sampleRate * 40;
      this.samplesUntilInternalEvolve = sampleRate * 70;
  
      this.noiseLP = 0;
      this.noiseBP = 0;
      this.dcBlockL = 0;
      this.dcBlockR = 0;
      this.lastInL = 0;
      this.lastInR = 0;
  
      this.delayLen = Math.max(1, Math.floor(sampleRate * 1.8));
      this.delayL = new Float32Array(this.delayLen);
      this.delayR = new Float32Array(this.delayLen);
      this.delayIndex = 0;
      this.diffuseL = 0;
      this.diffuseR = 0;
  
      this.numericKeys = [
        "brightness",
        "density",
        "movement",
        "warmth",
        "air",
        "shimmer",
        "noisiness",
        "reverb",
        "stereo_width",
        "sub_amount",
        "detune",
        "drift",
        "master_gain",
        "focus_mod_hz",
        "focus_mod_depth",
        "chord_change_min_s",
        "chord_change_max_s",
        "evolve_every_min_s",
        "evolve_every_max_s",
        "morph_s",
      ];
  
      this.port.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "scene_init") {
          this.loadScene(msg.scene, true);
        } else if (msg.type === "scene_morph") {
          this.loadScene(msg.scene, false);
        }
      };
    }
  
    clamp(x, lo, hi) {
      return Math.max(lo, Math.min(hi, x));
    }
  
    sceneOrDefault(scene) {
      return {
        generated_prompt: scene?.generated_prompt ?? "steady evolving ambient field",
        style_text: scene?.style_text ?? scene?.generated_prompt ?? "steady evolving ambient field",
        mode: scene?.mode ?? "focus",
        seed: scene?.seed ?? 1337,
        root: scene?.root ?? "D",
        scale: scene?.scale ?? "lydian",
        texture_family: scene?.texture_family ?? "mist",
        voice_shape: scene?.voice_shape ?? "hybrid",
        brightness: this.clamp(scene?.brightness ?? 0.48, 0, 1),
        density: this.clamp(scene?.density ?? 0.38, 0, 1),
        movement: this.clamp(scene?.movement ?? 0.24, 0, 1),
        warmth: this.clamp(scene?.warmth ?? 0.58, 0, 1),
        air: this.clamp(scene?.air ?? 0.30, 0, 1),
        shimmer: this.clamp(scene?.shimmer ?? 0.18, 0, 1),
        noisiness: this.clamp(scene?.noisiness ?? 0.14, 0, 1),
        reverb: this.clamp(scene?.reverb ?? 0.45, 0, 1),
        stereo_width: this.clamp(scene?.stereo_width ?? 0.62, 0, 1),
        sub_amount: this.clamp(scene?.sub_amount ?? 0.22, 0, 1),
        detune: this.clamp(scene?.detune ?? 0.10, 0, 1),
        drift: this.clamp(scene?.drift ?? 0.18, 0, 1),
        master_gain: this.clamp(scene?.master_gain ?? 0.32, 0.18, 0.55),
        focus_mod_hz: this.clamp(scene?.focus_mod_hz ?? 14.0, 5, 18),
        focus_mod_depth: this.clamp(scene?.focus_mod_depth ?? 0.012, 0, 0.03),
        chord_change_min_s: Math.max(20, Math.floor(scene?.chord_change_min_s ?? 30)),
        chord_change_max_s: Math.max(30, Math.floor(scene?.chord_change_max_s ?? 60)),
        evolve_every_min_s: Math.max(30, Math.floor(scene?.evolve_every_min_s ?? 60)),
        evolve_every_max_s: Math.max(45, Math.floor(scene?.evolve_every_max_s ?? 110)),
        morph_s: Math.max(6, Math.floor(scene?.morph_s ?? 20)),
      };
    }
  
    rnd() {
      this.randState = (1664525 * this.randState + 1013904223) >>> 0;
      return this.randState / 4294967296;
    }
  
    pick(arr) {
      return arr[Math.floor(this.rnd() * arr.length) % arr.length];
    }
  
    midiToHz(m) {
      return 440 * Math.pow(2, (m - 69) / 12);
    }
  
    rootToMidi(root) {
      const map = { C: 48, D: 50, E: 52, F: 53, G: 55, A: 57, B: 59 };
      return map[root] ?? 50;
    }
  
    scaleSteps(scale) {
      switch (scale) {
        case "ionian":
          return [0, 2, 4, 5, 7, 9, 11];
        case "mixolydian":
          return [0, 2, 4, 5, 7, 9, 10];
        case "dorian":
          return [0, 2, 3, 5, 7, 9, 10];
        case "aeolian":
          return [0, 2, 3, 5, 7, 8, 10];
        case "lydian":
        default:
          return [0, 2, 4, 6, 7, 9, 11];
      }
    }
  
    loadScene(scene, hard) {
      const next = this.sceneOrDefault(scene);
      if (hard || !this.sceneReady) {
        this.currentScene = { ...next };
        this.targetScene = { ...next };
        this.seed = next.seed >>> 0;
        this.randState = this.seed || 1337;
        const chord = this.makeChord(next, true);
        this.prevChord = chord.slice();
        this.currChord = chord.slice();
        this.fadeSamples = 1;
        this.fadeSamplesLeft = 0;
        this.samplesUntilNextChord = this.nextChordSamples(next);
        this.samplesUntilInternalEvolve = this.nextInternalEvolveSamples(next);
        this.sceneReady = true;
        return;
      }
  
      this.targetScene = { ...next };
      this.seed = next.seed >>> 0;
      this.scheduleChordMorph(this.makeChord(next, true), next.morph_s);
    }
  
    nextChordSamples(scene = this.currentScene) {
      const minS = scene.chord_change_min_s;
      const maxS = Math.max(minS + 1, scene.chord_change_max_s);
      return Math.max(1, Math.floor((minS + this.rnd() * (maxS - minS)) * sampleRate));
    }
  
    nextInternalEvolveSamples(scene = this.currentScene) {
      const minS = scene.evolve_every_min_s;
      const maxS = Math.max(minS + 1, scene.evolve_every_max_s);
      return Math.max(1, Math.floor((minS + this.rnd() * (maxS - minS)) * sampleRate));
    }
  
    makeChord(scene, allowExtensions = true) {
      const rootMidi = this.rootToMidi(scene.root);
      const steps = this.scaleSteps(scene.scale);
      const degreeChoices = [0, 1, 3, 4, 5];
      const d0 = this.pick(degreeChoices);
      const d1 = (d0 + 2) % steps.length;
      const d2 = (d0 + 4) % steps.length;
      const d3 = allowExtensions && scene.density > 0.42 ? (d0 + 6) % steps.length : (d0 + 1) % steps.length;
  
      const baseOct = scene.mode === "sleep" ? 2 : 3;
      const baseMidi = rootMidi + baseOct * 12 - 48;
  
      const m0 = baseMidi + steps[d0];
      const m1 = baseMidi + steps[d1];
      const m2 = baseMidi + 12 + steps[d2];
      const m3 = baseMidi + 12 + steps[d3];
  
      return [this.midiToHz(m0), this.midiToHz(m1), this.midiToHz(m2), this.midiToHz(m3)];
    }
  
    scheduleChordMorph(newChord, morphS) {
      this.prevChord = this.currChord.slice();
      this.currChord = newChord.slice();
      this.fadeSamples = Math.max(1, Math.floor(sampleRate * morphS));
      this.fadeSamplesLeft = this.fadeSamples;
    }
  
    maybeAdvanceStructures(blockSize) {
      this.samplesUntilNextChord -= blockSize;
      if (this.samplesUntilNextChord <= 0) {
        this.scheduleChordMorph(this.makeChord(this.targetScene, true), 8 + this.currentScene.movement * 10);
        this.samplesUntilNextChord = this.nextChordSamples(this.targetScene);
      }
  
      this.samplesUntilInternalEvolve -= blockSize;
      if (this.samplesUntilInternalEvolve <= 0) {
        this.internalEvolve();
        this.samplesUntilInternalEvolve = this.nextInternalEvolveSamples(this.targetScene);
      }
    }
  
    internalEvolve() {
      const nudges = {
        brightness: 0.06,
        density: 0.05,
        movement: 0.05,
        warmth: 0.05,
        air: 0.06,
        shimmer: 0.05,
        noisiness: 0.03,
        reverb: 0.05,
        stereo_width: 0.06,
        sub_amount: 0.03,
        detune: 0.03,
        drift: 0.05,
      };
  
      for (const [key, amt] of Object.entries(nudges)) {
        this.targetScene[key] = this.clamp(this.targetScene[key] + (this.rnd() * 2 - 1) * amt, 0, 1);
      }
  
      if (this.rnd() < 0.18) {
        this.targetScene.texture_family = this.pick(["mist", "glass", "velvet", "grain", "choir", "metallic"]);
      }
      if (this.rnd() < 0.14) {
        this.targetScene.voice_shape = this.pick(["sine", "triangle", "saw", "square", "hybrid"]);
      }
      if (this.rnd() < 0.16) {
        this.targetScene.scale = this.pick(["lydian", "ionian", "mixolydian", "dorian", "aeolian"]);
        this.scheduleChordMorph(this.makeChord(this.targetScene, true), 6 + this.targetScene.movement * 6);
      }
    }
  
    smoothScene(blockSize) {
      const timeConstantS = Math.max(2, this.targetScene.morph_s * 0.6);
      const coeff = 1 - Math.exp(-blockSize / (sampleRate * timeConstantS));
      for (const key of this.numericKeys) {
        const curr = this.currentScene[key];
        const target = this.targetScene[key];
        this.currentScene[key] = curr + (target - curr) * coeff;
      }
  
      if (this.fadeSamplesLeft <= 0) {
        this.currentScene.root = this.targetScene.root;
        this.currentScene.scale = this.targetScene.scale;
        this.currentScene.texture_family = this.targetScene.texture_family;
        this.currentScene.voice_shape = this.targetScene.voice_shape;
      }
    }
  
    waveformBlend(scene) {
      const shape = scene.voice_shape;
      let mix = { sine: 0.45, tri: 0.30, saw: 0.15, square: 0.10 };
  
      if (shape === "sine") mix = { sine: 0.72, tri: 0.18, saw: 0.05, square: 0.05 };
      if (shape === "triangle") mix = { sine: 0.22, tri: 0.58, saw: 0.12, square: 0.08 };
      if (shape === "saw") mix = { sine: 0.10, tri: 0.16, saw: 0.58, square: 0.16 };
      if (shape === "square") mix = { sine: 0.10, tri: 0.15, saw: 0.15, square: 0.60 };
  
      switch (scene.texture_family) {
        case "glass":
          mix.sine += 0.10;
          mix.tri += 0.10;
          mix.saw -= 0.05;
          break;
        case "velvet":
          mix.sine += 0.12;
          mix.square -= 0.05;
          mix.saw -= 0.04;
          break;
        case "grain":
          mix.saw += 0.08;
          mix.square += 0.04;
          break;
        case "choir":
          mix.sine += 0.16;
          mix.tri += 0.06;
          break;
        case "metallic":
          mix.saw += 0.14;
          mix.square += 0.10;
          break;
        default:
          break;
      }
  
      const sum = mix.sine + mix.tri + mix.saw + mix.square;
      return {
        sine: mix.sine / sum,
        tri: mix.tri / sum,
        saw: mix.saw / sum,
        square: mix.square / sum,
      };
    }
  
    onePoleLP(input, state, coeff) {
      return state + coeff * (input - state);
    }
  
    phaseToSaw(phase) {
      return phase / Math.PI - 1;
    }
  
    voiceSample(freq, bankIndex, scene, t, stereoBias) {
      const blend = this.waveformBlend(scene);
      const driftHz = 0.011 + scene.drift * 0.09;
      const driftA = 1 + 0.0025 * scene.drift * Math.sin(2 * Math.PI * driftHz * t + bankIndex * 0.31);
      const driftB = 1 + 0.0020 * scene.drift * Math.sin(2 * Math.PI * (driftHz * 1.37) * t + bankIndex * 0.19 + 0.6);
      const det = scene.detune * 0.007;
  
      const f1 = freq * driftA;
      const f2 = freq * (1 + det * stereoBias) * driftB;
      const f3 = freq * (1 - det * stereoBias * 0.6);
      const f4 = freq * (2 + scene.shimmer * 0.4);
  
      const p0 = this.phaseBank[bankIndex];
      const p1 = this.phaseBank[bankIndex + 1];
      const p2 = this.phaseBank[bankIndex + 2];
      const p3 = this.phaseBank[bankIndex + 3];
  
      const sine = Math.sin(p0);
      const tri = (2 / Math.PI) * Math.asin(Math.sin(p1));
      const saw = this.phaseToSaw(p2 % (2 * Math.PI));
      const square = Math.sin(p3) >= 0 ? 1 : -1;
  
      this.phaseBank[bankIndex] = (p0 + (2 * Math.PI * f1) / sampleRate) % (2 * Math.PI);
      this.phaseBank[bankIndex + 1] = (p1 + (2 * Math.PI * f2) / sampleRate) % (2 * Math.PI);
      this.phaseBank[bankIndex + 2] = (p2 + (2 * Math.PI * f3) / sampleRate) % (2 * Math.PI);
      this.phaseBank[bankIndex + 3] = (p3 + (2 * Math.PI * f4) / sampleRate) % (2 * Math.PI);
  
      const soft =
        sine * blend.sine +
        tri * blend.tri +
        saw * blend.saw +
        square * blend.square * (0.55 + scene.brightness * 0.25);
  
      return Math.tanh(soft * (1.05 + scene.brightness * 0.55));
    }
  
    shimmerSample(scene, t) {
      if (scene.shimmer <= 0.001) return 0;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.007 + scene.movement * 0.015) * t + 0.4);
      const f1 = 1760 + scene.brightness * 1100;
      const f2 = 2637 + scene.shimmer * 900;
      const s = 0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t + 0.17);
      return s * env * scene.shimmer * 0.028;
    }
  
    noiseSample(scene) {
      const n = this.rnd() * 2 - 1;
      const lpCoeff = 0.0015 + scene.warmth * 0.01;
      const bpCoeff = 0.010 + scene.air * 0.05;
      this.noiseLP = this.onePoleLP(n, this.noiseLP, lpCoeff);
      this.noiseBP = this.onePoleLP(n - this.noiseLP, this.noiseBP, bpCoeff);
      const warmNoise = this.noiseLP * (0.012 + scene.noisiness * 0.045);
      const airyNoise = this.noiseBP * (0.010 + scene.air * 0.04);
      return warmNoise + airyNoise;
    }
  
    diffuse(dryL, dryR, scene) {
      const len = this.delayLen;
      const baseA = Math.floor(sampleRate * (0.11 + scene.reverb * 0.19));
      const baseB = Math.floor(sampleRate * (0.17 + scene.reverb * 0.31));
      const idxA = (this.delayIndex + len - baseA) % len;
      const idxB = (this.delayIndex + len - baseB) % len;
  
      const tapL = 0.58 * this.delayL[idxA] + 0.42 * this.delayL[idxB];
      const tapR = 0.58 * this.delayR[idxA] + 0.42 * this.delayR[idxB];
  
      this.diffuseL = this.onePoleLP(tapL, this.diffuseL, 0.17 + scene.warmth * 0.12);
      this.diffuseR = this.onePoleLP(tapR, this.diffuseR, 0.17 + scene.warmth * 0.12);
  
      const feedback = 0.35 + scene.reverb * 0.42;
      this.delayL[this.delayIndex] = dryL + this.diffuseR * feedback;
      this.delayR[this.delayIndex] = dryR + this.diffuseL * feedback;
      this.delayIndex = (this.delayIndex + 1) % len;
  
      return [this.diffuseL, this.diffuseR];
    }
  
    process(inputs, outputs) {
      const output = outputs[0];
      const left = output[0];
      const right = output[1];
  
      if (!this.sceneReady) {
        for (let i = 0; i < left.length; i++) {
          left[i] = 0;
          right[i] = 0;
        }
        return true;
      }
  
      this.maybeAdvanceStructures(left.length);
      this.smoothScene(left.length);
  
      const scene = this.currentScene;
  
      for (let i = 0; i < left.length; i++) {
        const t = this.time / sampleRate;
  
        let mixOld = 0;
        let mixNew = 0;
        for (let v = 0; v < 4; v++) {
          const stereoBias = v % 2 === 0 ? -1 : 1;
          mixOld += this.voiceSample(this.prevChord[v], v * 4, scene, t, stereoBias);
          mixNew += this.voiceSample(this.currChord[v], 48 + v * 4, scene, t, stereoBias);
        }
  
        let chordMix = 1.0;
        if (this.fadeSamplesLeft > 0) {
          chordMix = 1.0 - this.fadeSamplesLeft / this.fadeSamples;
          this.fadeSamplesLeft--;
        }
  
        const harmonic = (1 - chordMix) * (mixOld / 4) + chordMix * (mixNew / 4);
        const droneFreq = this.currChord[0] * 0.5;
        const drone = this.voiceSample(droneFreq, 96, scene, t, -1) * (0.08 + scene.sub_amount * 0.22);
  
        const movementA = 1 + 0.07 * scene.movement * Math.sin(2 * Math.PI * (0.021 + scene.movement * 0.03) * t);
        const movementB = 1 + 0.05 * scene.movement * Math.sin(2 * Math.PI * (0.037 + scene.movement * 0.02) * t + 0.9);
        const micro = 1 + scene.focus_mod_depth * Math.sin(2 * Math.PI * scene.focus_mod_hz * t);
  
        const pad = (harmonic * movementA * movementB * micro) * (0.22 + scene.density * 0.24);
        const air = this.noiseSample(scene);
        const shimmer = this.shimmerSample(scene, t);
  
        const dry =
          pad * (0.86 + scene.warmth * 0.22) +
          drone +
          air * (0.75 + scene.brightness * 0.20) +
          shimmer;
  
        const pan = 0.22 * scene.stereo_width * Math.sin(2 * Math.PI * (0.011 + scene.movement * 0.015) * t);
        let dryL = dry * (1 - pan);
        let dryR = dry * (1 + pan);
  
        dryL += 0.013 * scene.stereo_width * Math.sin(2 * Math.PI * 0.17 * t) * pad;
        dryR -= 0.013 * scene.stereo_width * Math.sin(2 * Math.PI * 0.13 * t + 0.6) * pad;
  
        const [wetL, wetR] = this.diffuse(dryL, dryR, scene);
        let l = dryL * (1 - scene.reverb * 0.38) + wetL * scene.reverb * 0.74;
        let r = dryR * (1 - scene.reverb * 0.38) + wetR * scene.reverb * 0.74;
  
        const outL = l - this.lastInL + 0.995 * this.dcBlockL;
        const outR = r - this.lastInR + 0.995 * this.dcBlockR;
        this.lastInL = l;
        this.lastInR = r;
        this.dcBlockL = outL;
        this.dcBlockR = outR;
  
        left[i] = Math.tanh(outL * scene.master_gain);
        right[i] = Math.tanh(outR * scene.master_gain);
        this.time++;
      }
  
      return true;
    }
  }
  
  registerProcessor("ambient-engine", AmbientEngine);