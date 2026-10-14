/**
 * Obsidian API Mocks — barrel re-export.
 *
 * Split into modules by concern:
 *   core.ts       — Editor, files (TFile/TFolder), App, Vault, Workspace, Platform, requestUrl
 *   components.ts — Setting, input components, Notice, setIcon
 *   views.ts      — Modal, Scope, Component, Plugin, Menu/MenuItem
 *   dom.ts        — FakeElement, an element tree for structure assertions
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
  htmlToMarkdown,
  prepareFuzzySearch,
  parseYaml,
  stringifyYaml,
  Events,
  EventRef,
  MarkdownFileInfo,
  createMockElement,
} from './core';

export {
  Setting,
  SettingGroup,
  ExtraButtonComponent,
  ProgressBarComponent,
  TextComponent,
  TextAreaComponent,
  DropdownComponent,
  ToggleComponent,
  SliderComponent,
  ButtonComponent,
  AbstractInputSuggest,
  Notice,
  setIcon,
  debounce,
  Debouncer,
} from './components';

export {
  Scope,
  Modal,
  Component,
  ItemView,
  MarkdownRenderer,
  Plugin,
  Menu,
  MenuItem,
} from './views';

export { FakeElement, createFakeRoot, isFakeElement } from './dom';
