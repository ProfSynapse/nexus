const screenButtons = Array.from(document.querySelectorAll('[data-screen]'));
const drawerButton = document.querySelector('[data-toggle-drawer]');
const keyboardButton = document.querySelector('[data-toggle-keyboard]');
const deviceShells = Array.from(document.querySelectorAll('.mock-device-shell'));

const phoneTemplate = document.getElementById('phone-template');

const devices = deviceShells.map(shell => {
  if (!(shell instanceof HTMLElement) || !(phoneTemplate instanceof HTMLTemplateElement)) {
    return null;
  }

  shell.appendChild(phoneTemplate.content.cloneNode(true));

  return {
    shell,
    phone: shell.querySelector('.mock-phone'),
    warningBanner: shell.querySelector('[data-role="warning-banner"]'),
    messageDisplayContainer: shell.querySelector('[data-role="message-display-container"]'),
    chatTitle: shell.querySelector('[data-role="chat-title"]'),
    chatInput: shell.querySelector('[data-role="chat-input"]'),
    sendButton: shell.querySelector('[data-role="send-button"]'),
    hamburgerButton: shell.querySelector('[data-role="hamburger-button"]'),
    sidebar: shell.querySelector('[data-role="chat-sidebar"]'),
    backdrop: shell.querySelector('[data-role="chat-backdrop"]')
  };
}).filter(Boolean);

function getTemplateContent(id) {
  const template = document.getElementById(id);
  return template instanceof HTMLTemplateElement
    ? template.content.cloneNode(true)
    : document.createDocumentFragment();
}

function setComposerState(device, hasConversation) {
  const { chatInput, sendButton } = device;
  if (!(chatInput instanceof HTMLElement) || !(sendButton instanceof HTMLButtonElement)) {
    return;
  }

  if (hasConversation) {
    chatInput.textContent = 'Tighten the mobile layout.';
    chatInput.setAttribute('contenteditable', 'true');
    chatInput.setAttribute('data-placeholder', 'Type your message...');
    sendButton.disabled = false;
    sendButton.classList.remove('disabled-mode');
    sendButton.setAttribute('aria-label', 'Send message');
  } else {
    chatInput.textContent = '';
    chatInput.setAttribute('contenteditable', 'false');
    chatInput.setAttribute('data-placeholder', 'Select or create a conversation to begin');
    sendButton.disabled = true;
    sendButton.classList.add('disabled-mode');
    sendButton.setAttribute('aria-label', 'No conversation selected');
  }
}

function renderScreen(screen) {
  devices.forEach(device => {
    const { messageDisplayContainer, chatTitle } = device;
    if (!(messageDisplayContainer instanceof HTMLElement) || !(chatTitle instanceof HTMLElement)) {
      return;
    }

    messageDisplayContainer.replaceChildren();
    messageDisplayContainer.classList.add('message-display');

    if (screen === 'conversation') {
      messageDisplayContainer.appendChild(getTemplateContent('conversation-template'));
      chatTitle.textContent = 'Mobile sidebar redesign';
      setComposerState(device, true);
    } else {
      messageDisplayContainer.appendChild(getTemplateContent('welcome-template'));
      chatTitle.textContent = 'Chat';
      setComposerState(device, false);
    }
  });

  screenButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.screen === screen);
  });
}

function setDrawerVisible(visible) {
  devices.forEach(device => {
    const { sidebar, backdrop } = device;
    if (!(sidebar instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) {
      return;
    }

    sidebar.classList.toggle('chat-sidebar-visible', visible);
    sidebar.classList.toggle('chat-sidebar-hidden', !visible);
    backdrop.classList.toggle('chat-backdrop-visible', visible);
  });

  if (drawerButton instanceof HTMLButtonElement) {
    drawerButton.textContent = visible ? 'Drawer visible' : 'Drawer hidden';
  }
}

function toggleKeyboard() {
  const isOpen = devices[0]?.phone instanceof HTMLElement
    ? devices[0].phone.classList.toggle('is-keyboard-open')
    : false;

  devices.slice(1).forEach(device => {
    if (device.phone instanceof HTMLElement) {
      device.phone.classList.toggle('is-keyboard-open', isOpen);
    }
  });

  if (keyboardButton instanceof HTMLButtonElement) {
    keyboardButton.textContent = isOpen ? 'Keyboard open' : 'Keyboard closed';
  }
}

screenButtons.forEach(button => {
  button.addEventListener('click', () => renderScreen(button.dataset.screen));
});

drawerButton?.addEventListener('click', () => {
  const firstSidebar = devices[0]?.sidebar;
  const visible = !(firstSidebar instanceof HTMLElement && firstSidebar.classList.contains('chat-sidebar-visible'));
  setDrawerVisible(visible);
});

devices.forEach(device => {
  device.hamburgerButton?.addEventListener('click', () => {
    const firstSidebar = devices[0]?.sidebar;
    const visible = !(firstSidebar instanceof HTMLElement && firstSidebar.classList.contains('chat-sidebar-visible'));
    setDrawerVisible(visible);
  });

  device.backdrop?.addEventListener('click', () => setDrawerVisible(false));
});

keyboardButton?.addEventListener('click', toggleKeyboard);

devices.forEach(device => {
  if (device.warningBanner instanceof HTMLElement) {
    window.setTimeout(() => {
      device.warningBanner.classList.add('chat-warning-banner-fadeout');
      window.setTimeout(() => {
        device.warningBanner.classList.add('chat-loading-overlay-hidden');
      }, 500);
    }, 5000);
  }
});

renderScreen('welcome');
setDrawerVisible(false);
