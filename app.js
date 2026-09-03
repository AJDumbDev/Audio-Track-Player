/* ============================================================
 * Soundboard — Audio Track Player
 * Clean separation: AudioEngine (playback) vs UI (rendering)
 * 100% client-side. Files loaded via URL.createObjectURL().
 * Multiple <audio> elements play simultaneously & independently.
 * ============================================================ */

"use strict";

/* ---------------- AudioEngine: playback logic only ---------------- */
class AudioEngine {
  static createTrackAudio(objectUrl, volume = 1, loop = false) {
    const audio = new Audio();
    audio.src = objectUrl;
    audio.preload = "metadata";
    audio.volume = volume;
    audio.loop = loop;
    return audio;
  }

  /** Play from the beginning (per spec: re-press restarts). */
  static playFromStart(audio) {
    audio.currentTime = 0;
    return audio.play();
  }

  static pause(audio) {
    audio.pause();
  }

  /** Stop = pause + reset position to 0. */
  static stop(audio) {
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      /* metadata not loaded yet — ignore */
    }
  }

  static destroy(audio, objectUrl) {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  /** Route audio to a specific output device (Chrome/Edge). */
  static async setSink(audio, deviceId) {
    if (!deviceId) return; // "" = default output, nothing to do
    if (typeof audio.setSinkId !== "function") {
      throw new Error("Output switching not supported in this browser");
    }
    await audio.setSinkId(deviceId);
  }

  static supportsOutputSelection() {
    return (
      typeof Audio !== "undefined" &&
      typeof new Audio().setSinkId === "function" &&
      !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)
    );
  }
}

/* ---------------- Store: track state ---------------- */
const store = {
  tracks: [], // { id, file, name, url, audio, volume, loop, hotkey, status, filterHidden }
  masterVolume: 0.9,
  outputDeviceId: "",
  nextId: 1,
};

const Status = {
  STOPPED: "Stopped",
  PLAYING: "Playing",
  PAUSED: "Paused",
};

/* ---------------- DOM refs ---------------- */
const $ = (sel) => document.querySelector(sel);
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const chooseBtn = $("#chooseBtn");
const trackGrid = $("#trackGrid");
const emptyState = $("#emptyState");
const template = $("#trackCardTemplate");
const stopAllBtn = $("#stopAllBtn");
const clearAllBtn = $("#clearAllBtn");
const searchInput = $("#searchInput");
const trackCount = $("#trackCount");
const playingCount = $("#playingCount");
const footerCount = $("#footerCount");
const masterVolume = $("#masterVolume");
const masterVolumeVal = $("#masterVolumeVal");
const outputSelect = $("#outputDevice");
const outputRefreshBtn = $("#outputRefreshBtn");
const outputStatus = $("#outputStatus");

/* Card element lookup: trackId -> elements */
const cardRefs = new Map();

/* ---------------- Helpers ---------------- */
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function cleanFileName(name) {
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || name;
}

function effectiveVolume(track) {
  return track.volume * store.masterVolume;
}

function updateCounts() {
  const total = store.tracks.length;
  const playing = store.tracks.filter((t) => t.status === Status.PLAYING).length;
  trackCount.textContent = `${total} track${total === 1 ? "" : "s"}`;
  playingCount.textContent = `${playing} playing`;
  footerCount.textContent = String(total);
  emptyState.style.display = total === 0 ? "block" : "none";
}

/* ---------------- Core actions ---------------- */
function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) =>
    /audio|\.(mp3|wav|ogg|m4a|opus|aac|flac|webm)$/i.test(f.type + " " + f.name)
  );
  if (files.length === 0) return;

  for (const file of files) {
    const url = URL.createObjectURL(file);
    const audio = AudioEngine.createTrackAudio(url, store.masterVolume, false);

    const track = {
      id: store.nextId++,
      file,
      name: cleanFileName(file.name),
      url,
      audio,
      volume: 1,
      loop: false,
      hotkey: null,
      status: Status.STOPPED,
      filterHidden: false,
    };
    // Route new track to the selected output device (if any).
    if (store.outputDeviceId) {
      AudioEngine.setSink(audio, store.outputDeviceId).catch((err) =>
        console.warn("Could not set output device:", err)
      );
    }
    wireAudioEvents(track);
    store.tracks.push(track);
    renderCard(track);
  }
  applyFilter(searchInput.value);
  updateCounts();
}

