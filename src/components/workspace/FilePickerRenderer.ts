import { App, TFile, TFolder, setIcon, ButtonComponent, TextComponent, Modal, Component } from 'obsidian';

const DEBOUNCE_MS = 150;

/**
 * FilePickerRenderer - Folder tree with lazy loading and checkboxes
 *
 * Features:
 * - Lazy loading: only loads folder children when expanded
 * - Search filter: filters tree to matching files/folders
 * - Multi-select: checkboxes for selecting multiple files
 * - Workspace-aware: respects workspace rootFolder
 */
export class FilePickerRenderer {
  private selectedFiles: Set<string>;
  private expandedFolders: Set<string> = new Set();
  private treeContainer?: HTMLElement;
  private searchComponent?: TextComponent;
  private searchQuery: string = '';
  private searchTimeout?: ReturnType<typeof setTimeout>;
  private rootPath: string;
  private title: string;

  constructor(
    private app: App,
    private onSelect: (filePath: string) => void,
    private onCancel: () => void,
    initialSelection?: string,
    workspaceRootFolder?: string,
    title?: string,
    private component?: Component
  ) {
    // Support single or multiple initial selection
    this.selectedFiles = new Set(initialSelection ? [initialSelection] : []);

    // Use workspace root folder or vault root
    this.rootPath = workspaceRootFolder && workspaceRootFolder !== '/'
      ? workspaceRootFolder
      : '/';

    this.title = title || 'Select Files';
  }

  /**
   * Render the file picker view
   */
  render(container: HTMLElement): void {
    container.empty();

    // Header
    const header = container.createDiv('nexus-file-picker-header');

    const leftSection = header.createDiv('nexus-file-picker-left');
    new ButtonComponent(leftSection)
      .setButtonText('← Back')
      .onClick(() => this.onCancel());
    leftSection.createEl('h3', { text: this.title });

    const actions = header.createDiv('nexus-file-picker-actions');
    new ButtonComponent(actions)
      .setButtonText('Done')
      .setCta()
      .onClick(() => this.handleDone());

    // Search input
    const searchField = container.createDiv('nexus-form-field');
    this.searchComponent = new TextComponent(searchField);
    this.searchComponent.setPlaceholder('Filter files and folders...');
    this.searchComponent.onChange((value) => {
      this.debouncedSearch(value);
    });

    // Tree container
    this.treeContainer = container.createDiv('nexus-folder-tree');

    // Render root
    this.renderRoot();
  }

