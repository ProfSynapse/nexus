"""Behavior checks for the documentation-media maintenance CLI."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('media', Path(__file__).with_name('media.py'))
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)

# Real tiny PNG; enough metadata for the header reader, not a playback test.
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489')


class MediaWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'media-test@example.invalid')
        self.git('config', 'user.name', 'Media Test')
        self.write('src/ui/board.ts', 'export const title = "Tasks";\n')
        self.write('media/screenshots/board.png', PNG)
        self.write('guide/tasks.md', '![Board](../media/screenshots/board.png)\n')
        self.write('README.md', '![Board](media/screenshots/board.png)\n')
        self.catalog = {'schemaVersion': 1, 'assets': [{
            'id': 'board', 'title': 'Task board', 'status': 'published',
            'path': 'media/screenshots/board.png',
            'watch': ['src/ui/*'], 'recipe': 'Create tasks and open the board.',
            **media.media_info(self.root / 'media/screenshots/board.png')}]}
        self.save()
        self.run_cli('index')
        self.commit('baseline')
        self.base = self.git('rev-parse', 'HEAD')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, content):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content) if isinstance(content, bytes) else p.write_text(content)

    def save(self):
        self.write('media/catalog.json', json.dumps(self.catalog))

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True).strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def run_cli(self, *args, expected=0):
        r = subprocess.run(['python3', str(Path(media.__file__)), '--repo', str(self.root), *args],
                           text=True, capture_output=True)
        self.assertEqual(r.returncode, expected, r.stdout + r.stderr)
        return r.stdout

    def test_reverse_index_discovers_new_placements_and_remote_media(self):
        self.write('guide/new.md', '<video src="../media/screenshots/board.png"></video>\n'
                                 '![Badge](https://example.invalid/badge)\n')
        refs = media.references(self.root)
        self.assertEqual(refs['media/screenshots/board.png'], ['README.md:1', 'guide/new.md:1', 'guide/tasks.md:1'])
        self.assertEqual(refs['https://example.invalid/badge'], ['guide/new.md:2'])
        self.run_cli('check', expected=1)
        self.run_cli('index')
        self.run_cli('check')

    def test_byte_corruption_and_missing_assets_fail(self):
        self.write('media/screenshots/board.png', PNG + b'changed')
        self.assertIn('sha256 mismatch', self.run_cli('check', expected=1))
        (self.root / 'media/screenshots/board.png').unlink()
        self.assertIn('missing', self.run_cli('check', expected=1))

    def test_source_change_requires_review_and_invalidates_prior_approval(self):
        self.write('src/ui/board.ts', 'export const title = "Projects";\n')
        self.commit('changed UI')
        self.assertIn('guide/tasks.md:1', self.run_cli('review', '--base', self.base, expected=1))
        self.run_cli('approve', 'board', '--decision', 'keep', '--note', 'Verified unchanged demonstrated workflow')
        self.run_cli('review', '--base', self.base)
        self.commit('review metadata only')
        self.run_cli('review', '--base', self.base)
        self.write('src/ui/board.ts', 'export const title = "Board";\n')
        self.commit('second UI change')
        self.run_cli('review', '--base', self.base, expected=1)

    def test_unrelated_changes_do_not_require_recapture(self):
        self.write('src/unrelated.ts', 'export const count = 1;\n')
        self.commit('unrelated change')
        self.assertIn('0 asset review(s)', self.run_cli('review', '--base', self.base))

    def test_stable_path_swap_updates_metadata_and_preserves_placements(self):
        replacement = self.root / 'replacement.png'
        replacement.write_bytes(PNG + b'new bytes')
        self.run_cli('replace', 'board', '--file', str(replacement), '--plugin-version', '9.0.0',
                     '--platform', 'Obsidian / Linux')
        data = media.load(self.root)['assets'][0]
        self.assertEqual(data['path'], 'media/screenshots/board.png')
        self.assertEqual(data['capture']['pluginVersion'], '9.0.0')
        self.assertEqual((self.root / data['path']).read_bytes(), replacement.read_bytes())
        self.run_cli('check')
        self.assertIn('guide/tasks.md:1', (self.root / media.INDEX).read_text())

    def test_replacement_rejects_lfs_pointer_wrong_format_and_escaping_path(self):
        for raw in [b'version https://git-lfs.github.com/spec/v1\n', b'<html>Not an image</html>']:
            p = self.root / 'bad.png'
            p.write_bytes(raw)
            self.run_cli('replace', 'board', '--file', str(p), '--plugin-version', '9.0.0',
                         '--platform', 'Linux', expected=2)
        self.catalog['assets'][0]['path'] = '../outside.png'
        self.save()
        self.run_cli('check', expected=2)

    def test_deletion_and_new_watched_file_both_trigger_review(self):
        (self.root / 'src/ui/board.ts').unlink()
        self.write('src/ui/new-board.ts', 'new layout\n')
        self.commit('replace source file')
        out = self.run_cli('review', '--base', self.base, expected=1)
        self.assertIn('src/ui/board.ts', out)
        self.assertIn('src/ui/new-board.ts', out)

    def test_duplicate_ids_and_unknown_replacement_fail(self):
        self.run_cli('replace', 'unknown', '--file', '/tmp/unused.png',
                     '--plugin-version', '1.0.0', '--platform', 'Linux', expected=2)
        self.catalog['assets'].append(dict(self.catalog['assets'][0]))
        self.save()
        self.run_cli('check', expected=2)


if __name__ == '__main__':
    unittest.main()
