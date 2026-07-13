describe('Obsidian global DOM creators', () => {
  it('applies class, text, attributes, and element properties', () => {
    const element = createDiv({
      cls: ['alpha', 'beta'],
      text: 'Hello',
      attr: { role: 'status', 'aria-live': 'polite' },
      title: 'Greeting',
    });

    expect(element.className).toBe('alpha beta');
    expect(element.textContent).toBe('Hello');
    expect(element.setAttribute).toHaveBeenCalledWith('role', 'status');
    expect(element.setAttribute).toHaveBeenCalledWith('aria-live', 'polite');
    expect(element.title).toBe('Greeting');
  });

  it('supports the string class shorthand', () => {
    const element = createSpan('one two');

    expect(element.className).toBe('one two');
  });
});
