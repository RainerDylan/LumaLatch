"""Create a portable release ZIP, preserving Mac executable permissions."""
import pathlib
import shutil
import sys
import zipfile

source = pathlib.Path(sys.argv[1]).resolve(strict=True)
target = pathlib.Path(sys.argv[2]).resolve()
assert source.is_dir() and source.name == 'LumaLatch'
assert source.is_relative_to(pathlib.Path(__file__).resolve().parents[1])
assert target.is_relative_to(pathlib.Path(__file__).resolve().parents[1] / 'dist')
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(source.rglob('*')):
        if not file.is_file():
            continue
        assert not file.is_symlink() and file.resolve().is_relative_to(source)
        name = file.relative_to(source.parent).as_posix()
        entry = zipfile.ZipInfo(name, (2026, 10, 18, 0, 0, 0))
        entry.create_system = 3
        executable = file.name.endswith('.command') or name.endswith('/runtime/bin/node')
        entry.external_attr = (0o100755 if executable else 0o100644) << 16
        # ponytail: store runtime binaries; this host's deflater failed their CRC checks.
        # Restore compression only after a verified round trip on this build host.
        entry.compress_type = zipfile.ZIP_STORED if '/runtime/' in name else zipfile.ZIP_DEFLATED
        with file.open('rb') as source_file, archive.open(entry, 'w') as zipped_file:
            shutil.copyfileobj(source_file, zipped_file, 1024 * 1024)
with zipfile.ZipFile(target) as archive:
    damaged = archive.testzip()
    assert damaged is None, f'ZIP CRC validation failed: {damaged}'
    assert 'LumaLatch/START-HERE.html' in archive.namelist()
print(target.name, target.stat().st_size, 'bytes; ZIP integrity passed')