function wireAudioEvents(track) {
  const audio = track.audio;
  audio.addEventListener("loadedmetadata", () => {
    const ref = cardRefs.get(track.id);
    if (ref) ref.dur.textContent = formatTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    const ref = cardRefs.get(track.id);
    if (!ref || !isFinite(audio.duration) || audio.duration === 0) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    ref.fill.style.width = `${pct}%`;
    ref.cur.textContent = formatTime(audio.currentTime);
  });
  audio.addEventListener("play", () => setStatus(track, Status.PLAYING));
  audio.addEventListener("pause", () => {
    // 'pause' fires for both pause() and stop(); distinguish by position/end.
    if (audio.currentTime === 0 || audio.ended) {
      // handled by 'ended' or explicit stop — but ensure UI sync
      if (track.status === Status.PLAYING) setStatus(track, Status.STOPPED);
    } else if (track.status === Status.PLAYING) {
      setStatus(track, Status.PAUSED);
    }
  });
  audio.addEventListener("ended", () => {
    if (!audio.loop) {
      try {
        audio.currentTime = 0;
      } catch { /* ignore */ }
      setStatus(track, Status.STOPPED);
      syncProgress(track, true);
    }
  });
  audio.addEventListener("error", () => setStatus(track, Status.STOPPED));
}

function setStatus(track, status) {
  track.status = status;
  const ref = cardRefs.get(track.id);
  if (!ref) return;
  ref.card.classList.toggle("is-playing", status === Status.PLAYING);
  ref.card.classList.toggle("is-paused", status === Status.PAUSED);
  ref.statusText.textContent = status;
  updateCounts();
}

function syncProgress(track, reset = false) {
  const ref = cardRefs.get(track.id);
  if (!ref) return;
  if (reset) {
    ref.fill.style.width = "0%";
    ref.cur.textContent = "0:00";
  }
}

async function playTrack(track) {
  // Spec: pressing Play restarts from beginning.
  track.audio.volume = effectiveVolume(track);
  try {
    await AudioEngine.playFromStart(track.audio);
  } catch (err) {
    console.warn("Playback failed:", err);
  }
  syncProgress(track);
}

function pauseTrack(track) {
  if (track.audio.paused) {
    // resume
    track.audio.play().catch(() => {});
  } else {
    AudioEngine.pause(track.audio);
    setStatus(track, Status.PAUSED);
  }
}

function stopTrack(track) {
  AudioEngine.stop(track.audio);
  setStatus(track, Status.STOPPED);
  syncProgress(track, true);
}

function stopAll() {
  for (const t of store.tracks) stopTrack(t);
}

function removeTrack(track) {
  AudioEngine.destroy(track.audio, track.url);
  store.tracks = store.tracks.filter((t) => t.id !== track.id);
  const ref = cardRefs.get(track.id);
  if (ref) ref.card.remove();
  cardRefs.delete(track.id);
  updateCounts();
}

function clearAll() {
  if (store.tracks.length === 0) return;
  if (!confirm(`Remove all ${store.tracks.length} track(s)?`)) return;
  for (const t of store.tracks) AudioEngine.destroy(t.audio, t.url);
  store.tracks = [];
  cardRefs.clear();
  trackGrid.innerHTML = "";
  updateCounts();
}

