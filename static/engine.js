/* Ibe Music: motor de áudio (mixer, tom, velocidade, repetição e metrônomo).
   Roda como AudioWorklet e também como script comum (fallback e exportação). */

// Mixer: lê as faixas (Int16) com volume suave e cruzamento no loop A-B.
class IbeMixer {
  constructor() { this.stems = []; this.length = 0; this.g = []; this.gt = []; this.gk = 0.002; this.reset(0); this.setLoop(0, 0, false); }
  load(stems, length) {
    this.stems = stems.map(s => ({ L: s.L, R: s.R, n: s.L.length }));
    this.length = length; this.g = stems.map(() => 1); this.gt = stems.map(() => 1); this.reset(0);
  }
  reset(pos) { this.pos = pos; this.last = pos; this.xf = 0; this.xfFrom = 0; this.atEnd = pos >= this.length; }
  setLoop(a, b, on) { this.loopA = a; this.loopB = b; this.loopOn = on && b > a; }
  read(L, R, P, off, n) {
    const st = this.stems, ns = st.length, len = this.length, g = this.g, gt = this.gt, k = this.gk, S = 1 / 32768, XF = 512;
    for (let i = 0; i < n; i++) {
      let p = this.pos;
      if (this.loopOn && p >= this.loopB && this.last < this.loopB) { this.xfFrom = p; this.xf = XF; p = this.pos = this.loopA; }
      let l = 0, r = 0;
      const w = this.xf / XF, q = this.xfFrom;
      for (let s = 0; s < ns; s++) {
        g[s] += (gt[s] - g[s]) * k;
        const gs = g[s];
        if (gs < 1e-5) continue;
        const a = st[s];
        let x = 0, y = 0;
        if (p < a.n) { x = a.L[p]; y = a.R[p]; }
        if (this.xf > 0) {
          const ox = q < a.n ? a.L[q] : 0, oy = q < a.n ? a.R[q] : 0;
          x = x * (1 - w) + ox * w; y = y * (1 - w) + oy * w;
        }
        l += x * gs; r += y * gs;
      }
      if (this.xf > 0) { this.xf--; this.xfFrom++; }
      L[off + i] = l * S; R[off + i] = r * S; P[off + i] = p < len ? p : len;
      this.last = p;
      if (p < len) this.pos = p + 1; else this.atEnd = true;
    }
  }
}

