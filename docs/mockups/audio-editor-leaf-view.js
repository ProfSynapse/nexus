const state = {
  duration: 168,
  currentTime: 24.6,
  isPlaying: false,
  zoom: 2,
  timelineExpanded: false,
  editMode: 'pointer',
  activeWorkspaceId: 'podcast-lab',
  activeSourceId: 'episode-main',
  selectedParagraphId: 'core-thesis',
  selectedClipId: 'clip-core-thesis',
  sourceSearch: '',
  dragState: null,
  playTimer: null,
  workspaces: [
    {
      id: 'podcast-lab',
      label: 'Podcast lab',
      folders: [
        {
          path: 'recordings',
          files: [
            { id: 'episode-main', name: 'episode-07-host.wav', duration: 42, kind: 'voice' },
            { id: 'guest-quote', name: 'guest-quote.wav', duration: 14, kind: 'voice' }
          ]
        },
        {
          path: 'recordings/raw',
          files: [
            { id: 'room-tone', name: 'room-tone.wav', duration: 10, kind: 'voice' }
          ]
        },
        {
          path: 'music',
          files: [
            { id: 'intro-bed', name: 'intro-bed.mp3', duration: 28, kind: 'music' },
            { id: 'sting', name: 'chapter-sting.ogg', duration: 3, kind: 'music' }
          ]
        }
      ]
    },
    {
      id: 'course-audio',
      label: 'Course audio',
      folders: [
        {
          path: 'lessons/lesson-01',
          files: [
            { id: 'lesson-voice', name: 'lesson-01-voice.wav', duration: 31, kind: 'voice' }
          ]
        },
        {
          path: 'lessons/lesson-01/music',
          files: [
            { id: 'lesson-bed', name: 'lesson-bed.mp3', duration: 24, kind: 'music' }
          ]
        }
      ]
    }
  ],
  waveform: [22, 40, 58, 33, 68, 52, 19, 50, 66, 38, 24, 61, 28, 54, 70, 25, 42, 60, 34, 47, 62, 27],
  tracks: [
    {
      id: 'track-1',
      name: 'Host',
      kind: 'voice',
      clips: [
        {
          id: 'clip-core-thesis',
          title: 'Core thesis',
          start: 24,
          end: 61,
          paragraphId: 'core-thesis',
          fadeIn: 4,
          fadeOut: 0,
          keyframes: [
            { id: 'kf-1', t: 0.22, value: 0.48 },
            { id: 'kf-2', t: 0.64, value: 0.35 }
          ]
        },
        {
          id: 'clip-roadmap',
          title: 'Roadmap',
          start: 70,
          end: 113,
          paragraphId: 'roadmap',
          fadeIn: 0,
          fadeOut: 5,
          keyframes: [{ id: 'kf-3', t: 0.52, value: 0.55 }]
        }
      ]
    },
    {
      id: 'track-2',
      name: 'Music',
      kind: 'music',
      clips: [
        {
          id: 'clip-bed',
          title: 'Intro bed',
          start: 0,
          end: 28,
          paragraphId: 'guest-quote',
          fadeIn: 6,
          fadeOut: 6,
          keyframes: [{ id: 'kf-4', t: 0.28, value: 0.65 }]
        }
      ]
    }
  ],
  paragraphs: [
    {
      id: 'guest-quote',
      speaker: 'Guest',
      start: 8,
      end: 22,
      text: 'Honestly, the smallest cut won.',
      overlays: [
        { label: 'Intro bed', clipId: 'clip-bed' }
      ]
    },
    {
      id: 'core-thesis',
      speaker: 'Host',
      start: 24,
      end: 61,
      text: 'So today we are cutting an audio editor that feels closer to a document than a DAW. Keep the waveform close.',
      overlays: [
        { label: 'Bed under voice', clipId: 'clip-bed' },
        { label: 'Keyboard hit', clipId: 'clip-core-thesis' }
      ]
    },
    {
      id: 'roadmap',
      speaker: 'Host',
      start: 70,
      end: 113,
      text: 'Add tracks, trim clips, fade audio, and set gain markers.',
      overlays: [
        { label: 'Transition sting', clipId: 'clip-roadmap' }
      ]
    }
  ]
};

