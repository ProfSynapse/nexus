/**
 * The five top-level section arguments, shared by `base write` and
 * `base update` so the two commands cannot drift apart.
 *
 * The CLI coerces an `object`/`array` flag by `JSON.parse`, falling back to the
 * raw string — and the tools parse a raw string as YAML — so every one of these
 * accepts JSON or YAML equally.
 */

export function baseSectionSchemas(): Record<string, unknown> {
  return {
    filters: {
      type: 'object',
      description: 'Global filters applied to every view. Either an expression string (\'status == "done"\') or an object with exactly one of and/or/not holding an array of filters.'
    },
    formulas: {
      type: 'object',
      description: 'Computed properties: { name: "expression" }. Reference them elsewhere as formula.<name>. Subtracting two dates yields a Duration - access .days/.hours before rounding.'
    },
    properties: {
      type: 'object',
      description: 'Per-property settings: { "property-id": { displayName: "..." } }. Property ids are bare/note.X (frontmatter), file.X (metadata) or formula.X (computed).'
    },
    summaries: {
      type: 'object',
      description: 'Custom summary formulas: { name: "values.mean().round(2)" }. Views may then use the name alongside the built-ins (Average, Min, Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique).'
    },
    views: {
      type: 'array',
      description: 'Views to render. Each: { type: table|cards|list|map, name, filters?, groupBy?: { property, direction: ASC|DESC }, order?: [property ids], limit?, summaries?: { property: summaryName } }.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'View type: table, cards, list or map (a plugin-registered type is allowed)' },
          name: { type: 'string', description: 'View name, shown in the Bases view selector' },
          filters: { type: 'object', description: 'Filters applied to this view only' },
          groupBy: { type: 'object', description: '{ property, direction: ASC|DESC }' },
          order: { type: 'array', items: { type: 'string' }, description: 'Property ids to display, in order' },
          limit: { type: 'number', description: 'Maximum rows' },
          summaries: { type: 'object', description: 'Property id to summary formula name' }
        },
        required: ['type', 'name']
      }
    }
  };
}
