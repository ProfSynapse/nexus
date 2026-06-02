/* =====================================================================
   Workspace tab redesign — mockup interactions

   Everything here is in-memory. No persistence, no network, no plugin
   wiring. Filtering, archive/restore, validation, and modal state live
   only in this script.
   ===================================================================== */

(function () {
  'use strict';

  // ---------- Sample data (Nexus-flavored) ----------

  const TASKS = [
    {
      id: 't1', projectId: 'plugin-store',
      title: 'Audit remaining inline styles',
      meta: 'Review remaining inline style cases and decide which move to styles.css.',
      status: 'in_progress', priority: 'critical',
      due: '2026-03-24', assignee: 'Jordan', depth: 0
    },
    {
      id: 't1a', projectId: 'plugin-store', parent: 't1',
      title: 'Catalogue current call sites',
      meta: '', status: 'done', priority: 'high',
      due: '2026-03-20', assignee: 'Jordan', depth: 1
    },
    {
      id: 't1b', projectId: 'plugin-store', parent: 't1',
      title: 'Migrate trivial cases first',
      meta: '', status: 'todo', priority: 'medium',
      due: '2026-03-26', assignee: '', depth: 1
    },
    {
      id: 't2', projectId: 'plugin-store',
      title: 'Command palette naming audit',
      meta: '', status: 'in_progress', priority: 'medium',
      due: '2026-03-27', assignee: 'Ava', depth: 0
    },
    {
      id: 't3', projectId: 'plugin-store',
      title: 'Register DOM events cleanup',
      meta: '', status: 'done', priority: 'low',
      due: '', assignee: 'Jordan', depth: 0
    },
    {
      id: 't4', projectId: 'subagents',
      title: 'Refine subagent loading overlay',
      meta: '', status: 'in_progress', priority: 'high',
      due: '2026-03-24', assignee: 'Jordan', depth: 0
    },
    {
      id: 't5', projectId: 'subagents',
      title: 'Manual test branch restoration',
      meta: '', status: 'todo', priority: 'high',
      due: '2026-03-25', assignee: 'Dylan', depth: 0
    }
  ];

  const PROJECTS = {
    'plugin-store': { id: 'plugin-store', name: 'Plugin store compliance', status: 'active' },
    'subagents':    { id: 'subagents',    name: 'Subagent stability',     status: 'active' },
    'mobile':       { id: 'mobile',       name: 'Mobile parity',          status: 'archived' }
  };

  const STATES_INITIAL = [
    {
      id: 's1', name: 'Pre-merge sanity sweep',
      description: 'Snapshot before merging the v5.9 release branch.',
      created: 'Today, 14:21', tags: ['pre-merge', 'review'], archived: false
    },
    {
      id: 's2', name: 'Subagent loading overlay session',
      description: 'Mid-flight UI work on the subagent loading overlay.',
      created: 'Yesterday, 11:08', tags: ['ui', 'subagents'], archived: false
    },
    {
      id: 's3', name: 'Storage reconcile incident',
      description: 'Context captured during the GDrive Shared Drive boot-hang investigation.',
      created: '2 days ago', tags: ['incident', 'storage'], archived: false
    },
    {
      id: 's4', name: 'CLI parser hardening',
      description: 'POSIX-shell semantics + whitespace-gated comma separator.',
      created: 'Last week', tags: ['cli', 'parser'], archived: false
    },
    {
      id: 's5', name: 'Mobile audit notes',
      description: 'Catalogue of mobile-incompatible imports identified in the audit.',
      created: 'Last week', tags: ['mobile'], archived: true
    },
    {
      id: 's6', name: 'Composer agent kickoff',
      description: 'Initial design notes for the multimodal Composer app agent.',
      created: '3 weeks ago', tags: ['composer'], archived: true
    }
  ];

  let STATES = STATES_INITIAL.map(s => ({ ...s }));

  // ---------- View switching ----------

  const navItems = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.view');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewName = item.dataset.view;
      navItems.forEach(n => {
        n.classList.toggle('is-active', n === item);
      });
      views.forEach(v => {
        v.classList.toggle('is-active', v.dataset.view === viewName);
      });
    });
  });

  // Detail view "Manage states" link → jump to states view
  document.querySelectorAll('[data-action="view-states"]').forEach(btn => {
    btn.addEventListener('click', () => activateView('states'));
  });
  document.querySelectorAll('[data-action="view-projects"]').forEach(btn => {
    btn.addEventListener('click', () => activateView('projects'));
  });
  document.querySelectorAll('[data-action="edit-workspace"]').forEach(btn => {
    btn.addEventListener('click', () => activateView('form'));
  });

  function activateView(name) {
    navItems.forEach(n => n.classList.toggle('is-active', n.dataset.view === name));
    views.forEach(v => v.classList.toggle('is-active', v.dataset.view === name));
  }

  // ---------- Material toggle ----------

  const materialButtons = document.querySelectorAll('.material-button');
  const pageBody = document.querySelector('.page-body');
  materialButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      materialButtons.forEach(b => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      pageBody.dataset.material = btn.dataset.material;
    });
  });

  // ---------- Workspace form validation (F1 analogue at the workspace level) ----------

  const workspaceForm = document.getElementById('workspace-form');
  const formHint = document.getElementById('form-footer-hint');
  if (workspaceForm) {
    workspaceForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const nameField = workspaceForm.querySelector('[data-field="name"]');
      const nameInput = workspaceForm.querySelector('input[name="name"]');
      const errorEl = workspaceForm.querySelector('#name-error');
      const trimmed = (nameInput.value || '').trim();
      if (!trimmed) {
        nameField.classList.add('is-invalid');
        errorEl.hidden = false;
        nameInput.focus();
        formHint.textContent = 'Fix the highlighted field before saving.';
        return;
      }
      nameField.classList.remove('is-invalid');
      errorEl.hidden = true;
      formHint.textContent = `Saved "${trimmed}" (mock only — no persistence).`;
    });

    workspaceForm.querySelector('input[name="name"]').addEventListener('input', (event) => {
      if (event.target.value.trim()) {
        workspaceForm.querySelector('[data-field="name"]').classList.remove('is-invalid');
        workspaceForm.querySelector('#name-error').hidden = true;
      }
    });
  }

  // ---------- Projects & tasks ----------

  const projectCards = document.querySelectorAll('.project-card');
  const projectSearch = document.getElementById('project-search');
  const projectEmpty = document.getElementById('project-empty');
  const detailTitle = document.getElementById('project-detail-title');
  const detailSub = document.getElementById('project-detail-sub');
  const projectsCrumb = document.querySelector('[data-projects-crumb]');
  const taskTbody = document.getElementById('task-tbody');
  const taskEmpty = document.getElementById('task-empty');
  const taskSearch = document.getElementById('task-search');
  const filterPills = document.querySelectorAll('.filter-pill');
  const taskDetailPanel = document.getElementById('task-detail-panel');
  const taskDetailTitle = document.getElementById('task-detail-title');
  const taskDetailTitleInput = document.getElementById('task-detail-title-input');

  let selectedProjectId = 'plugin-store';
  let statusFilter = 'all';

  projectCards.forEach(card => {
    card.addEventListener('click', () => selectProject(card.dataset.projectId));
  });

  if (projectSearch) {
    projectSearch.addEventListener('input', (event) => {
      const q = event.target.value.trim().toLowerCase();
      let visibleCount = 0;
      projectCards.forEach(card => {
        const matches = !q || card.textContent.toLowerCase().includes(q);
        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });
      projectEmpty.hidden = visibleCount > 0;
    });
  }

  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      statusFilter = pill.dataset.status;
      filterPills.forEach(p => p.classList.toggle('is-active', p === pill));
      renderTasks();
    });
  });

  if (taskSearch) {
    taskSearch.addEventListener('input', () => renderTasks());
  }

  function selectProject(id) {
    if (!PROJECTS[id]) return;
    selectedProjectId = id;
    projectCards.forEach(c => c.classList.toggle('is-selected', c.dataset.projectId === id));
    const project = PROJECTS[id];
    const tasks = TASKS.filter(t => t.projectId === id);
    const open = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length;
    const done = tasks.filter(t => t.status === 'done').length;
    detailTitle.textContent = project.name;
    detailSub.textContent = `${tasks.length} tasks · ${open} open · ${done} done`;
    projectsCrumb.textContent = `Projects · ${project.name}`;
    renderTasks();
  }

  function renderTasks() {
    if (!taskTbody) return;
    taskTbody.innerHTML = '';
    const q = (taskSearch?.value || '').trim().toLowerCase();
    const filtered = TASKS.filter(t => t.projectId === selectedProjectId)
      .filter(t => statusFilter === 'all' || t.status === statusFilter)
      .filter(t => !q || t.title.toLowerCase().includes(q));

    if (filtered.length === 0) {
      taskEmpty.hidden = false;
      return;
    }
    taskEmpty.hidden = true;

    for (const task of filtered) {
      const tr = document.createElement('tr');
      tr.dataset.taskId = task.id;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input, button')) return;
        openTaskDetail(task);
      });

      const checkCell = document.createElement('td');
      checkCell.className = 'task-col-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'task-checkbox';
      checkbox.checked = task.status === 'done';
      checkbox.setAttribute('aria-label', `Mark ${task.title} done`);
      checkbox.addEventListener('change', () => {
        task.status = checkbox.checked ? 'done' : 'todo';
        renderTasks();
        const project = PROJECTS[selectedProjectId];
        selectProject(project.id);
      });
      checkCell.appendChild(checkbox);
      tr.appendChild(checkCell);

      const titleCell = document.createElement('td');
      titleCell.className = 'task-col-title';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'task-title' + (task.status === 'done' ? ' is-done' : '');
      if (task.depth > 0) {
        const indent = document.createElement('span');
        indent.className = 'task-subtask-indent';
        titleSpan.appendChild(indent);
      }
      const priorityDot = document.createElement('span');
      priorityDot.className = `task-priority-dot task-priority-${task.priority}`;
      priorityDot.title = `Priority: ${task.priority}`;
      titleSpan.appendChild(priorityDot);
      titleSpan.appendChild(document.createTextNode(task.title));
      titleCell.appendChild(titleSpan);
      tr.appendChild(titleCell);

      tr.appendChild(makeCell(formatStatus(task.status), 'task-col-status', (cell) => {
        const badge = document.createElement('span');
        badge.className = `task-status-badge task-status-${task.status}`;
        badge.textContent = formatStatus(task.status);
        cell.textContent = '';
        cell.appendChild(badge);
      }));
      tr.appendChild(makeCell(cap(task.priority), 'task-col-priority task-meta-cell'));
      tr.appendChild(makeCell(task.due || '—', 'task-col-due task-meta-cell'));
      tr.appendChild(makeCell(task.assignee || '—', 'task-col-assignee task-meta-cell'));

      const actionsCell = document.createElement('td');
      actionsCell.className = 'task-col-actions';
      const editBtn = makeIconButton('Edit task', '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTaskDetail(task);
      });
      actionsCell.appendChild(editBtn);
      tr.appendChild(actionsCell);

      taskTbody.appendChild(tr);
    }
  }

  function openTaskDetail(task) {
    taskDetailPanel.hidden = false;
    taskDetailTitle.textContent = task.title;
    taskDetailTitleInput.value = task.title;
  }

  document.querySelectorAll('[data-action="close-task-detail"]').forEach(btn => {
    btn.addEventListener('click', () => { taskDetailPanel.hidden = true; });
  });

  function makeCell(text, className, decorate) {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    if (decorate) decorate(td);
    return td;
  }

  function makeIconButton(label, svgInner) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-button';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svgInner}</svg>`;
    return btn;
  }

  function formatStatus(status) {
    if (status === 'in_progress') return 'In progress';
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
  function cap(value) {
    if (!value) return '—';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  // ---------- States view ----------

  const stateList = document.getElementById('state-list');
  const stateEmpty = document.getElementById('state-empty');
  const showArchivedToggle = document.getElementById('show-archived');

  if (showArchivedToggle) {
    showArchivedToggle.addEventListener('change', () => renderStates());
  }
  document.querySelectorAll('[data-action="refresh-states"]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Refresh';
        renderStates();
      }, 350);
    });
  });
  document.querySelectorAll('[data-action="new-state"]').forEach(btn => {
    btn.addEventListener('click', () => {
      openStateModal(null);
    });
  });

  function renderStates() {
    if (!stateList) return;
    stateList.innerHTML = '';
    const includeArchived = showArchivedToggle?.checked;
    const visible = STATES.filter(s => includeArchived || !s.archived);

    if (visible.length === 0) {
      stateEmpty.hidden = false;
      stateEmpty.textContent = includeArchived
        ? 'No states yet.'
        : 'No active states. Toggle "Show archived" to see archived states.';
      return;
    }
    stateEmpty.hidden = true;

    for (const state of visible) {
      stateList.appendChild(buildStateRow(state));
    }
  }

  function buildStateRow(state) {
    const row = document.createElement('li');
    row.className = 'state-row';
    if (state.archived) row.classList.add('is-muted');
    row.dataset.stateId = state.id;

    const main = document.createElement('div');
    main.className = 'state-row-main';

    const title = document.createElement('div');
    title.className = 'state-row-title';
    title.textContent = state.name;
    if (state.archived) {
      const badge = document.createElement('span');
      badge.className = 'inline-badge';
      badge.textContent = 'Archived';
      title.appendChild(badge);
    }
    main.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'state-row-meta';
    const tagText = state.tags && state.tags.length
      ? ' · ' + state.tags.map(t => `#${t}`).join(' ')
      : '';
    meta.textContent = state.created + tagText;
    main.appendChild(meta);

    if (state.description) {
      const desc = document.createElement('div');
      desc.className = 'state-row-description';
      desc.textContent = state.description;
      main.appendChild(desc);
    }
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'state-row-actions';

    const editBtn = makeIconButton('Edit state', '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>');
    editBtn.addEventListener('click', () => openStateModal(state));
    actions.appendChild(editBtn);

    const archiveBtn = makeIconButton(
      state.archived ? 'Restore state' : 'Archive state',
      state.archived
        ? '<path d="M3 6h18v4H3z"/><path d="M5 10v10h14V10"/><path d="m9 14 3-3 3 3"/><path d="M12 11v6"/>'
        : '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>'
    );
    archiveBtn.addEventListener('click', () => {
      runWithInFlight([archiveBtn, deleteBtn], async () => {
        await sleep(700);
        state.archived = !state.archived;
        renderStates();
      });
    });
    actions.appendChild(archiveBtn);

    const deleteBtn = makeIconButton('Delete state', '<polyline points="3 6 5 6 21 6"/><path d="M19 6 17 20a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>');
    deleteBtn.addEventListener('click', () => {
      confirmModal({
        title: 'Delete state?',
        body: `Delete state "${state.name}"? This cannot be undone.`,
        confirmLabel: 'Delete'
      }).then(ok => {
        if (!ok) return;
        runWithInFlight([archiveBtn, deleteBtn, editBtn], async () => {
          await sleep(700);
          STATES = STATES.filter(s => s.id !== state.id);
          renderStates();
        });
      });
    });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    return row;
  }

  function runWithInFlight(buttons, fn) {
    // F3 demo: lock buttons & spin the trigger for the duration of the async op.
    const triggers = Array.isArray(buttons) ? buttons : [buttons];
    triggers.forEach(b => {
      b.disabled = true;
      b.classList.add('is-busy');
    });
    fn().finally(() => {
      triggers.forEach(b => {
        b.disabled = false;
        b.classList.remove('is-busy');
      });
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---------- State edit modal (F1 demo) ----------

  const stateModal = document.getElementById('state-modal-backdrop');
  const stateForm = document.getElementById('state-edit-form');
  const stateNameInput = document.getElementById('state-name');
  const stateDescInput = document.getElementById('state-description');
  const stateNameError = document.getElementById('state-name-error');
  const stateNameField = stateForm?.querySelector('[data-field="state-name"]');
  const stateSaveBtn = document.getElementById('state-save-btn');

  let editingState = null;

  function openStateModal(state) {
    editingState = state;
    if (state) {
      stateNameInput.value = state.name;
      stateDescInput.value = state.description || '';
    } else {
      stateNameInput.value = '';
      stateDescInput.value = '';
    }
    stateNameField.classList.remove('is-invalid');
    stateNameError.hidden = true;
    stateModal.hidden = false;
    setTimeout(() => stateNameInput.focus(), 0);
  }

  function closeStateModal() {
    stateModal.hidden = true;
    editingState = null;
  }

  document.querySelectorAll('#state-modal-backdrop [data-modal-close]').forEach(btn => {
    btn.addEventListener('click', closeStateModal);
  });
  stateModal?.addEventListener('click', (event) => {
    if (event.target === stateModal) closeStateModal();
  });

  stateNameInput?.addEventListener('input', () => {
    if (stateNameInput.value.trim()) {
      stateNameField.classList.remove('is-invalid');
      stateNameError.hidden = true;
    }
  });

  stateForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const trimmed = stateNameInput.value.trim();
    if (!trimmed) {
      stateNameField.classList.add('is-invalid');
      stateNameError.hidden = false;
      stateNameInput.focus();
      return;
    }
    // F3 analogue on the save action — brief in-flight on the save button.
    stateSaveBtn.disabled = true;
    const originalLabel = stateSaveBtn.textContent;
    stateSaveBtn.textContent = 'Saving…';

    setTimeout(() => {
      if (editingState) {
        editingState.name = trimmed;
        editingState.description = stateDescInput.value;
      } else {
        STATES.unshift({
          id: 's-new-' + Date.now(),
          name: trimmed,
          description: stateDescInput.value,
          created: 'Just now (mock)',
          tags: [],
          archived: false
        });
      }
      stateSaveBtn.disabled = false;
      stateSaveBtn.textContent = originalLabel;
      closeStateModal();
      renderStates();
    }, 350);
  });

  // ---------- Confirm modal ----------

  const confirmBackdrop = document.getElementById('confirm-modal-backdrop');
  const confirmTitle = document.getElementById('confirm-modal-title');
  const confirmBody = document.getElementById('confirm-modal-body');
  const confirmOk = confirmBackdrop?.querySelector('[data-confirm-ok]');
  const confirmCancel = confirmBackdrop?.querySelector('[data-confirm-cancel]');

  function confirmModal({ title, body, confirmLabel = 'Confirm' }) {
    return new Promise(resolve => {
      confirmTitle.textContent = title;
      confirmBody.textContent = body;
      confirmOk.textContent = confirmLabel;
      confirmBackdrop.hidden = false;

      const cleanup = (result) => {
        confirmBackdrop.hidden = true;
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
        confirmBackdrop.removeEventListener('click', onBackdrop);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === confirmBackdrop) cleanup(false); };
      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
      confirmBackdrop.addEventListener('click', onBackdrop);
    });
  }

  // ---------- Initial render ----------

  renderTasks();
  renderStates();
})();
