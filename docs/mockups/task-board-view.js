const workspaceFilter = document.getElementById('workspace-filter');
const projectFilter = document.getElementById('project-filter');
const searchFilter = document.getElementById('search-filter');
const visibleTaskCount = document.getElementById('visible-task-count');
const visibleProjectCount = document.getElementById('visible-project-count');
const columnCounts = Array.from(document.querySelectorAll('[data-count-for]'));
const dropZones = Array.from(document.querySelectorAll('[data-drop-zone]'));
const modalBackdrop = document.getElementById('task-modal-backdrop');
const closeModalButton = document.getElementById('close-modal-button');
const cancelButton = document.getElementById('cancel-button');
const saveButton = document.getElementById('save-button');
const saveNote = document.getElementById('save-note');

const fields = {
  title: document.getElementById('edit-title'),
  description: document.getElementById('edit-description'),
  status: document.getElementById('edit-status'),
  priority: document.getElementById('edit-priority'),
  projectId: document.getElementById('edit-project-id'),
  parentTaskId: document.getElementById('edit-parent-task-id'),
  assignee: document.getElementById('edit-assignee'),
  dueDate: document.getElementById('edit-due-date'),
  tags: document.getElementById('edit-tags')
};

const projectCatalog = {
  'product-systems': [
    { id: 'plugin-store', label: 'Plugin store compliance' },
    { id: 'subagents', label: 'Subagent stability' }
  ],
  'mobile-lab': [
    { id: 'mobile', label: 'Mobile parity' }
  ]
};

let draggedCard = null;
let editingCard = null;

function getTaskCards() {
  return Array.from(document.querySelectorAll('.task-card'));
}

function getProjectLabel(projectId) {
  const allProjects = Object.values(projectCatalog).flat();
  return allProjects.find((project) => project.id === projectId)?.label || projectId;
}

function getWorkspaceLabel(workspaceId) {
  if (workspaceId === 'product-systems') return 'Product systems';
  if (workspaceId === 'mobile-lab') return 'Mobile lab';
  return workspaceId;
}

function refreshProjectFilterOptions() {
  const selectedWorkspace = workspaceFilter.value;
  const previousValue = projectFilter.value;
  projectFilter.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All projects';
  projectFilter.appendChild(allOption);

  const workspaces = selectedWorkspace === 'all' ? Object.keys(projectCatalog) : [selectedWorkspace];
  workspaces.forEach((workspaceId) => {
    (projectCatalog[workspaceId] || []).forEach((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.label;
      projectFilter.appendChild(option);
    });
  });

  const stillValid = Array.from(projectFilter.options).some((option) => option.value === previousValue);
  projectFilter.value = stillValid ? previousValue : 'all';
}

function readCard(card) {
  return {
    title: card.dataset.title || '',
    description: card.dataset.description || '',
    status: card.dataset.status || 'todo',
    priority: card.dataset.priority || 'medium',
    projectId: card.dataset.project || 'plugin-store',
    parentTaskId: card.dataset.parentTaskId || '',
    assignee: card.dataset.assignee || '',
    dueDate: card.dataset.dueDate || '',
    tags: card.dataset.tags || ''
  };
}

function writeCard(card, state) {
  const currentWorkspace = card.dataset.workspace || 'product-systems';

  card.dataset.title = state.title;
  card.dataset.description = state.description;
  card.dataset.status = state.status;
  card.dataset.priority = state.priority;
  card.dataset.project = state.projectId;
  card.dataset.projectLabel = getProjectLabel(state.projectId);
  card.dataset.parentTaskId = state.parentTaskId;
  card.dataset.assignee = state.assignee;
  card.dataset.dueDate = state.dueDate;
  card.dataset.tags = state.tags;
  card.dataset.workspace = currentWorkspace;
  card.dataset.workspaceLabel = getWorkspaceLabel(currentWorkspace);

  card.querySelector('.task-card-title').textContent = state.title || 'Untitled task';
  card.querySelector('.task-card-meta').textContent = `${card.dataset.workspaceLabel} · ${card.dataset.projectLabel}`;
}

