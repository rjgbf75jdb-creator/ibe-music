'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const LABEL = { vocals: 'Voz', drums: 'Bateria', bass: 'Baixo', guitar: 'Guitarra', piano: 'Teclado', other: 'Outros' };
  const COLOR = { vocals: '#3D3BD9', drums: '#D98A2B', bass: '#1F8A70', guitar: '#B8456B', piano: '#2A7FB8', other: '#8A5BC2' };
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_MAJ = new Set([5, 10, 3, 8, 1]), FLAT_MIN = new Set([2, 7, 0, 5, 10, 3]);
  const PPS = 64, ANCHOR = 24;
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>';
  const ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  const S = {
    songs: [], playlists: [], filter: 'all', query: '', jobs: [], stemsChoice: 4,
    song: null, stems: [], dur: 0, pos: 0, posAt: 0, playing: false, cmdAt: 0, loading: false,
    pitch: 0, speed: 1, gains: {}, loop: { a: null, b: null, on: false },
    metro: { on: false, vol: 0.7, mult: 1, meter: 4 }, lyrics: [], syncIdx: -1,
    curLine: -2, curChord: -2, blocks: new Map(), seeking: false, exporting: false, lastSeek: -1,
  };

  // ------------------------------------------------------------ utilidades
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mod = (n, m) => ((n % m) + m) % m;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = s => { s = isFinite(s) && s > 0 ? s : 0; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'musica';
  const api = p => (localStorage.getItem('ibe.server') || '').trim().replace(/\/+$/, '') + p;
  let toastTimer;
  function toast(msg, ms = 3600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function idxAt(arr, t, key) {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  // ------------------------------------------------------------ tom e acordes
  function keyOf(song, pitch) {
    if (!song || !song.key) return null;
    const pc = mod(song.key.pc + pitch, 12), minor = song.key.mode === 'minor';
    const flat = minor ? FLAT_MIN.has(pc) : FLAT_MAJ.has(pc);
    return { flat, name: (flat ? FLAT : SHARP)[pc] + (minor ? 'm' : '') };
  }
  const chordName = (c, pitch, flat) => !c || c.q === 'N' ? '' : (flat ? FLAT : SHARP)[mod(c.pc + pitch, 12)] + (c.q === 'm' ? 'm' : '');
  const curFlat = () => { const k = keyOf(S.song, S.pitch); return k ? k.flat : false; };

  // ------------------------------------------------------------ banco local (IndexedDB)
  const DB = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('ibe-music', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('songs', { keyPath: 'id' }); d.createObjectStore('blobs'); d.createObjectStore('playlists', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const run = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error || new Error('Erro no armazenamento do navegador.'));
    }));
    return {
      get: (s, k) => run(s, 'readonly', st => st.get(k)),
      all: s => run(s, 'readonly', st => st.getAll()),
      put: (s, v, k) => run(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
      del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    };
  })();

  // ------------------------------------------------------------ motor de áudio
  const Engine = {
    ctx: null, node: null, eng: null, worklet: false,
    async init() {
      if (this.ctx) return;
      // iPhone: toca mesmo com a chave do silencioso ligada (iOS 16.4+)
      if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (_) {} }
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ sampleRate: 44100, latencyHint: 'playback' }); } catch (_) { this.ctx = new AC(); }
      if (this.ctx.audioWorklet && window.AudioWorkletNode && window.isSecureContext) {
        try {
          await this.ctx.audioWorklet.addModule('engine.js');
          this.node = new AudioWorkletNode(this.ctx, 'ibe-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          this.node.port.onmessage = e => onEngine(e.data);
          this.worklet = true;
        } catch (err) { console.warn('AudioWorklet indisponível; usando o modo compatível.', err); this.node = null; }
      }
      if (!this.node) {
        const eng = this.eng = new IbeEngine(this.ctx.sampleRate);
        this.node = this.ctx.createScriptProcessor(4096, 1, 2);
        this.node.onaudioprocess = ev => {
          const ob = ev.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
          eng.render(L, R, L.length);
          onEngine({ type: 'pos', pos: eng.position, playing: eng.playing });
          if (eng.endedFlag) { eng.endedFlag = false; onEngine({ type: 'ended' }); }
        };
      }
      this.node.connect(this.ctx.destination);
    },
    send(msg, transfer) { if (!this.node) return; if (this.worklet) this.node.port.postMessage(msg, transfer || []); else this.eng.handle(msg); },
    get sr() { return this.ctx ? this.ctx.sampleRate : 44100; },
  };
  const decode = ab => new Promise((res, rej) => Engine.ctx.decodeAudioData(ab, res, rej));
  function toInt16(buf, peaks = true) {
    const n = buf.length, a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    const L = new Int16Array(n), R = new Int16Array(n), bins = 1600, pk = new Float32Array(bins), k = bins / n;
    for (let i = 0; i < n; i++) {
      let x = a[i], y = b[i];
      x = x > 1 ? 1 : x < -1 ? -1 : x; y = y > 1 ? 1 : y < -1 ? -1 : y;
      L[i] = x * 32767; R[i] = y * 32767;
      if (peaks) { const v = (Math.abs(x) + Math.abs(y)) * 0.5, j = (i * k) | 0; if (v > pk[j]) pk[j] = v; }
    }
    return { L, R, peaks: pk };
  }
  function onEngine(m) {
    if (m.type === 'pos') {
      S.pos = m.pos; S.posAt = performance.now();
      if (m.playing !== S.playing && performance.now() - S.cmdAt > 300) { S.playing = m.playing; renderPlay(); }
    } else if (m.type === 'ended') {
      S.playing = false; S.pos = 0; Engine.send({ type: 'seek', pos: 0 }); renderPlay();
    }
  }
  const nowPos = () => (!S.playing ? S.pos : clamp(S.pos + Math.min(0.2, (performance.now() - S.posAt) / 1000) * S.speed, 0, S.dur));

  function play() {
    if (!S.song || S.loading) return;
    if (Engine.ctx && Engine.ctx.state !== 'running') Engine.ctx.resume().catch(() => {});
    S.cmdAt = performance.now(); S.playing = true; S.posAt = performance.now();
    Engine.send({ type: 'play' }); renderPlay();
  }
  function pause() { S.cmdAt = performance.now(); S.playing = false; Engine.send({ type: 'pause' }); renderPlay(); }
  const toggle = () => (S.playing ? pause() : play());
  function seek(t) {
    if (!S.song || S.loading) return;
    t = clamp(t, 0, Math.max(0, S.dur - 0.05)); S.pos = t; S.posAt = performance.now();
    Engine.send({ type: 'seek', pos: t });
  }

  // ------------------------------------------------------------ envio e processamento
  function upload(file, stems, job, onProgress) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest(); job.xhr = x;
      x.open('POST', api('/api/jobs'));
      x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => {
        let d = {}; try { d = JSON.parse(x.responseText); } catch (_) {}
        if (x.status >= 200 && x.status < 300) res(d);
        else rej(new Error(typeof d.detail === 'string' ? d.detail : `O servidor recusou o envio (erro ${x.status}).`));
      };
      x.onerror = () => rej(new Error('Sem conexão com o servidor. Confira o endereço em Ajustes.'));
      x.onabort = () => rej(new Error('Envio cancelado.'));
      const fd = new FormData(); fd.append('file', file); fd.append('stems', String(stems)); x.send(fd);
    });
  }
  const saveJobs = () => localStorage.setItem('ibe.jobs', JSON.stringify(
    S.jobs.filter(j => j.id && j.status !== 'error').map(j => ({ id: j.id, title: j.title, local: j.local }))));

  async function startUpload(file) {
    const job = { local: uid(), title: (file.name || 'Música').replace(/\.[^.]+$/, '').slice(0, 120), status: 'uploading', stage: 'Enviando', progress: 0 };
    S.jobs.unshift(job); renderJobs();
    try {
      const res = await upload(file, S.stemsChoice, job, p => { job.progress = p; job.stage = `Enviando ${Math.round(p * 100)}%`; renderJobs(); });
      job.id = res.id; job.status = 'queued'; job.progress = 0; job.stage = 'Na fila'; job.xhr = null;
      saveJobs(); renderJobs(); poll(job);
    } catch (err) {
      if (job.removed) return;
      job.status = 'error'; job.error = err.message; renderJobs();
    }
  }
  async function poll(job) {
    let fails = 0;
    while (!job.removed) {
      let st;
      try {
        const r = await fetch(api(`/api/jobs/${job.id}`), { cache: 'no-store' });
        if (r.status === 404) { job.status = 'error'; job.error = 'O servidor reiniciou e perdeu esse envio. Envie a música de novo.'; saveJobs(); renderJobs(); return; }
        if (!r.ok) throw new Error();
        st = await r.json(); fails = 0;
      } catch (_) {
        fails++; job.stage = 'Tentando falar com o servidor…'; renderJobs();
        await sleep(Math.min(15000, 2000 * fails)); continue;
      }
      if (job.removed) return;
      job.status = st.status; job.progress = st.progress;
      job.stage = st.status === 'queued' ? (st.queue > 1 ? `Na fila (${st.queue}ª)` : 'Na fila') : st.stage;
      if (st.status === 'done') { await importJob(job, st.result); return; }
      if (st.status === 'error' || st.status === 'cancelled') { job.status = 'error'; job.error = st.error || 'O processamento foi interrompido.'; saveJobs(); renderJobs(); return; }
      renderJobs(); await sleep(2000);
    }
  }
  async function importJob(job, result) {
    const id = uid(), saved = [];
    job.status = 'saving'; job.stage = 'Salvando no navegador'; job.progress = 0; renderJobs();
    try {
      for (const [i, st] of result.stems.entries()) {
        const r = await fetch(api(`/api/jobs/${job.id}/files/${encodeURIComponent(st.file)}`));
        if (!r.ok) throw new Error('Não consegui baixar as faixas. Envie a música de novo.');
        await DB.put('blobs', await r.blob(), `${id}:${st.name}`); saved.push(st.name);
        job.progress = (i + 1) / result.stems.length; renderJobs();
      }
      await DB.put('songs', {
        id, title: job.title, created: Date.now(), duration: result.duration, stems: result.stems.map(s => s.name),
        bpm: result.bpm, beats: result.beats, beat_strength: result.beat_strength, key: result.key, chords: result.chords,
        tuning: result.tuning, lyrics: [], settings: {},
      });
      fetch(api(`/api/jobs/${job.id}`), { method: 'DELETE' }).catch(() => {});
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      removeJob(job, false); await loadLibrary(); toast(`“${job.title}” está pronta.`);
    } catch (err) {
      for (const n of saved) DB.del('blobs', `${id}:${n}`).catch(() => {});
      job.status = 'error';
      job.error = err && err.name === 'QuotaExceededError' ? 'Acabou o espaço do navegador. Exclua músicas antigas e tente de novo.' : (err.message || 'Falha ao salvar.');
      renderJobs();
    }
  }
  function removeJob(job, cancelOnServer = true) {
    job.removed = true;
    if (job.xhr) job.xhr.abort();
    if (cancelOnServer && job.id) fetch(api(`/api/jobs/${job.id}`), { method: 'DELETE' }).catch(() => {});
    S.jobs = S.jobs.filter(j => j !== job); saveJobs(); renderJobs();
  }
  function renderJobs() {
    $('#jobs').innerHTML = S.jobs.map(j => {
      const err = j.status === 'error', pct = Math.round((j.progress || 0) * 100);
      const showPct = (j.status === 'processing' || j.status === 'saving') && pct > 0;
      return `<div class="job${err ? ' err' : ''}" data-local="${j.local}">
        <div class="job-top"><strong>${esc(j.title)}</strong><button type="button" class="sm" data-act="${err ? 'remove' : 'cancel'}">${err ? 'Remover' : 'Cancelar'}</button></div>
        ${err ? `<p class="sub">${esc(j.error || 'Algo deu errado.')}</p>`
              : `<div class="bar"><i style="width:${pct}%"></i></div><p class="sub">${esc(j.stage || '')}${showPct ? ` (${pct}%)` : ''}</p>`}
      </div>`;
    }).join('');
  }
  async function checkServer() {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    try { const r = await fetch(api('/api/health'), { signal: ctl.signal, cache: 'no-store' }); $('#server-off').hidden = r.ok; }
    catch (_) { $('#server-off').hidden = false; }
    clearTimeout(t);
  }

  // ------------------------------------------------------------ biblioteca
  async function loadLibrary() {
    const [songs, pls] = await Promise.all([DB.all('songs'), DB.all('playlists')]);
    S.songs = songs; S.playlists = pls.sort((a, b) => (a.created || 0) - (b.created || 0));
    if (S.filter !== 'all' && !S.playlists.some(p => p.id === S.filter)) S.filter = 'all';
    renderPlaylists(); renderSongs();
  }
  function renderPlaylists() {
    $('#playlists').innerHTML = [
      `<button type="button" class="chip-btn" data-pl="all" aria-pressed="${S.filter === 'all'}">Todas</button>`,
      ...S.playlists.map(p => `<button type="button" class="chip-btn" data-pl="${p.id}" aria-pressed="${S.filter === p.id}">${esc(p.name)} <span class="count">${p.songIds.length}</span></button>`),
      '<button type="button" class="chip-btn add" data-pl="new">Nova playlist</button>',
    ].join('');
    $('#pl-actions').hidden = S.filter === 'all';
  }
  function renderSongs() {
    const pl = S.playlists.find(p => p.id === S.filter);
    let list = pl ? pl.songIds.map(id => S.songs.find(s => s.id === id)).filter(Boolean) : [...S.songs].sort((a, b) => b.created - a.created);
    if (S.query) { const q = norm(S.query); list = list.filter(s => norm(s.title).includes(q)); }
    const box = $('#songs');
    if (!list.length) {
      box.innerHTML = `<p class="empty-note">${S.query ? 'Nenhuma música encontrada.' : pl ? 'Essa playlist está vazia. No menu de uma música, toque em Playlists para adicioná-la aqui.' : 'Sua biblioteca está vazia. Envie uma música acima para começar.'}</p>`;
      return;
    }
    box.innerHTML = list.map(s => {
      const k = keyOf(s, 0), meta = [k ? `Tom ${k.name}` : '', s.bpm ? `${Math.round(s.bpm)} BPM` : '', fmt(s.duration), `${s.stems.length} faixas`].filter(Boolean);
      return `<div class="item${S.song && S.song.id === s.id ? ' current' : ''}" data-id="${s.id}">
        <button type="button" class="item-main" data-act="open"><strong>${esc(s.title)}</strong><span class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</span></button>
        <button type="button" class="icon-btn" data-act="more" aria-label="Opções de ${esc(s.title)}">${ICON_MORE}</button></div>`;
    }).join('');
  }
  async function songMenu(id) {
    const s = S.songs.find(x => x.id === id); if (!s) return;
    const act = await sheet(s.title, [['open', 'Abrir no estúdio'], ['rename', 'Renomear'], ['playlists', 'Adicionar a uma playlist'], ['delete', 'Excluir', true]]);
    if (act === 'open') openSong(id);
    else if (act === 'rename') {
      const v = await ask({ title: 'Renomear música', input: s.title, ok: 'Salvar' });
      if (!v || !v.trim()) return;
      const fresh = await DB.get('songs', id); if (!fresh) return;
      fresh.title = v.trim().slice(0, 120); await DB.put('songs', fresh);
      if (S.song && S.song.id === id) { S.song.title = fresh.title; renderHead(); }
      await loadLibrary();
    } else if (act === 'playlists') {
      if (!S.playlists.length) {
        const name = await ask({ title: 'Nova playlist', body: 'Você ainda não tem playlists. Dê um nome para a primeira.', input: '', placeholder: 'Ex.: Culto de domingo', ok: 'Criar' });
        if (!name || !name.trim()) return;
        const p = { id: uid(), name: name.trim().slice(0, 60), songIds: [id], created: Date.now() };
        await DB.put('playlists', p); await loadLibrary(); toast(`Adicionada em “${p.name}”.`); return;
      }
      const html = `<div class="checks">${S.playlists.map(p => `<label><input type="checkbox" value="${p.id}"${p.songIds.includes(id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')}</div>`;
      if (!(await ask({ title: 'Playlists', body: s.title, html, ok: 'Salvar' }))) return;
      const checked = new Set($$('#dlg input[type=checkbox]:checked').map(c => c.value));
      for (const p of S.playlists) {
        const has = p.songIds.includes(id), want = checked.has(p.id);
        if (has !== want) { p.songIds = want ? [...p.songIds, id] : p.songIds.filter(x => x !== id); await DB.put('playlists', p); }
      }
      await loadLibrary();
    } else if (act === 'delete') {
      if (!(await ask({ title: 'Excluir música?', body: `“${s.title}” e as faixas separadas serão apagadas deste navegador.`, ok: 'Excluir', danger: true }))) return;
      if (S.song && S.song.id === id) unloadSong();
      for (const st of s.stems) await DB.del('blobs', `${id}:${st}`);
      await DB.del('songs', id);
      for (const p of S.playlists) if (p.songIds.includes(id)) { p.songIds = p.songIds.filter(x => x !== id); await DB.put('playlists', p); }
      await loadLibrary(); toast('Música excluída.');
    }
  }
  async function newPlaylist() {
    const name = await ask({ title: 'Nova playlist', input: '', placeholder: 'Ex.: Culto de domingo', ok: 'Criar' });
    if (!name || !name.trim()) return;
    const p = { id: uid(), name: name.trim().slice(0, 60), songIds: [], created: Date.now() };
    await DB.put('playlists', p); S.filter = p.id; await loadLibrary();
  }

  // ------------------------------------------------------------ diálogos
  function ask({ title, body = '', input = null, textarea = null, placeholder = '', html = '', ok = 'OK', cancel = 'Cancelar', danger = false }) {
    return new Promise(res => {
      const d = $('#dlg');
      d.innerHTML = `<form method="dialog" class="dlg">
        <h2>${esc(title)}</h2>${body ? `<p class="sub">${esc(body)}</p>` : ''}
        ${input !== null ? `<input class="field" name="v" value="${esc(input)}" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="300">` : ''}
        ${textarea !== null ? `<textarea class="field" name="v" rows="12" placeholder="${esc(placeholder)}">${esc(textarea)}</textarea>` : ''}
        ${html}
        <div class="dlg-btns"><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button>${cancel ? `<button class="btn" value="cancel">${esc(cancel)}</button>` : ''}</div>
      </form>`;
      d.returnValue = '';
      d.onclose = () => { const f = $('[name=v]', d); res(d.returnValue === 'ok' ? (f ? f.value : true) : null); };
      d.showModal();
      const f = $('[name=v]', d); if (f) setTimeout(() => f.focus(), 40);
    });
  }
  function sheet(title, actions) {
    return new Promise(res => {
      const d = $('#dlg');
      d.innerHTML = `<form method="dialog" class="dlg"><h2>${esc(title)}</h2><div class="sheet-btns">
        ${actions.map(([v, label, danger]) => `<button class="btn${danger ? ' danger-text' : ''}" value="${v}">${esc(label)}</button>`).join('')}
        <button class="btn" value="">Fechar</button></div></form>`;
      d.returnValue = '';
      d.onclose = () => res(d.returnValue || null);
      d.showModal();
    });
  }
  async function openSettings() {
    let usage = '';
    try { const e = await navigator.storage.estimate(); usage = `Espaço usado pelas músicas: ${(e.usage / 1048576).toFixed(0)} MB.`; } catch (_) {}
    const v = await ask({
      title: 'Ajustes', body: 'Endereço do servidor que separa as faixas. Deixe vazio para usar este mesmo site.',
      input: localStorage.getItem('ibe.server') || '', placeholder: 'https://seu-servidor.hf.space', ok: 'Salvar',
      html: `<p class="sub small">${esc(usage)} As músicas ficam salvas somente neste navegador.</p><p class="sub small">Separação de faixas com Demucs (Meta, código aberto).</p>`,
    });
    if (v === null) return;
    localStorage.setItem('ibe.server', v.trim()); checkServer(); toast('Ajustes salvos.');
  }

  // ------------------------------------------------------------ estúdio
  function showTab(name) {
    $('#tab-lib').setAttribute('aria-selected', name === 'lib'); $('#tab-studio').setAttribute('aria-selected', name === 'studio');
    $('#lib').classList.toggle('on', name === 'lib'); $('#studio').classList.toggle('on', name === 'studio');
    if (name === 'studio') requestAnimationFrame(drawWaves); else renderSongs();
    window.scrollTo(0, 0);
  }
  function unloadSong() {
    clearTimeout(saveT); if (S.song) pause();
    S.song = null; S.stems = []; S.dur = 0;
    Engine.send({ type: 'load', stems: [], length: 0 });
    renderStudio();
  }
  async function openSong(id) {
    const song = await DB.get('songs', id);
    if (!song) { toast('Música não encontrada.'); return; }
    if (S.syncIdx >= 0) endSync();
    try { await Engine.init(); } catch (err) { toast('Este navegador não consegue tocar áudio aqui.'); return; }
    if (S.song) { clearTimeout(saveT); flushSave(); pause(); }
    S.song = song; S.loading = true; S.stems = []; S.pos = 0; S.pitch = 0; S.speed = 1;
    S.metro = { on: false, vol: 0.7, mult: 1, meter: 4 }; S.playing = false;
    showTab('studio'); renderStudio();
    const stems = [];
    try {
      for (const name of song.stems) {
        $('#studio-loading').textContent = `Carregando ${LABEL[name] || name}…`;
        const blob = await DB.get('blobs', `${id}:${name}`);
        if (!blob) continue;
        const buf = await decode(await blob.arrayBuffer());
        if (S.song !== song) return;
        stems.push({ name, ...toInt16(buf) });
      }
    } catch (err) {
      console.error(err); if (S.song === song) { toast('Não consegui abrir as faixas dessa música.'); unloadSong(); } return;
    }
    if (S.song !== song) return;
    if (!stems.length) { toast('As faixas dessa música não foram encontradas.'); unloadSong(); return; }
    const length = Math.max(...stems.map(s => s.L.length));
    S.stems = stems.map(s => ({ name: s.name, peaks: s.peaks }));
    S.dur = length / Engine.sr;
    Engine.send({ type: 'load', length, stems: stems.map(s => ({ L: s.L, R: s.R })) }, Engine.worklet ? stems.flatMap(s => [s.L.buffer, s.R.buffer]) : []);
    const st = song.settings || {};
    S.pitch = st.pitch || 0; S.speed = st.speed || 1;
    S.gains = {}; for (const s of S.stems) S.gains[s.name] = Object.assign({ vol: 1, mute: false, solo: false }, (st.gains || {})[s.name]);
    S.loop = Object.assign({ a: null, b: null, on: false }, st.loop);
    S.metro = Object.assign({ on: false, vol: 0.7, mult: 1, meter: 4 }, st.metro);
    S.lyrics = Array.isArray(song.lyrics) ? song.lyrics : [];
    Engine.send({ type: 'pitch', value: S.pitch }); Engine.send({ type: 'speed', value: S.speed });
    S.loading = false;
    renderStudio(); sendLoop(false); sendMetro(); mediaSession();
  }
  function renderStudio() {
    const has = !!S.song;
    $('#studio-empty').hidden = has; $('#studio-main').hidden = !has;
    if (!has) { renderSongs(); return; }
    $('#studio-loading').hidden = !S.loading; $('#studio-body').hidden = S.loading;
    renderHead();
    if (S.loading) return;
    $('#t-dur').textContent = fmt(S.dur); $('#seek').max = S.dur.toFixed(2);
    buildLanes(); buildStrip(); renderLyrics(); renderPitch(); renderSpeed(); renderLoop(); renderMetro(); renderExport(); renderPlay();
    S.curLine = -2; renderSongs();
  }
  function renderHead() {
    const s = S.song; if (!s) return;
    $('#s-title').textContent = s.title;
    const k = keyOf(s, S.pitch), ko = keyOf(s, 0);
    $('#c-key').textContent = k ? (S.pitch ? `Tom ${k.name} (original ${ko.name})` : `Tom ${k.name}`) : 'Tom não detectado';
    const bpm = s.bpm ? Math.round(s.bpm * S.metro.mult * S.speed) : 0;
    $('#c-bpm').textContent = bpm ? `${bpm} BPM` : 'BPM não detectado';
    $('#c-stems').textContent = `${s.stems.length} faixas`;
  }
  function renderPlay() {
    const b = $('#b-play'); b.innerHTML = S.playing ? ICON_PAUSE : ICON_PLAY; b.setAttribute('aria-label', S.playing ? 'Pausar' : 'Tocar');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
  }

  // faixas
  const gainList = () => S.stems.map(s => S.gains[s.name] || { vol: 1, mute: false, solo: false });
  function sendGains() {
    const list = gainList(), solo = list.some(g => g.solo);
    Engine.send({ type: 'gains', gains: list });
    S.stems.forEach((s, i) => { const off = list[i].mute || (solo && !list[i].solo); $$(`#lanes [data-stem="${s.name}"]`).forEach(el => el.classList.toggle('off', off)); });
  }
  function buildLanes() {
    const box = $('#lanes'); box.innerHTML = '';
    for (const st of S.stems) {
      const g = S.gains[st.name], label = LABEL[st.name] || st.name;
      const l = document.createElement('div'); l.className = 'lane-l'; l.dataset.stem = st.name;
      l.innerHTML = `<div class="lane-name"><i style="background:${COLOR[st.name] || '#6B7585'}"></i>${esc(label)}</div>
        <div class="lane-btns"><button type="button" class="sm" data-act="mute" aria-pressed="${g.mute}" aria-label="Silenciar ${esc(label)}">Mudo</button><button type="button" class="sm" data-act="solo" aria-pressed="${g.solo}" aria-label="Ouvir só ${esc(label)}">Solo</button></div>
        <input type="range" min="0" max="100" step="1" value="${Math.round(g.vol * 100)}" data-act="vol" aria-label="Volume de ${esc(label)}">`;
      const w = document.createElement('div'); w.className = 'lane-w'; w.dataset.stem = st.name; w.innerHTML = '<canvas aria-hidden="true"></canvas>';
      box.append(l, w);
    }
    const ov = document.createElement('div'); ov.className = 'lane-ov'; ov.style.gridRow = `1 / span ${S.stems.length}`;
    ov.innerHTML = '<div class="loop-zone" hidden></div><div class="head"></div>';
    box.append(ov);
    sendGains(); drawWaves();
  }
  function drawWaves() {
    if (!S.stems.length) return;
    const dpr = window.devicePixelRatio || 1;
    let gmax = 0; for (const s of S.stems) for (const v of s.peaks) if (v > gmax) gmax = v;
    gmax = gmax || 1;
    for (const st of S.stems) {
      const cell = $(`.lane-w[data-stem="${st.name}"]`); if (!cell) continue;
      const cv = $('canvas', cell), w = cv.clientWidth, h = 48;
      if (!w) continue;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
      c.fillStyle = COLOR[st.name] || '#6B7585';
      const pk = st.peaks, n = pk.length, cols = Math.floor(w / 3);
      for (let x = 0; x < cols; x++) {
        const a = Math.floor(x / cols * n), b = Math.max(a + 1, Math.floor((x + 1) / cols * n));
        let v = 0; for (let j = a; j < b; j++) if (pk[j] > v) v = pk[j];
        const bh = Math.max(1.5, Math.pow(v / gmax, 0.75) * (h - 4));
        c.fillRect(x * 3, (h - bh) / 2, 2, bh);
      }
    }
  }

  // acordes
  function buildStrip() {
    const ch = S.song.chords || [], track = $('#track'), flat = curFlat();
    const ok = ch.some(c => c.q !== 'N');
    $('#chords-card').hidden = !ok; S.blocks = new Map(); S.curChord = -2;
    if (!ok) { track.innerHTML = ''; return; }
    track.innerHTML = ch.map((c, i) => {
      if (c.q === 'N') return '';
      const end = i + 1 < ch.length ? ch[i + 1].t : S.dur;
      return `<span class="blk" data-i="${i}" style="left:${(c.t * PPS).toFixed(1)}px;width:${Math.max(20, (end - c.t) * PPS - 4).toFixed(1)}px">${esc(chordName(c, S.pitch, flat))}</span>`;
    }).join('');
    for (const b of $$('.blk', track)) S.blocks.set(+b.dataset.i, b);
  }
  function updateChords(p) {
    const ch = S.song.chords || [];
    if (!ch.length || $('#chords-card').hidden) return;
    $('#track').style.transform = `translate3d(${(ANCHOR - p * PPS).toFixed(1)}px,0,0)`;
    const i = idxAt(ch, p + 0.03, 't');
    if (i === S.curChord) return;
    const prev = S.blocks.get(S.curChord); if (prev) prev.classList.remove('on');
    S.curChord = i;
    const cur = S.blocks.get(i); if (cur) cur.classList.add('on');
    const flat = curFlat();
    $('#chord-now').textContent = chordName(ch[i], S.pitch, flat) || '–';
    let nx = ''; for (let j = i + 1; j < ch.length; j++) if (ch[j].q !== 'N') { nx = chordName(ch[j], S.pitch, flat); break; }
    $('#chord-next').textContent = nx || '–';
  }

  // letra
  function parseLyrics(text) {
    const out = [];
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      if (/^\s*\[[a-z]+:.*\]\s*$/i.test(raw)) continue;
      const m = raw.match(/^\s*\[(\d{1,2}):(\d{1,2}(?:[.,]\d{1,3})?)\]\s*(.*)$/);
      if (m) out.push({ text: m[3].trim(), t: (+m[1]) * 60 + parseFloat(m[2].replace(',', '.')) });
      else out.push({ text: raw.trim(), t: null });
    }
    const res = [];
    for (const l of out) { if (!l.text && (!res.length || !res[res.length - 1].text)) continue; res.push(l); }
    while (res.length && !res[res.length - 1].text) res.pop();
    return res;
  }
  function lineChords(i) {
    const L = S.lyrics, ch = S.song.chords || [], flat = curFlat(), t0 = L[i].t;
    let t1 = Math.min(S.dur, t0 + 10);
    for (let j = i + 1; j < L.length; j++) if (L[j].text && L[j].t != null) { t1 = L[j].t; break; }
    const out = [];
    for (let j = Math.max(0, idxAt(ch, t0 + 0.05, 't')); j < ch.length && ch[j].t < t1 - 0.15 && out.length < 8; j++) {
      const n = chordName(ch[j], S.pitch, flat); if (n && out[out.length - 1] !== n) out.push(n);
    }
    return out;
  }
  function renderLyrics() {
    const box = $('#lyrics'), L = S.lyrics, has = L.some(l => l.text);
    $('#ly-edit').textContent = has ? 'Editar' : 'Adicionar letra';
    $('#ly-sync').hidden = !has || S.syncIdx >= 0;
    $('#sync-bar').hidden = S.syncIdx < 0;
    S.curLine = -2;
    if (!has) { box.innerHTML = '<p class="empty-note">Cole a letra para acompanhar enquanto a música toca. Depois toque em Sincronizar para marcar quando cada verso começa.</p>'; return; }
    box.innerHTML = L.map((l, i) => {
      if (!l.text) return '<div class="ln gap"></div>';
      const ch = l.t != null && S.syncIdx < 0 ? lineChords(i) : [];
      return `<div class="ln${l.t != null ? ' timed' : ''}" data-i="${i}">${ch.length ? `<span class="ch">${ch.map(c => `<span>${esc(c)}</span>`).join('')}</span>` : ''}<span class="tx">${esc(l.text)}</span></div>`;
    }).join('');
  }
  function updateLyrics(p) {
    const L = S.lyrics; if (!L.length) return;
    let cur = -1;
    if (S.syncIdx >= 0) cur = S.syncIdx;
    else for (let i = 0; i < L.length; i++) if (L[i].text && L[i].t != null && L[i].t <= p + 0.1) cur = i;
    if (cur === S.curLine) return;
    const box = $('#lyrics');
    $$('.ln.now, .ln.next', box).forEach(el => el.classList.remove('now', 'next'));
    S.curLine = cur; if (cur < 0) return;
    const el = $(`.ln[data-i="${cur}"]`, box); if (!el) return;
    el.classList.add(S.syncIdx >= 0 ? 'next' : 'now');
    box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2) });
  }
  async function editLyrics() {
    if (S.syncIdx >= 0) endSync();
    const v = await ask({
      title: 'Letra', body: 'Uma linha por verso e uma linha em branco entre as partes. Arquivos de letra sincronizada (.lrc) também funcionam.',
      textarea: S.lyrics.map(l => l.text).join('\n'), placeholder: 'Cole a letra aqui', ok: 'Salvar',
    });
    if (v === null) return;
    const parsed = parseLyrics(v);
    if (!parsed.some(l => l.t != null)) parsed.forEach((l, i) => { const o = S.lyrics[i]; if (o && o.text === l.text) l.t = o.t; });
    S.lyrics = parsed; renderLyrics(); saveSoon();
  }
  async function startSync() {
    const L = S.lyrics; let i = L.findIndex(l => l.text && l.t == null);
    if (i < 0) {
      if (!(await ask({ title: 'Sincronizar de novo?', body: 'Todas as linhas já têm tempo marcado. Quer marcar tudo de novo desde o começo?', ok: 'Marcar de novo' }))) return;
      L.forEach(l => { l.t = null; }); i = L.findIndex(l => l.text);
    }
    S.syncIdx = i; renderLyrics(); toast('Toque em Marcar linha (ou Enter) no começo de cada verso.');
  }
  function markLine() {
    const L = S.lyrics; if (S.syncIdx < 0 || !L[S.syncIdx]) return;
    L[S.syncIdx].t = Math.max(0, Math.round((nowPos() - 0.15) * 100) / 100);
    let n = S.syncIdx + 1; while (n < L.length && !L[n].text) n++;
    if (n >= L.length) { endSync(); toast('Letra sincronizada.'); return; }
    S.syncIdx = n; S.curLine = -2; saveSoon();
  }
  function undoMark() {
    const L = S.lyrics; let p = S.syncIdx - 1;
    while (p >= 0 && !(L[p].text && L[p].t != null)) p--;
    if (p < 0) return;
    L[p].t = null; S.syncIdx = p; S.curLine = -2; saveSoon();
  }
  function endSync() { S.syncIdx = -1; renderLyrics(); saveSoon(); }

  // tom, velocidade, repetição, metrônomo
  function setPitch(v) {
    S.pitch = clamp(v, -6, 6); Engine.send({ type: 'pitch', value: S.pitch });
    renderPitch(); renderHead(); buildStrip(); if (S.syncIdx < 0) renderLyrics(); saveSoon();
  }
  function renderPitch() {
    const k0 = keyOf(S.song, 0), k = keyOf(S.song, S.pitch);
    $('#p-val').textContent = S.pitch > 0 ? `+${S.pitch}` : String(S.pitch);
    $('#p-sub').textContent = k0 ? (S.pitch ? `${k0.name} para ${k.name}` : `Original ${k0.name}`) : 'meios tons';
    $('#p-minus').disabled = S.pitch <= -6; $('#p-plus').disabled = S.pitch >= 6;
  }
  function setSpeed(v) {
    S.speed = clamp(Math.round(v * 100) / 100, 0.5, 1.5); Engine.send({ type: 'speed', value: S.speed });
    renderSpeed(); renderHead(); saveSoon();
  }
  function renderSpeed() { $('#sp').value = Math.round(S.speed * 100); $('#sp-val').textContent = `${Math.round(S.speed * 100)}%`; }
  function sendLoop(save = true) {
    const { a, b, on } = S.loop, valid = a != null && b != null && b > a + 0.2;
    Engine.send({ type: 'loop', a: a || 0, b: b || 0, on: !!(on && valid) });
    renderLoop(); if (save) saveSoon();
  }
  function renderLoop() {
    const { a, b, on } = S.loop;
    $('#lp-info').textContent = a == null ? 'Marque o início (A) e o fim (B) enquanto toca.' : b == null ? `Início em ${fmt(a)}. Agora marque o fim (B).` : `De ${fmt(a)} até ${fmt(b)}`;
    $('#lp-a').textContent = a == null ? 'Marcar A' : `A ${fmt(a)}`;
    $('#lp-b').textContent = b == null ? 'Marcar B' : `B ${fmt(b)}`;
    $('#lp-on').setAttribute('aria-pressed', String(!!on)); $('#lp-on').textContent = on ? 'Repetindo' : 'Repetir';
    const z = $('#lanes .loop-zone');
    if (z && S.dur) {
      const show = a != null && b != null; z.hidden = !show;
      if (show) { z.style.left = `${(a / S.dur) * 100}%`; z.style.width = `${((b - a) / S.dur) * 100}%`; z.classList.toggle('on', !!on); }
    }
  }
  function downbeatPhase(m) {
    const s = S.song, b = s.beats || [], st = s.beat_strength || [], ch = s.chords || [];
    if (b.length < m * 2) return 0;
    const score = new Array(m).fill(0);
    b.forEach((_, i) => { score[i % m] += st[i] || 0; });
    for (const c of ch) {
      const i = idxAt(b, c.t + 0.12);
      if (i >= 0 && Math.abs(b[i] - c.t) < 0.12) score[i % m] += 1.5;
    }
    return score.indexOf(Math.max(...score));
  }
  function metroBeats() {
    const b = (S.song && S.song.beats) || [];
    if (b.length < 2) return { beats: [], accents: [] };
    const m = S.metro.meter, ph = downbeatPhase(m), beats = [], accents = [];
    b.forEach((t, i) => {
      const acc = mod(i - ph, m) === 0 ? 1 : 0;
      if (S.metro.mult === 0.5 && mod(i - ph, 2) !== 0) return;
      beats.push(t); accents.push(acc);
      if (S.metro.mult === 2 && i + 1 < b.length) { beats.push((t + b[i + 1]) / 2); accents.push(0); }
    });
    return { beats, accents };
  }
  function sendMetro() { const { beats, accents } = metroBeats(); Engine.send({ type: 'metro', on: S.metro.on, vol: S.metro.vol, beats, accents }); }
  function renderMetro() {
    const has = ((S.song && S.song.beats) || []).length >= 2;
    $('#mt-on').disabled = !has;
    $('#mt-on').setAttribute('aria-pressed', String(S.metro.on && has)); $('#mt-on').textContent = !has ? 'Sem batidas detectadas' : S.metro.on ? 'Ligado' : 'Desligado';
    $$('#mt-mult button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.mult === S.metro.mult)));
    $('#mt-meter').value = String(S.metro.meter); $('#mt-vol').value = Math.round(S.metro.vol * 100);
  }

  // exportação
  function renderExport() {
    $('#ex-stems').innerHTML = S.stems.map(s => `<button type="button" class="tg" data-stem="${s.name}">Baixar ${esc(LABEL[s.name] || s.name)}</button>`).join('');
  }
  async function exportStem(name) {
    const blob = await DB.get('blobs', `${S.song.id}:${name}`);
    if (blob) download(blob, `${safeName(S.song.title)} - ${LABEL[name] || name}.mp3`);
  }
  function wavBlob(L, R, sr) {
    const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 4, true);
    const o = new Int16Array(buf, 44);
    for (let i = 0; i < n; i++) {
      const a = L[i], b = R[i];
      o[2 * i] = (a > 1 ? 1 : a < -1 ? -1 : a) * 32767; o[2 * i + 1] = (b > 1 ? 1 : b < -1 ? -1 : b) * 32767;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  async function exportMix() {
    if (S.exporting || !S.song) return;
    const song = S.song, status = $('#ex-status'), btn = $('#ex-mix');
    S.exporting = true; btn.disabled = true; status.hidden = false; status.textContent = 'Preparando as faixas…';
    try {
      const stems = [];
      for (const name of song.stems) {
        const blob = await DB.get('blobs', `${song.id}:${name}`); if (!blob) continue;
        const { L, R } = toInt16(await decode(await blob.arrayBuffer()), false); stems.push({ L, R });
      }
      const sr = Engine.sr, len = Math.max(...stems.map(s => s.L.length));
      const e = new IbeEngine(sr);
      e.load(stems, len); e.setGains(gainList()); e.setPitch(S.pitch); e.setSpeed(S.speed); e.play();
      const total = Math.ceil(len / S.speed) + sr, B = 8192;
      const outL = new Float32Array(total), outR = new Float32Array(total), bl = new Float32Array(B), br = new Float32Array(B);
      let n = 0, k = 0;
      while (!e.ended && n < total) {
        e.render(bl, br, B);
        const c = Math.min(B, total - n); outL.set(bl.subarray(0, c), n); outR.set(br.subarray(0, c), n); n += c;
        if (++k % 24 === 0) { status.textContent = `Gerando a mix… ${Math.min(99, Math.round((n / total) * 100))}%`; await sleep(0); }
      }
      const kn = keyOf(song, S.pitch);
      download(wavBlob(outL.subarray(0, n), outR.subarray(0, n), sr), `${safeName(song.title)} (${kn ? `tom ${kn.name}, ` : ''}${Math.round(S.speed * 100)}%).wav`);
      status.textContent = 'Mix pronta.';
    } catch (err) {
      console.error(err); status.textContent = 'Não foi possível gerar a mix neste aparelho.';
    } finally { S.exporting = false; btn.disabled = false; }
  }

  // configurações por música
  let saveT;
  function flushSave() {
    const song = S.song; if (!song) return;
    song.settings = { pitch: S.pitch, speed: S.speed, gains: S.gains, loop: S.loop, metro: S.metro };
    song.lyrics = S.lyrics;
    DB.put('songs', song).catch(() => {});
  }
  function saveSoon() { if (!S.song) return; clearTimeout(saveT); saveT = setTimeout(flushSave, 600); }

  function mediaSession() {
    if (!('mediaSession' in navigator) || !S.song) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: S.song.title, artist: 'Ibe Music' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('seekbackward', () => seek(nowPos() - 5));
      navigator.mediaSession.setActionHandler('seekforward', () => seek(nowPos() + 5));
    } catch (_) {}
  }

  // ------------------------------------------------------------ quadro a quadro
  let lastTxt = '';
  function frame() {
    requestAnimationFrame(frame);
    if (!S.song || S.loading || !$('#studio').classList.contains('on')) return;
    const p = nowPos();
    if (!S.seeking && Math.abs(p - S.lastSeek) > 0.02) { $('#seek').value = p.toFixed(2); S.lastSeek = p; }
    const txt = fmt(S.seeking ? +$('#seek').value : p);
    if (txt !== lastTxt) { $('#t-cur').textContent = txt; lastTxt = txt; }
    const head = $('#lanes .head'); if (head && S.dur) head.style.left = `${(p / S.dur) * 100}%`;
    updateChords(p); updateLyrics(p);
  }

  // ------------------------------------------------------------ eventos
  function bind() {
    $('#tab-lib').onclick = () => showTab('lib');
    $('#tab-studio').onclick = () => showTab('studio');
    $('#go-lib').onclick = () => showTab('lib');
    $('#btn-settings').onclick = openSettings;

    $$('.upload .seg button').forEach(b => b.onclick = () => {
      S.stemsChoice = +b.dataset.stems; localStorage.setItem('ibe.stems', String(S.stemsChoice));
      $$('.upload .seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      $('#stems-hint').textContent = S.stemsChoice === 6 ? 'Voz, bateria, baixo, guitarra, teclado e outros. Guitarra e teclado são experimentais.' : 'Voz, bateria, baixo e outros instrumentos.';
    });
    $('#file').onchange = e => { Array.from(e.target.files).forEach(startUpload); e.target.value = ''; };
    const drop = $('#drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('drag');
      Array.from(e.dataTransfer.files).filter(f => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(f.name)).forEach(startUpload);
    });
    $('#jobs').onclick = e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const job = S.jobs.find(j => j.local === b.closest('.job').dataset.local); if (job) removeJob(job, true);
    };
    $('#playlists').onclick = e => {
      const b = e.target.closest('[data-pl]'); if (!b) return;
      if (b.dataset.pl === 'new') { newPlaylist(); return; }
      S.filter = b.dataset.pl; renderPlaylists(); renderSongs();
    };
    $('#search').oninput = e => { S.query = e.target.value; renderSongs(); };
    $('#songs').onclick = e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('.item').dataset.id;
      if (b.dataset.act === 'open') { if (S.song && S.song.id === id && !S.loading) showTab('studio'); else openSong(id); } else songMenu(id);
    };
    $('#pl-rename').onclick = async () => {
      const p = S.playlists.find(x => x.id === S.filter); if (!p) return;
      const v = await ask({ title: 'Renomear playlist', input: p.name, ok: 'Salvar' });
      if (v && v.trim()) { p.name = v.trim().slice(0, 60); await DB.put('playlists', p); await loadLibrary(); }
    };
    $('#pl-delete').onclick = async () => {
      const p = S.playlists.find(x => x.id === S.filter); if (!p) return;
      if (!(await ask({ title: 'Excluir playlist?', body: `“${p.name}” será apagada. As músicas continuam na biblioteca.`, ok: 'Excluir', danger: true }))) return;
      await DB.del('playlists', p.id); S.filter = 'all'; await loadLibrary();
    };

    $('#b-play').onclick = toggle;
    $('#b-back').onclick = () => seek(nowPos() - 5);
    $('#b-fwd').onclick = () => seek(nowPos() + 5);
    const sk = $('#seek');
    sk.addEventListener('input', () => { S.seeking = true; });
    sk.addEventListener('change', () => { S.seeking = false; seek(+sk.value); });

    $('#lanes').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (b) {
        const name = b.closest('[data-stem]').dataset.stem, g = S.gains[name], k = b.dataset.act;
        g[k] = !g[k]; b.setAttribute('aria-pressed', String(g[k])); sendGains(); saveSoon(); return;
      }
      const w = e.target.closest('.lane-w');
      if (w && S.dur) { const r = w.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * S.dur); }
    });
    $('#lanes').addEventListener('input', e => {
      if (e.target.dataset.act !== 'vol') return;
      S.gains[e.target.closest('[data-stem]').dataset.stem].vol = e.target.value / 100; sendGains(); saveSoon();
    });

    $('#p-minus').onclick = () => setPitch(S.pitch - 1);
    $('#p-plus').onclick = () => setPitch(S.pitch + 1);
    $('#sp').oninput = e => setSpeed(e.target.value / 100);
    $('#sp-reset').onclick = () => setSpeed(1);

    $('#lp-a').onclick = () => {
      S.loop.a = Math.round(nowPos() * 100) / 100;
      if (S.loop.b != null && S.loop.b <= S.loop.a + 0.2) { S.loop.b = null; S.loop.on = false; }
      sendLoop();
    };
    $('#lp-b').onclick = () => {
      const p = Math.round(nowPos() * 100) / 100;
      if (S.loop.a == null || p <= S.loop.a + 0.2) { toast('Marque o ponto B depois do ponto A.'); return; }
      S.loop.b = p; S.loop.on = true; sendLoop(); seek(S.loop.a);
    };
    $('#lp-on').onclick = () => {
      const { a, b } = S.loop;
      if (a == null || b == null) { toast('Marque os pontos A e B primeiro.'); return; }
      S.loop.on = !S.loop.on; sendLoop();
      const p = nowPos(); if (S.loop.on && (p < a || p > b)) seek(a);
    };
    $('#lp-clear').onclick = () => { S.loop = { a: null, b: null, on: false }; sendLoop(); };

    $('#mt-on').onclick = () => { S.metro.on = !S.metro.on; renderMetro(); sendMetro(); saveSoon(); };
    $$('#mt-mult button').forEach(b => b.onclick = () => { S.metro.mult = +b.dataset.mult; renderMetro(); renderHead(); sendMetro(); saveSoon(); });
    $('#mt-meter').onchange = e => { S.metro.meter = +e.target.value; sendMetro(); saveSoon(); };
    $('#mt-vol').oninput = e => { S.metro.vol = e.target.value / 100; Engine.send({ type: 'metro', on: S.metro.on, vol: S.metro.vol }); saveSoon(); };

    $('#ly-edit').onclick = editLyrics;
    $('#ly-sync').onclick = startSync;
    $('#sync-mark').onclick = markLine;
    $('#sync-undo').onclick = undoMark;
    $('#sync-done').onclick = endSync;
    $('#lyrics').onclick = e => {
      if (S.syncIdx >= 0) return;
      const ln = e.target.closest('.ln.timed'); if (ln) seek(S.lyrics[+ln.dataset.i].t);
    };

    $('#ex-stems').onclick = e => { const b = e.target.closest('[data-stem]'); if (b) exportStem(b.dataset.stem); };
    $('#ex-mix').onclick = exportMix;

    document.addEventListener('keydown', e => {
      if (!S.song || S.loading || $('#dlg').open || !$('#studio').classList.contains('on')) return;
      const tag = (e.target.tagName || '').toLowerCase(), typing = tag === 'textarea' || tag === 'select' || (tag === 'input' && e.target.type !== 'range');
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'Enter' && S.syncIdx >= 0) { e.preventDefault(); markLine(); }
      else if (tag !== 'input' && e.key === 'ArrowLeft') { e.preventDefault(); seek(nowPos() - 5); }
      else if (tag !== 'input' && e.key === 'ArrowRight') { e.preventDefault(); seek(nowPos() + 5); }
    });
    let rz; window.addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(drawWaves); });
    window.addEventListener('pagehide', () => { if (S.song) { clearTimeout(saveT); flushSave(); } });
  }

  async function boot() {
    bind(); renderPlay();
    S.stemsChoice = localStorage.getItem('ibe.stems') === '6' ? 6 : 4;
    const sb = $(`.upload .seg button[data-stems="${S.stemsChoice}"]`); if (sb) sb.click();
    try { await loadLibrary(); } catch (err) { console.error(err); toast('Não consegui abrir a biblioteca deste navegador.'); }
    try {
      for (const j of JSON.parse(localStorage.getItem('ibe.jobs') || '[]')) {
        const job = { local: j.local || uid(), id: j.id, title: j.title, status: 'queued', stage: 'Verificando…', progress: 0 };
        S.jobs.push(job); poll(job);
      }
      renderJobs();
    } catch (_) {}
    checkServer();
    requestAnimationFrame(frame);
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
