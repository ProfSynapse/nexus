/**
 * Mobile-First Chat Redesign — Mockup Interactivity
 */

// Sample conversation data
const sampleMessages = [
  { role: 'user', content: 'Can you help me organize my project notes?' },
  { role: 'assistant', content: 'Of course! I can help you organize your project notes. Here are a few approaches:\n\n1. **By project** — group related notes under project folders\n2. **By date** — chronological organization\n3. **By topic** — tag-based clustering\n\nWhich approach works best for your workflow?' },
  { role: 'tool', content: 'searchContent → 12 notes found matching "project"' },
  { role: 'user', content: 'Let\'s go with option 1, by project. I have about 50 notes.' },
  { role: 'assistant', content: 'I\'ll scan your vault and group the 50 notes by project. Give me a moment to analyze the content and suggest folder structures.' },
  { role: 'user', content: 'Sounds good, thanks!' },
  { role: 'assistant', content: 'Done! I found 4 distinct projects across your notes:\n\n- **Website Redesign** (14 notes)\n- **Q2 Planning** (11 notes)\n- **Research** (18 notes)\n- **Misc** (7 notes)\n\nWant me to create these folders and move the notes?' },
  { role: 'user', content: 'Yes, please go ahead and move them.' },
  { role: 'tool', content: 'createFolder → 4 folders created' },
  { role: 'tool', content: 'move → 50 notes organized' },
  { role: 'assistant', content: 'All done! Your 50 notes are now organized into 4 project folders. Each folder has a README note with a summary. Let me know if you\'d like any adjustments.' },
];

// Render messages into a container
function renderMessages(containerId, style) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  sampleMessages.forEach((msg, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = `message-container message-${msg.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (style === 'current') {
      // Current design: header row with icon + actions
      const header = document.createElement('div');
      header.className = 'message-header';

      const icon = document.createElement('div');
      icon.className = 'message-role-icon';
      icon.innerHTML = msg.role === 'user'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
        : msg.role === 'tool'
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7 21v-1a5 5 0 0 1 10 0v1"/></svg>';

      const actions = document.createElement('div');
      actions.className = 'message-actions-external';

      if (msg.role === 'user') {
        actions.innerHTML = `
          <button class="message-action-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="message-action-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
        `;
      } else {
        actions.innerHTML = `
          <button class="message-action-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        `;
      }

      if (msg.role === 'user') {
        header.appendChild(icon);
        header.appendChild(actions);
      } else {
        header.appendChild(actions);
        header.appendChild(icon);
      }

      bubble.appendChild(header);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = formatMarkdown(msg.content);
      bubble.appendChild(content);
    } else {
      // Proposed design: clean, no header row
      if (msg.role === 'tool') {
        const toolIcon = document.createElement('span');
        toolIcon.className = 'tool-icon';
        toolIcon.textContent = '\u2699';
        bubble.appendChild(toolIcon);
      }

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = formatMarkdown(msg.content);
      bubble.appendChild(content);

      // Tap-to-reveal actions (hidden by default)
      const overlay = document.createElement('div');
      overlay.className = 'message-actions-overlay';

      if (msg.role === 'user') {
        overlay.innerHTML = `
          <button class="message-action-btn" title="Edit"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="message-action-btn" title="Retry"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
        `;
      } else if (msg.role === 'assistant') {
        overlay.innerHTML = `
          <button class="message-action-btn" title="Copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        `;
      }

      wrapper.appendChild(overlay);
    }

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
  });

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// Simple markdown-to-HTML (bold, lists, line breaks)
function formatMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n- /g, '<br>\u2022 ')
    .replace(/\n(\d+)\. /g, '<br>$1. ')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

// View toggle
function setView(view) {
  const proposedFrame = document.getElementById('proposed-frame');
  const currentFrame = document.getElementById('current-frame');
  const btns = document.querySelectorAll('.mockup-btn[data-view]');

  btns.forEach(b => b.classList.toggle('active', b.dataset.view === view));

  if (view === 'proposed') {
    proposedFrame.classList.remove('hidden');
    currentFrame.classList.add('hidden');
  } else if (view === 'current') {
    proposedFrame.classList.add('hidden');
    currentFrame.classList.remove('hidden');
  } else {
    proposedFrame.classList.remove('hidden');
    currentFrame.classList.remove('hidden');
  }
}

// Keyboard simulation
function toggleKeyboard(show) {
  document.querySelectorAll('.phone-screen').forEach(screen => {
    const existing = screen.querySelector('.keyboard-overlay');
    if (show && !existing) {
      const kb = createKeyboard();
      screen.appendChild(kb);
    } else if (!show && existing) {
      existing.remove();
    }
  });
}

function createKeyboard() {
  const kb = document.createElement('div');
  kb.className = 'keyboard-overlay';

  const rows = [
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['z','x','c','v','b','n','m'],
    ['123', ' ', 'return']
  ];

  rows.forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keyboard-row';
    row.forEach(key => {
      const keyEl = document.createElement('div');
      keyEl.className = 'keyboard-key';
      if (key === ' ') {
        keyEl.classList.add('spacebar');
        keyEl.textContent = 'space';
      } else if (key.length > 1) {
        keyEl.classList.add('wide');
        keyEl.textContent = key;
      } else {
        keyEl.textContent = key;
      }
      rowEl.appendChild(keyEl);
    });
    kb.appendChild(rowEl);
  });

  return kb;
}

// Mobile frame toggle
function toggleMobileFrame(isMobile) {
  document.querySelectorAll('.phone-frame').forEach(frame => {
    frame.classList.toggle('no-frame', !isMobile);
  });
}

// Tap-to-reveal actions (proposed design)
function setupTapActions() {
  document.addEventListener('click', (e) => {
    const bubble = e.target.closest('.proposed .message-bubble');
    const overlay = e.target.closest('.message-actions-overlay');
    const actionBtn = e.target.closest('.message-action-btn');

    // Hide all visible overlays first
    if (!bubble && !overlay) {
      document.querySelectorAll('.message-actions-overlay.visible').forEach(o => {
        o.classList.remove('visible');
      });
      return;
    }

    // If clicked an action button, handle it
    if (actionBtn) {
      const title = actionBtn.getAttribute('title');
      if (title === 'Copy') {
        actionBtn.style.color = 'var(--text-success)';
        setTimeout(() => { actionBtn.style.color = ''; }, 800);
      }
      return;
    }

    // If clicked a bubble, toggle its overlay
    if (bubble) {
      const container = bubble.closest('.message-container');
      const myOverlay = container?.querySelector('.message-actions-overlay');

      // Hide others
      document.querySelectorAll('.message-actions-overlay.visible').forEach(o => {
        if (o !== myOverlay) o.classList.remove('visible');
      });

      // Toggle this one
      if (myOverlay) {
        myOverlay.classList.toggle('visible');
      }
    }
  });
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  renderMessages('proposed-messages', 'proposed');
  renderMessages('current-messages', 'current');
  setupTapActions();

  // View toggle buttons
  document.querySelectorAll('.mockup-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Keyboard toggle
  document.getElementById('toggle-keyboard')?.addEventListener('change', (e) => {
    toggleKeyboard(e.target.checked);
  });

  // Mobile frame toggle
  document.getElementById('toggle-mobile')?.addEventListener('change', (e) => {
    toggleMobileFrame(e.target.checked);
  });
});