/* ---------------- Rendering (UI logic) ---------------- */
function renderCard(track) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector(".card");
  card.dataset.id = track.id;

  const refs = {
    card,
    statusText: node.querySelector(".status-text"),
    name: node.querySelector(".track-name"),
    fill: node.querySelector(".progress-fill"),
    cur: node.querySelector(".time-cur"),
    dur: node.querySelector(".time-dur"),
    progressWrap: node.querySelector(".progress-wrap"),
    playBtn: node.querySelector(".btn-play"),
    pauseBtn: node.querySelector(".btn-pause"),
    stopBtn: node.querySelector(".btn-stop"),
    delBtn: node.querySelector(".btn-delete"),
    vol: node.querySelector(".vol-slider"),
    dragHandle: node.querySelector(".drag-handle"),
    cardTop: node.querySelector(".card-top"),
    loopBtn: node.querySelector(".chip-loop"),
    renameBtn: node.querySelector(".chip-rename"),
    hotkeyBtn: node.querySelector(".chip-hotkey"),
    hotkeyBadge: node.querySelector(".hotkey-badge"),
  };
  refs.name.textContent = track.name;

  // Number shortcut label (1-9 by position)
  updateHotkeyBadge(track, refs);

  refs.playBtn.addEventListener("click", () => playTrack(track));
  refs.pauseBtn.addEventListener("click", () => pauseTrack(track));
  refs.stopBtn.addEventListener("click", () => stopTrack(track));
  refs.delBtn.addEventListener("click", () => removeTrack(track));

  refs.vol.addEventListener("input", () => {
    track.volume = refs.vol.value / 100;
    track.audio.volume = effectiveVolume(track);
  });
  // Volume slider (and all controls) must never start a card drag.
  // The card stays non-draggable except when grabbed by the handle.
  refs.vol.setAttribute("draggable", "false");
  ["pointerdown", "mousedown", "touchstart"].forEach((ev) =>
    refs.vol.addEventListener(ev, (e) => e.stopPropagation(), { passive: true })
  );
  refs.vol.addEventListener("dragstart", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  refs.loopBtn.addEventListener("click", () => {
    track.loop = !track.loop;
    track.audio.loop = track.loop;
    refs.loopBtn.classList.toggle("active", track.loop);
  });

  const startRename = () => {
    const next = prompt("Rename track:", track.name);
    if (next && next.trim()) {
      track.name = next.trim();
      refs.name.textContent = track.name;
    }
  };
  refs.renameBtn.addEventListener("click", startRename);
  refs.name.addEventListener("dblclick", startRename);

  // Seek on progress click
  refs.progressWrap.addEventListener("click", (e) => {
    const bar = refs.progressWrap.querySelector(".progress-track");
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const audio = track.audio;
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    }
  });

  // Custom hotkey assignment
  const assignHotkey = () => {
    card.classList.add("listening-hotkey");
    refs.hotkeyBadge.textContent = "press key…";
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      // Clear conflicts
      for (const t of store.tracks) {
        if (t.hotkey === key) {
          t.hotkey = null;
          const r = cardRefs.get(t.id);
          if (r) updateHotkeyBadge(t, r);
        }
      }
      track.hotkey = key === "ESCAPE" ? null : key;
      updateHotkeyBadge(track, refs);
      card.classList.remove("listening-hotkey");
      window.removeEventListener("keydown", handler, true);
    };
    window.addEventListener("keydown", handler, true);
  };
  refs.hotkeyBtn.addEventListener("click", assignHotkey);
  refs.hotkeyBadge.addEventListener("click", assignHotkey);

  // Drag-to-reorder (HTML5 DnD) — handle-only, so sliders/buttons
  // never trigger a reorder. Card is draggable="false" by default.
  refs.dragHandle.setAttribute("draggable", "true");
  refs.dragHandle.addEventListener("pointerdown", () => {
    card.draggable = true;
  });
  refs.dragHandle.addEventListener("mousedown", () => {
    card.draggable = true;
  });
  const lockDrag = () => {
    card.draggable = false;
  };
  window.addEventListener("pointerup", lockDrag);
  card.addEventListener("dragstart", (e) => {
    // Extra guard: only allow drags originating from the handle.
    const fromHandle = e.target === refs.dragHandle || e.target === card;
    if (!fromHandle && !card.draggable) {
      e.preventDefault();
      return;
    }
    if (e.target.closest("input,button,.progress-wrap,.track-name,.hotkey-badge")) {
      e.preventDefault();
      card.draggable = false;
      return;
    }
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", String(track.id));
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    card.draggable = false;
  });

  cardRefs.set(track.id, refs);
  trackGrid.appendChild(node);
}

