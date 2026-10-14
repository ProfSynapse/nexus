import type { Setting, SliderComponent } from 'obsidian';

/**
 * One value readout per slider.
 *
 * Obsidian 1.13+ draws its own `span.slider-value` in front of every
 * SliderComponent and keeps it current while the thumb moves, formatted by
 * `setDisplayFormat` when one is set (confirmed by reading the 1.14.4 app
 * bundle). Settings that also added their own span showed every value twice:
 * "High 2", "1,000,000 tokens 1000000". This helper writes the formatted text
 * into the native element when it exists and adds exactly one
 * `span.slider-value.nexus-slider-value` only on older builds that have none.
 * Either way it keeps `aria-valuetext` in step, since a bare index ("2") means
 * nothing to a screen reader.
 */

export interface DomEventRegistrar {
  registerDomEvent(el: HTMLElement, type: 'input', callback: (event: Event) => unknown): void;
}

export interface SliderReadout {
  readonly el: HTMLElement;
  /** Re-read the slider, or show `text` until the next drag (for values between stops). */
  update(text?: string): void;
}

type SliderWithDisplayFormat = SliderComponent & {
  setDisplayFormat?: (format: (value: number) => string) => unknown;
};

export interface SliderReadoutOptions {
  /** Screen-reader text for a value; defaults to `format`. */
  ariaValueText?: (value: number) => string;
  /** Text to show initially instead of `format(value)`. */
  initialText?: string;
  /** Extra class on the readout, e.g. for a minimum width. */
  cls?: string;
}

export function bindSliderReadout(
  events: DomEventRegistrar,
  setting: Setting,
  slider: SliderComponent,
  format: (value: number) => string,
  options: SliderReadoutOptions = {}
): SliderReadout {
  const native = slider as SliderWithDisplayFormat;
  if (typeof native.setDisplayFormat === 'function') {
    native.setDisplayFormat(format);
  }

  const existing = setting.controlEl.querySelector?.('.slider-value') as HTMLElement | null | undefined;
  let el: HTMLElement;
  if (existing) {
    el = existing;
  } else {
    el = setting.controlEl.createSpan({ cls: ['slider-value', 'nexus-slider-value'] });
    if (slider.sliderEl.parentElement === setting.controlEl) {
      setting.controlEl.insertBefore(el, slider.sliderEl);
    }
  }
  if (options.cls) el.addClass(options.cls);

  const ariaText = options.ariaValueText ?? format;
  const currentValue = (): number => Number(slider.sliderEl.value);

  const update = (text?: string): void => {
    const value = currentValue();
    el.setText(text ?? format(value));
    slider.sliderEl.setAttribute('aria-valuetext', text ?? ariaText(value));
  };

  events.registerDomEvent(slider.sliderEl, 'input', () => update());
  update(options.initialText);
  return { el, update };
}
