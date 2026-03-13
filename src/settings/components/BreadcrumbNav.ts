import { Component, setIcon } from 'obsidian';

export interface BreadcrumbNavItem {
  label: string;
  onClick?: () => void;
}

export class BreadcrumbNav {
  private element: HTMLElement;

  constructor(
    container: HTMLElement,
    items: BreadcrumbNavItem[],
    component?: Component
  ) {
    this.element = container.createDiv('nexus-breadcrumb');

    items.forEach((item, index) => {
      if (item.onClick) {
        const button = this.element.createEl('button', {
          cls: 'nexus-breadcrumb-link',
          text: item.label
        });

        if (component) {
          component.registerDomEvent(button, 'click', () => item.onClick?.());
        } else {
          button.addEventListener('click', () => item.onClick?.());
        }
      } else {
        this.element.createEl('span', {
          cls: 'nexus-breadcrumb-current',
          text: item.label
        });
      }

      if (index < items.length - 1) {
        const sep = this.element.createEl('span', {
          cls: 'nexus-breadcrumb-separator'
        });
        setIcon(sep, 'chevron-right');
      }
    });
  }

  getElement(): HTMLElement {
    return this.element;
  }
}