function updateHotkeyBadge(track, refs) {
  const idx = store.tracks.indexOf(track);
  const auto = idx >= 0 && idx < 9 ? String(idx + 1) : null;
  if (track.hotkey) {
    refs.hotkeyBadge.textContent = track.hotkey;
    refs.hotkeyBadge.title = `Custom hotkey "${track.hotkey}" — click to reassign (Esc clears)`;
  } else if (auto) {
    refs.hotkeyBadge.textContent = auto;
    refs.hotkeyBadge.title = `Press ${auto} to play — click to assign a custom hotkey`;
  } else {
    refs.hotkeyBadge.textContent = "–";
    refs.hotkeyBadge.title = "Click to assign a custom hotkey";
  }
}

function refreshAllBadges() {
  for (const t of store.tracks) {
    const r = cardRefs.get(t.id);
    if (r) updateHotkeyBadge(t, r);
  }
}

function applyFilter(q) {
  const query = (q || "").trim().toLowerCase();
  for (const t of store.tracks) {
    const hide = query && !t.name.toLowerCase().includes(query);
    t.filterHidden = !!hide;
    const ref = cardRefs.get(t.id);
    if (ref) ref.card.style.display = hide ? "none" : "";
  }
}

/* Reorder via dragover on grid */
trackGrid.addEventListener("dragover", (e) => {
  e.preventDefault();
  const dragging = trackGrid.querySelector(".dragging");
  if (!dragging) return;
  const after = [...trackGrid.querySelectorAll(".card:not(.dragging)")].find((el) => {
    const r = el.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (after) trackGrid.insertBefore(dragging, after);
  else trackGrid.appendChild(dragging);
});

trackGrid.addEventListener("drop", (e) => {
  e.preventDefault();
  // Rebuild store order from DOM order
  const order = [...trackGrid.querySelectorAll(".card")].map((c) => Number(c.dataset.id));
  store.tracks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  refreshAllBadges();
});

/* ---------------- Upload wiring ---------------- */
chooseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});
dropzone.addEventListener("click", (e) => {
  if (e.target === chooseBtn || e.target === fileInput) return;
  fileInput.click();
});
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = ""; // allow re-selecting same files
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length) addFiles(dt.files);
});

// Allow dropping files anywhere on the page
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length && !dropzone.contains(e.target)) {
    addFiles(e.dataTransfer.files);
  }
});

/* ---------------- Global controls ---------------- */
stopAllBtn.addEventListener("click", stopAll);
clearAllBtn.addEventListener("click", clearAll);
searchInput.addEventListener("input", () => applyFilter(searchInput.value));

masterVolume.addEventListener("input", () => {
  store.masterVolume = masterVolume.value / 100;
  masterVolumeVal.textContent = `${masterVolume.value}%`;
  for (const t of store.tracks) t.audio.volume = effectiveVolume(t);
});

/* ---------------- Audio output selection ---------------- */
function setOutputStatus(msg) {
  if (outputStatus) {
    outputStatus.textContent = msg;
    outputStatus.title = msg;
  }
}

function friendlyOutputName(device, index) {
  if (device.label) return device.label;
  if (device.deviceId === "default") return "System default speaker";
  if (device.deviceId === "communications") return "Communications device";
  const short = (device.deviceId || "").slice(0, 6);
  return short ? `Speaker ${index + 1} (${short}…)` : `Speaker ${index + 1}`;
}

