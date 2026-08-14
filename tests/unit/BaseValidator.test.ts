/**
 * tests/unit/BaseValidator.test.ts
 *
 * Every validation rule in docs/plans/bases-manager-agent-plan.md §6, exercised
 * in BOTH directions — a config that must be rejected and a neighbouring one
 * that must pass. A one-directional test on a validator proves nothing: a
 * validator that rejects everything passes half of them.
 *
 * Plus two checks the repo did not author:
 *   - the complete examples from kepano's `obsidian-bases` skill must validate
 *     clean (fixtures in tests/fixtures/bases/, copied verbatim from
 *     https://github.com/kepano/obsidian-skills). If a rule of ours rejects a
 *     file the ecosystem calls correct, the rule is wrong.
 *   - YAML round-trip stability: parse -> mutate -> stringify -> reparse must
 *     preserve the config, because that is exactly what `update` does to a
 *     user's file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from 'obsidian';
import { BaseValidator } from '@/agents/baseManager/services/BaseValidator';
import type { BaseValidationCode, BaseValidationResult } from '@/agents/baseManager/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'bases');

function codes(result: BaseValidationResult): BaseValidationCode[] {
    return result.errors.map((issue) => issue.code);
}

function warningCodes(result: BaseValidationResult): BaseValidationCode[] {
    return result.warnings.map((issue) => issue.code);
}

/** A minimal config that passes every rule; each test perturbs one thing. */
function validConfig(): Record<string, unknown> {
    return {
        filters: { and: ['file.hasTag("task")'] },
        formulas: { days_left: 'if(due, (date(due) - today()).days, "")' },
        properties: { 'formula.days_left': { displayName: 'Days left' } },
        summaries: { mean_days: 'values.mean().round(2)' },
        views: [
            {
                type: 'table',
                name: 'Active',
                filters: 'status != "done"',
                groupBy: { property: 'status', direction: 'ASC' },
                order: ['file.name', 'status', 'formula.days_left'],
                summaries: { 'formula.days_left': 'Average' }
            }
        ]
    };
}

describe('BaseValidator — the baseline config is valid', () => {
    it('accepts a config that uses every section', () => {
        const result = BaseValidator.validate(validConfig());
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
    });
});

describe('BaseValidator — yaml-parse', () => {
    it('rejects a document that is not YAML at all', () => {
        const { config, result } = BaseValidator.parseAndValidate('views:\n  - type: table\n   name: broken\n');
        expect(codes(result)).toContain('yaml-parse');
        expect(config).toBeUndefined();
    });

    it('accepts an empty document as an empty base', () => {
        const { config, result } = BaseValidator.parseAndValidate('');
        expect(result.valid).toBe(true);
        expect(config).toEqual({});
    });

    it('returns the parsed config even when it is structurally invalid', () => {
        // A caller that cannot see a broken file cannot fix it.
        const { config, result } = BaseValidator.parseAndValidate('nonsense: 1\n');
        expect(result.valid).toBe(false);
        expect(config).toEqual({ nonsense: 1 });
    });
});

describe('BaseValidator — unknown-key', () => {
    it('rejects a top-level key outside the documented schema', () => {
        const result = BaseValidator.validate({ ...validConfig(), viewz: [] });
        expect(codes(result)).toEqual(['unknown-key']);
        expect(result.errors[0].path).toBe('viewz');
    });

    it('accepts all five documented top-level keys', () => {
        const result = BaseValidator.validate({
            filters: 'a == 1',
            formulas: {},
            properties: {},
            summaries: {},
            views: []
        });
        expect(result.errors).toEqual([]);
    });
});

describe('BaseValidator — filter-arity', () => {
    it('rejects a filter object with two keys', () => {
        const result = BaseValidator.validate({ filters: { and: ['a'], or: ['b'] } });
        expect(codes(result)).toEqual(['filter-arity']);
        expect(result.errors[0].message).toContain('2 keys');
    });

    it('rejects a filter object whose single key is not and/or/not', () => {
        const result = BaseValidator.validate({ filters: { xor: ['a'] } });
        expect(codes(result)).toEqual(['filter-arity']);
    });

    it('rejects a nested filter with the same rule, and reports its path', () => {
        const result = BaseValidator.validate({ filters: { and: ['a', { or: ['b'], not: ['c'] }] } });
        expect(codes(result)).toEqual(['filter-arity']);
        expect(result.errors[0].path).toBe('filters.and[1]');
    });

    it('accepts a bare expression string, and one-key and/or/not objects', () => {
        for (const filters of ['status == "done"', { and: ['a'] }, { or: ['a'] }, { not: ['a'] }]) {
            expect(BaseValidator.validate({ filters }).errors).toEqual([]);
        }
    });

    it('applies the rule to per-view filters too', () => {
        const result = BaseValidator.validate({
            views: [{ type: 'table', name: 'V', filters: { and: ['a'], not: ['b'] } }]
        });
        expect(codes(result)).toEqual(['filter-arity']);
        expect(result.errors[0].path).toBe('views[0].filters');
    });
});

