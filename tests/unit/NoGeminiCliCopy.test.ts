/**
 * The Google-login provider and MCP client are called Antigravity in the UI.
 * Failure this buys: "Gemini CLI" creeping back into a provider name, a
 * notice, an error message or the mobile-unavailable list, next to screens
 * that already say "Antigravity CLI".
 *
 * Every string literal and template in src/**\/*.ts is checked, so a new user
 * facing string cannot slip past a list of known call sites. Comments are not
 * string literals, and internal ids (`google-gemini-cli`) do not contain the
 * phrase, so neither needs an allowlist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..', '..');
const PHRASE = /Gemini CLI/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function stringsIn(path: string, code = readFileSync(path, 'utf-8')): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it('no string in src says "Gemini CLI"', () => {
  const hits = sourceFiles(join(ROOT, 'src')).flatMap(path =>
    stringsIn(path)
      .filter(({ text }) => PHRASE.test(text))
      .map(({ line, text }) => `${relative(ROOT, path)}:${line} ${JSON.stringify(text)}`));
  expect(hits).toEqual([]);
});

it('the scanner sees ordinary, template and nested template strings', () => {
  const strings = (code: string) => stringsIn(join(__dirname, 'fixture.ts'), code)
    .map(({ text }) => text)
    .filter(text => PHRASE.test(text));
  expect(strings("new Notice('Gemini CLI ready'); // Gemini CLI in a comment")).toEqual(['Gemini CLI ready']);
  expect(strings('const x = `${a} Gemini CLI ${b}`;')).toEqual([' Gemini CLI ']);
  expect(strings("const id = 'google-gemini-cli';")).toEqual([]);
});
