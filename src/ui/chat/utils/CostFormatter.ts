export function formatConversationCost(totalCost: number): string {
  if (!Number.isFinite(totalCost) || totalCost <= 0) return '$0.00';
  if (totalCost < 0.0001) return '<$0.0001';
  if (totalCost < 0.01) return `$${totalCost.toFixed(4)}`;
  if (totalCost < 1) return `$${totalCost.toFixed(3)}`;
  return `$${totalCost.toFixed(2)}`;
}