describe('BaseValidator — group-direction', () => {
    it('rejects a direction other than ASC/DESC', () => {
        const result = BaseValidator.validate({
            views: [{ type: 'table', name: 'V', groupBy: { property: 'status', direction: 'asc' } }]
        });
        expect(codes(result)).toEqual(['group-direction']);
        expect(result.errors[0].path).toBe('views[0].groupBy.direction');
    });

    it('accepts ASC and DESC, and an absent direction', () => {
        for (const groupBy of [{ property: 'status', direction: 'ASC' }, { property: 'status', direction: 'DESC' }, { property: 'status' }]) {
            const result = BaseValidator.validate({ views: [{ type: 'table', name: 'V', groupBy }] });
            expect(result.errors).toEqual([]);
        }
    });
});

describe('BaseValidator — unknown-formula', () => {
    it('rejects a formula reference in order that is not defined', () => {
        const result = BaseValidator.validate({
            formulas: { days_left: 'x' },
            views: [{ type: 'table', name: 'V', order: ['file.name', 'formula.days_until_due'] }]
        });
        expect(codes(result)).toEqual(['unknown-formula']);
        expect(result.errors[0].path).toBe('views[0].order[1]');
    });

    it('rejects a formula reference in the properties section', () => {
        const result = BaseValidator.validate({ properties: { 'formula.missing': { displayName: 'x' } } });
        expect(codes(result)).toEqual(['unknown-formula']);
        expect(result.errors[0].path).toBe('properties.formula.missing');
    });

    it('rejects a formula reference in a view summary key', () => {
        const result = BaseValidator.validate({
            views: [{ type: 'table', name: 'V', summaries: { 'formula.missing': 'Average' } }]
        });
        expect(codes(result)).toEqual(['unknown-formula']);
    });

    it('accepts references to formulas that are defined, and non-formula property ids', () => {
        const result = BaseValidator.validate({
            formulas: { days_left: 'x' },
            views: [{ type: 'table', name: 'V', order: ['file.name', 'status', 'note.author', 'formula.days_left'] }]
        });
        expect(result.errors).toEqual([]);
    });
});

describe('BaseValidator — unknown-summary', () => {
    it('rejects a summary name that is neither built-in nor defined', () => {
        const result = BaseValidator.validate({
            views: [{ type: 'table', name: 'V', summaries: { price: 'Aveerage' } }]
        });
        expect(codes(result)).toEqual(['unknown-summary']);
        expect(result.errors[0].path).toBe('views[0].summaries.price');
    });

    it('accepts every built-in summary name', () => {
        const builtIns = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev',
            'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
        for (const name of builtIns) {
            const result = BaseValidator.validate({ views: [{ type: 'table', name: 'V', summaries: { price: name } }] });
            expect(result.errors).toEqual([]);
        }
    });

    it('accepts a custom summary defined in the top-level summaries section', () => {
        const result = BaseValidator.validate({
            summaries: { mean_days: 'values.mean().round(2)' },
            views: [{ type: 'table', name: 'V', summaries: { price: 'mean_days' } }]
        });
        expect(result.errors).toEqual([]);
    });
});

describe('BaseValidator — invalid-shape', () => {
    it.each([
        ['a non-mapping document', 'a string'],
        ['views as a string', { views: 'table' }],
        ['a view with no name', { views: [{ type: 'table' }] }],
        ['a view with no type', { views: [{ name: 'V' }] }],
        ['formulas holding a non-string', { formulas: { x: 3 } }],
        ['properties holding a non-mapping', { properties: { status: 'Status' } }],
        ['order holding a non-string', { views: [{ type: 'table', name: 'V', order: [3] }] }]
    ])('rejects %s', (_label, config) => {
        expect(codes(BaseValidator.validate(config))).toContain('invalid-shape');
    });

    it('accepts a view carrying view-specific keys we do not model', () => {
        // View config is an open set (limit, image, cardSize, map settings...).
        // Rejecting unknown VIEW keys would reject files Obsidian renders.
        const result = BaseValidator.validate({
            views: [{ type: 'cards', name: 'V', limit: 30, image: 'cover', cardSize: 220 }]
        });
        expect(result.errors).toEqual([]);
    });
});

describe('BaseValidator — unknown-view-type is a WARNING, not an error', () => {
    it('warns for a type outside table|cards|list|map but still validates', () => {
        const result = BaseValidator.validate({ views: [{ type: 'nexus-analyze', name: 'V' }] });
        expect(result.valid).toBe(true);
        expect(warningCodes(result)).toEqual(['unknown-view-type']);
    });

    it('does not warn for the four built-in types', () => {
        for (const type of ['table', 'cards', 'list', 'map']) {
            const result = BaseValidator.validate({ views: [{ type, name: 'V' }] });
            expect(result.warnings).toEqual([]);
        }
    });
});