async function refreshOutputDevices() {
  // Always start from a known state so the dropdown never looks "stuck".
  outputSelect.innerHTML = `<option value="">Default output</option>`;
  outputSelect.disabled = false;
  if (outputRefreshBtn) outputRefreshBtn.disabled = false;

  if (!navigator.mediaDevices?.enumerateDevices) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = "Device list blocked — serve over localhost/HTTPS";
    outputSelect.appendChild(opt);
    setOutputStatus("⚠ mediaDevices unavailable (insecure context?)");
    console.warn("[output] navigator.mediaDevices.enumerateDevices missing. isSecureContext =", window.isSecureContext);
    return;
  }
  if (!AudioEngine.supportsOutputSelection()) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = "Switching needs Chrome/Edge 49+";
    outputSelect.appendChild(opt);
    outputSelect.disabled = true;
    setOutputStatus("⚠ this browser can't switch outputs");
    console.warn("[output] setSinkId() not supported in this browser");
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    console.log("[output] enumerateDevices ->", outputs);
    // De-duplicate by deviceId (Chrome can list "default" twice).
    const seen = new Set();
    const unique = outputs.filter((d) => {
      const key = `${d.deviceId}|${d.groupId || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.forEach((d, i) => {
      // Skip empty-id entries — value "" already means "Default output".
      if (!d.deviceId) return;
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = friendlyOutputName(d, i);
      outputSelect.appendChild(opt);
    });
    const realCount = [...outputSelect.options].filter((o) => o.value).length;
    if (realCount === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.textContent = "No extra outputs — plug in headphones/speakers, then ↻";
      outputSelect.appendChild(opt);
      setOutputStatus("1 option: only default speaker found");
    } else if (unique.every((d) => !d.label)) {
      setOutputStatus(`${realCount + 1} outputs (names hidden — press ↻ to reveal)`);
      outputSelect.title =
        "Names hidden by browser — press ↻ and allow microphone once to reveal them. Selection still works.";
    } else {
      setOutputStatus(`${realCount + 1} outputs found`);
      outputSelect.title = "Choose where audio plays";
    }
    // Restore previous selection if still present
    const prev = store.outputDeviceId;
    if (prev && [...outputSelect.options].some((o) => o.value === prev)) {
      outputSelect.value = prev;
    } else {
      store.outputDeviceId = outputSelect.value || "";
    }
  } catch (err) {
    console.warn("Could not list audio outputs:", err);
    setOutputStatus("⚠ could not list outputs — see console");
  }
}

async function applyOutputDeviceToAll() {
  const id = store.outputDeviceId;
  if (!id) return; // default output — nothing to set
  const results = await Promise.allSettled(
    store.tracks.map((t) => AudioEngine.setSink(t.audio, id))
  );
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    console.warn("Output switch failed:", failed.reason);
    alert(
      "Could not switch audio output. The device may be disconnected, or this browser blocks it.\n" +
        "Use Chrome/Edge over HTTPS or localhost."
    );
    outputSelect.value = "";
    store.outputDeviceId = "";
  }
}

outputSelect.addEventListener("change", async () => {
  store.outputDeviceId = outputSelect.value || "";
  await applyOutputDeviceToAll();
});

outputRefreshBtn.addEventListener("click", async () => {
  // If labels are hidden, offer one mic-permission request so real
  // speaker names appear. Stream is stopped immediately; no audio recorded.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hidden = devices
      .filter((d) => d.kind === "audiooutput")
      .every((d) => !d.label);
    if (hidden && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
  } catch {
    /* user denied mic — still refresh, generic names will show */
  }
  await refreshOutputDevices();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", refreshOutputDevices);
}

/* ---------------- Keyboard shortcuts ---------------- */
window.addEventListener("keydown", (e) => {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" && document.activeElement !== document.body) {
    if (document.activeElement.type === "text") return; // don't hijack search typing
  }

  if (e.key === "/") {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (e.key.toLowerCase() === "u" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    fileInput.click();
    return;
  }
  if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
    // 'S' = stop all (avoid clash while typing)
    if (tag === "input" || tag === "textarea") return;
    e.preventDefault();
    stopAll();
    return;
  }

  // Custom hotkeys first
  const pressed = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const custom = store.tracks.find((t) => t.hotkey === pressed);
  if (custom && !e.ctrlKey && !e.metaKey) {
    if (tag === "input" || tag === "textarea") return;
    e.preventDefault();
    playTrack(custom);
    const ref = cardRefs.get(custom.id);
    ref?.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  // Numeric 1-9 -> play track by visible position
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    if (tag === "input" || tag === "textarea") return;
    const visible = store.tracks.filter((t) => !t.filterHidden);
    const t = visible[Number(e.key) - 1];
    if (t) playTrack(t);
  }
});

/* ---------------- Init ---------------- */
updateCounts();
refreshOutputDevices();
