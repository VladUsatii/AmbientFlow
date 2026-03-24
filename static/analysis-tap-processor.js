// static/analysis-tap-processor.js
class AnalysisTapProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.frameSize = 2048;
      this.leftFrame = new Float32Array(this.frameSize);
      this.rightFrame = new Float32Array(this.frameSize);
      this.index = 0;
      this.seq = 0;
    }
  
    flushFrame() {
      if (this.index === 0) return;
      const left = this.leftFrame.slice(0, this.index);
      const right = this.rightFrame.slice(0, this.index);
      this.port.postMessage({
        type: "audio_frame",
        seq: this.seq++,
        sampleRate,
        t: currentTime,
        left,
        right,
      });
      this.index = 0;
    }
  
    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      const inL = input[0];
      const inR = input[1] ?? input[0];
      const outL = output[0];
      const outR = output[1] ?? output[0];
  
      if (!outL || !outR) return true;
  
      if (!inL) {
        for (let i = 0; i < outL.length; i++) {
          outL[i] = 0;
          outR[i] = 0;
        }
        return true;
      }
  
      for (let i = 0; i < inL.length; i++) {
        const l = inL[i] || 0;
        const r = inR ? (inR[i] || 0) : l;
  
        outL[i] = l;
        outR[i] = r;
  
        this.leftFrame[this.index] = l;
        this.rightFrame[this.index] = r;
        this.index += 1;
  
        if (this.index >= this.frameSize) {
          this.flushFrame();
        }
      }
  
      return true;
    }
  }
  
  registerProcessor("analysis-tap", AnalysisTapProcessor);