function fillForm(state) {
  fields.title.value = state.title;
  fields.description.value = state.description;
  fields.status.value = state.status;
  fields.priority.value = state.priority;
  fields.projectId.value = state.projectId;
  fields.parentTaskId.value = state.parentTaskId;
  fields.assignee.value = state.assignee;
  fields.dueDate.value = state.dueDate;
  fields.tags.value = state.tags;
}

function readForm() {
  return {
    title: fields.title.value,
    description: fields.description.value,
    status: fields.status.value,
    priority: fields.priority.value,
    projectId: fields.projectId.value,
    parentTaskId: fields.parentTaskId.value,
    assignee: fields.assignee.value,
    dueDate: fields.dueDate.value,
    tags: fields.tags.value
  };
}

function updateCounts() {
  const taskCards = getTaskCards();
  const visibleCards = taskCards.filter((card) => !card.classList.contains('is-hidden'));
  visibleTaskCount.textContent = String(visibleCards.length);
  visibleProjectCount.textContent = String(new Set(visibleCards.map((card) => card.dataset.project)).size);

  columnCounts.forEach((countEl) => {
    const status = countEl.dataset.countFor;
    const count = visibleCards.filter((card) => card.dataset.status === status).length;
    countEl.textContent = String(count);
  });
}

function matchesSearch(card, query) {
  if (!query) return true;

  const haystack = [
    card.dataset.title,
    card.dataset.description,
    card.dataset.projectLabel,
    card.dataset.workspaceLabel,
    card.dataset.tags,
    card.dataset.assignee
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}

function applyFilters() {
  const workspaceValue = workspaceFilter.value;
  const projectValue = projectFilter.value;
  const query = searchFilter.value.trim().toLowerCase();

  getTaskCards().forEach((card) => {
    const matchesWorkspace = workspaceValue === 'all' || card.dataset.workspace === workspaceValue;
    const matchesProject = projectValue === 'all' || card.dataset.project === projectValue;
    const matchesText = matchesSearch(card, query);
    const visible = matchesWorkspace && matchesProject && matchesText;
    card.classList.toggle('is-hidden', !visible);
  });

  updateCounts();
}

function moveCardToColumn(card, status) {
  const targetZone = document.querySelector(`[data-drop-zone="${status}"]`);
  if (targetZone) {
    targetZone.prepend(card);
  }
}

function openModal(card) {
  editingCard = card;
  fillForm(readCard(card));
  saveNote.textContent = 'Dragging updates status immediately. Save here for field edits.';
  modalBackdrop.classList.remove('is-hidden');
}

function closeModal() {
  editingCard = null;
  modalBackdrop.classList.add('is-hidden');
}

function bindTaskCard(card) {
  const editButton = card.querySelector('[data-edit-task]');

  editButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openModal(card);
  });

  card.addEventListener('dragstart', (event) => {
    draggedCard = card;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.id || '');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragging');
    draggedCard = null;
    dropZones.forEach((zone) => zone.classList.remove('is-drop-target'));
  });
}

getTaskCards().forEach(bindTaskCard);

dropZones.forEach((zone) => {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-drop-target');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('is-drop-target');
  });

  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-drop-target');
    if (!draggedCard) return;

    const newStatus = zone.dataset.dropZone;
    draggedCard.dataset.status = newStatus;
    moveCardToColumn(draggedCard, newStatus);
    applyFilters();
    saveNote.textContent = `Status updated to ${newStatus.replace('_', ' ')} in this mock.`;
  });
});

workspaceFilter.addEventListener('change', () => {
  refreshProjectFilterOptions();
  applyFilters();
});

projectFilter.addEventListener('change', applyFilters);
searchFilter.addEventListener('input', applyFilters);

saveButton.addEventListener('click', () => {
  if (!editingCard) return;
  const nextState = readForm();
  writeCard(editingCard, nextState);
  moveCardToColumn(editingCard, nextState.status);
  applyFilters();
  saveNote.textContent = 'Task fields updated in this mock.';
  closeModal();
});

closeModalButton.addEventListener('click', closeModal);
cancelButton.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (event) => {
  if (event.target === modalBackdrop) {
    closeModal();
  }
});

refreshProjectFilterOptions();
applyFilters();