// Esticador de tempo (WSOLA, no estilo do SoundTouch): muda a velocidade sem mudar o tom.
class IbeStretch {
  constructor(sr, src) {
    this.sr = sr; this.src = src; this.tempo = 1; this.cap = 1 << 15;
    this.iL = new Float32Array(this.cap); this.iR = new Float32Array(this.cap); this.iP = new Float64Array(this.cap);
    this.oL = new Float32Array(this.cap); this.oR = new Float32Array(this.cap); this.oP = new Float64Array(this.cap);
    this.ov = Math.round(0.008 * sr);
    this.mL = new Float32Array(this.ov); this.mR = new Float32Array(this.ov);
    this.setTempo(1); this.reset();
  }
  reset() { this.iLen = 0; this.oLen = 0; this.oPos = 0; this.skip = 0; this.first = true; this.mL.fill(0); this.mR.fill(0); }
  setTempo(t) {
    this.tempo = t;
    const u = Math.min(1, Math.max(0, (t - 0.5) / 1.5));
    this.seq = Math.max(3 * this.ov, Math.round((90 - 50 * u) / 1000 * this.sr));
    this.seekLen = Math.round((20 - 5 * u) / 1000 * this.sr);
  }
  _fill(need) {
    if (need > this.iLen) { this.src.read(this.iL, this.iR, this.iP, this.iLen, need - this.iLen); this.iLen = need; }
  }
  _best() {
    const ov = this.ov, sk = this.seekLen, iL = this.iL, iR = this.iR, mL = this.mL, mR = this.mR;
    let mn = 0;
    for (let j = 0; j < ov; j++) mn += mL[j] * mL[j] + mR[j] * mR[j];
    if (mn < 1e-12) return 0;
    let best = -1e30, at = 0;
    for (let o = 0; o < sk; o++) {
      let c = 0, e = 0;
      for (let j = 0; j < ov; j++) { const a = iL[o + j], b = iR[o + j]; c += a * mL[j] + b * mR[j]; e += a * a + b * b; }
      const t = (2 * o - sk) / sk;
      const v = (c / Math.sqrt(e * mn + 1e-12) + 0.1) * (1 - 0.25 * t * t);
      if (v > best) { best = v; at = o; }
    }
    return at;
  }
  _step() {
    const ov = this.ov, seq = this.seq, nominal = this.tempo * (seq - ov);
    this._fill(Math.max(Math.floor(this.skip + nominal) + ov, seq) + this.seekLen);
    const off = this.first ? 0 : this._best();
    this.first = false;
    if (this.oLen + seq > this.cap) { this._compactOut(); }
    const iL = this.iL, iR = this.iR, iP = this.iP, oL = this.oL, oR = this.oR, oP = this.oP;
    let w = this.oLen;
    for (let j = 0; j < ov; j++, w++) {
      const f = j / ov;
      oL[w] = this.mL[j] * (1 - f) + iL[off + j] * f; oR[w] = this.mR[j] * (1 - f) + iR[off + j] * f; oP[w] = iP[off + j];
    }
    for (let j = ov; j < seq - ov; j++, w++) { oL[w] = iL[off + j]; oR[w] = iR[off + j]; oP[w] = iP[off + j]; }
    this.oLen = w;
    for (let j = 0; j < ov; j++) { this.mL[j] = iL[off + seq - ov + j]; this.mR[j] = iR[off + seq - ov + j]; }
    this.skip += nominal;
    const s = Math.floor(this.skip); this.skip -= s;
    this.iL.copyWithin(0, s, this.iLen); this.iR.copyWithin(0, s, this.iLen); this.iP.copyWithin(0, s, this.iLen);
    this.iLen -= s;
  }
  _compactOut() {
    const a = this.oPos, b = this.oLen;
    this.oL.copyWithin(0, a, b); this.oR.copyWithin(0, a, b); this.oP.copyWithin(0, a, b);
    this.oLen = b - a; this.oPos = 0;
  }
  read(L, R, P, off, n) {
    let done = 0;
    while (done < n) {
      if (this.oPos >= this.oLen) { this.oPos = 0; this.oLen = 0; this._step(); continue; }
      const k = Math.min(n - done, this.oLen - this.oPos);
      L.set(this.oL.subarray(this.oPos, this.oPos + k), off + done);
      R.set(this.oR.subarray(this.oPos, this.oPos + k), off + done);
      P.set(this.oP.subarray(this.oPos, this.oPos + k), off + done);
      this.oPos += k; done += k;
    }
  }
}

// Reamostrador (sinc com janela): muda o tom junto com o esticador.
class IbeResampler {
  constructor(src) {
    this.src = src; this.half = 8; this.taps = 16; this.ph = 512; this.cap = 8192;
    this.bL = new Float32Array(this.cap); this.bR = new Float32Array(this.cap); this.bP = new Float64Array(this.cap);
    this.rate = 1; this._table(); this.reset(0);
  }
  reset(p0) {
    const h = this.half - 1;
    this.bL.fill(0, 0, h); this.bR.fill(0, 0, h); this.bP.fill(p0, 0, h);
    this.bLen = h; this.x = h;
  }
  setRate(r) { if (r !== this.rate) { this.rate = r; this._table(); } }
  _table() {
    const fc = Math.min(1, 1 / this.rate), T = this.taps, H = this.half, t = new Float32Array((this.ph + 1) * T);
    for (let q = 0; q <= this.ph; q++) {
      const f = q / this.ph; let sum = 0;
      for (let k = 0; k < T; k++) {
        const d = k - H + 1 - f, u = d / H;
        const win = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
        const x = Math.PI * fc * d, s = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
        t[q * T + k] = fc * s * win; sum += t[q * T + k];
      }
      for (let k = 0; k < T; k++) t[q * T + k] /= sum;
    }
    this.tab = t;
  }
  read(L, R, P, off, n) {
    const T = this.taps, H = this.half, tab = this.tab;
    for (let i = 0; i < n; i++) {
      let ix = Math.floor(this.x);
      const need = ix + H + 1;
      if (need > this.bLen) {
        const keep = ix - H + 1;
        if (keep > 0 && this.bLen + 4096 > this.cap) {
          this.bL.copyWithin(0, keep, this.bLen); this.bR.copyWithin(0, keep, this.bLen); this.bP.copyWithin(0, keep, this.bLen);
          this.bLen -= keep; this.x -= keep; ix -= keep;
        }
        const add = Math.max(need - this.bLen, 2048);
        this.src.read(this.bL, this.bR, this.bP, this.bLen, add);
        this.bLen += add;
      }
      const f = this.x - ix, base = Math.round(f * this.ph) * T, s0 = ix - H + 1;
      let l = 0, r = 0;
      for (let k = 0; k < T; k++) { const c = tab[base + k]; l += this.bL[s0 + k] * c; r += this.bR[s0 + k] * c; }
      const p0 = this.bP[ix], p1 = this.bP[ix + 1];
      L[off + i] = l; R[off + i] = r; P[off + i] = Math.abs(p1 - p0) < 8 ? p0 + (p1 - p0) * f : (f < 0.5 ? p0 : p1);
      this.x += this.rate;
    }
  }
}