describe('BaseValidator — duration-arithmetic warning', () => {
    it('warns when a date subtraction is rounded without a numeric field first', () => {
        const result = BaseValidator.validate({ formulas: { age: '(now() - file.ctime).round(0)' } });
        expect(result.valid).toBe(true);
        expect(warningCodes(result)).toEqual(['duration-arithmetic']);
        expect(result.warnings[0].path).toBe('formulas.age');
    });

    it.each([
        ['a numeric field is accessed first', '(now() - file.ctime).days.round(0)'],
        ['the parenthesised expression is not a subtraction', '(file.size / 5).round(0)'],
        ['there is no rounding at all', '(now() - file.ctime).days'],
        ['the minus is unary', '(-file.size).round(0)']
    ])('does not warn when %s', (_label, expression) => {
        expect(BaseValidator.validate({ formulas: { x: expression } }).warnings).toEqual([]);
    });
});

describe('BaseValidator — unused-property warning', () => {
    it('warns for an order entry no note has, when the vault properties are supplied', () => {
        const result = BaseValidator.validate(
            { views: [{ type: 'table', name: 'V', order: ['file.name', 'status', 'nonexistent'] }] },
            { knownProperties: new Set(['status']) }
        );
        expect(result.valid).toBe(true);
        expect(warningCodes(result)).toEqual(['unused-property']);
        expect(result.warnings[0].path).toBe('views[0].order[2]');
    });

    it('is skipped entirely when no vault properties are supplied', () => {
        const result = BaseValidator.validate({
            views: [{ type: 'table', name: 'V', order: ['nonexistent'] }]
        });
        expect(result.warnings).toEqual([]);
    });

    it('never warns about file.* or formula.* ids', () => {
        const result = BaseValidator.validate(
            {
                formulas: { x: '1' },
                views: [{ type: 'table', name: 'V', order: ['file.mtime', 'formula.x'] }]
            },
            { knownProperties: new Set<string>() }
        );
        expect(result.warnings).toEqual([]);
    });
});

describe('BaseValidator — collects every error rather than stopping at the first', () => {
    it('reports both problems in one pass, each with its own path', () => {
        const result = BaseValidator.validate({
            filters: { and: ['a'], or: ['b'] },
            views: [{ type: 'table', name: 'V', order: ['formula.days_left'] }]
        });
        expect(codes(result).sort()).toEqual(['filter-arity', 'unknown-formula']);
        expect(result.errors.map((issue) => issue.path).sort()).toEqual(['filters', 'views[0].order[0]']);
    });
});

describe('kepano obsidian-bases skill examples validate clean', () => {
    const fixtures = ['task-tracker', 'reading-list', 'daily-notes-index'];

    it.each(fixtures)('%s.base has no errors and no warnings', (name) => {
        const source = fs.readFileSync(path.join(FIXTURES, `${name}.base`), 'utf8');
        const { config, result } = BaseValidator.parseAndValidate(source);
        expect(config).toBeDefined();
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
    });
});

describe('YAML round-trip stability', () => {
    const fixtures = ['task-tracker', 'reading-list', 'daily-notes-index'];

    it.each(fixtures)('%s.base survives parse -> stringify -> parse unchanged', (name) => {
        const source = fs.readFileSync(path.join(FIXTURES, `${name}.base`), 'utf8');
        const parsed = parseYaml(source);
        const reparsed = parseYaml(stringifyYaml(parsed));
        expect(reparsed).toEqual(parsed);
    });

    it('survives the mutation an update performs, and still validates', () => {
        // This is exactly `base update --views ...`: replace one top-level
        // section, re-serialise, and hand the file back to Obsidian.
        const source = fs.readFileSync(path.join(FIXTURES, 'task-tracker.base'), 'utf8');
        const original = parseYaml(source) as Record<string, unknown>;

        const mutated = {
            ...original,
            views: [{ type: 'table', name: 'Overdue', filters: 'formula.is_overdue', order: ['file.name', 'due'] }]
        };

        const reparsed = parseYaml(stringifyYaml(mutated)) as Record<string, unknown>;

        expect(reparsed).toEqual(mutated);
        // The sections the caller did not touch are byte-for-byte the same values.
        expect(reparsed.formulas).toEqual(original.formulas);
        expect(reparsed.filters).toEqual(original.filters);
        expect(reparsed.properties).toEqual(original.properties);
        expect(BaseValidator.validate(reparsed).errors).toEqual([]);
    });

    it('quotes an expression that would otherwise break the YAML', () => {
        // Quoting is the largest single source of broken bases; the serialiser
        // handles it, which is why nothing here builds YAML from templates.
        const config = { formulas: { label: 'if(done, "Yes: done", "No")' } };
        const roundTripped = parseYaml(stringifyYaml(config));
        expect(roundTripped).toEqual(config);
    });
});
