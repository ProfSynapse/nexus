/**
 * Every slider value appears once.
 *
 * Failure this buys: Obsidian 1.13+ draws its own `span.slider-value` in front
 * of each SliderComponent (confirmed in the 1.14.4 app bundle), and the
 * settings renderer added a second span of its own, so values read "High 2" and
 * "1,000,000 tokens 1000000". The SliderComponent mock reproduces the native
 * element in FakeElement mode, so a plugin-made duplicate shows up here.
 */
import { Component, Setting } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { SliderComponent } from '../mocks/obsidian/components';
import { bindSliderReadout } from '../../src/components/shared/settings/sliderReadout';

function renderSlider(value: number, configure?: (slider: SliderComponent) => void) {
  const root = createFakeRoot();
  const events = new Component();
  const setting = new Setting(root as unknown as HTMLElement).setName('Creativity');
  let slider!: SliderComponent;
  setting.addSlider(s => {
    slider = s as unknown as SliderComponent;
    configure?.(slider);
    s.setLimits(0, 1, 0.1).setValue(value);
  });
  const readout = bindSliderReadout(events, setting, slider as never, v => v.toFixed(1), {
    ariaValueText: v => `Creativity ${v.toFixed(1)}`
  });
  const control = setting.controlEl as unknown as FakeElement;
  return { root, events, setting, slider, readout, control };
}

it('writes the formatted value into Obsidian\'s own readout instead of adding a second one', () => {
  const { control } = renderSlider(0.5);
  const readouts = control.querySelectorAll('.slider-value');
  expect(readouts).toHaveLength(1);
  expect(readouts[0].textContent).toBe('0.5');
  expect(control.textContent).toBe('0.5');
});

it('updates the single readout and aria-valuetext while dragging, before any change commits', () => {
  const onChange = jest.fn();
  const { slider, control } = renderSlider(0.5, s => s.onChange(onChange));
  slider.drag(0.8);
  expect(control.querySelectorAll('.slider-value').map(el => el.textContent)).toEqual(['0.8']);
  expect((slider.sliderEl as unknown as FakeElement).getAttribute('aria-valuetext')).toBe('Creativity 0.8');
  expect(onChange).not.toHaveBeenCalled();
});

it('adds exactly one readout before the input on builds without a native one', () => {
  const root = createFakeRoot();
  const setting = new Setting(root as unknown as HTMLElement);
  let slider!: SliderComponent;
  setting.addSlider(s => { slider = s as unknown as SliderComponent; });
  // An Obsidian older than 1.13: no native value element and no setDisplayFormat.
  (slider.valueEl as unknown as FakeElement).remove();
  (slider as unknown as { setDisplayFormat?: unknown }).setDisplayFormat = undefined;
  slider.setValue(3);
  const events = new Component();
  const readout = bindSliderReadout(events, setting, slider as never, v => `Level ${v}`);
  const control = setting.controlEl as unknown as FakeElement;
  const readouts = control.querySelectorAll('.slider-value');
  expect(readouts).toHaveLength(1);
  expect(readouts[0].hasClass('nexus-slider-value')).toBe(true);
  expect(control.children.indexOf(readouts[0])).toBeLessThan(control.children.indexOf(slider.sliderEl as unknown as FakeElement));
  expect(readout.el.textContent).toBe('Level 3');
  slider.drag(4);
  expect(readout.el.textContent).toBe('Level 4');
});

it('can show a value between stops until the user drags', () => {
  const { readout, slider } = renderSlider(0.5);
  readout.update('150K');
  expect(readout.el.textContent).toBe('150K');
  slider.drag(0.2);
  expect(readout.el.textContent).toBe('0.2');
});

it('stops listening when its owner unloads', () => {
  const { events, slider } = renderSlider(0.5);
  const input = slider.sliderEl as unknown as FakeElement;
  const before = input.listenerCount('input');
  events.unload();
  expect(input.listenerCount('input')).toBe(before - 1);
});