class IbeEngine {
  constructor(sr) {
    this.sr = sr; this.mixer = new IbeMixer(); this.stretch = new IbeStretch(sr, this.mixer); this.rs = new IbeResampler(this.stretch);
    this.length = 0; this.playing = false; this.fade = 0; this.fadeTarget = 0; this.fadeStep = 1 / (0.008 * sr);
    this.pendingSeek = null; this.pendingPause = false; this.ended = false; this.endedFlag = false;
    this.pitch = 0; this.speed = 1; this.bypass = true; this.curP = 0; this.P = new Float64Array(4096);
    this.beats = new Float64Array(0); this.accents = new Uint8Array(0); this.metroOn = false; this.metroVol = 0.7;
    this.mIdx = 0; this.mLast = 0; this.click = 0; this.clickLen = Math.round(0.04 * sr); this.clickHz = 1000;
  }
  get position() { return this.curP / this.sr; }
  handle(m) {
    switch (m.type) {
      case 'load': this.load(m.stems, m.length); break;
      case 'gains': this.setGains(m.gains); break;
      case 'pitch': this.setPitch(m.value); break;
      case 'speed': this.setSpeed(m.value); break;
      case 'loop': this.setLoop(m.a, m.b, m.on); break;
      case 'metro': this.setMetro(m); break;
      case 'play': this.play(); break;
      case 'pause': this.pause(); break;
      case 'seek': this.seek(m.pos); break;
    }
  }
  load(stems, length) {
    this.mixer.load(stems, length); this.length = length; this.playing = false; this.fade = 0; this.fadeTarget = 0;
    this.pendingSeek = null; this.pendingPause = false; this.ended = false; this._doSeek(0);
  }
  setGains(list) {
    const solo = list.some(s => s.solo);
    list.forEach((s, i) => { if (i < this.mixer.gt.length) this.mixer.gt[i] = s.mute || (solo && !s.solo) ? 0 : Math.max(0, s.vol); });
  }
  setPitch(v) { this.pitch = v; this._chain(); }
  setSpeed(v) { this.speed = v; this._chain(); }
  _chain() {
    const p = Math.pow(2, this.pitch / 12);
    this.stretch.setTempo(this.speed / p); this.rs.setRate(p);
    const want = this.pitch === 0 && this.speed === 1;
    if (want !== this.bypass) {
      this.wantBypass = want;
      if (this.playing) { this.pendingSeek = Math.round(this.curP); this.fadeTarget = 0; } else this._doSeek(Math.round(this.curP));
    }
  }
  setLoop(a, b, on) { this.mixer.setLoop(Math.round(a * this.sr), Math.round(b * this.sr), on); }
  setMetro(m) {
    if (m.beats) { this.beats = Float64Array.from(m.beats, b => b * this.sr); this.accents = Uint8Array.from(m.accents || []); }
    this.metroOn = !!m.on; if (m.vol != null) this.metroVol = m.vol;
    this.mIdx = this._lower(this.curP); this.mLast = this.curP;
  }
  play() {
    if (!this.length) return;
    if (this.ended || this.curP >= this.length - 1) { this.ended = false; this._doSeek(0); }
    if (!this.playing) { this.playing = true; this.fade = 0; }
    this.fadeTarget = 1; this.pendingPause = false;
  }
  pause() { if (this.playing) { this.pendingPause = true; this.fadeTarget = 0; } }
  seek(sec) {
    const f = Math.max(0, Math.min(this.length - 1, Math.round(sec * this.sr)));
    this.ended = false;
    if (this.playing) { this.pendingSeek = f; this.fadeTarget = 0; } else this._doSeek(f);
  }
  _doSeek(f) {
    if (this.wantBypass !== undefined) { this.bypass = this.wantBypass; this.wantBypass = undefined; }
    this.mixer.reset(f); this.stretch.reset(); this.rs.reset(f);
    this.curP = f; this.mIdx = this._lower(f); this.mLast = f; this.click = 0;
  }
  _lower(p) { const b = this.beats; let lo = 0, hi = b.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] < p) lo = m + 1; else hi = m; } return lo; }
  render(L, R, n) {
    if (!this.playing) { L.fill(0); R.fill(0); return; }
    if (this.P.length < n) this.P = new Float64Array(n);
    const P = this.P;
    if (this.bypass) this.mixer.read(L, R, P, 0, n); else this.rs.read(L, R, P, 0, n);
    const sr = this.sr, beats = this.beats, nb = beats.length, jump = sr * 0.3;
    for (let i = 0; i < n; i++) {
      if (this.fade !== this.fadeTarget) {
        this.fade += this.fade < this.fadeTarget ? this.fadeStep : -this.fadeStep;
        if (this.fade > 1) this.fade = 1; else if (this.fade < 0) this.fade = 0;
        if (Math.abs(this.fade - this.fadeTarget) < this.fadeStep) this.fade = this.fadeTarget;
      }
      L[i] *= this.fade; R[i] *= this.fade;
      const p = P[i];
      if (p >= this.mLast) {
        if (p - this.mLast < jump) {
          while (this.mIdx < nb && beats[this.mIdx] <= p) {
            if (this.metroOn) { this.click = this.clickLen; this.clickHz = this.accents[this.mIdx] ? 1760 : 1100; }
            this.mIdx++;
          }
        } else this.mIdx = this._lower(p);
        this.mLast = p;
      } else if (this.mLast - p > sr * 0.1) { this.mIdx = this._lower(p); this.mLast = p; }
      if (this.click > 0) {
        const t = (this.clickLen - this.click) / sr;
        const v = Math.sin(2 * Math.PI * this.clickHz * t) * Math.exp(-t * 110) * this.metroVol * 0.6 * this.fade;
        L[i] += v; R[i] += v; this.click--;
      }
    }
    this.curP = P[n - 1];
    if (this.fadeTarget === 0 && this.fade === 0) {
      if (this.pendingSeek !== null) { this._doSeek(this.pendingSeek); this.pendingSeek = null; this.fadeTarget = this.pendingPause ? 0 : 1; }
      if (this.pendingPause) { this.playing = false; this.pendingPause = false; }
    }
    if (this.curP >= this.length && this.playing) { this.playing = false; this.ended = true; this.endedFlag = true; }
  }
}

if (typeof registerProcessor === 'function') {
  class IbeProcessor extends AudioWorkletProcessor {
    constructor() {
      super(); this.e = new IbeEngine(sampleRate); this.t = 0;
      this.port.onmessage = ev => this.e.handle(ev.data);
    }
    process(_inputs, outputs) {
      const out = outputs[0], L = out[0], R = out[1] || out[0];
      this.e.render(L, R, L.length);
      this.t += L.length;
      if (this.t >= 1024) {
        this.t = 0;
        this.port.postMessage({ type: 'pos', pos: this.e.position, playing: this.e.playing });
        if (this.e.endedFlag) { this.e.endedFlag = false; this.port.postMessage({ type: 'ended' }); }
      }
      return true;
    }
  }
  registerProcessor('ibe-engine', IbeProcessor);
}
