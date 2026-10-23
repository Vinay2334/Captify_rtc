class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.isRecording = false;
    this.buffer = [];

    // AudioContext's actual sample rate, not a rate we can set here.
    this.sourceRate = sampleRate;
    this.targetRate = 24000;

    this.chunkSize = this.targetRate / 5; // 200 ms
    this.step = this.sourceRate / this.targetRate;

    // Fractional read position carried into the next 128-sample block, plus
    // the previous block's tail sample so interpolation stays continuous.
    this.carry = 0;
    this.prevSample = 0;
    this.hasPrev = false;

    this.port.onmessage = ({ data }) => {
      if (data === "start") this.isRecording = true;
      if (data === "stop") {
        this.isRecording = false;
        this.flushBuffer();
      }
    };
  }

  sampleAt(channel, i) {
    if (i < 0) return this.hasPrev ? this.prevSample : channel[0];
    return channel[i];
  }

  process(inputs) {
    if (!this.isRecording) return true;

    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Linear-interpolation resample to the target rate. Unlike the socket
    // extension (which silently dropped audio on non-integer ratios such as
    // 44.1 kHz -> 24 kHz), this handles any source rate and still emits the
    // same 24 kHz Int16 200 ms chunks downstream.
    const last = channel.length;
    let pos = this.carry;

    while (pos < last - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s =
        this.sampleAt(channel, i) +
        (this.sampleAt(channel, i + 1) - this.sampleAt(channel, i)) * frac;
      const sample = Math.max(-1, Math.min(1, s));
      this.buffer.push(
        sample < 0 ? sample * 32768 : sample * 32767
      );

      pos += this.step;

      while (this.buffer.length >= this.chunkSize) {
        const chunk = this.buffer.splice(0, this.chunkSize);
        this.flushChunk(chunk);
      }
    }

    this.carry = pos - last;
    if (last > 0) {
      this.prevSample = channel[last - 1];
      this.hasPrev = true;
    }

    return true;
  }

  flushChunk(samples) {
    const pcm = new Int16Array(samples);
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }

  flushBuffer() {
    if (this.buffer.length) {
      this.flushChunk(this.buffer);
      this.buffer = [];
    }
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
