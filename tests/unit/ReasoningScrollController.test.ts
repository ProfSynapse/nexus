import { createMockElement } from 'obsidian';
import { ReasoningScrollController } from '../../src/ui/chat/controllers/ReasoningScrollController';

// Geometry is supplied, but the real controller decides whether to follow.
// These assertions prove intent and frame ordering; real layout is checked in Obsidian.
describe('reasoning reading position', () => {
  it('follows growth, pauses on upward scroll before a queued frame, then catches up', () => {
    const viewport = createMockElement('div');
    const button = createMockElement('button') as HTMLButtonElement;
    const frames: FrameRequestCallback[] = [];
    const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    Object.assign(viewport, { scrollHeight: 600, clientHeight: 200, scrollTop: 400 });
    const hold = jest.fn();
    const controller = new ReasoningScrollController(viewport, button, () => true, hold);
    controller.beforeGrowth();
    viewport.scrollHeight = 700;
    controller.afterGrowth();
    viewport.scrollTop = 250; // Reader scrolls before the queued layout write.
    frames.shift()!(0);
    expect(viewport.scrollTop).toBe(250);
    expect(button.hidden).toBe(false);
    expect(hold).toHaveBeenLastCalledWith(true);
    viewport.scrollHeight = 800;
    controller.beforeGrowth(); controller.afterGrowth(); frames.shift()!(1);
    expect(viewport.scrollTop).toBe(250);
    controller.catchUp(); frames.shift()!(2);
    expect(viewport.scrollTop).toBe(800);
    expect(button.hidden).toBe(true);
    expect(hold).toHaveBeenLastCalledWith(false);
    // Detaching an ancestor resets browser geometry. Restoring it must not be
    // mistaken for the reader scrolling upward during completion redraw.
    viewport.scrollTop = 0;
    controller.restorePosition(800);
    frames.shift()!(3);
    expect(viewport.scrollTop).toBe(800);
    expect(hold).toHaveBeenLastCalledWith(false);
    controller.unload(); raf.mockRestore();
  });
});
