import { SkillValidator } from '../../src/agents/apps/skills/services/SkillValidator';

describe('SkillValidator', () => {
  let validator: SkillValidator;

  beforeEach(() => {
    validator = new SkillValidator();
  });

  describe('validate (structured input)', () => {
    it('accepts a valid name + description', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: 'Edits essays for clarity and tone.',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags a missing/empty name', () => {
      const result = validator.validate({
        name: '',
        description: 'A valid description.',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /name.*required/i.test(e))).toBe(true);
    });

    it('flags whitespace-only name as empty', () => {
      const result = validator.validate({
        name: '   ',
        description: 'A valid description.',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /name.*required/i.test(e))).toBe(true);
    });

    it.each([
      ['Essay Editor'], // capitals + space
      ['essay_editor'], // underscore
      ['-foo'],         // leading hyphen
      ['foo-'],         // trailing hyphen
      ['foo--bar'],     // double hyphen
      ['Foo'],          // single capital
      ['foo bar'],      // space
    ])('flags a bad-case name "%s"', (name) => {
      const result = validator.validate({
        name,
        description: 'A valid description.',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /lowercase-hyphenated/i.test(e))).toBe(true);
    });

    it.each([
      ['essay-editor'],
      ['pr-reviewer-2'],
      ['foo'],
      ['a1-b2-c3'],
      ['123'],
    ])('accepts a valid hyphenated name "%s"', (name) => {
      const result = validator.validate({
        name,
        description: 'A valid description.',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags an empty description', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /description.*required/i.test(e))).toBe(true);
    });

    it('flags a whitespace-only description as empty', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: '    \n\t  ',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /description.*required/i.test(e))).toBe(true);
    });

    it('flags an over-length description (> 1024 chars)', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: 'x'.repeat(1025),
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /at most 1024 characters/i.test(e))).toBe(true);
    });

    it('accepts a description at exactly the 1024-char boundary', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: 'x'.repeat(1024),
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('collects ALL errors (does not stop at the first)', () => {
      const result = validator.validate({
        name: 'Bad Name',
        description: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some(e => /lowercase-hyphenated/i.test(e))).toBe(true);
      expect(result.errors.some(e => /description.*required/i.test(e))).toBe(true);
    });

    it('rejects a description containing a newline', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: 'line one\nline two',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /control characters|newlines/i.test(e))).toBe(true);
    });

    it('rejects a description containing a control character', () => {
      const result = validator.validate({
        name: 'essay-editor',
        description: `bad${String.fromCharCode(0)}null`,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /control characters|newlines/i.test(e))).toBe(true);
    });
  });

  describe('validateProvider', () => {
    it.each(['nexus', 'claude', 'codex', 'pr-reviewer-2'])(
      'accepts safe provider id "%s"',
      (provider) => {
        expect(validator.validateProvider(provider).valid).toBe(true);
      }
    );

    it.each(['', '..', '../evil', 'a/b', 'Claude', 'foo_bar'])(
      'rejects unsafe/invalid provider id "%s"',
      (provider) => {
        const result = validator.validateProvider(provider);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    );
  });

  describe('validateSkillMd (raw SKILL.md)', () => {
    it('accepts a SKILL.md with good frontmatter', async () => {
      const content = [
        '---',
        'name: essay-editor',
        'description: Edits essays for clarity and tone.',
        '---',
        '',
        '# Essay Editor',
        'Body content here.',
      ].join('\n');

      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects content with no frontmatter block', async () => {
      const content = '# Essay Editor\n\nNo frontmatter at all.';
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SKILL.md must begin with a YAML frontmatter block');
    });

    it('rejects content where frontmatter fence is not at the start', async () => {
      const content = 'leading text\n---\nname: foo\ndescription: bar\n---';
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SKILL.md must begin with a YAML frontmatter block');
    });

    it('rejects frontmatter with no closing fence', async () => {
      const content = '---\nname: foo\ndescription: bar\n\n# Body';
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SKILL.md must begin with a YAML frontmatter block');
    });

    it('rejects frontmatter missing description', async () => {
      const content = ['---', 'name: essay-editor', '---', '', '# Body'].join('\n');
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /description.*required/i.test(e))).toBe(true);
    });

    it('rejects frontmatter missing name', async () => {
      const content = ['---', 'description: A fine description.', '---'].join('\n');
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /name.*required/i.test(e))).toBe(true);
    });

    it('applies the name-convention rule to frontmatter values', async () => {
      const content = ['---', 'name: Bad Name', 'description: ok', '---'].join('\n');
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => /lowercase-hyphenated/i.test(e))).toBe(true);
    });

    it('handles CRLF line endings in frontmatter', async () => {
      const content = '---\r\nname: essay-editor\r\ndescription: Edits essays.\r\n---\r\n# Body';
      const result = await validator.validateSkillMd(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});
