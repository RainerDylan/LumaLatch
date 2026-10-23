"""Inspect all release archives, then extract Windows for executable tests."""
import pathlib
import struct
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
version, destination = sys.argv[1:]
destination = pathlib.Path(destination).resolve()
assert destination.is_relative_to(root / '.cache')
for label in ['Windows-x64', 'Mac-Apple-Silicon', 'Mac-Intel', 'Guest']:
    with zipfile.ZipFile(root / 'dist' / f'LumaLatch-{version}-{label}.zip') as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert all(name.startswith('LumaLatch/') and '..' not in pathlib.PurePosixPath(name).parts for name in names)
        assert 'LumaLatch/extension/manifest.json' in names
        assert 'LumaLatch/Quick-Start.pdf' in names
        assert archive.read('LumaLatch/Quick-Start.pdf') == (root / 'docs' / 'Quick-Start.pdf').read_bytes(), 'Packaged PDF is stale'
        assert archive.read('LumaLatch/START-HERE.html') == (root / 'docs' / 'Quick-Start.html').read_bytes(), 'Packaged HTML is stale'
        assert not any('playwright' in name or '.cache' in name or name.endswith('npm.cmd') for name in names)
        if label == 'Windows-x64':
            assert archive.read('LumaLatch/LumaLatch.exe')[:2] == b'MZ'
            assert archive.read('LumaLatch/runtime/node.exe')[:2] == b'MZ'
            archive.extractall(destination)
        elif label.startswith('Mac'):
            command = archive.getinfo('LumaLatch/Start LumaLatch.command')
            binary = archive.getinfo('LumaLatch/runtime/bin/node')
            assert command.external_attr >> 16 & 0o111
            assert binary.external_attr >> 16 & 0o111
            assert b'\r' not in archive.read(command)
            header = archive.read(binary)[:8]
            assert header[:4] == b'\xcf\xfa\xed\xfe'
            assert struct.unpack('<I', header[4:8])[0] == (0x100000c if label == 'Mac-Apple-Silicon' else 0x1000007)
        else:
            assert not any(name.endswith('.exe') or '/runtime/' in name or '/app/' in name for name in names)
        print(label, 'archive contents and integrity passed')
