import { formatConversationCost } from '../../src/ui/chat/utils/CostFormatter';

describe('formatConversationCost', () => {
  it('keeps small positive charges visible as they arrive', () => {
    expect(formatConversationCost(0)).toBe('$0.00');
    expect(formatConversationCost(0.00004)).toBe('<$0.0001');
    expect(formatConversationCost(0.0012)).toBe('$0.0012');
    expect(formatConversationCost(0.1234)).toBe('$0.123');
    expect(formatConversationCost(1.234)).toBe('$1.23');
  });
});