const workspaceSelect = document.getElementById('workspace-select');
const sourceSearch = document.getElementById('source-search');
const sourceTree = document.getElementById('source-tree');
const transcriptList = document.getElementById('transcript-list');
const timelineToggle = document.getElementById('timeline-toggle');
const timelinePanel = document.getElementById('timeline-panel');
const timelineOverview = document.getElementById('timeline-overview');
const timeReadout = document.getElementById('time-readout');
const durationReadout = document.getElementById('duration-readout');
const playToggle = document.getElementById('play-toggle');
const timelineRuler = document.getElementById('timeline-ruler');
const trackList = document.getElementById('track-list');
const zoomRange = document.getElementById('zoom-range');
const modePointer = document.getElementById('mode-pointer');
const modeCut = document.getElementById('mode-cut');

function formatTime(value) {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  const paddedSeconds = seconds < 10 ? `0${seconds.toFixed(1)}` : seconds.toFixed(1);
  return `${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getActiveWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) || state.workspaces[0];
}

function getSelectedParagraph() {
  return state.paragraphs.find((paragraph) => paragraph.id === state.selectedParagraphId) || state.paragraphs[0];
}

function getSelectedClip() {
  return state.tracks.flatMap((track) => track.clips).find((clip) => clip.id === state.selectedClipId) || null;
}

function getSelectedTrack() {
  return state.tracks.find((track) => track.clips.some((clip) => clip.id === state.selectedClipId)) || state.tracks[0];
}

function findClipIdForParagraph(paragraphId) {
  const clip = state.tracks.flatMap((track) => track.clips).find((item) => item.paragraphId === paragraphId);
  return clip?.id || null;
}

function getActiveSource() {
  return getActiveWorkspace().folders.flatMap((folder) => folder.files).find((file) => file.id === state.activeSourceId) || null;
}

function matchesSourceSearch(folder, file) {
  const query = state.sourceSearch.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [folder.path, file.name].join(' ').toLowerCase().includes(query);
}

function updateReadout() {
  timeReadout.textContent = formatTime(state.currentTime);
  durationReadout.textContent = formatTime(state.duration);
  playToggle.textContent = state.isPlaying ? '⏸' : '▶';
  playToggle.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
}

function renderWorkspaceSelect() {
  workspaceSelect.innerHTML = '';
  state.workspaces.forEach((workspace) => {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = workspace.label;
    workspaceSelect.appendChild(option);
  });
  workspaceSelect.value = state.activeWorkspaceId;
}

function renderSourceTree() {
  sourceTree.innerHTML = '';

  getActiveWorkspace().folders.forEach((folder) => {
    const visibleFiles = folder.files.filter((file) => matchesSourceSearch(folder, file));
    if (visibleFiles.length === 0) {
      return;
    }

    const group = document.createElement('section');
    group.className = 'folder-group';

    const label = document.createElement('div');
    label.className = 'folder-label';
    label.textContent = folder.path;
    group.appendChild(label);

    const children = document.createElement('div');
    children.className = 'folder-children';

    visibleFiles.forEach((file) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-file';
      if (file.id === state.activeSourceId) {
        button.classList.add('is-active');
      }
      button.addEventListener('click', () => {
        state.activeSourceId = file.id;
        renderSourceTree();
      });
      button.addEventListener('dblclick', () => {
        addSourceToTrack(false);
      });

      const copy = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'source-file-name';
      name.textContent = file.name;
      const meta = document.createElement('span');
      meta.className = 'source-file-meta';
      meta.textContent = folder.path;
      copy.append(name, meta);

      const duration = document.createElement('span');
      duration.className = 'source-file-meta';
      duration.textContent = formatTime(file.duration);

      button.append(copy, duration);
      children.appendChild(button);
    });

    group.appendChild(children);
    sourceTree.appendChild(group);
  });
}

function renderTranscript() {
  transcriptList.innerHTML = '';

  state.paragraphs.forEach((paragraph) => {
    const paragraphEl = document.createElement('article');
    paragraphEl.className = 'paragraph';
    if (paragraph.id === state.selectedParagraphId) {
      paragraphEl.classList.add('is-selected');
    }

    const header = document.createElement('div');
    header.className = 'paragraph-header';
    const speaker = document.createElement('div');
    speaker.className = 'paragraph-speaker';
    speaker.textContent = paragraph.speaker;
    const meta = document.createElement('div');
    meta.className = 'paragraph-meta';
    meta.textContent = `${formatTime(paragraph.start)} to ${formatTime(paragraph.end)}`;
    header.append(speaker, meta);

    const editor = document.createElement('div');
    editor.className = 'paragraph-editor';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.textContent = paragraph.text;
    editor.addEventListener('focus', () => {
      state.selectedParagraphId = paragraph.id;
      state.selectedClipId = findClipIdForParagraph(paragraph.id) || state.selectedClipId;
      state.currentTime = paragraph.start;
      render();
    });
    editor.addEventListener('input', () => {
      paragraph.text = editor.textContent || '';
    });

    paragraphEl.append(header, editor);

    if (paragraph.overlays && paragraph.overlays.length > 0) {
      const overlays = document.createElement('div');
      overlays.className = 'paragraph-overlays';

      paragraph.overlays.forEach((overlay) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'overlay-chip';
        chip.textContent = overlay.label;
        chip.addEventListener('click', () => {
          state.selectedParagraphId = paragraph.id;
          state.selectedClipId = overlay.clipId || findClipIdForParagraph(paragraph.id) || state.selectedClipId;
          state.timelineExpanded = true;
          render();
        });
        overlays.appendChild(chip);
      });

      paragraphEl.appendChild(overlays);
    }

    transcriptList.appendChild(paragraphEl);
  });
}

function renderTimelineRuler() {
  timelineRuler.innerHTML = '';
  for (let time = 0; time <= state.duration; time += 12) {
    const tick = document.createElement('div');
    tick.className = 'timeline-tick';
    tick.textContent = formatTime(time).slice(0, 5);
    timelineRuler.appendChild(tick);
  }
}

function renderWaveform(container, samples, kind) {
  container.innerHTML = '';
  const width = container.clientWidth || 500;
  const height = container.clientHeight || 48;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('waveform-svg');

  const gap = 4;
  const barWidth = Math.max((width - gap * (samples.length - 1)) / samples.length, 2);
  const fill = kind === 'music' ? 'rgba(255,255,255,0.28)' : 'rgba(155,188,255,0.56)';

  samples.forEach((sample, index) => {
    const amplitude = (sample / 100) * height * 0.75;
    const y = (height - amplitude) / 2;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(index * (barWidth + gap)));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barWidth));
    rect.setAttribute('height', String(amplitude));
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', fill);
    svg.appendChild(rect);
  });

  container.appendChild(svg);
}

function renderOverview() {
  renderWaveform(timelineOverview, state.waveform.concat(state.waveform.slice(0, 8)), 'voice');
  const playhead = document.createElement('div');
  playhead.className = 'overview-playhead';
  playhead.style.left = `${(state.currentTime / state.duration) * 100}%`;
  timelineOverview.appendChild(playhead);
}

function renderTracks() {
  trackList.innerHTML = '';
  document.documentElement.style.setProperty('--timeline-zoom', String(1 + state.zoom * 0.25));
  const selectedParagraph = getSelectedParagraph();

  state.tracks.forEach((track) => {
    const row = document.createElement('article');
    row.className = 'track-row';
    if (!track.clips.some((clip) => clip.paragraphId === selectedParagraph.id)) {
      row.classList.add('is-dimmed');
    }

    const header = document.createElement('div');
    header.className = 'track-header';

    const trackName = document.createElement('input');
    trackName.className = 'track-name-input';
    trackName.value = track.name;
    trackName.addEventListener('input', () => {
      track.name = trackName.value;
    });

    const meta = document.createElement('div');
    meta.className = 'track-meta';
    meta.textContent = track.kind === 'music' ? 'Music track' : 'Audio track';
    header.append(trackName, meta);

    const lane = document.createElement('div');
    lane.className = 'track-lane';

    const grid = document.createElement('div');
    grid.className = 'lane-grid';
    for (let tick = 0; tick < 18; tick += 1) {
      grid.appendChild(document.createElement('span'));
    }
    lane.appendChild(grid);

    track.clips.forEach((clip) => {
      const clipLength = clip.end - clip.start;
      const clipEl = document.createElement('div');
      clipEl.className = `clip ${track.kind === 'music' ? 'is-music' : ''}`.trim();
      if (clip.id === state.selectedClipId) {
        clipEl.classList.add('is-selected');
      }
      if (state.editMode === 'cut') {
        clipEl.classList.add('is-cut-mode');
      }
      clipEl.style.left = `${(clip.start / state.duration) * 100}%`;
      clipEl.style.width = `${(clipLength / state.duration) * 100}%`;
      clipEl.addEventListener('click', (event) => {
        if (state.editMode === 'cut') {
          event.stopPropagation();
          state.selectedClipId = clip.id;
          cutSelectedClip();
          return;
        }
        state.selectedClipId = clip.id;
        state.selectedParagraphId = clip.paragraphId;
        state.currentTime = clip.start;
        render();
      });

      const label = document.createElement('div');
      label.className = 'clip-label';
      const title = document.createElement('div');
      title.className = 'clip-title';
      title.textContent = clip.title;
      const metaLabel = document.createElement('div');
      metaLabel.className = 'clip-meta';
      metaLabel.textContent = `${formatTime(clip.start)} to ${formatTime(clip.end)}`;
      label.append(title, metaLabel);

      const wave = document.createElement('div');
      wave.className = 'clip-wave';

      const leftHandle = document.createElement('div');
      leftHandle.className = 'clip-handle clip-handle-left';
      leftHandle.addEventListener('pointerdown', (event) => startClipResize(event, clip, lane, 'left'));

      const rightHandle = document.createElement('div');
      rightHandle.className = 'clip-handle clip-handle-right';
      rightHandle.addEventListener('pointerdown', (event) => startClipResize(event, clip, lane, 'right'));

      const fadeInLine = document.createElement('div');
      fadeInLine.className = 'fade-line';
      fadeInLine.style.left = '0';
      fadeInLine.style.width = `${(clip.fadeIn / Math.max(1, clipLength)) * 100}%`;
      fadeInLine.style.transform = 'skewY(-18deg)';
      fadeInLine.style.transformOrigin = 'left bottom';

      const fadeOutLine = document.createElement('div');
      fadeOutLine.className = 'fade-line';
      fadeOutLine.style.right = '0';
      fadeOutLine.style.width = `${(clip.fadeOut / Math.max(1, clipLength)) * 100}%`;
      fadeOutLine.style.transform = 'skewY(18deg)';
      fadeOutLine.style.transformOrigin = 'right bottom';

      const fadeInHandle = document.createElement('div');
      fadeInHandle.className = 'fade-handle fade-handle-in';
      fadeInHandle.addEventListener('pointerdown', (event) => startFadeResize(event, clip, lane, 'in'));

      const fadeOutHandle = document.createElement('div');
      fadeOutHandle.className = 'fade-handle fade-handle-out';
      fadeOutHandle.addEventListener('pointerdown', (event) => startFadeResize(event, clip, lane, 'out'));

      clip.keyframes.forEach((keyframe) => {
        const point = document.createElement('div');
        point.className = 'gain-point';
        point.style.left = `${keyframe.t * 100}%`;
        point.style.top = `${keyframe.value * 100}%`;
        point.addEventListener('pointerdown', (event) => startKeyframeDrag(event, clip, keyframe, lane));
        clipEl.appendChild(point);
      });

      clipEl.append(label, wave, fadeInLine, fadeOutLine, fadeInHandle, fadeOutHandle, leftHandle, rightHandle);
      lane.appendChild(clipEl);
      renderWaveform(wave, state.waveform.slice(0, 12), track.kind);
    });

    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    playhead.style.left = `${(state.currentTime / state.duration) * 100}%`;
    lane.appendChild(playhead);

    row.append(header, lane);
    trackList.appendChild(row);
  });
}

function render() {
  renderWorkspaceSelect();
  renderSourceTree();
  renderTranscript();
  renderOverview();
  renderTimelineRuler();
  renderTracks();
  updateReadout();
  timelinePanel.classList.toggle('is-collapsed', !state.timelineExpanded);
  timelineToggle.textContent = state.timelineExpanded ? '▾' : '▸';
  timelineToggle.setAttribute('aria-expanded', state.timelineExpanded ? 'true' : 'false');
  modePointer.classList.toggle('is-active', state.editMode === 'pointer');
  modeCut.classList.toggle('is-active', state.editMode === 'cut');
  modePointer.setAttribute('aria-selected', state.editMode === 'pointer' ? 'true' : 'false');
  modeCut.setAttribute('aria-selected', state.editMode === 'cut' ? 'true' : 'false');
}

function stopPlayback() {
  state.isPlaying = false;
  if (state.playTimer) {
    window.clearInterval(state.playTimer);
    state.playTimer = null;
  }
}

function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
    render();
    return;
  }

  state.isPlaying = true;
  state.playTimer = window.setInterval(() => {
    state.currentTime += 0.2;
    if (state.currentTime >= state.duration) {
      state.currentTime = state.duration;
      stopPlayback();
    }
    renderOverview();
    renderTracks();
    updateReadout();
  }, 120);
  render();
}

function createTrack(kind = 'voice') {
  const track = {
    id: `track-${Date.now()}`,
    name: kind === 'music' ? `Music ${state.tracks.length + 1}` : `Track ${state.tracks.length + 1}`,
    kind,
    clips: []
  };
  state.tracks.push(track);
  return track;
}

function addSourceToTrack(createNewTrack) {
  const source = getActiveSource();
  if (!source) {
    return;
  }

  const targetTrack = createNewTrack ? createTrack(source.kind) : getSelectedTrack();
  if (targetTrack.kind !== source.kind) {
    targetTrack.kind = source.kind;
  }

  const clipId = `clip-${Date.now()}`;
  targetTrack.clips.push({
    id: clipId,
    title: source.name.replace(/\.[^.]+$/, ''),
    start: state.currentTime,
    end: Math.min(state.duration, state.currentTime + source.duration),
    paragraphId: state.selectedParagraphId,
    fadeIn: 0,
    fadeOut: 0,
    keyframes: []
  });

  state.selectedClipId = clipId;
  state.timelineExpanded = true;
  render();
}

function deleteSelectedClip() {
  const track = getSelectedTrack();
  if (!track) {
    return;
  }
  track.clips = track.clips.filter((clip) => clip.id !== state.selectedClipId);
  state.selectedClipId = track.clips[0]?.id || state.tracks[0]?.clips[0]?.id || '';
  render();
}

function cutSelectedClip() {
  const clip = getSelectedClip();
  const track = getSelectedTrack();
  if (!clip || !track) {
    return;
  }

  const midpoint = clip.start + (clip.end - clip.start) / 2;
  const leftClip = { ...clip, id: `${clip.id}-a`, end: midpoint };
  const rightClip = { ...clip, id: `${clip.id}-b`, start: midpoint };
  track.clips = track.clips.flatMap((item) => (item.id === clip.id ? [leftClip, rightClip] : [item]));
  state.selectedClipId = rightClip.id;
  state.currentTime = midpoint;
  render();
}

function addKeyframeAtCursor() {
  const clip = getSelectedClip();
  if (!clip) {
    return;
  }
  const relative = clamp((state.currentTime - clip.start) / Math.max(1, clip.end - clip.start), 0.08, 0.92);
  clip.keyframes.push({
    id: `kf-${Date.now()}`,
    t: relative,
    value: 0.5
  });
  renderTracks();
}

function startClipResize(event, clip, lane, edge) {
  event.stopPropagation();
  const rect = lane.getBoundingClientRect();
  state.dragState = {
    type: 'clip-resize',
    clip,
    laneWidth: rect.width,
    edge,
    startX: event.clientX,
    originalStart: clip.start,
    originalEnd: clip.end
  };
}

function startFadeResize(event, clip, lane, edge) {
  event.stopPropagation();
  const rect = lane.getBoundingClientRect();
  state.dragState = {
    type: 'fade-resize',
    clip,
    laneWidth: rect.width,
    edge,
    startX: event.clientX,
    originalFade: edge === 'in' ? clip.fadeIn : clip.fadeOut
  };
}

function startKeyframeDrag(event, clip, keyframe, lane) {
  event.stopPropagation();
  const rect = lane.getBoundingClientRect();
  state.dragState = {
    type: 'keyframe-drag',
    clip,
    keyframe,
    laneHeight: rect.height,
    startY: event.clientY,
    originalValue: keyframe.value
  };
}

function handlePointerMove(event) {
  const drag = state.dragState;
  if (!drag) {
    return;
  }

  if (drag.type === 'clip-resize') {
    const deltaSeconds = ((event.clientX - drag.startX) / drag.laneWidth) * state.duration;
    if (drag.edge === 'left') {
      drag.clip.start = clamp(drag.originalStart + deltaSeconds, 0, drag.originalEnd - 2);
    } else {
      drag.clip.end = clamp(drag.originalEnd + deltaSeconds, drag.originalStart + 2, state.duration);
    }
    renderTracks();
    return;
  }

  if (drag.type === 'fade-resize') {
    const deltaSeconds = ((event.clientX - drag.startX) / drag.laneWidth) * state.duration;
    const clipLength = drag.clip.end - drag.clip.start;
    const nextFade = clamp(drag.originalFade + (drag.edge === 'in' ? deltaSeconds : -deltaSeconds), 0, clipLength * 0.8);
    if (drag.edge === 'in') {
      drag.clip.fadeIn = nextFade;
    } else {
      drag.clip.fadeOut = nextFade;
    }
    renderTracks();
    return;
  }

  if (drag.type === 'keyframe-drag') {
    const deltaValue = (event.clientY - drag.startY) / drag.laneHeight;
    drag.keyframe.value = clamp(drag.originalValue + deltaValue, 0.15, 0.85);
    renderTracks();
  }
}

function handlePointerUp() {
  state.dragState = null;
}

function shouldIgnoreKeyboardTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function handleGlobalKeydown(event) {
  if (shouldIgnoreKeyboardTarget(event.target)) {
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    addSourceToTrack(false);
    return;
  }

  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    addSourceToTrack(true);
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedClip();
    return;
  }

  if (event.key.toLowerCase() === 'k') {
    event.preventDefault();
    addKeyframeAtCursor();
    return;
  }

  if (event.key.toLowerCase() === 'x') {
    event.preventDefault();
    cutSelectedClip();
    return;
  }

  if (event.key === ' ') {
    event.preventDefault();
    togglePlayback();
  }
}

workspaceSelect.addEventListener('change', () => {
  state.activeWorkspaceId = workspaceSelect.value;
  state.activeSourceId = getActiveWorkspace().folders[0]?.files[0]?.id || '';
  render();
});

sourceSearch.addEventListener('input', () => {
  state.sourceSearch = sourceSearch.value;
  renderSourceTree();
});

timelineToggle.addEventListener('click', () => {
  state.timelineExpanded = !state.timelineExpanded;
  render();
});

playToggle.addEventListener('click', togglePlayback);
modePointer.addEventListener('click', () => {
  state.editMode = 'pointer';
  render();
});
modeCut.addEventListener('click', () => {
  state.editMode = 'cut';
  render();
});
document.getElementById('add-keyframe').addEventListener('click', addKeyframeAtCursor);
document.getElementById('new-track').addEventListener('click', () => {
  createTrack();
  state.timelineExpanded = true;
  render();
});

zoomRange.addEventListener('input', () => {
  state.zoom = Number(zoomRange.value);
  renderTracks();
});

document.addEventListener('pointermove', handlePointerMove);
document.addEventListener('pointerup', handlePointerUp);
document.addEventListener('keydown', handleGlobalKeydown);
window.addEventListener('beforeunload', stopPlayback);

render();