  /**
   * Debounced search to prevent excessive re-renders
   */
  private debouncedSearch(query: string): void {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }
    this.searchTimeout = setTimeout(() => {
      this.searchQuery = query.toLowerCase().trim();
      // When searching, auto-expand folders that have matches
      if (this.searchQuery) {
        this.expandFoldersWithMatches();
      }
      this.renderRoot();
    }, DEBOUNCE_MS);
  }

  /**
   * Expand all folders that contain matching files
   */
  private expandFoldersWithMatches(): void {
    if (!this.searchQuery) return;

    const rootFolder = this.getRootFolder();
    if (!rootFolder) return;

    this.expandedFolders.clear();
    this.findAndExpandMatchingFolders(rootFolder);
  }

  /**
   * Recursively find folders with matching children and expand them
   */
  private findAndExpandMatchingFolders(folder: TFolder): boolean {
    let hasMatch = false;

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        // Check if folder name matches
        if (child.name.toLowerCase().includes(this.searchQuery)) {
          hasMatch = true;
        }
        // Recursively check children
        if (this.findAndExpandMatchingFolders(child)) {
          hasMatch = true;
        }
      } else if (child instanceof TFile) {
        if (child.name.toLowerCase().includes(this.searchQuery)) {
          hasMatch = true;
        }
      }
    }

    if (hasMatch) {
      this.expandedFolders.add(folder.path);
    }

    return hasMatch;
  }

  /**
   * Check if item matches search query
   */
  private matchesSearch(name: string): boolean {
    if (!this.searchQuery) return true;
    return name.toLowerCase().includes(this.searchQuery);
  }

  /**
   * Check if folder contains any matching items (for filtering)
   */
  private folderHasMatches(folder: TFolder): boolean {
    if (!this.searchQuery) return true;

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        if (this.matchesSearch(child.name) || this.folderHasMatches(child)) {
          return true;
        }
      } else if (child instanceof TFile) {
        if (this.matchesSearch(child.name)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Get the root folder
   */
  private getRootFolder(): TFolder | null {
    if (this.rootPath === '/') {
      return this.app.vault.getRoot();
    } else {
      const abstractFile = this.app.vault.getAbstractFileByPath(this.rootPath);
      return abstractFile instanceof TFolder ? abstractFile : null;
    }
  }

  /**
   * Render the root folder(s)
   */
  private renderRoot(): void {
    if (!this.treeContainer) return;
    this.treeContainer.empty();

    const rootFolder = this.getRootFolder();

    if (!rootFolder) {
      this.treeContainer.createDiv({
        text: 'Folder not found',
        cls: 'nexus-file-picker-empty'
      });
      return;
    }

    // Render children of root (don't show root itself)
    const hasVisibleItems = this.renderFolderChildren(rootFolder, this.treeContainer, 0);

    if (!hasVisibleItems && this.searchQuery) {
      this.treeContainer.createDiv({
        text: 'No matching files found',
        cls: 'nexus-file-picker-empty'
      });
    }
  }

  /**
   * Render children of a folder
   * Returns true if any items were rendered
   */
  private renderFolderChildren(folder: TFolder, container: HTMLElement, depth: number): boolean {
    // Sort: folders first, then files, alphabetically
    const children = [...folder.children].sort((a, b) => {
      const aIsFolder = a instanceof TFolder;
      const bIsFolder = b instanceof TFolder;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    let renderedCount = 0;

    for (const child of children) {
      if (child instanceof TFolder) {
        // Show folder if it matches or has matching children
        if (this.matchesSearch(child.name) || this.folderHasMatches(child)) {
          this.renderFolderRow(child, container, depth);
          renderedCount++;
        }
      } else if (child instanceof TFile) {
        // Show file if it matches search
        if (this.matchesSearch(child.name)) {
          this.renderFileRow(child, container, depth);
          renderedCount++;
        }
      }
    }

    // Empty folder message (only when not searching)
    if (renderedCount === 0 && !this.searchQuery) {
      const empty = container.createDiv({ cls: 'nexus-tree-empty' });
      empty.dataset.depth = String(depth + 1);
      empty.textContent = 'Empty folder';
    }

    return renderedCount > 0;
  }

  /**
   * Render a folder row with expand/collapse
   */
  private renderFolderRow(folder: TFolder, container: HTMLElement, depth: number): void {
    const isExpanded = this.expandedFolders.has(folder.path);

    const row = container.createDiv({ cls: 'nexus-tree-row nexus-tree-folder' });
    row.dataset.depth = String(depth);

    // Folder icon (changes based on expanded state)
    const iconEl = row.createSpan({ cls: 'nexus-tree-icon' });
    setIcon(iconEl, isExpanded ? 'folder-open' : 'folder');

    // Folder name
    row.createSpan({ text: folder.name, cls: 'nexus-tree-name' });

    // Click to expand/collapse
    const clickHandler = () => {
      if (isExpanded) {
        this.expandedFolders.delete(folder.path);
      } else {
        this.expandedFolders.add(folder.path);
      }
      this.renderRoot(); // Re-render tree
    };
    this.component!.registerDomEvent(row, 'click', clickHandler);

    // Render children if expanded
    if (isExpanded) {
      const childrenContainer = container.createDiv({ cls: 'nexus-tree-children' });
      this.renderFolderChildren(folder, childrenContainer, depth + 1);
    }
  }

  /**
   * Render a file row with checkbox
   */
  private renderFileRow(file: TFile, container: HTMLElement, depth: number): void {
    const isSelected = this.selectedFiles.has(file.path);

    const row = container.createDiv({ cls: 'nexus-tree-row nexus-tree-file' });
    row.dataset.depth = String(depth);

    // Checkbox
    const checkbox = row.createEl('input', { type: 'checkbox', cls: 'nexus-tree-checkbox' });
    checkbox.checked = isSelected;
    const changeHandler = (e: Event) => {
      e.stopPropagation();
      if (checkbox.checked) {
        this.selectedFiles.add(file.path);
      } else {
        this.selectedFiles.delete(file.path);
      }
    };
    this.component!.registerDomEvent(checkbox, 'change', changeHandler);

    // File icon
    const iconEl = row.createSpan({ cls: 'nexus-tree-icon' });
    setIcon(iconEl, 'file-text');

    // File name
    row.createSpan({ text: file.name, cls: 'nexus-tree-name' });

    // Click row to toggle checkbox
    const rowClickHandler = (e: MouseEvent) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
      }
    };
    this.component!.registerDomEvent(row, 'click', rowClickHandler);
  }

  /**
   * Handle done - return first selected file (for single selection mode)
   */
  private handleDone(): void {
    const selected = Array.from(this.selectedFiles);
    if (selected.length > 0) {
      // For now, return first selected file (maintains compatibility)
      this.onSelect(selected[0]);
    } else {
      this.onCancel();
    }
  }

  /**
   * Get all selected file paths
   */
  getSelectedPaths(): string[] {
    return Array.from(this.selectedFiles);
  }

  /**
   * Get currently selected file path (first one, for compatibility)
   */
  getSelectedPath(): string {
    const paths = this.getSelectedPaths();
    return paths.length > 0 ? paths[0] : '';
  }

  /**
   * Open file picker in a modal - reusable anywhere
   * @param app Obsidian App instance
   * @param options Configuration options
   * @returns Promise with selected file paths (empty array if cancelled)
   */
  static openModal(
    app: App,
    options: {
      title?: string;
      rootFolder?: string;
      initialSelection?: string[];
      excludePaths?: string[];
    } = {}
  ): Promise<string[]> {
    return new Promise((resolve) => {
      const modal = new Modal(app);
      modal.titleEl.setText(options.title || 'Select Files');
      modal.modalEl.addClass('file-picker-modal');

      let pickerInstance: FilePickerRenderer;

      pickerInstance = new FilePickerRenderer(
        app,
        () => {
          // Done callback - return all selected paths
          const paths = pickerInstance.getSelectedPaths();
          const filtered = options.excludePaths
            ? paths.filter(p => !options.excludePaths!.includes(p))
            : paths;
          resolve(filtered);
          modal.close();
        },
        () => {
          // Cancel callback
          resolve([]);
          modal.close();
        },
        options.initialSelection?.join(','),
        options.rootFolder || '/'
      );

      pickerInstance.render(modal.contentEl);
      modal.open();
    });
  }
}
