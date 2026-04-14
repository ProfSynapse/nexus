/**
 * Obsidian API Mocks — barrel re-export.
 *
 * Split into modules by concern:
 *   core.ts       — Editor, files (TFile/TFolder), App, Vault, Workspace, Platform, requestUrl
 *   components.ts — Setting, input components, Notice, setIcon
 *   views.ts      — Modal, Scope, Component, Plugin, Menu/MenuItem
 */

export {
  EditorPosition,
  Editor,
  TFile,
  TFolder,
  App,
  Platform,
  Vault,
  Workspace,
  WorkspaceLeaf,
  MarkdownView,
  requestUrl,
  __setRequestUrlMock,
  normalizePath,
  EventRef,
  MarkdownFileInfo,
  createMockElement,
} from './core';

export {
  Setting,
  TextComponent,
  TextAreaComponent,
  DropdownComponent,
  ToggleComponent,
  SliderComponent,
  ButtonComponent,
  Notice,
  setIcon,
  debounce,
  Debouncer,
} from './components';

export {
  Scope,
  Modal,
  Component,
  Plugin,
  Menu,
  MenuItem,
} from './views';
