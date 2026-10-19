import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))
archive = root / 'artifacts' / f"bookmark-grove-v{manifest['version']}.zip"
with zipfile.ZipFile(archive) as bundle:
    names = bundle.namelist()
    assert not any('local-settings' in name or '/private/' in name for name in names), 'Private configuration found in package'
    private_file = root / 'extension' / 'local-settings.json'
    if private_file.exists():
        secret = json.loads(private_file.read_text(encoding='utf-8-sig')).get('apiKey', '')
        if secret:
            assert all(secret.encode() not in bundle.read(name) for name in names), 'Credential found in package'
    packaged_manifest = json.loads(bundle.read('extension/manifest.json'))
    assert packaged_manifest['version'] == manifest['version']
    assert 'extension/native-flow.js' in names
    for module in ('collect.html', 'popup-bootstrap.js', 'page-state.js', 'organizer-core.js', 'organizer.js', 'organizer-ui.js'):
        assert f'extension/{module}' in names
print(f"PASS: v{manifest['version']} package contains native popup flow and excludes private configuration and API Key.")
